import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 as windowsPath } from 'node:path';
import type { CloudConfig } from '../shared/types.js';
import { createCloudServer } from '../server/server.js';
import { createMapping, defaultSyncHome, freshConfig, saveSyncConfig, SyncDaemon, syncWatcherMode, validateSyncRelativePath } from '../sync/client.js';
import { defaultSyncPolicy, normalizeSyncPolicy, syncPathExcluded } from '../shared/sync-policy.js';
import { autoStartPaths, installSyncAutoStart, renderLaunchAgent, renderSystemdUnit, renderWindowsLauncher, uninstallSyncAutoStart } from '../sync/auto-start.js';

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
async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'sync-cli.js'), ...args], { cwd: process.cwd(), env: { ...process.env } }); let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); }); child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
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

test('project policy excludes generated trees while exact policy includes every safe path', () => {
  const project = defaultSyncPolicy();
  assert.equal(syncPathExcluded('node_modules/library/index.js', project), true);
  assert.equal(syncPathExcluded('packages/app/dist/bundle.js', project), true);
  assert.equal(syncPathExcluded('src/index.ts', project), false);
  assert.equal(syncPathExcluded('notes/tmp.txt', project), false);
  assert.deepEqual(normalizeSyncPolicy({ preset: 'exact', exclude: ['node_modules/**'] }), { preset: 'exact', exclude: [] });
  assert.equal(syncPathExcluded('node_modules/library/index.js', defaultSyncPolicy('exact')), false);
  assert.throws(() => normalizeSyncPolicy({ preset: 'project', exclude: ['../outside'] }));
});

test('auto-start paths and launchers are per-user on every supported desktop platform', () => {
  const mac = autoStartPaths('darwin', {}, '/Users/Ada');
  assert.equal(mac.installedPath, '/Users/Ada/Library/LaunchAgents/com.continental.cloud.sync.plist');
  assert.match(renderLaunchAgent({ executable: '/usr/local/bin/node', scriptFile: '/opt/cloud/dist/sync-cli.js', configFile: mac.configFile, logDirectory: mac.logDirectory }), /<key>KeepAlive<\/key><true\/>/);
  const linux = autoStartPaths('linux', { XDG_CONFIG_HOME: '/home/ada/.config' }, '/home/ada');
  assert.equal(linux.installedPath, '/home/ada/.config/systemd/user/continental-cloud-sync.service');
  assert.match(renderSystemdUnit({ executable: '/usr/bin/node', scriptFile: '/srv/Continental Cloud/dist/sync-cli.js', configFile: linux.configFile }), /Restart=on-failure/);
  assert.match(renderSystemdUnit({ executable: '/usr/bin/node', scriptFile: '/srv/Continental Cloud/dist/sync-cli.js', configFile: linux.configFile }), /Continental\\x20Cloud/);
  const windows = autoStartPaths('win32', {}, 'C:\\Users\\Ada');
  assert.equal(windows.taskName, 'Continental Cloud Sync');
  assert.match(renderWindowsLauncher({ executable: 'C:\\Program Files\\nodejs\\node.exe', scriptFile: 'C:\\Cloud\\dist\\sync-cli.js', configFile: windows.configFile }), /@echo off/);
  assert.match(renderWindowsLauncher({ executable: 'C:\\Cloud\\cloud-sync.exe', configFile: windows.configFile }), /cloud-sync\.exe.*start/);
});

test('auto-start installation writes only a user unit and uninstall leaves the sync config intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continental-cloud-autostart-')); const configFile = join(root, 'config.json'); await writeFile(configFile, '{}'); const calls: string[][] = [];
  try {
    const runCommand = async (file: string, args: string[]): Promise<void> => { calls.push([file, ...args]); };
    const installed = await installSyncAutoStart({ platform: 'linux', userHome: root, environment: { XDG_CONFIG_HOME: join(root, '.config') }, configFile, scriptFile: join(root, 'sync-cli.js'), executable: '/usr/bin/node', runCommand });
    assert.equal(installed.activated, true); assert.match(await readFile(installed.installedPath, 'utf8'), /ExecStart=/); assert(calls.some((call) => call.join(' ').includes('enable --now')));
    const removed = await uninstallSyncAutoStart({ platform: 'linux', userHome: root, environment: { XDG_CONFIG_HOME: join(root, '.config') }, configFile, runCommand });
    assert.equal(removed.activated, false); await assert.rejects(() => access(installed.installedPath)); await access(configFile);
  } finally { await rm(root, { recursive: true, force: true }); }
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
  const conflicts = await request<Array<{ node: { id: string }; cloud: { name: string } | null; originalPath: string }>>(run, '/sync/conflicts'); assert.equal(conflicts.length, 1); assert.equal(conflicts[0].cloud?.name, 'essay.txt');
  const resolved = await json<{ choice: string }>(run, `/sync/conflicts/${conflicts[0].node.id}/resolve`, { originalPath: conflicts[0].originalPath, choice: 'keep-cloud' }); assert.equal(resolved.choice, 'keep-cloud');
  assert.equal((await request<Array<unknown>>(run, '/sync/conflicts')).length, 0);
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

test('one-time pairing registers a device and consumes the code exactly once', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const pairing = await json<{ id: string; code: string; cloudPath: string; policy: { preset: string }; expiresAt: string; qr: string }>(run, '/sync/pairing', { cloudPath: 'Projects', policy: { preset: 'project' } });
  assert.match(pairing.code, /^[A-F0-9]{6}(?:-[A-F0-9]{6}){5}$/);
  assert.match(pairing.qr, /^<svg/);
  const deviceId = randomUUID(); const localPath = join(run.root, 'paired-device'); await mkdir(localPath);
  const claimResponse = await fetch(`${run.base}/api/sync/pairing/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code, deviceId, name: 'Paired device', platform: 'test', clientVersion: 'test', localPath }) });
  const claimBody = await claimResponse.json() as any; assert.equal(claimResponse.ok, true, claimBody?.error?.message);
  const claim = claimBody.data as { token: string; device: { id: string }; mapping: { cloudPath: string; localPath: string; policy: { preset: string } } };
  assert.equal(claim.device.id, deviceId); assert.equal(claim.mapping.cloudPath, 'Projects'); assert.equal(claim.mapping.localPath, localPath); assert.equal(claim.mapping.policy.preset, 'project');
  assert.match(claim.token, /^cc_device_/);
  const scopedState = await fetch(`${run.base}/api/sync/state`, { headers: { 'X-Continental-Token': claim.token, 'X-Continental-Device': deviceId } }); assert.equal(scopedState.status, 200);
  const mismatchedState = await fetch(`${run.base}/api/sync/state`, { headers: { 'X-Continental-Token': claim.token, 'X-Continental-Device': randomUUID() } }); assert.equal(mismatchedState.status, 401);
  const generalApi = await fetch(`${run.base}/api/health`, { headers: { 'X-Continental-Token': claim.token } }); assert.equal(generalApi.status, 401);
  const status = await request<{ state: string; deviceId: string | null }>(run, `/sync/pairing/${pairing.id}`); assert.equal(status.state, 'claimed'); assert.equal(status.deviceId, deviceId);
  const reused = await fetch(`${run.base}/api/sync/pairing/claim`, { method: 'POST', headers: { 'X-Continental-Token': run.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code, deviceId: randomUUID(), name: 'Second device', platform: 'test', clientVersion: 'test', localPath }) });
  assert.equal(reused.status, 409);
});

test('cloud-sync pair creates a local mapping and performs its initial sync', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const pairing = await json<{ code: string }>(run, '/sync/pairing', { cloudPath: 'Projects', policy: { preset: 'project' } }); const localPath = join(run.root, 'cli-device'); const configFile = join(run.root, 'cli-config.json');
  const result = await runCli(['pair', '--server', run.base, '--code', pairing.code, '--local', localPath, '--name', 'CLI device', '--config', configFile]);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Paired CLI device/); const config = JSON.parse(await readFile(configFile, 'utf8')) as { deviceName: string; mappings: Array<{ cloudPath: string; localPath: string; policy: { preset: string } }> };
  assert.equal(config.deviceName, 'CLI device'); assert.equal(config.mappings[0].cloudPath, 'Projects'); assert.equal(config.mappings[0].localPath, localPath); assert.equal(config.mappings[0].policy.preset, 'project'); await access(localPath);
});

test('the server creates a platform installer without putting the cloud token in it', async () => {
  const run = await boot(); const pairing = await json<{ code: string }>(run, '/sync/pairing', { cloudPath: 'Projects', policy: { preset: 'project' } });
  const response = await fetch(`${run.base}/api/sync/installer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Continental-Token': run.token, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'cloud.example.test' }, body: JSON.stringify({ platform: 'windows', code: pairing.code }) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition') ?? '', /Continental Cloud Sync\.cmd/);
  const installer = await response.text(); assert.match(installer, /SERVER_URL=https:\/\/cloud\.example\.test/); assert.match(installer, /%SERVER_URL%\/downloads\/%ARTIFACT%/); assert.match(installer, new RegExp(pairing.code)); assert.doesNotMatch(installer, new RegExp(run.token));
});

test('project mapping uploads source files while leaving dependencies and build output local', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' });
  const local = join(run.root, 'project'); await mkdir(join(local, 'node_modules', 'pkg'), { recursive: true }); await mkdir(join(local, 'dist'), { recursive: true }); await mkdir(join(local, 'src'), { recursive: true });
  await writeFile(join(local, 'node_modules', 'pkg', 'index.js'), 'dependency'); await writeFile(join(local, 'dist', 'bundle.js'), 'generated'); await writeFile(join(local, 'src', 'index.ts'), 'source');
  const daemon = await client(run, 'Project device', local); await daemon.syncNow();
  const remote = await request<{ items: Array<{ name: string; isDirectory: boolean }> }>(run, '/files?path=Projects');
  assert.deepEqual(remote.items.map((item) => item.name), ['src']);
  assert.equal(daemon.status()[0].progress?.excludedFolders, 2);
  const devices = await request<Array<{ mappings: Array<{ status: string; progress: { phase: string; filesDone: number; filesTotal: number } | null }> }>>(run, '/sync/devices');
  assert.equal(devices[0].mappings[0].status, 'idle'); assert.equal(devices[0].mappings[0].progress?.phase, 'complete'); assert.equal(devices[0].mappings[0].progress?.filesDone, devices[0].mappings[0].progress?.filesTotal);
});

test('web-managed folder mappings are adopted by the desktop client', async () => {
  const run = await boot(); await json(run, '/files/folder', { parentPath: '', name: 'Projects' }); const config = freshConfig(run.base, run.token, 'Web managed'); const configFile = join(run.root, 'web-managed.json'); await saveSyncConfig(config, configFile); const daemon = new SyncDaemon(config, configFile);
  await daemon.syncNow();
  const mappingId = '11111111-1111-4111-8111-111111111111'; const localPath = join(run.root, 'web-folder'); const endpoint = `/sync/devices/${config.deviceId}/mappings`;
  const remote = await json<{ id: string }>(run, endpoint, { id: mappingId, cloudPath: 'Projects', localPath }); await daemon.syncNow();
  assert.equal(config.mappings.length, 1); assert.equal(config.mappings[0].id, remote.id); assert.equal(config.mappings[0].localPath, localPath);
  await request(run, `${endpoint}/${remote.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }) }); await daemon.syncNow(); assert.equal(daemon.status()[0].status, 'paused');
  const nextPath = join(run.root, 'web-folder-new'); await mkdir(nextPath); await writeFile(join(nextPath, 'chosen-here.txt'), 'picked from the web console'); await json(run, endpoint, { id: remote.id, cloudPath: 'Projects', localPath: nextPath, paused: false }); await daemon.syncNow();
  assert.equal(config.mappings[0].localPath, nextPath); const cloud = await request<{ items: Array<{ name: string }> }>(run, '/files?path=Projects'); assert(cloud.items.some((item) => item.name === 'chosen-here.txt'));
});
