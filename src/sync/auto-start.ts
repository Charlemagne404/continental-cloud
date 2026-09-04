import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 as windowsPath } from 'node:path';
import { promisify } from 'node:util';
import { defaultSyncHome } from './client.js';

const execFile = promisify(execFileCallback);
const SERVICE_LABEL = 'com.continental.cloud.sync';
const SERVICE_NAME = 'continental-cloud-sync.service';
const TASK_NAME = 'Continental Cloud Sync';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';
type CommandRunner = (file: string, args: string[]) => Promise<void>;

export interface AutoStartPaths {
  platform: SupportedPlatform;
  syncHome: string;
  configFile: string;
  installedPath: string;
  logDirectory: string;
  taskName?: string;
}

export interface AutoStartResult {
  platform: SupportedPlatform;
  installedPath: string;
  activated: boolean;
  detail?: string;
}

export interface AutoStartOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
  configFile?: string;
  scriptFile?: string | null;
  executable?: string;
  runCommand?: CommandRunner;
}

export function autoStartPaths(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  configuredPath?: string,
): AutoStartPaths {
  if (!isSupportedPlatform(platform)) throw new Error(`Automatic sync start is not supported on ${platform}.`);
  const pathJoin = platform === 'win32' ? windowsPath.join : join;
  const syncHome = defaultSyncHome(platform, environment, userHome);
  const configFile = configuredPath ?? pathJoin(syncHome, 'config.json');
  const logDirectory = pathJoin(syncHome, 'logs');
  if (platform === 'darwin') return { platform, syncHome, configFile, installedPath: pathJoin(userHome, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`), logDirectory };
  if (platform === 'linux') {
    const configRoot = nonEmpty(environment.XDG_CONFIG_HOME) ?? pathJoin(userHome, '.config');
    return { platform, syncHome, configFile, installedPath: pathJoin(configRoot, 'systemd', 'user', SERVICE_NAME), logDirectory };
  }
  return { platform, syncHome, configFile, installedPath: pathJoin(syncHome, 'run-sync.cmd'), logDirectory, taskName: TASK_NAME };
}

export async function installSyncAutoStart(options: AutoStartOptions = {}): Promise<AutoStartResult> {
  const paths = autoStartPaths(options.platform, options.environment, options.userHome, options.configFile);
  await access(paths.configFile).catch((error: unknown) => {
    if (isMissingFile(error)) throw new Error(`Sync is not initialized at ${paths.configFile}. Run cloud-sync init or cloud-sync pair first.`);
    throw error;
  });
  const scriptFile = options.scriptFile === undefined ? resolve(process.argv[1] ?? 'dist/sync-cli.js') : options.scriptFile ? resolve(options.scriptFile) : undefined;
  const executable = options.executable ?? process.execPath;
  const run = options.runCommand ?? runCommand;
  await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });

  if (paths.platform === 'darwin') {
    await mkdir(dirname(paths.installedPath), { recursive: true, mode: 0o700 });
    await writeFile(paths.installedPath, renderLaunchAgent({ executable, scriptFile, configFile: paths.configFile, logDirectory: paths.logDirectory }), { mode: 0o600 });
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined) return { platform: paths.platform, installedPath: paths.installedPath, activated: false, detail: 'The launch agent was written, but this process has no user session ID for launchctl.' };
    try { await run('launchctl', ['bootout', `gui/${uid}`, paths.installedPath]); } catch { /* replacing an unregistered agent is normal */ }
    try {
      await run('launchctl', ['bootstrap', `gui/${uid}`, paths.installedPath]);
      return { platform: paths.platform, installedPath: paths.installedPath, activated: true };
    } catch (error) {
      return { platform: paths.platform, installedPath: paths.installedPath, activated: false, detail: commandError(error, 'launchctl bootstrap') };
    }
  }

  if (paths.platform === 'linux') {
    await mkdir(dirname(paths.installedPath), { recursive: true, mode: 0o700 });
    await writeFile(paths.installedPath, renderSystemdUnit({ executable, scriptFile, configFile: paths.configFile }), { mode: 0o600 });
    try {
      await run('systemctl', ['--user', 'daemon-reload']);
      await run('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
      return { platform: paths.platform, installedPath: paths.installedPath, activated: true };
    } catch (error) {
      return { platform: paths.platform, installedPath: paths.installedPath, activated: false, detail: commandError(error, 'systemctl --user') };
    }
  }

  await mkdir(dirname(paths.installedPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.installedPath, renderWindowsLauncher({ executable, scriptFile, configFile: paths.configFile }), { mode: 0o700 });
  try {
    await run('schtasks.exe', ['/Create', '/TN', paths.taskName!, '/SC', 'ONLOGON', '/TR', windowsArgument(paths.installedPath), '/RL', 'LIMITED', '/F']);
    return { platform: paths.platform, installedPath: paths.installedPath, activated: true };
  } catch (error) {
    return { platform: paths.platform, installedPath: paths.installedPath, activated: false, detail: commandError(error, 'schtasks /Create') };
  }
}

export async function uninstallSyncAutoStart(options: AutoStartOptions = {}): Promise<AutoStartResult> {
  const paths = autoStartPaths(options.platform, options.environment, options.userHome, options.configFile);
  const run = options.runCommand ?? runCommand;
  let detail: string | undefined;
  if (paths.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined) {
      try { await run('launchctl', ['bootout', `gui/${uid}`, paths.installedPath]); } catch (error) { detail = commandError(error, 'launchctl bootout'); }
    }
  } else if (paths.platform === 'linux') {
    try { await run('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]); } catch (error) { detail = commandError(error, 'systemctl --user disable'); }
    try { await run('systemctl', ['--user', 'daemon-reload']); } catch { /* the unit can still be removed when systemd is unavailable */ }
  } else {
    try { await run('schtasks.exe', ['/Delete', '/TN', paths.taskName!, '/F']); } catch (error) { detail = commandError(error, 'schtasks /Delete'); }
  }
  await rm(paths.installedPath, { force: true });
  return { platform: paths.platform, installedPath: paths.installedPath, activated: false, detail };
}

export function renderLaunchAgent(input: { executable: string; scriptFile?: string; configFile: string; logDirectory: string }): string {
  const argumentsXml = [input.executable, ...(input.scriptFile ? [input.scriptFile] : []), 'start', '--config', input.configFile].map((value) => `    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(join(input.logDirectory, 'sync.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(input.logDirectory, 'sync-error.log'))}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(input: { executable: string; scriptFile?: string; configFile: string }): string {
  return `[Unit]
Description=Continental Cloud Sync
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${systemdArgument(input.executable)}${input.scriptFile ? ` ${systemdArgument(input.scriptFile)}` : ''} start --config ${systemdArgument(input.configFile)}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

export function renderWindowsLauncher(input: { executable: string; scriptFile?: string; configFile: string }): string {
  return `@echo off\r\n${windowsArgument(input.executable)}${input.scriptFile ? ` ${windowsArgument(input.scriptFile)}` : ''} start --config ${windowsArgument(input.configFile)}\r\n`;
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform { return platform === 'darwin' || platform === 'linux' || platform === 'win32'; }
async function runCommand(file: string, args: string[]): Promise<void> { await execFile(file, args, { windowsHide: true }); }
function commandError(error: unknown, command: string): string { return `${command} could not activate sync: ${error instanceof Error ? error.message : String(error)}`; }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function systemdArgument(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\s]/g, (character) => character === ' ' ? '\\x20' : '\\x09'); }
function windowsArgument(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function nonEmpty(value: string | undefined): string | undefined { return value && value.length ? value : undefined; }
function isMissingFile(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT'); }
