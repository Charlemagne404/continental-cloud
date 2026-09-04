import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CloudConfig } from '../shared/types.js';
import { CloudError, fail } from './errors.js';
import { FileService, isPreviewable } from './files.js';
import { metadataPath, MetadataDatabase } from './metadata.js';
import { Storage } from './storage.js';
import { UploadService } from './uploads.js';
import { streamTar } from './archive.js';
import { SyncNotifier, SyncService } from './sync.js';
import { isSyncInstallerPlatform, renderSyncInstaller } from './installers.js';
import { toString as qrToString } from 'qrcode';

type Services = { db: MetadataDatabase; files: FileService; uploads: UploadService; sync: SyncService; notifier: SyncNotifier };
const JSON_LIMIT = 1_048_576;
const STATIC_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function createCloudServer(config: CloudConfig) {
  const storage = new Storage(config);
  let services: Services | undefined;

  async function ensureServices(): Promise<Services> {
    await storage.requireReady();
    if (!services) {
      const db = new MetadataDatabase(metadataPath(config.storagePath));
      await db.open();
      const runtime = db.getRuntimeSettings({ versionRetention: config.versionRetention, trashRetentionDays: config.trashRetentionDays });
      config.versionRetention = runtime.versionRetention;
      config.trashRetentionDays = runtime.trashRetentionDays;
      const notifier = new SyncNotifier();
      services = { db, files: new FileService(storage, db), uploads: undefined as never, sync: undefined as never, notifier };
      services.uploads = new UploadService(services.files, config.maxUploadBytes, config.uploadChunkBytes, config.versionRetention);
      services.sync = new SyncService(db, services.files, services.uploads);
      db.setChangeListener((change) => notifier.publish(change));
    }
    services.db.health();
    return services;
  }

  const server = createServer(async (request, response) => {
    const requestId = crypto.randomUUID();
    setSecurityHeaders(response);
    try {
      if (!request.url || !request.method) throw fail.badRequest('Malformed request.');
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      if (request.method === 'OPTIONS') { response.writeHead(204, corsHeaders(request, config)); response.end(); return; }
      if (url.pathname.startsWith('/api/')) {
        const unauthenticatedPairingClaim = request.method === 'POST' && url.pathname === '/api/sync/pairing/claim';
        if (!unauthenticatedPairingClaim) authorize(request, config, url.pathname, request.method);
        if (!['GET', 'HEAD'].includes(request.method)) assertMutationOrigin(request, config);
        if (request.method === 'POST' && url.pathname === '/api/session') {
          // A short-lived browser session lets regular <a>, media, and image requests
          // stream without ever putting the long-lived token in a URL.
          response.setHeader('Set-Cookie', `cc_session=${encodeURIComponent(config.authToken!)}; Path=/; HttpOnly; SameSite=Strict${config.environment === 'production' ? '; Secure' : ''}`);
          sendJson(response, 200, { data: { established: true } });
          return;
        }
        if (request.method === 'DELETE' && url.pathname === '/api/session') {
          response.setHeader('Set-Cookie', 'cc_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict');
          sendJson(response, 200, { data: { ended: true } });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/health') {
          const status = await storage.refresh();
          let database: { ok: boolean; detail?: string } = { ok: false, detail: 'Storage is unavailable.' };
          if (status.state === 'ready') {
            try { database = (await ensureServices()).db.health(); }
            catch { database = { ok: false, detail: 'Metadata database is unavailable.' }; }
          }
          sendJson(response, 200, { data: { app: 'continental-cloud', version: config.appVersion, state: database.ok && status.state === 'ready' ? 'ready' : 'degraded', storage: status, database, timestamp: new Date().toISOString() } });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/storage') {
          const status = await storage.refresh(); let usedBytes: number | null = null;
          let breakdown: { managedBytes: number; trashBytes: number; versionBytes: number } | null = null;
          if (status.state === 'ready') { try { const db = (await ensureServices()).db; usedBytes = db.usage(); breakdown = db.storageBreakdown(); } catch { /* health endpoint retains the database failure detail */ } }
          if (status.state === 'ready' && services) services.db.recordHealth({ state: status.state, freeBytes: status.freeBytes, totalBytes: status.totalBytes, usedBytes });
          sendJson(response, 200, { data: { ...status, usedBytes, breakdown, warnings: status.freeBytes !== undefined && status.freeBytes < config.minFreeBytes ? ['Free space is below the configured safety reserve.'] : [] } });
          return;
        }
        await handleApi(request, response, url, await ensureServices(), storage, config);
        return;
      }
      await serveStatic(response, url.pathname);
    } catch (error: unknown) {
      const known = error instanceof CloudError ? error : undefined;
      const status = known?.status ?? 500;
      if (!known) console.error(`[${requestId}]`, error);
      sendJson(response, status, { error: { code: known?.code ?? 'INTERNAL_ERROR', message: known?.message ?? 'An unexpected server error occurred.', requestId }, meta: { timestamp: new Date().toISOString() } });
    }
  });

  return {
    server,
    storage,
    async initialize(): Promise<void> {
      const status = await storage.initialize();
      if (status.state === 'ready') await ensureServices();
    },
    async close(): Promise<void> { services?.db.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL, services: Services, storage: Storage, config: CloudConfig): Promise<void> {
  const { pathname } = url; const method = request.method!;
  if (method === 'POST' && pathname === '/api/sync/pairing') {
    const pairing = services.sync.createPairing(await readJson(request));
    const serverUrl = config.allowedOrigin ?? publicOrigin(request);
    const qr = await qrToString(JSON.stringify({ type: 'continental-cloud-sync', serverUrl, code: pairing.code, cloudPath: pairing.cloudPath, policy: pairing.policy }), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 240 });
    sendJson(response, 201, { data: { ...pairing, qr } }); return;
  }
  if (method === 'POST' && pathname === '/api/sync/installer') {
    const body = await readJson(request);
    if (!isSyncInstallerPlatform(body.platform)) throw fail.badRequest('Choose Windows, macOS, or Linux for the installer.');
    const pairing = services.sync.pairingForInstaller(body.code);
    const installer = renderSyncInstaller(body.platform, publicOrigin(request), pairing.code);
    sendInstaller(response, installer);
    return;
  }
  if (method === 'POST' && pathname === '/api/sync/pairing/claim') {
    const claim = services.sync.claimPairing(await readJson(request));
    sendJson(response, 201, { data: { ...claim, token: config.authToken ? createDeviceToken(claim.device.id, config.authToken) : 'auth-disabled-sync-token' } }); return;
  }
  const pairingStatus = pathname.match(/^\/api\/sync\/pairing\/([0-9a-f-]{36})$/i);
  if (method === 'GET' && pairingStatus) { sendJson(response, 200, { data: services.sync.pairingStatus(pairingStatus[1]) }); return; }
  if (method === 'POST' && pathname === '/api/sync/devices') {
    const body = await readJson(request);
    const headerDevice = request.headers['x-continental-device'];
    if (typeof headerDevice === 'string' && body.deviceId !== headerDevice) throw fail.forbidden('The sync device header does not match the registered device.');
    const device = services.sync.registerDevice(body); sendJson(response, 201, { data: device }); return;
  }
  if (method === 'GET' && pathname === '/api/sync/devices') { sendJson(response, 200, { data: services.sync.devices() }); return; }
  const syncDevice = pathname.match(/^\/api\/sync\/devices\/([0-9a-f-]{36})$/i);
  if (method === 'DELETE' && syncDevice) { services.sync.revokeDevice(syncDevice[1]); sendJson(response, 200, { data: { revoked: true } }); return; }
  const consoleMappings = pathname.match(/^\/api\/sync\/devices\/([0-9a-f-]{36})\/mappings$/i);
  if (consoleMappings && method === 'POST') { sendJson(response, 201, { data: services.sync.mappingForDevice(consoleMappings[1], await readJson(request)) }); return; }
  const consoleMapping = pathname.match(/^\/api\/sync\/devices\/([0-9a-f-]{36})\/mappings\/([0-9a-f-]{36})$/i);
  if (consoleMapping && method === 'PATCH') { sendJson(response, 200, { data: services.sync.setMappingFromConsole(consoleMapping[1], consoleMapping[2], await readJson(request)) }); return; }
  const conflictResolution = pathname.match(/^\/api\/sync\/conflicts\/([0-9a-f-]{36})\/resolve$/i);
  if (method === 'POST' && conflictResolution) { const body = await readJson(request); sendJson(response, 200, { data: await services.files.resolveConflict(conflictResolution[1], body.originalPath, body.choice) }); return; }
  if (method === 'GET' && pathname === '/api/sync/conflicts') { sendJson(response, 200, { data: services.sync.conflicts() }); return; }
  if (pathname.startsWith('/api/sync/')) {
    const deviceId = requiredSyncDevice(request);
    if (method === 'GET' && pathname === '/api/sync/state') { sendJson(response, 200, { data: services.sync.state(deviceId) }); return; }
    if (method === 'GET' && pathname === '/api/sync/mappings') { sendJson(response, 200, { data: services.sync.mappings(deviceId) }); return; }
    if (method === 'POST' && pathname === '/api/sync/mappings') { sendJson(response, 201, { data: services.sync.mapping(deviceId, await readJson(request)) }); return; }
    const mapping = pathname.match(/^\/api\/sync\/mappings\/([0-9a-f-]{36})$/i);
    if (method === 'PATCH' && mapping) { sendJson(response, 200, { data: services.sync.setMappingStatus(deviceId, mapping[1], await readJson(request)) }); return; }
    if (method === 'GET' && pathname === '/api/sync/changes') {
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0); const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 250) || 250));
      sendJson(response, 200, { data: services.sync.changes(deviceId, after, limit) }); return;
    }
    if (method === 'GET' && pathname === '/api/sync/snapshot') { sendJson(response, 200, { data: services.sync.snapshot(deviceId, url.searchParams.get('path') ?? '') }); return; }
    if (method === 'POST' && pathname === '/api/sync/ack') { const body = await readJson(request); sendJson(response, 200, { data: services.sync.setMappingStatus(deviceId, String(body.mappingId ?? ''), { cursor: body.cursor, status: body.status ?? 'idle', error: body.error, progress: body.progress }) }); return; }
    if (method === 'POST' && pathname === '/api/sync/folders') { sendJson(response, 201, { data: await services.sync.createFolder(deviceId, await readJson(request)) }); return; }
    if (method === 'POST' && pathname === '/api/sync/mutations') { sendJson(response, 200, { data: await services.sync.mutation(deviceId, await readJson(request)) }); return; }
    if (method === 'POST' && pathname === '/api/sync/uploads') { sendJson(response, 201, { data: await services.sync.startUpload(deviceId, await readJson(request)) }); return; }
    const syncChunk = pathname.match(/^\/api\/sync\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/i);
    if (method === 'PUT' && syncChunk) { services.sync.uploadForDevice(deviceId, syncChunk[1]); sendJson(response, 200, { data: await services.uploads.writeChunk(syncChunk[1], Number(syncChunk[2]), request, contentLength(request)) }); return; }
    const syncUploadComplete = pathname.match(/^\/api\/sync\/uploads\/([0-9a-f-]{36})\/complete$/i);
    if (method === 'POST' && syncUploadComplete) { services.sync.uploadForDevice(deviceId, syncUploadComplete[1]); sendJson(response, 201, { data: await services.uploads.complete(syncUploadComplete[1]) }); return; }
    const syncUpload = pathname.match(/^\/api\/sync\/uploads\/([0-9a-f-]{36})$/i);
    if (method === 'GET' && syncUpload) { sendJson(response, 200, { data: services.sync.uploadForDevice(deviceId, syncUpload[1]) }); return; }
    const syncNode = pathname.match(/^\/api\/sync\/files\/([0-9a-f-]{36})$/i);
    if (method === 'GET' && syncNode) { sendJson(response, 200, { data: await services.files.getNode(syncNode[1]) }); return; }
    const syncDownload = pathname.match(/^\/api\/sync\/files\/([0-9a-f-]{36})\/download$/i);
    if (method === 'GET' && syncDownload) { const file = await services.files.getNode(syncDownload[1]); if (file.isDirectory) throw fail.badRequest('Folders cannot be downloaded as a single file.'); await sendDiskFile(request, response, await storage.pathFor(file.relativePath), false, file.mimeType ?? undefined, file.name); return; }
    if (method === 'GET' && pathname === '/api/sync/events') { await streamSyncEvents(request, response, services.notifier); return; }
  }
  if (method === 'POST' && pathname === '/api/storage/reconcile') {
    sendJson(response, 200, { data: await services.files.reconcile() }); return;
  }
  if (method === 'POST' && pathname === '/api/operations/recovery-check') {
    sendJson(response, 200, { data: await services.files.verifyRecovery() }); return;
  }
  if (method === 'GET' && pathname === '/api/operations') {
    const storageStatus = await storage.refresh(); const usedBytes = services.db.usage();
    const runtime = services.db.getRuntimeSettings({ versionRetention: config.versionRetention, trashRetentionDays: config.trashRetentionDays });
    sendJson(response, 200, { data: {
      storage: { ...storageStatus, usedBytes, breakdown: services.db.storageBreakdown(), history: services.db.healthHistory() },
      jobs: services.db.listJobs(50), failedJobs: services.db.listJobs(100).filter((job) => job.state === 'failed'),
      uploads: services.db.staleUploads(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      usage: { folders: services.db.usageByFolder(), types: services.db.usageByType() },
      retention: { versionRetention: runtime.versionRetention, trashRetentionDays: runtime.trashRetentionDays, trashItems: services.db.listTrash().length, expiringTrash: services.db.expiredTrash(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()).length },
      lastIntegrityCheck: services.db.listActivity(200).find((event) => event.action === 'integrity_checked') ?? null,
    } }); return;
  }
  if (method === 'POST' && pathname === '/api/operations/cleanup') {
    const body = await readJson(request); const hours = typeof body.uploadHours === 'number' && body.uploadHours >= 1 && body.uploadHours <= 8760 ? body.uploadHours : 24;
    const removedUploads = await services.uploads.cleanupOlderThan(hours); const removedTrash = body.includeTrash === true ? await services.files.cleanupTrashOlderThan(config.trashRetentionDays) : 0;
    sendJson(response, 200, { data: { removedUploads, removedTrash } }); return;
  }
  if (method === 'PATCH' && pathname === '/api/operations/retention') {
    const body = await readJson(request);
    const current = services.db.getRuntimeSettings({ versionRetention: config.versionRetention, trashRetentionDays: config.trashRetentionDays });
    const next = {
      versionRetention: typeof body.versionRetention === 'number' && Number.isInteger(body.versionRetention) && body.versionRetention >= 1 && body.versionRetention <= 1000 ? body.versionRetention : current.versionRetention,
      trashRetentionDays: typeof body.trashRetentionDays === 'number' && Number.isInteger(body.trashRetentionDays) && body.trashRetentionDays >= 1 && body.trashRetentionDays <= 3650 ? body.trashRetentionDays : current.trashRetentionDays,
    };
    services.db.setRuntimeSettings(next);
    config.versionRetention = next.versionRetention;
    config.trashRetentionDays = next.trashRetentionDays;
    services.uploads.setVersionRetention(next.versionRetention);
    sendJson(response, 200, { data: next }); return;
  }
  if (method === 'GET' && pathname === '/api/files') {
    const path = url.searchParams.get('path') ?? '';
    const sort = url.searchParams.get('sort') ?? 'name'; const direction = url.searchParams.get('direction') ?? 'asc';
    const number = (name: string, fallback: number): number => { const value = url.searchParams.get(name); const parsed = value !== null && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(parsed) ? parsed : fallback; };
    const page = await services.files.listPage(path, sort, direction, Math.min(250, Math.max(1, number('limit', 100))), number('offset', 0));
    sendJson(response, 200, { data: { path, ...page, nextOffset: page.hasMore ? page.offset + page.items.length : null } }); return;
  }
  if (method === 'POST' && pathname === '/api/files/folder') {
    const body = await readJson(request); const folder = await services.files.createFolder(body.parentPath ?? '', body.name);
    sendJson(response, 201, { data: folder }); return;
  }
  if (method === 'GET' && pathname === '/api/recent') { sendJson(response, 200, { data: services.db.listRecent() }); return; }
  if (method === 'GET' && pathname === '/api/favorites') { sendJson(response, 200, { data: services.db.listFavorites() }); return; }
  if (method === 'GET' && pathname === '/api/search') {
    const number = (name: string): number | undefined => { const value = url.searchParams.get(name); const parsed = value !== null && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(parsed) ? parsed : undefined; };
    const boolean = (name: string): boolean | undefined => url.searchParams.get(name) === 'true' ? true : url.searchParams.get(name) === 'false' ? false : undefined;
    sendJson(response, 200, { data: services.db.search(url.searchParams.get('q') ?? '', Math.min(250, number('limit') ?? 100), { extension: url.searchParams.get('extension') ?? undefined, type: url.searchParams.get('type') ?? undefined, tag: url.searchParams.get('tag') ?? undefined, favorite: boolean('favorite'), trashed: boolean('trash'), minSize: number('minSize'), maxSize: number('maxSize'), before: url.searchParams.get('before') ?? undefined, after: url.searchParams.get('after') ?? undefined, path: url.searchParams.get('path') ?? undefined }) }); return;
  }
  if (method === 'GET' && pathname === '/api/search/suggestions') { sendJson(response, 200, { data: services.db.searchSuggestions((url.searchParams.get('q') ?? '').slice(0, 80)) }); return; }
  if (method === 'GET' && pathname === '/api/duplicates') { sendJson(response, 200, { data: services.db.duplicateGroups() }); return; }
  if (method === 'GET' && pathname === '/api/tags') { sendJson(response, 200, { data: services.db.listTags() }); return; }
  if (method === 'GET' && pathname === '/api/saved-searches') { sendJson(response, 200, { data: services.db.listSavedSearches() }); return; }
  if (method === 'POST' && pathname === '/api/saved-searches') { const body = await readJson(request); const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''; if (!name) throw fail.badRequest('A saved-search name is required.'); const query = typeof body.query === 'string' ? body.query.slice(0, 250) : ''; const filters = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? body.filters as Record<string, string | number | boolean> : {}; sendJson(response, 201, { data: services.db.saveSearch(name, query, filters) }); return; }
  const savedSearch = pathname.match(/^\/api\/saved-searches\/([0-9a-f-]{36})$/i);
  if (savedSearch && method === 'DELETE') { if (!services.db.deleteSavedSearch(savedSearch[1])) throw fail.notFound('Saved search not found.'); sendJson(response, 200, { data: { deleted: true } }); return; }
  if (method === 'GET' && pathname === '/api/changes') { sendJson(response, 200, { data: services.db.listChanges(Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0), Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 250) || 250))) }); return; }
  if (method === 'GET' && pathname === '/api/jobs') { sendJson(response, 200, { data: services.db.listJobs(Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25))) }); return; }
  if (method === 'GET' && pathname === '/api/activity') { sendJson(response, 200, { data: services.db.listActivity(Number(url.searchParams.get('limit') ?? 100)) }); return; }
  if (method === 'GET' && pathname === '/api/trash') { sendJson(response, 200, { data: services.db.listTrash() }); return; }
  if (method === 'POST' && pathname === '/api/trash/empty') { sendJson(response, 200, { data: { removed: await services.files.emptyTrash() } }); return; }
  if (method === 'POST' && pathname === '/api/trash/bulk') { const body = await readJson(request); const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string').slice(0, 200) : []; if (!ids.length) throw fail.badRequest('Choose one or more trash items.'); if (body.action === 'restore') { for (const id of ids) await services.files.restoreTrash(id); sendJson(response, 200, { data: { restored: ids.length } }); return; } if (body.action === 'delete') { for (const id of ids) await services.files.permanentlyDeleteTrash(id); sendJson(response, 200, { data: { deleted: ids.length } }); return; } throw fail.badRequest('Unsupported bulk trash action.'); }
  const restoreTrash = pathname.match(/^\/api\/trash\/([0-9a-f-]{36})\/restore$/i);
  if (method === 'POST' && restoreTrash) { sendJson(response, 200, { data: await services.files.restoreTrash(restoreTrash[1]) }); return; }
  const trashItem = pathname.match(/^\/api\/trash\/([0-9a-f-]{36})$/i);
  if (method === 'DELETE' && trashItem) { await services.files.permanentlyDeleteTrash(trashItem[1]); sendJson(response, 200, { data: { deleted: true } }); return; }
  if (method === 'POST' && pathname === '/api/uploads') { sendJson(response, 201, { data: await services.uploads.start(await readJson(request)) }); return; }
  const uploadChunk = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/i);
  if (method === 'PUT' && uploadChunk) {
    const length = request.headers['content-length'];
    const declared = typeof length === 'string' ? Number(length) : undefined;
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) throw fail.badRequest('Invalid Content-Length.');
    sendJson(response, 200, { data: await services.uploads.writeChunk(uploadChunk[1], Number(uploadChunk[2]), request, declared) }); return;
  }
  const uploadComplete = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})\/complete$/i);
  if (method === 'POST' && uploadComplete) { sendJson(response, 201, { data: await services.uploads.complete(uploadComplete[1]) }); return; }
  const upload = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
  if (method === 'GET' && upload) { const session = services.db.getUpload(upload[1]); if (!session) throw fail.notFound('Upload session not found.'); sendJson(response, 200, { data: session }); return; }
  if (method === 'DELETE' && upload) { await services.uploads.cancel(upload[1]); sendJson(response, 200, { data: { cancelled: true } }); return; }
  const versionRestore = pathname.match(/^\/api\/versions\/([0-9a-f-]{36})\/restore$/i);
  if (method === 'POST' && versionRestore) { sendJson(response, 200, { data: await services.files.restoreVersion(versionRestore[1]) }); return; }
  const versionCopy = pathname.match(/^\/api\/versions\/([0-9a-f-]{36})\/restore-copy$/i);
  if (method === 'POST' && versionCopy) { sendJson(response, 201, { data: await services.files.restoreVersionAsCopy(versionCopy[1]) }); return; }
  const versionContent = pathname.match(/^\/api\/versions\/([0-9a-f-]{36})\/content$/i);
  if (method === 'GET' && versionContent) {
    const version = services.db.getVersion(versionContent[1]); if (!version) throw fail.notFound('Version not found.');
    await sendDiskFile(request, response, await storage.internalExisting(version.storedPath), false, version.mimeType ?? undefined, version.originalName); return;
  }
  const fileThumbnail = pathname.match(/^\/api\/files\/([0-9a-f-]{36})\/thumbnail$/i);
  if (method === 'GET' && fileThumbnail) {
    const thumbnail = await services.files.thumbnail(fileThumbnail[1]);
    if (!thumbnail) throw fail.notFound('No generated thumbnail is available.');
    await sendDiskFile(request, response, thumbnail, true, 'image/webp'); return;
  }
  const archive = pathname.match(/^\/api\/files\/([0-9a-f-]{36})\/archive$/i);
  if (method === 'GET' && archive) {
    const file = await services.files.getNode(archive[1]);
    services.db.addActivity('downloaded_archive', file.id, file.relativePath);
    await streamTar(response, await storage.pathFor(file.relativePath), file.name);
    return;
  }
  const fileContent = pathname.match(/^\/api\/files\/([0-9a-f-]{36})\/(download|content)$/i);
  if (method === 'GET' && fileContent) {
    const file = await services.files.getNode(fileContent[1]); if (file.isDirectory) throw fail.badRequest('Folders cannot be downloaded as a single file.');
    services.db.addActivity(fileContent[2] === 'download' ? 'downloaded' : 'previewed', file.id, file.relativePath);
    await sendDiskFile(request, response, await storage.pathFor(file.relativePath), fileContent[2] === 'content', file.mimeType ?? undefined, file.name); return;
  }
  const fileVersions = pathname.match(/^\/api\/files\/([0-9a-f-]{36})\/versions$/i);
  if (method === 'GET' && fileVersions) { const file = await services.files.getNode(fileVersions[1]); sendJson(response, 200, { data: services.db.listVersions(file.id) }); return; }
  const fileTags = pathname.match(/^\/api\/files\/([0-9a-f-]{36})\/tags$/i);
  if (fileTags && method === 'GET') { await services.files.getNode(fileTags[1]); sendJson(response, 200, { data: services.db.tagsForNode(fileTags[1]) }); return; }
  if (fileTags && method === 'PUT') { const body = await readJson(request); await services.files.getNode(fileTags[1]); const tags = Array.isArray(body.tags) ? body.tags.filter((value): value is string => typeof value === 'string') : []; sendJson(response, 200, { data: services.db.setNodeTags(fileTags[1], tags) }); return; }
  const file = pathname.match(/^\/api\/files\/([0-9a-f-]{36})$/i);
  if (file) {
    if (method === 'GET') { const item = await services.files.getNode(file[1]); sendJson(response, 200, { data: { ...item, previewable: isPreviewable(item.mimeType) } }); return; }
    if (method === 'DELETE') { const trashId = await services.files.trash(file[1]); sendJson(response, 200, { data: { trashed: true, trashId } }); return; }
    if (method === 'PATCH') {
      const body = await readJson(request); const action = body.action;
      let item;
      if (action === 'rename') item = await services.files.rename(file[1], body.name);
      else if (action === 'move') item = await services.files.move(file[1], body.parentPath);
      else if (action === 'copy') item = await services.files.copy(file[1], body.parentPath);
      else if (action === 'favorite') { item = services.db.setFavorite(file[1], body.favorite === true); if (!item) throw fail.notFound(); services.db.addActivity(item.favorite ? 'favorited' : 'unfavorited', item.id, item.relativePath); services.db.addChange(item.favorite ? 'favorited' : 'unfavorited', item.id, item.relativePath); }
      else throw fail.badRequest('Unsupported file action.');
      sendJson(response, 200, { data: item }); return;
    }
  }
  throw fail.notFound('API endpoint not found.');
}

function authorize(request: IncomingMessage, config: CloudConfig, pathname: string, method: string): void {
  if (config.authDisabled) return;
  const supplied = typeof request.headers['x-continental-token'] === 'string' ? request.headers['x-continental-token'] : readCookie(request, 'cc_session');
  if (typeof supplied !== 'string' || !config.authToken) throw fail.unauthorized();
  const a = Buffer.from(supplied); const b = Buffer.from(config.authToken);
  if (a.length === b.length && timingSafeEqual(a, b)) return;
  const deviceId = deviceIdFromToken(supplied, config.authToken);
  const suppliedDevice = request.headers['x-continental-device'];
  if (deviceId && typeof suppliedDevice === 'string' && suppliedDevice === deviceId && isDeviceApiPath(pathname, method)) return;
  throw fail.unauthorized();
}
function isDeviceApiPath(pathname: string, method: string): boolean {
  if (!pathname.startsWith('/api/sync/')) return false;
  if (pathname === '/api/sync/devices') return method === 'POST';
  if (pathname.startsWith('/api/sync/pairing') || pathname.startsWith('/api/sync/devices') || pathname.startsWith('/api/sync/installer')) return false;
  return /^\/api\/sync\/(?:state|mappings|changes|snapshot|ack|folders|mutations|uploads|files|events)(?:\/|$)/.test(pathname);
}
function createDeviceToken(deviceId: string, secret: string): string {
  const payload = Buffer.from(deviceId).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `cc_device_${payload}.${signature}`;
}
function deviceIdFromToken(token: string, secret: string): string | undefined {
  if (!token.startsWith('cc_device_')) return undefined;
  const [payload, suppliedSignature] = token.slice('cc_device_'.length).split('.');
  if (!payload || !suppliedSignature) return undefined;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'));
  const actual = Buffer.from(suppliedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  const deviceId = Buffer.from(payload, 'base64url').toString('utf8');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId) ? deviceId : undefined;
}
function requiredSyncDevice(request: IncomingMessage): string {
  const value = request.headers['x-continental-device'];
  if (typeof value !== 'string') throw fail.badRequest('Sync requests require X-Continental-Device.');
  return value;
}
function contentLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length'];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : undefined;
}
async function streamSyncEvents(request: IncomingMessage, response: ServerResponse, notifier: SyncNotifier): Promise<void> {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.write('event: ready\ndata: {}\n\n');
  await new Promise<void>((resolve) => {
    const unsubscribe = notifier.onChange((change) => response.write(`event: change\ndata: ${JSON.stringify({ sequence: change.sequence })}\n\n`));
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25_000);
    const close = () => { clearInterval(heartbeat); unsubscribe(); resolve(); };
    request.once('close', close); response.once('close', close);
  });
}
function readCookie(request: IncomingMessage, key: string): string | undefined {
  const value = request.headers.cookie; if (!value) return undefined;
  const encoded = value.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  try { return encoded ? decodeURIComponent(encoded) : undefined; } catch { return undefined; }
}
function assertMutationOrigin(request: IncomingMessage, config: CloudConfig): void {
  const origin = request.headers.origin;
  if (!origin) return; // native clients do not send Origin; pairing claims use their one-time code instead.
  if (config.allowedOrigin && origin !== config.allowedOrigin) throw fail.forbidden('Request origin is not allowed.');
  if (!config.allowedOrigin) {
    const parsed = new URL(origin); const host = request.headers.host?.toLowerCase();
    if (parsed.host.toLowerCase() !== host) throw fail.forbidden('Cross-origin mutation was blocked.');
  }
}
function corsHeaders(request: IncomingMessage, config: CloudConfig): Record<string, string> {
  const origin = request.headers.origin;
  // The browser UI is same-origin. Only an explicitly configured trusted origin
  // receives CORS permission; never reflect arbitrary origins around private data.
  return origin && config.allowedOrigin === origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, X-Continental-Token, X-Continental-Device', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' } : {};
}
function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'");
  response.setHeader('Cache-Control', 'no-store');
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) throw fail.badRequest('Expected application/json.');
  let total = 0; const parts: Buffer[] = [];
  for await (const chunk of request) { total += chunk.length; if (total > JSON_LIMIT) throw fail.tooLarge('JSON request is too large.'); parts.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; } catch { throw fail.badRequest('Invalid JSON request.'); }
}
function sendJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); }
function sendInstaller(response: ServerResponse, installer: { filename: string; contentType: string; body: string | Buffer }): void {
  response.writeHead(200, { 'Content-Type': installer.contentType, 'Content-Disposition': `attachment; filename="${installer.filename}"`, 'Content-Length': Buffer.isBuffer(installer.body) ? installer.body.length : Buffer.byteLength(installer.body), 'Cache-Control': 'no-store' });
  response.end(installer.body);
}
async function sendDiskFile(request: IncomingMessage, response: ServerResponse, path: string, inline: boolean, mimeType?: string, filename?: string): Promise<void> {
  const info = await stat(path); if (!info.isFile()) throw fail.notFound();
  const range = request.headers.range; let start = 0; let end = info.size - 1; let status = 200;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/); if (!match) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    start = match[1] ? Number(match[1]) : 0; end = match[2] ? Number(match[2]) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    status = 206;
  }
  // User-provided HTML, XML, and SVG must never execute in the Cloud origin.
  // Text previews fetch these bytes explicitly; downloads retain their original file.
  const unsafeInlineType = ['text/html; charset=utf-8', 'application/xml; charset=utf-8', 'image/svg+xml'].includes(mimeType ?? '');
  const deliveredType = inline && unsafeInlineType ? 'text/plain; charset=utf-8' : (mimeType ?? 'application/octet-stream');
  const headers: Record<string, string | number> = { 'Content-Type': deliveredType, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  if (filename) headers['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`;
  response.writeHead(status, headers); if (request.method === 'HEAD') { response.end(); return; }
  await new Promise<void>((resolve, reject) => { const source = createReadStream(path, { start, end }); source.on('error', reject); response.on('error', reject); response.on('finish', resolve); source.pipe(response); });
}
async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const root = join(import.meta.dirname, '..', 'public');
  const path = pathname === '/' ? join(root, 'index.html') : pathname === '/client/app.js' ? join(import.meta.dirname, '..', 'client', 'app.js') : join(root, pathname);
  if (!path.startsWith(root) && pathname !== '/client/app.js') throw fail.notFound();
  try { const info = await lstat(path); if (!info.isFile()) throw fail.notFound(); } catch (error: unknown) { if (error instanceof CloudError) throw error; throw fail.notFound(); }
  response.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
  createReadStream(path).pipe(response);
}
function publicOrigin(request: IncomingMessage): string {
  const forwardedProtocol = firstForwardedValue(request.headers['x-forwarded-proto']);
  const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
  const host = firstForwardedValue(request.headers['x-forwarded-host']) ?? request.headers.host ?? 'localhost';
  return `${protocol}://${host}`;
}
function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',')[0]?.trim() || undefined;
}
