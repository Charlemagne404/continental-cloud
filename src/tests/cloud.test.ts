import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudConfig } from '../shared/types.js';
import { createCloudServer } from '../server/server.js';
import { Storage } from '../server/storage.js';
import { resolveExistingNoSymlink } from '../server/paths.js';

type Running = { root: string; base: string; token: string; app: ReturnType<typeof createCloudServer> };
const running: Running[] = [];
afterEach(async () => { while (running.length) { const item = running.pop()!; await item.app.close(); await rm(item.root, { recursive: true, force: true }); } });

async function boot(): Promise<Running> {
  const root = await mkdtemp(join(tmpdir(), 'continental-cloud-')); const token = 'test-token-that-is-long-enough';
  const config: CloudConfig = { storagePath: join(root, 'storage'), allowStorageInitialization: true, host: '127.0.0.1', port: 0, authToken: token, authDisabled: false, maxUploadBytes: 2 * 1024 * 1024, uploadChunkBytes: 4, versionRetention: 2, trashRetentionDays: 30, minFreeBytes: 1, appVersion: 'test', environment: 'test' };
  const app = createCloudServer(config); await app.initialize(); await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert(address && typeof address !== 'string'); const item = { root, base: `http://127.0.0.1:${address.port}`, token, app }; running.push(item); return item;
}
async function request<T>(run: Running, path: string, init: RequestInit = {}): Promise<{ response: Response; body: T }> {
  const headers = new Headers(init.headers); headers.set('X-Continental-Token', run.token); const response = await fetch(`${run.base}/api${path}`, { ...init, headers }); const body = await response.json() as T; return { response, body };
}
async function json<T>(run: Running, path: string, method: string, body: unknown): Promise<{ response: Response; body: T }> { return request<T>(run, path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
async function upload(run: Running, name: string, data: string, overwrite = false): Promise<any> {
  const bytes = new TextEncoder().encode(data); const started = await json<{ data: { id: string; chunkSize: number; chunkCount: number } }>(run, '/uploads', 'POST', { parentPath: '', name, size: bytes.byteLength, mimeType: 'text/plain', overwrite }); assert.equal(started.response.status, 201);
  for (let index = 0; index < started.body.data.chunkCount; index++) { const part = bytes.slice(index * started.body.data.chunkSize, Math.min(bytes.length, (index + 1) * started.body.data.chunkSize)); const result = await request(run, `/uploads/${started.body.data.id}/chunks/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(part.byteLength) }, body: part }); assert.equal(result.response.status, 200); }
  const complete = await json<{ data: { node: any } }>(run, `/uploads/${started.body.data.id}/complete`, 'POST', {}); assert.equal(complete.response.status, 201); return complete.body.data.node;
}

test('API requires its token and blocks traversal and internals', async () => {
  const run = await boot(); const unauth = await fetch(`${run.base}/api/files`); assert.equal(unauth.status, 401);
  const traversal = await request<{ error: { code: string } }>(run, '/files?path=../outside'); assert.equal(traversal.response.status, 400); assert.equal(traversal.body.error.code, 'BAD_REQUEST');
  const internal = await request<{ error: { code: string } }>(run, '/files?path=.continental'); assert.equal(internal.response.status, 403);
  const invalidName = await json<{ error: { code: string } }>(run, '/files/folder', 'POST', { parentPath: '', name: '../nope' }); assert.equal(invalidName.response.status, 400);
  const cors = await fetch(`${run.base}/api/files`, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'GET' } }); assert.equal(cors.headers.get('access-control-allow-origin'), null);
});

test('symlinks cannot escape the data root', async () => {
  const run = await boot(); const outside = join(run.root, 'outside.txt'); await writeFile(outside, 'not cloud data'); await symlink(outside, join(run.root, 'storage', 'data', 'escape.txt'));
  await assert.rejects(() => resolveExistingNoSymlink(join(run.root, 'storage', 'data'), 'escape.txt'), { code: 'FORBIDDEN' });
  const listing = await request<{ data: { items: Array<{ name: string }> } }>(run, '/files'); assert.equal(listing.response.status, 200); assert.equal(listing.body.data.items.some((item) => item.name === 'escape.txt'), false);
});

test('chunked uploads create normal files and preserve/restore versions', async () => {
  const run = await boot(); const original = await upload(run, 'notes.txt', 'first version'); const firstPath = join(run.root, 'storage', 'data', 'notes.txt'); assert.equal((await (await import('node:fs/promises')).readFile(firstPath, 'utf8')), 'first version');
  await upload(run, 'notes.txt', 'second version', true);
  const versions = await request<{ data: Array<{ id: string }> }>(run, `/files/${original.id}/versions`); assert.equal(versions.body.data.length, 1);
  const restored = await json(run, `/versions/${versions.body.data[0].id}/restore`, 'POST', {}); assert.equal(restored.response.status, 200);
  assert.equal((await (await import('node:fs/promises')).readFile(firstPath, 'utf8')), 'first version');
});

test('rename, copy, trash and restore keep paths recoverable', async () => {
  const run = await boot(); const folder = await json<{ data: { id: string } }>(run, '/files/folder', 'POST', { parentPath: '', name: 'Field notes' }); const source = await upload(run, 'map.txt', 'ridge line');
  const moved = await json<{ data: { relativePath: string } }>(run, `/files/${source.id}`, 'PATCH', { action: 'move', parentPath: 'Field notes' }); assert.equal(moved.body.data.relativePath, 'Field notes/map.txt');
  const copied = await json<{ data: { relativePath: string } }>(run, `/files/${source.id}`, 'PATCH', { action: 'copy', parentPath: '' }); assert.equal(copied.body.data.relativePath, 'map.txt');
  const deleted = await request(run, `/files/${folder.body.data.id}`, { method: 'DELETE' }); assert.equal(deleted.response.status, 200);
  const trash = await request<{ data: Array<{ id: string; originalPath: string }> }>(run, '/trash'); assert.equal(trash.body.data[0].originalPath, 'Field notes');
  const restored = await json<{ data: { relativePath: string } }>(run, `/trash/${trash.body.data[0].id}/restore`, 'POST', {}); assert.equal(restored.body.data.relativePath, 'Field notes');
  assert.equal((await (await import('node:fs/promises')).readFile(join(run.root, 'storage', 'data', 'Field notes', 'map.txt'), 'utf8')), 'ridge line');
});

test('collisions are explicit and reconciliation notices external files', async () => {
  const run = await boot(); await upload(run, 'same.txt', 'one'); const duplicate = await json<{ error: { code: string } }>(run, '/uploads', 'POST', { parentPath: '', name: 'same.txt', size: 3 }); assert.equal(duplicate.response.status, 409); assert.equal(duplicate.body.error.code, 'CONFLICT');
  await writeFile(join(run.root, 'storage', 'data', 'outside-added.md'), '# external'); const scan = await json<{ data: { indexed: number } }>(run, '/storage/reconcile', 'POST', {}); assert(scan.body.data.indexed >= 2);
  const search = await request<{ data: Array<{ name: string }> }>(run, '/search?q=outside-added'); assert.equal(search.body.data[0].name, 'outside-added.md');
});

test('search filters, sync changes, archive downloads, and retention stay index-backed', async () => {
  const run = await boot(); const original = await upload(run, 'field-log.txt', 'one'); await upload(run, 'field-log.txt', 'two', true); await upload(run, 'field-log.txt', 'three', true); await upload(run, 'field-log.txt', 'four', true);
  const versions = await request<{ data: Array<{ id: string }> }>(run, `/files/${original.id}/versions`); assert.equal(versions.body.data.length, 2);
  const filtered = await request<{ data: Array<{ name: string }> }>(run, '/search?q=&extension=txt&minSize=3'); assert.equal(filtered.response.status, 200); assert(filtered.body.data.some((item) => item.name === 'field-log.txt'));
  const changes = await request<{ data: Array<{ sequence: number; action: string }> }>(run, '/changes?after=0'); assert(changes.body.data.some((item) => item.action === 'uploaded')); assert.deepEqual([...changes.body.data].map((item) => item.sequence), [...changes.body.data].map((item) => item.sequence).sort((a, b) => a - b));
  const folder = await json<{ data: { id: string } }>(run, '/files/folder', 'POST', { parentPath: '', name: 'archive-source' }); await upload(run, 'inside.txt', 'archive payload'); const moved = await json(run, `/files/${(await request<{ data: { items: Array<{ id: string; name: string }> } }>(run, '/files')).body.data.items.find((item) => item.name === 'inside.txt')!.id}`, 'PATCH', { action: 'move', parentPath: 'archive-source' }); assert.equal(moved.response.status, 200);
  const archive = await fetch(`${run.base}/api/files/${folder.body.data.id}/archive`, { headers: { 'X-Continental-Token': run.token } }); assert.equal(archive.status, 200); const bytes = Buffer.from(await archive.arrayBuffer()); assert.equal(bytes.subarray(257, 262).toString('ascii'), 'ustar');
});

test('a missing identity is treated as offline, never as an empty mount', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continental-cloud-offline-')); const storagePath = join(root, 'mount'); await mkdir(storagePath);
  const storage = new Storage({ storagePath, expectedStorageId: 'known-id', allowStorageInitialization: false, host: '127.0.0.1', port: 1, authToken: 'x', authDisabled: false, maxUploadBytes: 1, uploadChunkBytes: 1, versionRetention: 1, trashRetentionDays: 1, minFreeBytes: 1, appVersion: 'test', environment: 'production' });
  const status = await storage.initialize(); assert.equal(status.state, 'offline'); assert.equal(await (async () => { try { await (await import('node:fs/promises')).lstat(join(storagePath, '.continental', 'storage-id')); return true; } catch { return false; } })(), false); await rm(root, { recursive: true, force: true });
});

test('health stays observable while storage is degraded and writes are blocked', async () => {
  const run = await boot(); await rm(join(run.root, 'storage', '.continental', 'storage-id'));
  const health = await request<{ data: { state: string; storage: { state: string } } }>(run, '/health');
  assert.equal(health.response.status, 200); assert.equal(health.body.data.state, 'degraded'); assert.equal(health.body.data.storage.state, 'offline');
  const write = await json<{ error: { code: string } }>(run, '/files/folder', 'POST', { parentPath: '', name: 'must-not-write' }); assert.equal(write.response.status, 503); assert.equal(write.body.error.code, 'STORAGE_UNAVAILABLE');
});
