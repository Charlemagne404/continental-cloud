import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createMapping, claimSyncPairing, configPath, defaultSyncHome, freshConfig, loadSyncConfig, saveSyncConfig, SyncDaemon } from './sync/client.js';
import { defaultSyncPolicy } from './shared/sync-policy.js';
import { installSyncAutoStart, uninstallSyncAutoStart } from './sync/auto-start.js';
import type { SyncClientConfig } from './sync/client.js';

const argv = process.argv.slice(2);
const command = argv.shift();
const flag = (name: string): string | undefined => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
const configFile = flag('--config');
const interactive = Boolean(input.isTTY && output.isTTY);

async function main(): Promise<void> {
  if (!command) {
    if (!interactive) return usage();
    await setup();
    return;
  }
  if (command === 'help' || command === '--help') return usage();
  if (command === 'setup') { await setup(); return; }
  if (command === 'init') {
    const server = flag('--server'); const token = flag('--token'); const name = flag('--name') ?? defaultDeviceName();
    if (!server || !token) throw new Error('Usage: cloud-sync init --server <url> --token <token> [--name <device>]');
    const config = freshConfig(server, token, name); await saveSyncConfig(config, configFile); console.log(`Continental Cloud Sync initialized for ${config.deviceName}.`); return;
  }
  if (command === 'pair') { await pairDevice(); return; }
  if (command === 'install') {
    await loadSyncConfig(configFile ?? configPath());
    const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
    const result = await installSyncAutoStart({ configFile: configFile ?? configPath(), scriptFile: packaged ? null : resolve(process.argv[1] ?? 'dist/sync-cli.js'), executable: packaged ? process.execPath : undefined });
    console.log(result.activated ? `Automatic sync start is active (${result.installedPath}).` : `Automatic sync start was written to ${result.installedPath}, but could not be activated.`);
    if (result.detail) console.error(`  ${result.detail}`);
    return;
  }
  if (command === 'uninstall') {
    const result = await uninstallSyncAutoStart({ configFile: configFile ?? configPath() });
    console.log(`Automatic sync start removed from ${result.installedPath}.`);
    if (result.detail) console.error(`  ${result.detail}`);
    return;
  }
  const config = await loadSyncConfig(configFile); const client = new SyncDaemon(config, configFile);
  if (command === 'map') {
    const action = argv.shift();
    if (action === 'add') { await addMapping(config); return; }
    if (action === 'list') { for (const mapping of client.status()) console.log(`${mapping.id}\t${mapping.paused ? 'Paused' : mapping.status}\t${mapping.policy.preset}\t/${mapping.cloudPath || 'My drive'}\t${mapping.localPath}`); return; }
    throw new Error('Usage: cloud-sync map add [--cloud <Cloud/Folder>] [--local <local-directory>] [--profile project|exact] | list');
  }
  if (command === 'sync') { await client.syncNow(flag('--mapping'), true); printStatus(client); return; }
  if (command === 'start') { console.log('Continental Cloud Sync is watching mapped folders. Press Ctrl-C to stop.'); await client.run(); return; }
  if (command === 'status') { printStatus(client); return; }
  if (command === 'pause' || command === 'resume') { const id = argv[0]; if (!id) throw new Error(`Usage: cloud-sync ${command} <mapping-id>`); await client.pause(id, command === 'pause'); printStatus(client); return; }
  throw new Error(`Unknown cloud-sync command: ${command}`);
}

function printStatus(client: SyncDaemon): void {
  for (const mapping of client.status()) {
    const transfer = mapping.transfer ? ` · ${mapping.transfer.direction} ${mapping.transfer.path} ${mapping.transfer.total ? Math.round((mapping.transfer.completed / mapping.transfer.total) * 100) : 100}%` : '';
    const progress = mapping.progress ? ` · ${mapping.progress.phase} ${mapping.progress.filesDone}/${mapping.progress.filesTotal} files, ${mapping.progress.foldersDone}/${mapping.progress.foldersTotal} folders` : '';
    console.log(`${mapping.cloudPath || 'My drive'}\t${mapping.paused ? 'Paused' : mapping.status}\t${mapping.policy.preset}\tqueued ${mapping.pending.length}\tconflicts ${mapping.conflicts.length}\t${mapping.lastSyncAt ? `last sync ${mapping.lastSyncAt}` : 'not synced yet'}${progress}${transfer}`);
    if (mapping.lastError) console.log(`  Error: ${mapping.lastError}`);
  }
}

function usage(): void {
  console.log(`Continental Cloud Sync\n\nFirst-time setup (recommended):\n  cloud-sync setup --server <url> [--no-start]\n\n  cloud-sync init --server <url> --token <token> [--name <device>]\n  cloud-sync pair --server <url> --code <pairing-code> --local <directory> [--name <device>]\n  cloud-sync map add [--cloud <Cloud/Folder>] [--local <directory>] [--profile project|exact]\n  cloud-sync map list\n  cloud-sync sync [--mapping <id>]\n  cloud-sync start\n  cloud-sync install\n  cloud-sync uninstall\n  cloud-sync status\n  cloud-sync pause|resume <mapping-id>\n\nThe web console can download a standalone installer that pairs this computer without the repository, Node.js, or the main cloud token.\nConfiguration lives in ${defaultSyncHome()} (use --config <path> for automation/tests).`);
}

async function setup(): Promise<void> {
  if (!interactive && !flag('--server')) throw new Error('Interactive setup needs a terminal. Provide --server and the remaining setup flags, or run this command in a terminal.');
  const readline = interactive ? createInterface({ input, output }) : undefined;
  try {
    let config: Awaited<ReturnType<typeof loadSyncConfig>> | undefined;
    try { config = await loadSyncConfig(configFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

    if (config) {
      console.log(`This computer is already connected as “${config.deviceName}”. Let’s add another folder.`);
    } else {
      console.log('\nContinental Cloud Sync setup\nConnect this computer in three quick steps. Your files stay in your private cloud.\n');
      const server = await requiredAnswer(readline, 'Cloud URL (for example https://cloud.example.ts.net)', flag('--server'));
      const token = await requiredAnswer(readline, 'Cloud access token', flag('--token'));
      const name = await answer(readline, 'Device name', flag('--name') ?? defaultDeviceName());
      config = freshConfig(server, token, name);
    }

    const mapping = await createMappingFromAnswers(config, readline);
    await saveSyncConfig(config, configFile);
    console.log(`\nSaved “${mapping.localPath}” ↔ “/${mapping.cloudPath || 'My drive'}”.`);
    console.log('Running the first sync now. Existing cloud files will be downloaded; local files will be uploaded safely.');
    const client = new SyncDaemon(config, configFile);
    let firstSyncError: unknown;
    try { await client.syncNow(mapping.id, true); } catch (error) { firstSyncError = error; }
    printStatus(client);
    if (firstSyncError) console.log(`\nThe cloud is not reachable yet (${firstSyncError instanceof Error ? firstSyncError.message : 'connection error'}). Setup is saved and sync will retry when you run cloud-sync start.`);

    const start = argv.includes('--start') || (interactive && !argv.includes('--no-start') && await yesNo(readline, 'Keep live sync running in this terminal?', true));
    if (start) {
      console.log('\nLive sync is on. Leave this window running; press Ctrl-C to stop.');
      await client.run();
    } else {
      console.log('\nSetup is complete. Run “cloud-sync start” whenever you want continuous sync.');
    }
  } finally {
    readline?.close();
  }
}

async function addMapping(config: Awaited<ReturnType<typeof loadSyncConfig>>): Promise<void> {
  const readline = interactive ? createInterface({ input, output }) : undefined;
  try {
    const mapping = await createMappingFromAnswers(config, readline);
    await saveSyncConfig(config, configFile);
    console.log(`Mapped “${mapping.localPath}” ↔ “/${mapping.cloudPath || 'My drive'}”.\nRun cloud-sync sync to start the initial synchronization.`);
  } finally {
    readline?.close();
  }
}

async function createMappingFromAnswers(config: Awaited<ReturnType<typeof loadSyncConfig>>, readline: Interface | undefined) {
  const defaultLocal = join(homedir(), 'Continental Cloud');
  const cloud = await answer(readline, 'Cloud folder (blank means My drive)', flag('--cloud') ?? '');
  const local = await requiredAnswer(readline, 'Local folder', expandHome(flag('--local') ?? defaultLocal));
  const profile = await answer(readline, 'Sync profile (project skips dependencies; exact mirrors safe files)', flag('--profile') ?? 'project');
  if (profile !== 'project' && profile !== 'exact') throw new Error('Sync profile must be project or exact.');
  const normalizedCloud = cloud.replace(/^\/+|\/+$/g, '');
  if (config.mappings.some((mapping) => mapping.cloudPath === normalizedCloud)) throw new Error(`The cloud folder “/${normalizedCloud || 'My drive'}” is already mapped on this computer.`);
  return createMapping(config, normalizedCloud, expandHome(local), undefined, defaultSyncPolicy(profile));
}

async function answer(readline: Interface | undefined, label: string, fallback: string): Promise<string> {
  if (!readline) return fallback;
  const value = (await readline.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  return value || fallback;
}

async function requiredAnswer(readline: Interface | undefined, label: string, provided?: string): Promise<string> {
  const value = await answer(readline, label, provided ?? '');
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

async function yesNo(readline: Interface | undefined, label: string, defaultYes: boolean): Promise<boolean> {
  const value = (await answer(readline, `${label} ${defaultYes ? '[Y/n]' : '[y/N]'}`, '')).toLowerCase();
  if (!value) return defaultYes;
  return value === 'y' || value === 'yes';
}

async function pairDevice(): Promise<void> {
  const server = flag('--server'); const token = flag('--token'); const code = flag('--code'); const local = flag('--local');
  if (!code || !local) throw new Error('Usage: cloud-sync pair --server <url> --code <pairing-code> --local <directory> [--token <token>] [--name <device>]');
  const target = configFile ?? configPath();
  let config: SyncClientConfig; let newConfig = false;
  try {
    await access(target);
    config = await loadSyncConfig(target);
    if (server && normalizeServer(server) !== config.serverUrl) throw new Error('The pairing server does not match the existing sync configuration.');
    if (token && token !== config.token) throw new Error('The supplied token does not match the existing sync configuration.');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    if (!server) throw new Error('A new sync device needs --server.');
    config = freshConfig(server, token ?? `pairing-bootstrap-${randomUUID()}`, flag('--name') ?? defaultDeviceName()); newConfig = true;
  }
  const requestedName = flag('--name'); if (requestedName) config.deviceName = requestedName;
  const pairing = await claimSyncPairing(server ?? config.serverUrl, newConfig && !token ? undefined : token ?? config.token, { code, deviceId: config.deviceId, name: config.deviceName, platform: config.platform, clientVersion: config.clientVersion, localPath: resolve(expandHome(local)) });
  if (pairing.token) config.token = pairing.token;
  else if (newConfig && !token) throw new Error('The server did not issue a device credential. Update the Continental Cloud server and try again.');
  const existing = config.mappings.find((mapping) => mapping.id === pairing.mapping.id || mapping.cloudPath === pairing.mapping.cloudPath);
  if (existing) {
    if (resolve(existing.localPath) !== resolve(expandHome(local))) throw new Error('This cloud folder is already mapped in the local sync configuration. Remove that mapping before pairing it to a different local folder.');
    existing.policy = pairing.mapping.policy;
  } else {
    await createMapping(config, pairing.mapping.cloudPath, resolve(expandHome(local)), pairing.mapping.id, pairing.mapping.policy);
  }
  await saveSyncConfig(config, target);
  const client = new SyncDaemon(config, target);
  console.log(`Paired ${config.deviceName}: /${pairing.mapping.cloudPath || 'My drive'} → ${resolve(local)}.`);
  console.log('Starting the initial synchronization…');
  await client.syncNow();
  printStatus(client);
  console.log('Run cloud-sync install to keep this mapping synchronized after login.');
}

function normalizeServer(value: string): string { const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Server URL must use http or https.'); return parsed.toString().replace(/\/$/, ''); }
function isMissingFile(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT'); }
function expandHome(path: string): string { return path.replace(/^~(?=$|[\\/])/, homedir()); }
function defaultDeviceName(): string { return basename(process.env.HOSTNAME || process.env.COMPUTERNAME || 'This computer'); }

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
