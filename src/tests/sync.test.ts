import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 as windowsPath } from 'node:path';
import type { CloudConfig } from '../shared/types.js';
import { createCloudServer } from '../server/server.js';
import { createMapping, defaultSyncHome, freshConfig, saveSyncConfig, SyncDaemon, syncWatcherMode, validateSyncRelativePath } from '../sync/client.js';

type Running = { root: string; base: string; token: string; app: ReturnType<typeof createCloudServer> };
const running: Running[] = [];
afterEach(async () => { while (running.length) { const item = running.pop()!; await item.app.close(); await rm(item.root, { recursive: true, force: true }); } });

async function boot(): Promise<Running> {
  const root = await mkdtemp(join(tmpdir(), 'continental-cloud-sync-')); const token = 'sync-test-token-that-is-long-enough';
  const config: CloudConfig = { storagePath: join(root, 'storage'), allowStorageInitialization: true, host: '127.0.0.1', port: 0, authToken: token, authDisabled: false, maxUploadBytes: 8 * 1024 * 1024, uploadChunkBytes: 4, versionRetention: 5, trashRetentionDays: 30, minFreeBytes: 1, appVersion: 'test', environment: 'test' };
  const app = createCloudServer(config); await app.initialize(); await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert(address && typeof address !== 'string'); const item = { root, base: `http://127.0.0.1:${address.port}`, token, app }; running.push(item); return item;
}
async function request<T>(run: Running, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers); headers.set('X-Continental-Token', run.token); const response = await fetch(`${run.base}/api${path}`, { ...init, headers }); const body = await response.json() as any; assert.equal(response.ok, true, body?.error?.message); return body.data as T;
}
async function json<T>(run: Running, path: string, body: unknown): Promise<T> { return request<T>(run, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
async function client(run: Running, name: string, local: string): Promise<SyncDaemon> {
  const config = freshConfig(run.base, run.token, name); await createMapping(config, 'Projects', local); const file = join(run.root, `${name}.json`); await saveSyncConfig(config, file); return new SyncDaemon(config, file);
}
async function eventually(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise<void>((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for live sync.');
}

test('sync client uses native config locations and validates portable Windows names', () => {
  const windowsHome = 'C:\\Users\\Ada';
  assert.equal(defaultSyncHome('win32', { LOCALAPPDATA: windowsPath.join(windowsHome, 'AppData', 'Local') }, windowsHome), windowsPath.join(windowsHome, 'AppData', 'Local', 'Continental Cloud Sync'));
  assert.equal(defaultSyncHome('darwin', {}, '/Users/ada'), '/Users/ada/Library/Application Support/Continental Cloud Sync');
  assert.equal(defaultSyncHome('linux', { XDG_CONFIG_HOME: '/tmp/continental-config' }, '/home/ada'), '/tmp/continental-config/continental-cloud-sync');
  assert.equal(defaultSyncHome('win32', {}, windowsHome), windowsPath.join(windowsHome, 'AppData', 'Local', 'Continental Cloud Sync'));
  assert.equal(syncWatcherMode('win32'), 'recursive'); assert.equal(syncWatcherMode('darwin'), 'recursive'); assert.equal(syncWatcherMode('linux'), 'directories');
  for (const name of ['CON.txt', 'folder/aux', 'trailing.', 'trailing ', 'bad:name', 'bad*name', 'bad\u0001name']) assert.throws(() => validateSyncRelativePath(name, 'win32'));
  assert.doesNotThrow(() => validateSyncRelativePath('folder/report.final.txt', 'win32'));
  assert.doesNotThrow(() => validateSyncRelativePath('folder/report:final.txt', 'linux'));
});

test('live daemon watches local changes on the host platform', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const local = join(run.root, 'live-client'); await mkdir(local); const daemon = await client(run, 'Live watcher', local); const controller = new AbortController(); const daemonRun = daemon.run(controller.signal);
  try {
    await eventually(async () => Boolean(daemon.status()[0]?.lastSyncAt));
    await writeFile(join(local, 'live.txt'), 'noticed by the native watcher');
    await eventually(async () => (await request<{ items: Array<{ name: string }> }>(run, '/files?path=Projects')).items.some((item) => item.name === 'live.txt'));
  } finally { controller.abort(); await daemonRun; }
});

test('two devices synchronize a selected folder and preserve simultaneous edits as a conflict copy', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const macPath = join(run.root, 'mac'); await mkdir(macPath); await writeFile(join(macPath, 'essay.txt'), 'draft from Mac');
  const mac = await client(run, 'MacBook', macPath); await mac.syncNow();
  const remote = await request<{ items: Array<{ name: string }> }>(run, '/files?path=Projects'); assert.deepEqual(remote.items.map((item) => item.name), ['essay.txt']);
  const linuxPath = join(run.root, 'linux'); await mkdir(linuxPath); await writeFile(join(linuxPath, '.essay.txt.continental-cloud-download.part'), 'draft '); const linux = await client(run, 'ThinkPad', linuxPath); await linux.syncNow();
  assert.equal(await readFile(join(linuxPath, 'essay.txt'), 'utf8'), 'draft from Mac');

  await writeFile(join(macPath, 'essay.txt'), 'Mac revision'); await mac.syncNow();
  await writeFile(join(linuxPath, 'essay.txt'), 'ThinkPad revision'); await linux.syncNow();

  assert.equal(await readFile(join(linuxPath, 'essay.txt'), 'utf8'), 'Mac revision');
  const localNames = (await (await import('node:fs/promises')).readdir(linuxPath)).sort(); assert(localNames.some((name) => name.startsWith('essay (Conflict - ThinkPad - ')));
  const cloud = await request<{ items: Array<{ name: string }> }>(run, '/files?path=Projects'); assert(cloud.items.some((item) => item.name.startsWith('essay (Conflict - ThinkPad - ')));
  const activity = await request<Array<{ action: string }>>(run, '/activity'); assert(activity.some((item) => item.action === 'sync_conflict'));
});

test('offline edits are queued durably, then delete through cloud Trash and propagate to another mapping', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const aPath = join(run.root, 'a'); await mkdir(aPath); await writeFile(join(aPath, 'note.txt'), 'first'); const a = await client(run, 'Studio Mac', aPath); await a.syncNow();
  const bPath = join(run.root, 'b'); await mkdir(bPath); const b = await client(run, 'Linux', bPath); await b.syncNow();

  await writeFile(join(aPath, 'note.txt'), 'offline revision');
  a.config.serverUrl = 'http://127.0.0.1:1'; await a.syncNow().catch(() => undefined);
  assert.equal(a.config.mappings[0].pending.some((item) => item.kind === 'upload'), true);
  a.config.serverUrl = run.base; await a.syncNow();
  assert.equal((await request<{ items: Array<{ name: string }> }>(run, '/files?path=Projects')).items.length, 1);

  await rm(join(aPath, 'note.txt')); await a.syncNow(); await b.syncNow();
  await assert.rejects(() => readFile(join(bPath, 'note.txt'), 'utf8'));
  const trash = await request<Array<{ originalPath: string }>>(run, '/trash'); assert.equal(trash[0].originalPath, 'Projects/note.txt');
});

test('rename and folder move keep stable IDs rather than re-uploading descendants', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const aPath = join(run.root, 'move-a'); await mkdir(join(aPath, 'Drafts'), { recursive: true }); await writeFile(join(aPath, 'Drafts', 'brief.txt'), 'keep this identity'); const a = await client(run, 'Mover', aPath); await a.syncNow();
  const bPath = join(run.root, 'move-b'); await mkdir(bPath); const b = await client(run, 'Receiver', bPath); await b.syncNow();

  await rename(join(aPath, 'Drafts'), join(aPath, 'Archive')); await a.syncNow(); await b.syncNow();
  assert.equal(await readFile(join(bPath, 'Archive', 'brief.txt'), 'utf8'), 'keep this identity');
  await assert.rejects(() => readFile(join(bPath, 'Drafts', 'brief.txt'), 'utf8'));
  await mkdir(join(aPath, 'Finished')); await a.syncNow(); await b.syncNow(); await rename(join(aPath, 'Archive'), join(aPath, 'Finished', 'Archive')); await a.syncNow(); await b.syncNow();
  assert.equal(await readFile(join(bPath, 'Finished', 'Archive', 'brief.txt'), 'utf8'), 'keep this identity');
  const changes = await request<Array<{ operation: string; path: string | null }>>(run, '/changes?after=0'); assert(changes.some((change) => change.operation === 'rename' && change.path === 'Projects/Archive')); assert(changes.some((change) => change.operation === 'move' && change.path === 'Projects/Finished/Archive'));
});

test('a persisted client resumes against a restarted server without replaying its initial snapshot', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const local = join(run.root, 'restart-client'); await mkdir(local); await writeFile(join(local, 'resume.txt'), 'before restart'); const daemon = await client(run, 'Restartable', local); await daemon.syncNow();
  await run.app.close();
  const config: CloudConfig = { storagePath: join(run.root, 'storage'), allowStorageInitialization: true, host: '127.0.0.1', port: 0, authToken: run.token, authDisabled: false, maxUploadBytes: 8 * 1024 * 1024, uploadChunkBytes: 4, versionRetention: 5, trashRetentionDays: 30, minFreeBytes: 1, appVersion: 'test', environment: 'test' };
  const restarted = createCloudServer(config); await restarted.initialize(); await new Promise<void>((resolve) => restarted.server.listen(0, '127.0.0.1', resolve)); const address = restarted.server.address(); assert(address && typeof address !== 'string'); run.app = restarted; run.base = `http://127.0.0.1:${address.port}`; daemon.config.serverUrl = run.base;
  await writeFile(join(local, 'resume.txt'), 'after restart'); await daemon.syncNow();
  const entries = await request<{ items: Array<{ id: string; name: string }> }>(run, '/files?path=Projects'); assert.equal(entries.items[0].name, 'resume.txt');
  assert.equal(await readFile(join(run.root, 'storage', 'data', 'Projects', 'resume.txt'), 'utf8'), 'after restart');
});

test('sync API requires registered devices and never accepts traversal mapping paths', async () => {
  const run = await boot();
  const unregistered = await fetch(`${run.base}/api/sync/state`, { headers: { 'X-Continental-Token': run.token, 'X-Continental-Device': '00000000-0000-4000-8000-000000000000' } }); assert.equal(unregistered.status, 401);
  const registered = await json<{ id: string }>(run, '/sync/devices', { deviceId: '00000000-0000-4000-8000-000000000000', name: 'Safe test', platform: 'test', clientVersion: 'test' }); assert.equal(registered.id, '00000000-0000-4000-8000-000000000000');
  const bad = await fetch(`${run.base}/api/sync/mappings`, { method: 'POST', headers: { 'X-Continental-Token': run.token, 'X-Continental-Device': registered.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', cloudPath: '../escape', localPath: '/tmp/local' }) }); assert.equal(bad.status, 400);
});
