import { basename, resolve } from 'node:path';
import { createMapping, defaultSyncHome, freshConfig, loadSyncConfig, saveSyncConfig, SyncDaemon } from './sync/client.js';

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
  const config = await loadSyncConfig(configFile); const client = new SyncDaemon(config, configFile);
  if (command === 'map') {
    const action = argv.shift();
    if (action === 'add') {
      const cloud = flag('--cloud'); const local = flag('--local'); if (cloud === undefined || !local) throw new Error('Usage: cloud-sync map add --cloud <Cloud/Folder> --local <local-directory>');
      const mapping = await createMapping(config, cloud, resolve(local)); await saveSyncConfig(config, configFile); console.log(`Mapped Cloud: /${mapping.cloudPath} to Local: ${mapping.localPath}\nRun cloud-sync sync to start the initial synchronization.`); return;
    }
    if (action === 'list') { for (const mapping of client.status()) console.log(`${mapping.id}\t${mapping.paused ? 'Paused' : mapping.status}\t/${mapping.cloudPath}\t${mapping.localPath}`); return; }
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
    console.log(`${mapping.cloudPath || 'My drive'}\t${mapping.paused ? 'Paused' : mapping.status}\tqueued ${mapping.pending.length}\tconflicts ${mapping.conflicts.length}\t${mapping.lastSyncAt ? `last sync ${mapping.lastSyncAt}` : 'not synced yet'}${transfer}`);
    if (mapping.lastError) console.log(`  Error: ${mapping.lastError}`);
  }
}
function usage(): void {
  console.log(`Continental Cloud Sync\n\n  cloud-sync init --server <url> --token <token> [--name <device>]\n  cloud-sync map add --cloud <Cloud/Folder> --local <directory>\n  cloud-sync map list\n  cloud-sync sync [--mapping <id>]\n  cloud-sync start\n  cloud-sync status\n  cloud-sync pause|resume <mapping-id>\n\nConfiguration lives in ${defaultSyncHome()} (use --config <path> for automation/tests).`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
