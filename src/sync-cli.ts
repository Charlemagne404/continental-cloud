import { basename, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createMapping, claimSyncPairing, configPath, defaultSyncHome, freshConfig, loadSyncConfig, saveSyncConfig, SyncDaemon } from './sync/client.js';
import { defaultSyncPolicy } from './shared/sync-policy.js';
import { installSyncAutoStart, uninstallSyncAutoStart } from './sync/auto-start.js';
import type { SyncClientConfig } from './sync/client.js';

const argv = process.argv.slice(2);
const command = argv.shift();
const flag = (name: string): string | undefined => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
const configFile = flag('--config');

async function main(): Promise<void> {
  if (!command || command === 'help' || command === '--help') return usage();
  if (command === 'init') {
    const server = flag('--server'); const token = flag('--token'); const name = flag('--name') ?? basename(process.env.HOSTNAME || process.env.COMPUTERNAME || 'Continental Cloud');
    if (!server || !token) throw new Error('Usage: cloud-sync init --server <url> --token <token> [--name <device>]');
    const config = freshConfig(server, token, name); await saveSyncConfig(config, configFile); console.log(`Continental Cloud Sync initialized for ${config.deviceName}.`); return;
  }
  if (command === 'pair') { await pairDevice(); return; }
  if (command === 'install') {
    await loadSyncConfig(configFile ?? configPath());
    const result = await installSyncAutoStart({ configFile: configFile ?? configPath(), scriptFile: resolve(process.argv[1] ?? 'dist/sync-cli.js') });
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
    if (action === 'add') {
      const cloud = flag('--cloud'); const local = flag('--local'); if (cloud === undefined || !local) throw new Error('Usage: cloud-sync map add --cloud <Cloud/Folder> --local <local-directory>');
      const profile = flag('--profile') ?? 'project'; if (profile !== 'project' && profile !== 'exact') throw new Error('Sync profile must be project or exact.');
      const mapping = await createMapping(config, cloud, resolve(local), undefined, defaultSyncPolicy(profile)); await saveSyncConfig(config, configFile); console.log(`Mapped Cloud: /${mapping.cloudPath} to Local: ${mapping.localPath}\nProfile: ${profile}\nRun cloud-sync sync to start the initial synchronization.`); return;
    }
    if (action === 'list') { for (const mapping of client.status()) console.log(`${mapping.id}\t${mapping.paused ? 'Paused' : mapping.status}\t${mapping.policy.preset}\t/${mapping.cloudPath}\t${mapping.localPath}`); return; }
    throw new Error('Usage: cloud-sync map add|list');
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
  console.log(`Continental Cloud Sync\n\n  cloud-sync init --server <url> --token <token> [--name <device>]\n  cloud-sync pair --server <url> --token <token> --code <pairing-code> --local <directory> [--name <device>]\n  cloud-sync map add --cloud <Cloud/Folder> --local <directory> [--profile project|exact]\n  cloud-sync map list\n  cloud-sync sync [--mapping <id>]\n  cloud-sync start\n  cloud-sync install\n  cloud-sync uninstall\n  cloud-sync status\n  cloud-sync pause|resume <mapping-id>\n\nConfiguration lives in ${defaultSyncHome()} (use --config <path> for automation/tests).`);
}

async function pairDevice(): Promise<void> {
  const server = flag('--server'); const token = flag('--token'); const code = flag('--code'); const local = flag('--local');
  if (!code || !local) throw new Error('Usage: cloud-sync pair --server <url> --token <token> --code <pairing-code> --local <directory> [--name <device>]');
  const target = configFile ?? configPath();
  let config: SyncClientConfig; let newConfig = false;
  try {
    await access(target);
    config = await loadSyncConfig(target);
    if (server && normalizeServer(server) !== config.serverUrl) throw new Error('The pairing server does not match the existing sync configuration.');
    if (token && token !== config.token) throw new Error('The supplied token does not match the existing sync configuration.');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    if (!server || !token) throw new Error('A new sync device needs --server and --token.');
    const name = flag('--name') ?? basename(process.env.HOSTNAME || process.env.COMPUTERNAME || 'Continental Cloud');
    config = freshConfig(server, token, name); newConfig = true;
  }
  const requestedName = flag('--name'); if (requestedName) config.deviceName = requestedName;
  if (newConfig) await saveSyncConfig(config, target);
  const pairing = await claimSyncPairing(server ?? config.serverUrl, token ?? config.token, { code, deviceId: config.deviceId, name: config.deviceName, platform: config.platform, clientVersion: config.clientVersion, localPath: resolve(local) });
  const existing = config.mappings.find((mapping) => mapping.id === pairing.mapping.id || mapping.cloudPath === pairing.mapping.cloudPath);
  if (existing) {
    if (resolve(existing.localPath) !== resolve(local)) throw new Error('This cloud folder is already mapped in the local sync configuration. Remove that mapping before pairing it to a different local folder.');
    existing.policy = pairing.mapping.policy;
  } else {
    await createMapping(config, pairing.mapping.cloudPath, resolve(local), pairing.mapping.id, pairing.mapping.policy);
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
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
