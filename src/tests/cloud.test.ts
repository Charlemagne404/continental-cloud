import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudConfig } from '../shared/types.js';
import { loadConfig } from '../server/config.js';
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
  return uploadBytes(run, name, new TextEncoder().encode(data), 'text/plain', overwrite);
}
async function uploadBytes(run: Running, name: string, bytes: Uint8Array, mimeType?: string, overwrite = false): Promise<any> {
  const started = await json<{ data: { id: string; chunkSize: number; chunkCount: number } }>(run, '/uploads', 'POST', { parentPath: '', name, size: bytes.byteLength, mimeType, overwrite }); assert.equal(started.response.status, 201);
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

test('configuration fails closed for production-like environment values and unsafe hosts', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'Production', CLOUD_AUTH_DISABLED: 'true' }), /forbidden in production/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', CLOUD_AUTH_DISABLED: 'true', CLOUD_HOST: '127.0.0.1\nattacker' }), /control characters/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', CLOUD_AUTH_DISABLED: 'true', CLOUD_ALLOWED_ORIGIN: 'https://example.test/path' }), /without a path/);
});

test('symlinks cannot escape the data root', async () => {
  const run = await boot(); const outside = join(run.root, 'outside.txt'); await writeFile(outside, 'not cloud data'); await symlink(outside, join(run.root, 'storage', 'data', 'escape.txt'));
  await assert.rejects(() => resolveExistingNoSymlink(join(run.root, 'storage', 'data'), 'escape.txt'), { code: 'FORBIDDEN' });
  const listing = await request<{ data: { items: Array<{ name: string }> } }>(run, '/files'); assert.equal(listing.response.status, 200); assert.equal(listing.body.data.items.some((item) => item.name === 'escape.txt'), false);
});

test('chunked uploads create normal files and preserve/restore versions', async () => {
  const run = await boot(); const original = await upload(run, 'notes.txt', 'first version'); const firstPath = join(run.root, 'storage', 'data', 'notes.txt'); assert.equal(await readFile(firstPath, 'utf8'), 'first version');
  await upload(run, 'notes.txt', 'second version', true);
  const versions = await request<{ data: Array<{ id: string }> }>(run, `/files/${original.id}/versions`); assert.equal(versions.body.data.length, 1);
  assert.equal('storedPath' in versions.body.data[0], false);
  const restored = await json(run, `/versions/${versions.body.data[0].id}/restore`, 'POST', {}); assert.equal(restored.response.status, 200);
  assert.equal(await readFile(firstPath, 'utf8'), 'first version');
});

test('uploads are opaque and accept empty files, unknown extensions, and arbitrary MIME hints', async () => {
  const run = await boot();
  const bytes = Uint8Array.from([0, 255, 1, 2, 10, 13, 128, 254]);
  const binary = await uploadBytes(run, 'payload.anything', bytes, 'application/x-custom; charset=binary');
  assert.equal(binary.mimeType, 'application/x-custom');
  assert.deepEqual(new Uint8Array(await readFile(join(run.root, 'storage', 'data', 'payload.anything'))), bytes);
  const empty = await uploadBytes(run, 'empty-file', new Uint8Array(), '');
  assert.equal(empty.size, 0);
  assert.equal((await readFile(join(run.root, 'storage', 'data', 'empty-file'))).byteLength, 0);
  const invalidMime = await uploadBytes(run, 'header-safe.bin', bytes, 'text/plain\r\nX-Injected: yes');
  assert.equal(invalidMime.mimeType, 'application/octet-stream');
  const content = await fetch(`${run.base}/api/files/${invalidMime.id}/content`, { headers: { 'X-Continental-Token': run.token } });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes);
});

test('source, project, archive, and extensionless files retain their exact bytes', async () => {
  const run = await boot();
  const files = [
    { name: 'Program.cs', bytes: Uint8Array.from([0xef, 0xbb, 0xbf, 0x2f, 0x2f, 0x20, 0x03, 0x00]), mimeType: 'text/x-csharp' },
    { name: 'CloudApp.csproj', bytes: Uint8Array.from([0x3c, 0x50, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x3e, 0x00]), mimeType: 'application/xml' },
    { name: 'library.dll', bytes: Uint8Array.from([0x4d, 0x5a, 0x00, 0xff, 0x01, 0x80]), mimeType: 'application/octet-stream' },
    { name: 'release.bin', bytes: Uint8Array.from([0x00, 0x7f, 0x80, 0xff]), mimeType: 'application/octet-stream' },
    { name: 'archive.7z', bytes: Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), mimeType: 'application/x-7z-compressed' },
  ];
  for (const file of files) {
    const node = await uploadBytes(run, file.name, file.bytes);
    assert.equal(node.mimeType, file.mimeType);
    assert.deepEqual(new Uint8Array(await readFile(join(run.root, 'storage', 'data', file.name))), file.bytes);
    const downloaded = await fetch(`${run.base}/api/files/${node.id}/download`, { headers: { 'X-Continental-Token': run.token } });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), file.bytes);
  }
});

test('interrupted chunks remain resumable and same-name uploads receive distinct suffixes', async () => {
  const run = await boot();
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const started = await json<{ data: { id: string; chunkSize: number; chunkCount: number; status: string } }>(run, '/uploads', 'POST', { parentPath: '', name: 'resume.bin', size: bytes.length });
  assert.equal(started.response.status, 201);
  const short = await request<{ error: { code: string } }>(run, `/uploads/${started.body.data.id}/chunks/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '2' }, body: bytes.slice(0, 2) });
  assert.equal(short.response.status, 400);
  const status = await request<{ data: { status: string; receivedChunks: number[] } }>(run, `/uploads/${started.body.data.id}`);
  assert.equal(status.body.data.status, 'active');
  assert.equal('tempName' in status.body.data, false);
  for (let index = 0; index < started.body.data.chunkCount; index++) {
    const part = bytes.slice(index * started.body.data.chunkSize, Math.min(bytes.length, (index + 1) * started.body.data.chunkSize));
    if (index === 0) {
      const streamBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(part); controller.close(); } });
      const streamed = await fetch(`${run.base}/api/uploads/${started.body.data.id}/chunks/${index}`, { method: 'PUT', headers: { 'X-Continental-Token': run.token, 'Content-Type': 'application/octet-stream' }, body: streamBody, duplex: 'half' } as RequestInit & { duplex: 'half' });
      assert.equal(streamed.status, 200);
      const streamedBody = await streamed.json() as { data: { tempName?: string } };
      assert.equal('tempName' in streamedBody.data, false);
    } else {
      const result = await request(run, `/uploads/${started.body.data.id}/chunks/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(part.length) }, body: part });
      assert.equal(result.response.status, 200);
    }
  }
  const completed = await json<{ data: { node: { name: string } } }>(run, `/uploads/${started.body.data.id}/complete`, 'POST', {});
  assert.equal(completed.response.status, 201);

  const first = await json<{ data: { id: string; name: string; chunkSize: number } }>(run, '/uploads', 'POST', { parentPath: '', name: 'collision.bin', size: 1 });
  const second = await json<{ data: { id: string; name: string; chunkSize: number } }>(run, '/uploads', 'POST', { parentPath: '', name: 'collision.bin', size: 1 });
  assert.equal(first.body.data.name, 'collision.bin');
  assert.equal(second.body.data.name, 'collision (1).bin');
  for (const id of [first.body.data.id, second.body.data.id]) {
    const result = await request(run, `/uploads/${id}/chunks/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' }, body: Uint8Array.of(id === first.body.data.id ? 7 : 9) });
    assert.equal(result.response.status, 200);
  }
  assert.equal((await json(run, `/uploads/${first.body.data.id}/complete`, 'POST', {})).response.status, 201);
  assert.equal((await json(run, `/uploads/${second.body.data.id}/complete`, 'POST', {})).response.status, 201);
  assert.equal((await readFile(join(run.root, 'storage', 'data', 'collision.bin')))[0], 7);
  assert.equal((await readFile(join(run.root, 'storage', 'data', 'collision (1).bin')))[0], 9);
});

test('concurrent same-name uploads reserve separate destinations before completion', async () => {
  const run = await boot();
  const sessions = await Promise.all([7, 9].map(() => json<{ data: { id: string; name: string; chunkSize: number } }>(run, '/uploads', 'POST', { parentPath: '', name: 'parallel.bin', size: 1 })));
  assert.deepEqual(new Set(sessions.map((session) => session.body.data.name)), new Set(['parallel.bin', 'parallel (1).bin']));
  await Promise.all(sessions.map((started, index) => request(run, `/uploads/${started.body.data.id}/chunks/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' }, body: Uint8Array.of(index ? 9 : 7) })));
  const completed = await Promise.all(sessions.map((started) => json<{ data: { node: { name: string } } }>(run, `/uploads/${started.body.data.id}/complete`, 'POST', {})));
  assert(completed.every((result) => result.response.status === 201));
  for (const [index, result] of completed.entries()) assert.equal((await readFile(join(run.root, 'storage', 'data', result.body.data.node.name)))[0], index ? 9 : 7);
});

test('starting an upload reconciles a file removed outside the app', async () => {
  const run = await boot();
  await upload(run, 'reappearing.txt', 'old');
  await rm(join(run.root, 'storage', 'data', 'reappearing.txt'));
  const replacement = await upload(run, 'reappearing.txt', 'new');
  assert.equal(replacement.name, 'reappearing.txt');
  assert.equal(await readFile(join(run.root, 'storage', 'data', 'reappearing.txt'), 'utf8'), 'new');
});

test('concurrent folder creation returns one success and clean conflicts', async () => {
  const run = await boot();
  const attempts = await Promise.all(Array.from({ length: 4 }, () => json(run, '/files/folder', 'POST', { parentPath: '', name: 'shared-folder' })));
  assert.equal(attempts.filter((attempt) => attempt.response.status === 201).length, 1);
  assert.equal(attempts.filter((attempt) => attempt.response.status === 409).length, 3);
  const listing = await request<{ data: { items: Array<{ name: string; isDirectory: boolean }> } }>(run, '/files');
  assert.equal(listing.body.data.items.filter((item) => item.name === 'shared-folder' && item.isDirectory).length, 1);
});

test('sync upload idempotency is payload-bound and never returns private staging names', async () => {
  const run = await boot();
  const deviceId = randomUUID();
  await json(run, '/sync/devices', 'POST', { deviceId, name: 'Idempotent device', platform: 'test', clientVersion: 'test' });
  const syncJson = async (body: unknown) => {
    const response = await fetch(`${run.base}/api/sync/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Continental-Token': run.token, 'X-Continental-Device': deviceId }, body: JSON.stringify(body) });
    return { response, body: await response.json() as any };
  };
  const input = { parentPath: '', name: 'idempotent.bin', size: 1, mimeType: 'application/octet-stream', idempotencyKey: 'same-operation-key' };
  const first = await syncJson(input);
  assert.equal(first.response.status, 201);
  assert.equal('tempName' in first.body.data, false);
  const repeat = await syncJson(input);
  assert.equal(repeat.response.status, 201);
  assert.equal(repeat.body.data.id, first.body.data.id);
  assert.equal('tempName' in repeat.body.data, false);
  const mismatch = await syncJson({ ...input, name: 'different.bin' });
  assert.equal(mismatch.response.status, 409);
  const wrongRoute = await json<{ error: { code: string } }>(run, '/uploads', 'POST', { ...input, sync: { deviceId, idempotencyKey: 'wrong-route' } });
  assert.equal(wrongRoute.response.status, 400);
});

test('a missing staged file is failed and can be safely retried', async () => {
  const run = await boot();
  const started = await json<{ data: { id: string; chunkSize: number } }>(run, '/uploads', 'POST', { parentPath: '', name: 'missing-stage.bin', size: 1 });
  const chunk = await request(run, `/uploads/${started.body.data.id}/chunks/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' }, body: Uint8Array.of(1) });
  assert.equal(chunk.response.status, 200);
  await rm(join(run.root, 'storage', '.continental', 'temp', `${started.body.data.id}.part`), { force: true });
  const complete = await json<{ error: { code: string } }>(run, `/uploads/${started.body.data.id}/complete`, 'POST', {});
  assert.equal(complete.response.status, 409);
  const status = await request<{ data: { status: string } }>(run, `/uploads/${started.body.data.id}`);
  assert.equal(status.body.data.status, 'failed');
  const cancelled = await request(run, `/uploads/${started.body.data.id}`, { method: 'DELETE' });
  assert.equal(cancelled.response.status, 200);
});

test('Unicode names use filesystem byte limits and protect reserved storage names', async () => {
  const run = await boot();
  const valid = await uploadBytes(run, 'café-🛰️.bin', Uint8Array.of(4), 'application/octet-stream');
  assert.equal(valid.name, 'café-🛰️.bin');
  const tooLong = await json<{ error: { code: string } }>(run, '/uploads', 'POST', { parentPath: '', name: '😀'.repeat(70) + '.bin', size: 0 });
  assert.equal(tooLong.response.status, 400);
  const internal = await json<{ error: { code: string } }>(run, '/uploads', 'POST', { parentPath: '', name: '.CONTINENTAL', size: 0 });
  assert.equal(internal.response.status, 403);
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

test('same-name uploads preserve the extension and continue numbering', async () => {
  const run = await boot(); await upload(run, 'same.txt', 'one');
  const duplicate = await upload(run, 'same.txt', 'two');
  const third = await upload(run, 'same.txt', 'three');
  assert.equal(duplicate.name, 'same (1).txt');
  assert.equal(third.name, 'same (2).txt');
  assert.equal(await readFile(join(run.root, 'storage', 'data', 'same (1).txt'), 'utf8'), 'two');
  assert.equal(await readFile(join(run.root, 'storage', 'data', 'same (2).txt'), 'utf8'), 'three');
});

test('an external file appearing during an upload is preserved by the next suffix', async () => {
  const run = await boot();
  const started = await json<{ data: { id: string; chunkSize: number } }>(run, '/uploads', 'POST', { parentPath: '', name: 'late.txt', size: 3 });
  const chunk = await request(run, `/uploads/${started.body.data.id}/chunks/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' }, body: Uint8Array.from([1, 2, 3]) });
  assert.equal(chunk.response.status, 200);
  await writeFile(join(run.root, 'storage', 'data', 'late.txt'), 'external');
  const completed = await json<{ data: { node: { name: string } } }>(run, `/uploads/${started.body.data.id}/complete`, 'POST', {});
  assert.equal(completed.response.status, 201);
  assert.equal(completed.body.data.node.name, 'late (1).txt');
  const status = await request<{ data: { name: string } }>(run, `/uploads/${started.body.data.id}`);
  assert.equal(status.body.data.name, 'late (1).txt');
  assert.equal(await readFile(join(run.root, 'storage', 'data', 'late.txt'), 'utf8'), 'external');
  assert.deepEqual(new Uint8Array(await readFile(join(run.root, 'storage', 'data', 'late (1).txt'))), Uint8Array.from([1, 2, 3]));
});

test('reconciliation notices external files', async () => {
  const run = await boot();
  await writeFile(join(run.root, 'storage', 'data', 'outside-added.md'), '# external'); const scan = await json<{ data: { indexed: number } }>(run, '/storage/reconcile', 'POST', {}); assert(scan.body.data.indexed >= 1);
  const search = await request<{ data: Array<{ name: string }> }>(run, '/search?q=outside-added'); assert.equal(search.body.data[0].name, 'outside-added.md');
});

test('trash preserves an external replacement and restores the original beside it', async () => {
  const run = await boot(); const original = await upload(run, 'same.txt', 'old content');
  const deleted = await request<{ data: { trashId: string } }>(run, `/files/${original.id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  await writeFile(join(run.root, 'storage', 'data', 'same.txt'), 'new external content');
  const reconciled = await json<{ data: { indexed: number } }>(run, '/storage/reconcile', 'POST', {}); assert.equal(reconciled.response.status, 200);
  const listing = await request<{ data: { items: Array<{ id: string; name: string }> } }>(run, '/files');
  const replacement = listing.body.data.items.find((item) => item.name === 'same.txt'); assert(replacement); assert.notEqual(replacement.id, original.id);
  assert.equal(await readFile(join(run.root, 'storage', 'data', 'same.txt'), 'utf8'), 'new external content');
  const trash = await request<{ data: Array<{ id: string; originalPath: string; node: { relativePath: string } }> }>(run, '/trash');
  assert.equal(trash.body.data.length, 1); assert.equal(trash.body.data[0].node.relativePath, 'same.txt');
  const trashSearch = await request<{ data: Array<{ relativePath: string }> }>(run, '/search?q=&trash=true');
  assert.equal(trashSearch.body.data[0].relativePath, 'same.txt');
  const restored = await json<{ data: { relativePath: string } }>(run, `/trash/${deleted.body.data.trashId}/restore`, 'POST', {});
  assert.equal(restored.body.data.relativePath, 'same (1).txt');
  assert.equal(await readFile(join(run.root, 'storage', 'data', 'same (1).txt'), 'utf8'), 'old content');
});

test('file ranges and HEAD responses follow HTTP semantics', async () => {
  const run = await boot(); const file = await uploadBytes(run, 'range.bin', Uint8Array.from([1, 2, 3, 4, 5]), 'application/octet-stream');
  const suffix = await fetch(`${run.base}/api/files/${file.id}/content`, { headers: { 'X-Continental-Token': run.token, Range: 'bytes=-2' } });
  assert.equal(suffix.status, 206); assert.equal(suffix.headers.get('content-range'), 'bytes 3-4/5'); assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())], [4, 5]);
  const clamped = await fetch(`${run.base}/api/files/${file.id}/content`, { headers: { 'X-Continental-Token': run.token, Range: 'bytes=1-999' } });
  assert.equal(clamped.status, 206); assert.equal(clamped.headers.get('content-range'), 'bytes 1-4/5'); assert.deepEqual([...new Uint8Array(await clamped.arrayBuffer())], [2, 3, 4, 5]);
  const head = await fetch(`${run.base}/api/files/${file.id}/download`, { method: 'HEAD', headers: { 'X-Continental-Token': run.token } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '5'); assert.equal((await head.arrayBuffer()).byteLength, 0);
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

test('storage refuses a symlinked managed directory before creating any layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continental-cloud-layout-')); const storagePath = join(root, 'mount'); const outside = join(root, 'outside');
  await mkdir(storagePath); await mkdir(outside); await symlink(outside, join(storagePath, 'data'));
  const storage = new Storage({ storagePath, allowStorageInitialization: true, host: '127.0.0.1', port: 1, authToken: 'x', authDisabled: false, maxUploadBytes: 1, uploadChunkBytes: 1, versionRetention: 1, trashRetentionDays: 1, minFreeBytes: 1, appVersion: 'test', environment: 'production' });
  const status = await storage.initialize(); assert.equal(status.state, 'misconfigured');
  await assert.rejects(() => lstat(join(outside, 'should-not-exist')), { code: 'ENOENT' });
  await rm(root, { recursive: true, force: true });
});

test('health stays observable while storage is degraded and writes are blocked', async () => {
  const run = await boot(); await rm(join(run.root, 'storage', '.continental', 'storage-id'));
  const health = await request<{ data: { state: string; storage: { state: string } } }>(run, '/health');
  assert.equal(health.response.status, 200); assert.equal(health.body.data.state, 'degraded'); assert.equal(health.body.data.storage.state, 'offline');
  const write = await json<{ error: { code: string } }>(run, '/files/folder', 'POST', { parentPath: '', name: 'must-not-write' }); assert.equal(write.response.status, 503); assert.equal(write.body.error.code, 'STORAGE_UNAVAILABLE');
});

test('organization and operations APIs expose tags, saved search, duplicate groups, and restore-as-copy', async () => {
  const run = await boot(); const file = await upload(run, 'brief.txt', 'first'); await upload(run, 'brief.txt', 'second', true); await upload(run, 'brief-copy.txt', 'second');
  const versions = await request<{ data: Array<{ id: string }> }>(run, `/files/${file.id}/versions`); const copy = await json<{ data: { relativePath: string } }>(run, `/versions/${versions.body.data[0].id}/restore-copy`, 'POST', {}); assert.equal(copy.response.status, 201); assert.notEqual(copy.body.data.relativePath, 'brief.txt');
  const tagged = await json<{ data: Array<{ name: string }> }>(run, `/files/${file.id}/tags`, 'PUT', { tags: ['work', 'review'] }); assert.deepEqual(tagged.body.data.map((tag) => tag.name), ['review', 'work']);
  const tagSearch = await request<{ data: Array<{ id: string }> }>(run, '/search?q=&tag=work'); assert(tagSearch.body.data.some((item) => item.id === file.id));
  const saved = await json<{ data: { id: string } }>(run, '/saved-searches', 'POST', { name: 'Recent text', query: 'brief', filters: { type: 'text' } }); assert.equal(saved.response.status, 201);
  const suggestions = await request<{ data: string[] }>(run, '/search/suggestions?q=brief'); assert(suggestions.body.data.includes('brief.txt'));
  const duplicates = await request<{ data: Array<{ count: number }> }>(run, '/duplicates'); assert(duplicates.body.data.some((group) => group.count >= 2));
  const operations = await request<{ data: { usage: { folders: unknown[] }; retention: { versionRetention: number } } }>(run, '/operations'); assert.equal(operations.response.status, 200); assert(operations.body.data.usage.folders.length >= 1);
});

test('settings survive restart and recovery, pagination, and browser sessions remain observable', async () => {
  const run = await boot(); await upload(run, 'one.txt', '1'); await upload(run, 'two.txt', '2'); await upload(run, 'three.txt', '3');
  const page = await request<{ data: { items: Array<{ name: string }>; hasMore: boolean; nextOffset: number | null } }>(run, '/files?limit=2&offset=0'); assert.equal(page.response.status, 200); assert.equal(page.body.data.items.length, 2); assert.equal(page.body.data.hasMore, true); assert.equal(page.body.data.nextOffset, 2);
  const check = await json<{ data: { healthy: boolean; checkedFiles: number } }>(run, '/operations/recovery-check', 'POST', {}); assert.equal(check.response.status, 200); assert.equal(check.body.data.healthy, true); assert(check.body.data.checkedFiles >= 3);
  const changed = await json<{ data: { versionRetention: number; trashRetentionDays: number } }>(run, '/operations/retention', 'PATCH', { versionRetention: 7, trashRetentionDays: 45 }); assert.equal(changed.body.data.versionRetention, 7); assert.equal(changed.body.data.trashRetentionDays, 45);
  const session = await fetch(`${run.base}/api/session`, { method: 'POST', headers: { 'X-Continental-Token': run.token } }); assert.equal(session.status, 200); const cookie = session.headers.get('set-cookie'); assert(cookie);
  const ended = await fetch(`${run.base}/api/session`, { method: 'DELETE', headers: { Cookie: cookie!.split(';')[0] } }); assert.equal(ended.status, 200); assert.match(ended.headers.get('set-cookie') ?? '', /Max-Age=0/);
  await run.app.close(); const config: CloudConfig = { storagePath: join(run.root, 'storage'), allowStorageInitialization: true, host: '127.0.0.1', port: 0, authToken: run.token, authDisabled: false, maxUploadBytes: 2 * 1024 * 1024, uploadChunkBytes: 4, versionRetention: 2, trashRetentionDays: 30, minFreeBytes: 1, appVersion: 'test', environment: 'test' }; const restarted = createCloudServer(config); await restarted.initialize(); await new Promise<void>((resolve) => restarted.server.listen(0, '127.0.0.1', resolve)); const address = restarted.server.address(); assert(address && typeof address !== 'string'); run.app = restarted; run.base = `http://127.0.0.1:${address.port}`;
  const persisted = await request<{ data: { retention: { versionRetention: number; trashRetentionDays: number }; lastIntegrityCheck: { action: string } | null } }>(run, '/operations'); assert.equal(persisted.body.data.retention.versionRetention, 7); assert.equal(persisted.body.data.retention.trashRetentionDays, 45); assert.equal(persisted.body.data.lastIntegrityCheck?.action, 'integrity_checked');
});
