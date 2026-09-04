import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, readdirSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform as hostPlatform } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep, win32 as windowsPath } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ChangeEvent, FileNode, SyncMapping, SyncPairingClaim, SyncPolicy, SyncProgress, UploadSession } from '../shared/types.js';
import { defaultSyncPolicy, normalizeSyncPolicy, syncPathExcluded } from '../shared/sync-policy.js';

export const SYNC_CLIENT_VERSION = '0.1.0';
const CONFIG_NAME = 'config.json';
const PART_SUFFIX = '.continental-cloud-download.part';
const RENAME_SUFFIX = '.continental-cloud-rename.part';

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_NAME = /[<>:"\\|?*\u0000-\u001f]/;

export interface LocalEntry {
  nodeId?: string;
  revision?: number;
  checksum?: string | null;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  ino: number;
  dev: number;
}
export interface PendingOperation {
  id: string;
  kind: 'upload' | 'folder' | 'delete' | 'relocate';
  path: string;
  nodeId?: string;
  baseRevision?: number;
  uploadId?: string;
  createdAt: string;
  error?: string;
}
export interface LocalMapping {
  id: string;
  cloudPath: string;
  localPath: string;
  rootRealPath: string;
  rootDev: number;
  rootIno?: number;
  policy: SyncPolicy;
  paused: boolean;
  initialized: boolean;
  cursor: number;
  entries: Record<string, LocalEntry>;
  pending: PendingOperation[];
  status: 'idle' | 'syncing' | 'paused' | 'offline' | 'error';
  lastError?: string;
  lastSyncAt?: string;
  lastReconcileAt?: string;
  transfer?: { direction: 'upload' | 'download'; path: string; completed: number; total: number };
  progress: SyncProgress | null;
  conflicts: Array<{ path: string; at: string; detail: string }>;
}
export interface SyncClientConfig {
  schemaVersion: 1;
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  clientVersion: string;
  mappings: LocalMapping[];
}

export class SyncApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = 'SyncApiError'; }
}

class SyncApi {
  constructor(private readonly config: SyncClientConfig) {}
  async json<T>(path: string, method = 'GET', body?: unknown, extra: HeadersInit = {}): Promise<T> {
    const headers = new Headers(extra);
    headers.set('X-Continental-Token', this.config.token); headers.set('X-Continental-Device', this.config.deviceId);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetch(`${this.config.serverUrl.replace(/\/$/, '')}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (error) { throw new SyncApiError(error instanceof Error ? error.message : 'Network request failed.'); }
    const payload = await response.json().catch(() => undefined) as { data?: T; error?: { message?: string; code?: string } } | undefined;
    if (!response.ok) throw new SyncApiError(payload?.error?.message ?? `Server returned HTTP ${response.status}.`, response.status, payload?.error?.code);
    return payload?.data as T;
  }
  async bytes(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers); headers.set('X-Continental-Token', this.config.token); headers.set('X-Continental-Device', this.config.deviceId);
    let response: Response;
    try { response = await fetch(`${this.config.serverUrl.replace(/\/$/, '')}/api${path}`, { ...init, headers }); }
    catch (error) { throw new SyncApiError(error instanceof Error ? error.message : 'Network request failed.'); }
    if (!response.ok) { const payload = await response.json().catch(() => undefined) as any; throw new SyncApiError(payload?.error?.message ?? `Server returned HTTP ${response.status}.`, response.status, payload?.error?.code); }
    return response;
  }
}

export function defaultSyncHome(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  const pathJoin = platform === 'win32' ? windowsPath.join : join; const pathResolve = platform === 'win32' ? windowsPath.resolve : resolve;
  if (environment.CONTINENTAL_CLOUD_SYNC_HOME) return pathResolve(environment.CONTINENTAL_CLOUD_SYNC_HOME);
  if (platform === 'win32') {
    const localAppData = nonEmpty(environment.LOCALAPPDATA) ?? nonEmpty(environment.APPDATA) ?? pathJoin(userHome, 'AppData', 'Local');
    return pathJoin(localAppData, 'Continental Cloud Sync');
  }
  if (platform === 'darwin') return pathJoin(userHome, 'Library', 'Application Support', 'Continental Cloud Sync');
  return pathJoin(nonEmpty(environment.XDG_CONFIG_HOME) ?? pathJoin(userHome, '.config'), 'continental-cloud-sync');
}
export function syncWatcherMode(platform: NodeJS.Platform = process.platform): 'recursive' | 'directories' { return platform === 'darwin' || platform === 'win32' ? 'recursive' : 'directories'; }
export function configPath(home = defaultSyncHome()): string { return join(home, CONFIG_NAME); }
export async function loadSyncConfig(path = configPath()): Promise<SyncClientConfig> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as SyncClientConfig;
  if (raw.schemaVersion !== 1 || !raw.deviceId || !raw.serverUrl || !Array.isArray(raw.mappings)) throw new Error('Sync configuration is invalid. Run cloud-sync init again.');
  return { ...raw, mappings: raw.mappings.map((mapping) => ({ ...mapping, policy: normalizeSyncPolicy(mapping.policy), progress: mapping.progress ?? null })) };
}
export async function saveSyncConfig(config: SyncClientConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path); try { await chmod(path, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
}
export function freshConfig(serverUrl: string, token: string, deviceName: string, platform: NodeJS.Platform = process.platform, architecture = process.arch): SyncClientConfig {
  const parsed = new URL(serverUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Server URL must use http or https.');
  if (!token || token.length < 12) throw new Error('A Continental Cloud token is required.');
  return { schemaVersion: 1, serverUrl: parsed.toString().replace(/\/$/, ''), token, deviceId: randomUUID(), deviceName: limited(deviceName || platform || hostPlatform(), 120), platform: `${platform}-${architecture}`, clientVersion: SYNC_CLIENT_VERSION, mappings: [] };
}

export class SyncDaemon {
  private readonly api: SyncApi;
  private readonly watchers = new Map<string, FSWatcher[]>();
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private running = false;
  private syncQueue: Promise<void> = Promise.resolve();
  private watcherDirty = false;
  private notificationTimer?: NodeJS.Timeout;
  private notificationAbort?: AbortController;
  private configDirty = false;
  private configPath: string;

  constructor(readonly config: SyncClientConfig, path = configPath()) { this.api = new SyncApi(config); this.configPath = path; }

  async register(preserveLocalMappingState = false): Promise<Set<string>> {
    const reconfigured = new Set<string>();
    await this.api.json('/sync/devices', 'POST', { deviceId: this.config.deviceId, name: this.config.deviceName, platform: this.config.platform, clientVersion: this.config.clientVersion });
    const remoteMappings = await this.api.json<SyncMapping[]>('/sync/mappings');
    // The web console can add a mapping or pause one while the daemon is not
    // running. Pull that state before publishing our local copy so the two
    // ways of managing sync stay in agreement.
    for (const remote of remoteMappings) {
      const local = this.config.mappings.find((mapping) => mapping.id === remote.id || mapping.cloudPath === remote.cloudPath);
      if (!local) {
        const adopted = await createMapping(this.config, remote.cloudPath, expandHome(remote.localPath), remote.id, remote.policy);
        adopted.paused = remote.paused;
      }
    }
    for (const mapping of this.config.mappings) {
      const remote = remoteMappings.find((item) => item.id === mapping.id || item.cloudPath === mapping.cloudPath);
      if (remote) {
        if (mapping.id !== remote.id) mapping.id = remote.id;
        if (!preserveLocalMappingState) mapping.paused = remote.paused;
        if (!sameLocalPath(resolve(expandHome(remote.localPath)), mapping.localPath) || remote.cloudPath !== mapping.cloudPath) { await this.adoptRemoteMapping(mapping, remote); reconfigured.add(mapping.id); }
        mapping.policy = normalizeSyncPolicy(remote.policy);
      }
      await this.api.json('/sync/mappings', 'POST', { id: mapping.id, cloudPath: mapping.cloudPath, localPath: mapping.localPath, paused: mapping.paused, policy: mapping.policy });
    }
    return reconfigured;
  }
  async syncNow(mappingId?: string, scan = true): Promise<void> {
    const previous = this.syncQueue;
    const run = previous.then(() => this.syncNowInternal(mappingId, scan), () => this.syncNowInternal(mappingId, scan));
    this.syncQueue = run.then(() => undefined, () => undefined);
    return run;
  }
  private async syncNowInternal(mappingId?: string, scan = true): Promise<void> {
    // Local observation is deliberately durable even while the server is down.
    // It never deletes anything and lets edits made offline survive restarts.
    const preScanned = new Set<string>();
    if (scan) for (const mapping of this.matchMappings(mappingId)) if (!mapping.paused && mapping.initialized) {
      try { await this.assertRoot(mapping); await this.scanLocal(mapping); preScanned.add(mapping.id); } catch (error) { this.setError(mapping, error); }
    }
    let reconfigured = new Set<string>();
    try { reconfigured = await this.register(); }
    catch (error) { for (const mapping of this.matchMappings(mappingId)) this.setError(mapping, error); await this.persist(); throw error; }
    for (const mapping of this.matchMappings(mappingId)) await this.syncMapping(mapping, scan && (!preScanned.has(mapping.id) || reconfigured.has(mapping.id)), preScanned.has(mapping.id));
    await this.persist();
  }
  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Attach watchers before the initial snapshot so edits made while the
    // first network round-trip is in progress are not lost between scans.
    this.refreshWatchers();
    await this.syncNow(undefined, true).catch(() => undefined);
    if (signal?.aborted) { this.running = false; this.closeWatchers(); await this.persist(); return; }
    this.refreshWatchers();
    void this.listenForChanges();
    const remoteTimer = setInterval(() => { const scan = this.watcherDirty; void this.syncNow(undefined, scan).then(() => { if (this.watcherDirty) this.refreshWatchers(); }).catch(() => undefined); }, 20_000);
    const reconciliationTimer = setInterval(() => { void this.syncNow(undefined, true).catch(() => undefined); }, 10 * 60_000);
    await new Promise<void>((resolve) => {
      const stop = () => { clearInterval(remoteTimer); clearInterval(reconciliationTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop); if (process.platform === 'win32') process.off('SIGBREAK', stop); signal?.removeEventListener('abort', stop); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop); if (process.platform === 'win32') process.once('SIGBREAK', stop);
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    });
    this.running = false; this.notificationAbort?.abort(); if (this.notificationTimer) clearTimeout(this.notificationTimer); this.closeWatchers(); await this.persist();
  }
  async pause(mappingId: string, paused: boolean): Promise<void> {
    await this.syncQueue;
    const mapping = this.mapping(mappingId); mapping.paused = paused; mapping.status = paused ? 'paused' : 'idle'; this.configDirty = true;
    try { await this.register(true); await this.api.json(`/sync/mappings/${mapping.id}`, 'PATCH', { paused }); } catch (error) { this.setError(mapping, error); }
    await this.persist(); this.refreshWatchers();
  }
  status(): Array<Pick<LocalMapping, 'id' | 'cloudPath' | 'localPath' | 'policy' | 'paused' | 'status' | 'lastError' | 'lastSyncAt' | 'pending' | 'conflicts' | 'transfer' | 'progress'>> {
    return this.config.mappings.map(({ id, cloudPath, localPath, policy, paused, status, lastError, lastSyncAt, pending, conflicts, transfer, progress }) => ({ id, cloudPath, localPath, policy, paused, status, lastError, lastSyncAt, pending, conflicts, transfer, progress }));
  }

  private async syncMapping(mapping: LocalMapping, scan: boolean, reconciled = false): Promise<void> {
    if (mapping.paused) { mapping.status = 'paused'; return; }
    const initial = !mapping.initialized;
    mapping.status = 'syncing'; mapping.lastError = undefined; this.configDirty = true;
    mapping.progress = startProgress(initial);
    try {
      await this.assertRoot(mapping);
      if (!mapping.initialized) await this.bootstrap(mapping);
      if (scan) await this.scanLocal(mapping);
      const pendingChanges = await this.collectChanges(mapping);
      // Uploads are sent after their remote journal window is known but before it
      // is applied. A stale base revision therefore turns into a conflict copy.
      await this.flushPending(mapping);
      await this.applyChanges(mapping, pendingChanges);
      mapping.status = 'idle'; mapping.transfer = undefined; mapping.lastSyncAt = new Date().toISOString(); mapping.lastReconcileAt = scan || reconciled ? mapping.lastSyncAt : mapping.lastReconcileAt;
      mapping.progress = finishProgress(mapping.progress);
      await this.ack(mapping);
    } catch (error) { this.setError(mapping, error); try { await this.ack(mapping); } catch { /* preserve the local error when the server is unavailable */ } }
    finally { this.configDirty = true; }
  }

  private async bootstrap(mapping: LocalMapping): Promise<void> {
    const snapshot = await this.api.json<{ cursor: number; nodes: FileNode[] }>(`/sync/snapshot?path=${encodeURIComponent(mapping.cloudPath)}`);
    const included = snapshot.nodes.filter((node) => {
      const path = cloudRelative(mapping, node.relativePath); return path !== undefined && path !== '' && !syncPathExcluded(path, mapping.policy);
    });
    mapping.progress = mergeProgress(mapping.progress, { phase: 'syncing', filesTotal: Math.max(mapping.progress?.filesTotal ?? 0, included.filter((node) => !node.isDirectory).length), foldersTotal: Math.max(mapping.progress?.foldersTotal ?? 0, included.filter((node) => node.isDirectory).length) });
    for (const node of snapshot.nodes) {
      const path = cloudRelative(mapping, node.relativePath); if (path === undefined || path === '') continue;
      if (syncPathExcluded(path, mapping.policy)) continue;
      await this.applyNode(mapping, node, path, true);
    }
    mapping.cursor = snapshot.cursor; mapping.initialized = true; this.configDirty = true;
    await this.ack(mapping);
  }
  private async collectChanges(mapping: LocalMapping): Promise<ChangeEvent[]> {
    const changes: ChangeEvent[] = [];
    let cursor = mapping.cursor;
    for (;;) {
      const page = await this.api.json<{ changes: ChangeEvent[]; nextCursor: number; hasMore: boolean }>(`/sync/changes?after=${cursor}&limit=500`);
      changes.push(...page.changes); cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    return changes;
  }
  private async applyChanges(mapping: LocalMapping, changes: ChangeEvent[]): Promise<void> {
    for (const change of changes) {
      const relevant = cloudRelative(mapping, change.path) !== undefined || cloudRelative(mapping, change.previousPath) !== undefined;
      if (relevant && change.deviceId !== this.config.deviceId) await this.applyChange(mapping, change);
      mapping.cursor = change.sequence; this.configDirty = true;
    }
    if (changes.length) await this.ack(mapping);
  }
  private async ack(mapping: LocalMapping): Promise<void> { await this.api.json('/sync/ack', 'POST', { mappingId: mapping.id, cursor: mapping.cursor, status: mapping.status, error: mapping.lastError ?? null, progress: mapping.progress }); }

  private async applyChange(mapping: LocalMapping, change: ChangeEvent): Promise<void> {
    const path = cloudRelative(mapping, change.path); const previous = cloudRelative(mapping, change.previousPath);
    if (change.operation === 'delete' || change.operation === 'folder_delete') {
      const target = this.findPathByNode(mapping, change.nodeId) ?? path ?? previous;
      if (target === '') await this.removeRemoteRoot(mapping);
      else if (target !== undefined) await this.removeRemoteLocal(mapping, target, change.nodeId);
      return;
    }
    if (path !== undefined && syncPathExcluded(path, mapping.policy)) {
      if (previous && !syncPathExcluded(previous, mapping.policy)) await this.removeRemoteLocal(mapping, previous, change.nodeId);
      return;
    }
    if (!change.nodeId) return;
    let node: FileNode;
    try { node = await this.api.json<FileNode>(`/sync/files/${change.nodeId}`); }
    catch (error) {
      // A later delete can make an earlier modify in this same journal window
      // unreadable. The following delete remains authoritative, so do not stall.
      if (error instanceof SyncApiError && error.status === 404) return;
      throw error;
    }
    const localPath = cloudRelative(mapping, node.relativePath);
    if (localPath === undefined || localPath === '') {
      if (previous) await this.removeRemoteLocal(mapping, previous, node.id);
      return;
    }
    await this.applyNode(mapping, node, localPath, false, previous);
  }
  private async applyNode(mapping: LocalMapping, node: FileNode, target: string, bootstrap: boolean, previous?: string): Promise<void> {
    if (syncPathExcluded(target, mapping.policy)) return;
    const caseCollision = Object.keys(mapping.entries).find((path) => path !== target && comparableSyncPath(path) === comparableSyncPath(target));
    if (caseCollision) throw new Error(`Remote path ${target} collides with ${caseCollision} on this device; no files were changed.`);
    const trackedPath = this.findPathByNode(mapping, node.id);
    const oldPath = trackedPath ?? previous;
    if (oldPath && oldPath !== target && mapping.entries[oldPath]) await this.relocateLocal(mapping, oldPath, target, node.isDirectory);
    if (node.isDirectory) {
      await this.ensureDirectory(mapping, target); this.setEntry(mapping, target, node, await localEntry(await this.safePath(mapping, target)));
      if (oldPath && oldPath !== target) this.rewritePrefix(mapping, oldPath, target); return;
    }
    const destination = await this.safePath(mapping, target);
    const current = mapping.entries[target] ?? (oldPath ? mapping.entries[oldPath] : undefined);
    if (current && await this.isDirty(mapping, oldPath ?? target, current)) {
      await this.preserveLocal(mapping, oldPath ?? target, 'Remote update arrived while local content was pending.');
    } else if (!current && existsSync(destination)) {
      await this.preserveUntracked(mapping, target, 'A pre-existing local file was preserved before download.');
    }
    const afterPreserve = mapping.entries[target];
    if (!afterPreserve || afterPreserve.nodeId !== node.id || afterPreserve.revision !== node.revision || afterPreserve.checksum !== node.checksum) await this.download(mapping, node, target);
    this.setEntry(mapping, target, node, await localEntry(destination));
    if (oldPath && oldPath !== target) delete mapping.entries[oldPath];
    if (!bootstrap) this.configDirty = true;
  }

  private async scanLocal(mapping: LocalMapping): Promise<void> {
    const walked = await walkLocal(mapping.localPath, mapping.policy);
    const actual = walked.entries;
    const known = mapping.entries;
    for (const path of Object.keys(known)) if (syncPathExcluded(path, mapping.policy)) delete known[path];
    mapping.progress = mergeProgress(mapping.progress, {
      phase: 'scanning',
      filesTotal: [...actual.values()].filter((entry) => !entry.isDirectory).length,
      foldersTotal: [...actual.values()].filter((entry) => entry.isDirectory).length,
      bytesTotal: [...actual.values()].filter((entry) => !entry.isDirectory).reduce((total, entry) => total + entry.size, 0),
      excludedFiles: walked.excludedFiles,
      excludedFolders: walked.excludedFolders,
      excludedBytes: walked.excludedBytes,
    });
    const missing = Object.entries(known).filter(([path]) => !actual.has(path));
    const added = [...actual.entries()].filter(([path]) => !known[path]);
    const consumed = new Set<string>();
    const relocatedOldFolders: string[] = []; const relocatedNewFolders: string[] = [];
    for (const [oldPath, old] of missing) {
      if (relocatedOldFolders.some((folder) => oldPath.startsWith(`${folder}/`))) continue;
      let match = added.find(([newPath, entry]) => !consumed.has(newPath) && sameLocalIdentity(old, entry));
      // Some Windows filesystems and network shares report zero for file
      // identity fields. An unchanged file can still be matched safely by
      // its already-known cloud checksum, but only when the match is unique.
      if (!match && !old.isDirectory && old.checksum && (!hasStableLocalIdentity(old) || added.some(([, entry]) => !hasStableLocalIdentity(entry)))) {
        let checksumMatch: [string, LocalEntry] | undefined; let ambiguous = false;
        for (const candidate of added) {
          const [newPath, entry] = candidate;
          if (consumed.has(newPath) || entry.isDirectory || entry.size !== old.size || (hasStableLocalIdentity(old) && hasStableLocalIdentity(entry))) continue;
          if (await this.hasChecksum(mapping, newPath, old.checksum)) { if (checksumMatch) { ambiguous = true; break; } checksumMatch = candidate; }
        }
        if (!ambiguous) match = checksumMatch;
      }
      if (match && old.nodeId) { this.enqueue(mapping, { kind: 'relocate', path: match[0], nodeId: old.nodeId, baseRevision: old.revision }); consumed.add(match[0]); if (old.isDirectory) { relocatedOldFolders.push(oldPath); relocatedNewFolders.push(match[0]); } continue; }
      if (old.nodeId) this.enqueue(mapping, { kind: 'delete', path: oldPath, nodeId: old.nodeId, baseRevision: old.revision });
    }
    for (const [path, entry] of added) {
      if (consumed.has(path) || relocatedNewFolders.some((folder) => path.startsWith(`${folder}/`))) continue;
      this.enqueue(mapping, { kind: entry.isDirectory ? 'folder' : 'upload', path });
    }
    for (const [path, entry] of actual) {
      const prior = known[path];
      if (!prior || prior.isDirectory) continue;
      if (prior.size !== entry.size || prior.mtimeMs !== entry.mtimeMs || prior.ino !== entry.ino || prior.dev !== entry.dev) this.enqueue(mapping, { kind: 'upload', path, nodeId: prior.nodeId, baseRevision: prior.revision });
    }
    this.configDirty = true;
  }
  private enqueue(mapping: LocalMapping, data: Omit<PendingOperation, 'id' | 'createdAt'>): void {
    const existing = mapping.pending.find((item) => item.kind === data.kind && item.path === data.path && item.nodeId === data.nodeId);
    if (!existing) mapping.pending.push({ id: randomUUID(), createdAt: new Date().toISOString(), ...data });
  }
  private async flushPending(mapping: LocalMapping): Promise<void> {
    const priority: Record<PendingOperation['kind'], number> = { folder: 0, relocate: 1, upload: 2, delete: 3 };
    for (const operation of [...mapping.pending].sort((a, b) => priority[a.kind] - priority[b.kind])) {
      try {
        if (operation.kind === 'upload') await this.upload(mapping, operation);
        else if (operation.kind === 'folder') await this.createFolder(mapping, operation);
        else if (operation.kind === 'delete') await this.mutate(mapping, operation, 'delete');
        else await this.relocate(mapping, operation);
        mapping.pending = mapping.pending.filter((entry) => entry.id !== operation.id); mapping.transfer = undefined; this.configDirty = true;
      } catch (error) {
        operation.error = error instanceof Error ? error.message : 'Unknown sync error.';
        if (error instanceof SyncApiError && !error.status) throw error;
        if (error instanceof SyncApiError && error.status && error.status >= 500) throw error;
        // A revision conflict is surfaced and the authoritative change journal is
        // allowed to repair the local view on the next pull instead of retrying a delete.
        if (error instanceof SyncApiError && error.status === 409 && operation.kind !== 'upload') mapping.pending = mapping.pending.filter((entry) => entry.id !== operation.id);
      }
    }
  }
  private async upload(mapping: LocalMapping, operation: PendingOperation): Promise<void> {
    const full = await this.safePath(mapping, operation.path); const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Cannot sync non-regular file: ${operation.path}`);
    const parent = cloudParent(mapping, operation.path); const name = basename(operation.path);
    const key = operation.id;
    const session = await this.api.json<UploadSession>('/sync/uploads', 'POST', { parentPath: parent, name, size: info.size, mimeType: mimeFor(name), nodeId: operation.nodeId, baseRevision: operation.baseRevision, idempotencyKey: key });
    operation.uploadId = session.id; this.configDirty = true;
    mapping.transfer = { direction: 'upload', path: operation.path, completed: session.receivedChunks.length * session.chunkSize, total: info.size }; this.reportTransfer(mapping);
    for (let index = 0; index < session.chunkCount; index++) {
      if (session.receivedChunks.includes(index)) continue;
      const start = index * session.chunkSize; const length = Math.min(session.chunkSize, info.size - start);
      const data = await readChunk(full, start, length);
      await this.api.bytes(`/sync/uploads/${session.id}/chunks/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength) }, body: data as unknown as BodyInit });
      mapping.transfer = { direction: 'upload', path: operation.path, completed: Math.min(info.size, (index + 1) * session.chunkSize), total: info.size }; this.reportTransfer(mapping);
    }
    const result = await this.api.json<{ node: FileNode; conflict: boolean; conflictPath?: string }>(`/sync/uploads/${session.id}/complete`, 'POST', {});
    if (result.conflict && result.conflictPath) {
      const conflictLocal = cloudRelative(mapping, result.conflictPath);
      if (!conflictLocal) throw new Error('Server conflict path is outside this mapping.');
      await this.relocateLocal(mapping, operation.path, conflictLocal, false);
      this.setEntry(mapping, conflictLocal, result.node, await localEntry(await this.safePath(mapping, conflictLocal)));
      mapping.conflicts.unshift({ path: conflictLocal, at: new Date().toISOString(), detail: 'Both versions were kept because another device changed the same file.' });
      mapping.conflicts.splice(50);
    } else this.setEntry(mapping, operation.path, result.node, await localEntry(full));
    mapping.progress = mergeProgress(mapping.progress, { phase: 'syncing', filesDone: (mapping.progress?.filesDone ?? 0) + 1, bytesDone: (mapping.progress?.bytesDone ?? 0) + info.size });
  }
  private async createFolder(mapping: LocalMapping, operation: PendingOperation): Promise<void> {
    const node = await this.api.json<FileNode>('/sync/folders', 'POST', { parentPath: cloudParent(mapping, operation.path), name: basename(operation.path) });
    this.setEntry(mapping, operation.path, node, await localEntry(await this.safePath(mapping, operation.path)));
    mapping.progress = mergeProgress(mapping.progress, { phase: 'syncing', foldersDone: (mapping.progress?.foldersDone ?? 0) + 1 });
  }
  private async mutate(mapping: LocalMapping, operation: PendingOperation, operationName: 'delete'): Promise<void> {
    await this.api.json('/sync/mutations', 'POST', { operation: operationName, nodeId: operation.nodeId, baseRevision: operation.baseRevision });
    delete mapping.entries[operation.path];
  }
  private async relocate(mapping: LocalMapping, operation: PendingOperation): Promise<void> {
    const targetPath = cloudJoin(mapping, operation.path);
    const node = await this.api.json<FileNode>('/sync/mutations', 'POST', { operation: 'relocate', nodeId: operation.nodeId, baseRevision: operation.baseRevision, targetPath });
    const previous = this.findPathByNode(mapping, node.id); const entry = await localEntry(await this.safePath(mapping, operation.path));
    if (previous && previous !== operation.path) { if (entry.isDirectory) this.rewritePrefix(mapping, previous, operation.path); else delete mapping.entries[previous]; }
    this.setEntry(mapping, operation.path, node, entry);
  }

  private async download(mapping: LocalMapping, node: FileNode, path: string): Promise<void> {
    const destination = await this.safePath(mapping, path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await this.assertSafeParent(mapping, dirname(destination));
    const temporary = join(dirname(destination), `.${basename(destination)}${PART_SUFFIX}`);
    let offset = 0; try { const info = await stat(temporary); offset = info.isFile() ? info.size : 0; } catch { /* no interrupted transfer */ }
    const headers: Record<string, string> = offset ? { Range: `bytes=${offset}-` } : {};
    const response = await this.api.bytes(`/sync/files/${node.id}/download`, { headers });
    if (offset && response.status !== 206) { await rm(temporary, { force: true }); return this.download(mapping, node, path); }
    if (!response.body) throw new Error('Download response had no body.');
    mapping.transfer = { direction: 'download', path, completed: offset, total: node.size }; this.reportTransfer(mapping);
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(temporary, { flags: offset ? 'a' : 'w', mode: 0o600 }));
    mapping.transfer = { direction: 'download', path, completed: node.size, total: node.size }; this.reportTransfer(mapping);
    if (node.checksum && await sha256(temporary) !== node.checksum) { await rm(temporary, { force: true }); throw new Error(`Downloaded checksum did not match for ${path}.`); }
    await rename(temporary, destination);
    mapping.progress = mergeProgress(mapping.progress, { phase: 'syncing', filesDone: (mapping.progress?.filesDone ?? 0) + 1, bytesDone: (mapping.progress?.bytesDone ?? 0) + node.size });
  }
  private async removeRemoteLocal(mapping: LocalMapping, path: string, nodeId: string | null): Promise<void> {
    const knownPath = mapping.entries[path] ? path : nodeId ? this.findPathByNode(mapping, nodeId) : undefined;
    const targetPath = knownPath ?? path; const entry = knownPath ? mapping.entries[knownPath] : undefined; const destination = await this.safePath(mapping, targetPath);
    if (entry && await this.isDirty(mapping, targetPath, entry)) await this.preserveLocal(mapping, targetPath, 'Remote deletion arrived while local content was pending.');
    else if (!entry && existsSync(destination)) await this.preserveUntracked(mapping, targetPath, 'A pre-existing local item was preserved before remote deletion.');
    await rm(destination, { recursive: true, force: true, maxRetries: 2 });
    for (const key of Object.keys(mapping.entries)) if (key === targetPath || key.startsWith(`${targetPath}/`) || (nodeId && mapping.entries[key].nodeId === nodeId)) delete mapping.entries[key];
  }
  private async removeRemoteRoot(mapping: LocalMapping): Promise<void> { for (const path of Object.keys(mapping.entries).filter((entry) => !entry.includes('/'))) await this.removeRemoteLocal(mapping, path, mapping.entries[path].nodeId ?? null); }
  private async preserveUntracked(mapping: LocalMapping, path: string, detail: string): Promise<void> { await this.preservePath(mapping, path, detail); }
  private async preserveLocal(mapping: LocalMapping, path: string, detail: string): Promise<void> { await this.preservePath(mapping, path, detail); delete mapping.entries[path]; }
  private async preservePath(mapping: LocalMapping, path: string, detail: string): Promise<void> {
    const candidate = await this.availableConflictPath(mapping, path);
    await this.relocateLocal(mapping, path, candidate, false); mapping.conflicts.unshift({ path: candidate, at: new Date().toISOString(), detail }); mapping.conflicts.splice(50);
  }
  private async availableConflictPath(mapping: LocalMapping, path: string): Promise<string> {
    const base = localConflictPath(path, this.config.deviceName); const extension = extname(base); const stem = extension ? base.slice(0, -extension.length) : base;
    for (let index = 1; index <= 1000; index++) {
      const candidate = index === 1 ? base : `${stem} (${index})${extension}`;
      if (Object.keys(mapping.entries).every((entry) => comparableSyncPath(entry) !== comparableSyncPath(candidate)) && !existsSync(await this.safePath(mapping, candidate))) return candidate;
    }
    throw new Error(`Unable to create a unique conflict copy for ${path}.`);
  }
  private async relocateLocal(mapping: LocalMapping, from: string, to: string, directory: boolean): Promise<void> {
    if (from === to) return;
    const source = await this.safePath(mapping, from); const sourceInfo = await lstat(source); if (sourceInfo.isSymbolicLink()) throw new Error(`Refusing to move a symlink from ${from}.`); const target = await this.safePath(mapping, to); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await this.assertSafeParent(mapping, dirname(target));
    let targetInfo: { dev: number | bigint; ino: number | bigint } | undefined;
    try { targetInfo = await lstat(target); } catch (error) { if (!isMissingPathError(error)) throw error; }
    const caseOnlyEntry = Boolean(targetInfo && isCaseInsensitivePlatform() && sameLocalPath(source, target) && (sameLocalObject(sourceInfo, targetInfo) || await sameRealPath(source, target)));
    if (targetInfo && !caseOnlyEntry) throw new Error(`Refusing to overwrite local ${directory ? 'folder' : 'file'} at ${to}.`);
    if (caseOnlyEntry && source !== target) {
      // Windows and the default macOS filesystem are normally
      // case-insensitive, so a direct rename from "Drafts" to "drafts" can
      // be interpreted as a move onto itself. A sibling hop makes the rename
      // deterministic while the identity check above protects case-sensitive
      // volumes from overwrites.
      const temporary = `${source}.${randomUUID()}${RENAME_SUFFIX}`;
      await rename(source, temporary);
      try { await rename(temporary, target); }
      catch (error) { await rename(temporary, source).catch(() => undefined); throw error; }
      return;
    }
    await rename(source, target);
  }
  private async ensureDirectory(mapping: LocalMapping, path: string): Promise<void> { const target = await this.safePath(mapping, path); await mkdir(target, { recursive: true, mode: 0o700 }); await this.assertSafeParent(mapping, target); if (this.running) this.watcherDirty = true; mapping.progress = mergeProgress(mapping.progress, { phase: 'syncing', foldersDone: (mapping.progress?.foldersDone ?? 0) + 1 }); }
  private async isDirty(mapping: LocalMapping, path: string, entry: LocalEntry): Promise<boolean> {
    try { const current = await localEntry(await this.safePath(mapping, path)); return current.size !== entry.size || current.mtimeMs !== entry.mtimeMs || current.ino !== entry.ino || current.dev !== entry.dev || current.isDirectory !== entry.isDirectory; } catch { return false; }
  }
  private async hasChecksum(mapping: LocalMapping, path: string, expected: string): Promise<boolean> { try { return await sha256(await this.safePath(mapping, path)) === expected; } catch { return false; } }
  private setEntry(mapping: LocalMapping, path: string, node: FileNode, local: LocalEntry): void { mapping.entries[path] = { ...local, nodeId: node.id, revision: node.revision, checksum: node.checksum }; }
  private findPathByNode(mapping: LocalMapping, nodeId: string | null): string | undefined { return nodeId ? Object.entries(mapping.entries).find(([, value]) => value.nodeId === nodeId)?.[0] : undefined; }
  private rewritePrefix(mapping: LocalMapping, from: string, to: string): void { for (const [path, entry] of Object.entries({ ...mapping.entries })) if (path === from || path.startsWith(`${from}/`)) { delete mapping.entries[path]; mapping.entries[`${to}${path.slice(from.length)}`] = entry; } }
  private async assertRoot(mapping: LocalMapping): Promise<void> {
    const info = await lstat(mapping.localPath); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Sync root is missing, not a real directory, or is a symlink. No local deletions were made.');
    const real = await realpath(mapping.localPath); if (!sameLocalPath(real, mapping.rootRealPath) || info.dev !== mapping.rootDev || (mapping.rootIno !== undefined && Number(info.ino) !== mapping.rootIno)) throw new Error('Sync root identity changed (possibly an unmounted disk). Sync is paused to protect local files.');
    if (mapping.rootIno === undefined) { mapping.rootIno = Number(info.ino); this.configDirty = true; }
  }
  private async adoptRemoteMapping(mapping: LocalMapping, remote: SyncMapping): Promise<void> {
    if (mapping.pending.length) throw new Error('Finish the pending changes in this folder before changing its local location.');
    const localPath = resolve(expandHome(remote.localPath));
    await mkdir(localPath, { recursive: true, mode: 0o700 });
    const info = await lstat(localPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`The selected local sync folder is not a real directory: ${localPath}`);
    mapping.localPath = localPath;
    mapping.rootRealPath = await realpath(localPath);
    mapping.rootDev = Number(info.dev);
    mapping.rootIno = Number(info.ino);
    mapping.cloudPath = remote.cloudPath;
    mapping.initialized = false;
    mapping.cursor = 0;
    mapping.entries = {};
    mapping.pending = [];
    mapping.transfer = undefined;
    mapping.lastError = undefined;
    this.configDirty = true;
  }
  private async safePath(mapping: LocalMapping, path: string): Promise<string> { validateRelative(path); const target = resolve(mapping.localPath, ...path.split('/').filter(Boolean)); if (!contained(mapping.localPath, target)) throw new Error('Remote path escapes the local sync root.'); return target; }
  private async assertSafeParent(mapping: LocalMapping, parent: string): Promise<void> { if (!contained(mapping.localPath, parent)) throw new Error('Local operation escapes sync root.'); const rel = relative(mapping.localPath, parent); let current = mapping.localPath; for (const segment of rel.split(sep).filter(Boolean)) { current = join(current, segment); const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Local sync path contains an unsafe parent: ${rel}`); } }
  private mapping(id: string): LocalMapping { const mapping = this.config.mappings.find((item) => item.id === id); if (!mapping) throw new Error('Sync mapping not found.'); return mapping; }
  private matchMappings(id?: string): LocalMapping[] { return id ? [this.mapping(id)] : this.config.mappings; }
  private setError(mapping: LocalMapping, error: unknown): void { mapping.status = error instanceof SyncApiError && !error.status ? 'offline' : 'error'; mapping.lastError = error instanceof Error ? error.message : 'Unknown sync error.'; mapping.progress = mergeProgress(mapping.progress, { phase: 'error' }); this.configDirty = true; }
  private reportTransfer(mapping: LocalMapping): void { const transfer = mapping.transfer; if (!transfer || !process.stdout.isTTY) return; const percent = transfer.total ? Math.min(100, Math.round((transfer.completed / transfer.total) * 100)) : 100; process.stdout.write(`\r${transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} ${transfer.path} ${percent}%   `); if (percent === 100) process.stdout.write('\n'); }
  private async persist(): Promise<void> { if (this.configDirty) { await saveSyncConfig(this.config, this.configPath); this.configDirty = false; } }
  private refreshWatchers(): void {
    this.closeWatchers(); this.watcherDirty = false; if (!this.running) return;
    for (const mapping of this.config.mappings) if (!mapping.paused) {
      const watchers: FSWatcher[] = []; const schedule = () => this.schedule(mapping.id); const onError = (error: Error) => { this.setError(mapping, error); this.watcherDirty = true; };
      const attach = (directory: string, recursive: boolean) => { const watcher = watch(directory, { recursive }, schedule); watcher.on('error', onError); watchers.push(watcher); };
      try {
        if (syncWatcherMode() === 'recursive') {
          try { attach(mapping.localPath, true); }
          catch { const directories = localDirectories(mapping.localPath, mapping.policy); if (!directories.length) throw new Error('Unable to watch the sync root. It may be missing or inaccessible.'); for (const directory of directories) attach(directory, false); }
        } else { const directories = localDirectories(mapping.localPath, mapping.policy); if (!directories.length) throw new Error('Unable to watch the sync root. It may be missing or inaccessible.'); for (const directory of directories) attach(directory, false); }
        this.watchers.set(mapping.id, watchers);
      } catch (error) {
        for (const watcher of watchers) watcher.close();
        this.setError(mapping, error); this.watcherDirty = true;
      }
    }
  }
  private schedule(mappingId: string): void { const current = this.scheduled.get(mappingId); if (current) clearTimeout(current); this.scheduled.set(mappingId, setTimeout(() => { this.scheduled.delete(mappingId); void this.syncNow(mappingId, true).then(() => this.refreshWatchers()).catch(() => undefined); }, 450)); }
  private async listenForChanges(): Promise<void> {
    while (this.running) {
      this.notificationAbort = new AbortController();
      try {
        const response = await this.api.bytes('/sync/events', { signal: this.notificationAbort.signal }); if (!response.body) throw new Error('Sync notification stream had no body.');
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done || !this.running) break;
          pending += decoder.decode(value, { stream: true }); let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) !== -1) { const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2); if (event.includes('event: change')) this.scheduleRemotePull(); }
        }
      } catch (error) { if (this.running && !isAbortError(error)) await delay(3_000); }
    }
  }
  private scheduleRemotePull(): void { if (this.notificationTimer) return; this.notificationTimer = setTimeout(() => { this.notificationTimer = undefined; const scan = this.watcherDirty; void this.syncNow(undefined, scan).then(() => { if (this.watcherDirty) this.refreshWatchers(); }).catch(() => undefined); }, 200); }
  private closeWatchers(): void { for (const watchers of this.watchers.values()) for (const watcher of watchers) watcher.close(); this.watchers.clear(); for (const timer of this.scheduled.values()) clearTimeout(timer); this.scheduled.clear(); }
}

export async function createMapping(config: SyncClientConfig, cloudPath: string, localPath: string, id: string = randomUUID(), policy: unknown = defaultSyncPolicy()): Promise<LocalMapping> {
  cloudPath = cloudPath.replace(/^\/+|\/+$/g, ''); validateCloudPath(cloudPath); await mkdir(localPath, { recursive: true, mode: 0o700 }); const info = await lstat(localPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A sync mapping must point at a real local directory, never a symlink.');
  const mapping: LocalMapping = { id, cloudPath, localPath: resolve(localPath), rootRealPath: await realpath(localPath), rootDev: Number(info.dev), rootIno: Number(info.ino), policy: normalizeSyncPolicy(policy), paused: false, initialized: false, cursor: 0, entries: {}, pending: [], status: 'idle', progress: null, conflicts: [] };
  config.mappings.push(mapping); return mapping;
}

async function walkLocal(root: string, policy: SyncPolicy): Promise<{ entries: Map<string, LocalEntry>; excludedFiles: number; excludedFolders: number; excludedBytes: number }> {
  const result = new Map<string, LocalEntry>(); let excludedFiles = 0; let excludedFolders = 0; let excludedBytes = 0;
  async function visit(folder: string, prefix = ''): Promise<void> {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (item.name.includes(PART_SUFFIX) || item.name.includes(RENAME_SUFFIX)) continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name; validateRelative(path); const full = join(folder, item.name); const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Symlink found in sync folder: ${path}. It was not followed.`);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Unsupported local item in sync folder: ${path}.`);
      if (syncPathExcluded(path, policy)) { if (info.isFile()) { excludedFiles++; excludedBytes += info.size; } else excludedFolders++; continue; }
      result.set(path, { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory(), ino: Number(info.ino), dev: Number(info.dev) });
      if (info.isDirectory()) await visit(full, path);
    }
  }
  await visit(root); return { entries: result, excludedFiles, excludedFolders, excludedBytes };
}
function localDirectories(root: string, policy: SyncPolicy): string[] {
  const paths: string[] = [root]; const next = [root]; let rootReal: string;
  try { rootReal = realpathSync(root); } catch { return []; }
  while (next.length) {
    const directory = next.pop()!;
    try {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink()) continue;
        const relativePath = relative(rootReal, join(directory, item.name)).split(sep).filter(Boolean).join('/'); if (syncPathExcluded(relativePath, policy)) continue;
        const path = join(directory, item.name); const info = lstatSync(path); if (info.isSymbolicLink()) continue;
        const real = realpathSync(path); if (!contained(rootReal, real)) continue;
        paths.push(path); next.push(path);
      }
    } catch { /* a periodic reconciliation recreates a missed watcher */ }
  }
  return paths;
}
async function localEntry(path: string): Promise<LocalEntry> { const info = await lstat(path); if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Unsafe local path: ${path}`); return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory(), ino: Number(info.ino), dev: Number(info.dev) }; }
async function readChunk(path: string, start: number, length: number): Promise<Uint8Array> { const handle = await open(path, 'r'); try { const buffer = Buffer.allocUnsafe(length); const { bytesRead } = await handle.read(buffer, 0, length, start); if (bytesRead !== length) throw new Error('File changed during upload; it will be retried.'); return buffer; } finally { await handle.close(); } }
async function sha256(path: string): Promise<string> { const hash = createHash('sha256'); const handle = await open(path, 'r'); try { const buffer = Buffer.allocUnsafe(1024 * 1024); for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } } finally { await handle.close(); } return hash.digest('hex'); }
function validateCloudPath(path: string): void { if (path && (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0')))) throw new Error('Cloud path must be a safe Continental Cloud relative path.'); }
export function validateSyncRelativePath(path: string, platform: NodeJS.Platform = process.platform): void { validateCloudPath(path); for (const part of path.split('/').filter(Boolean)) { if (part.length > 255 || (platform === 'win32' && (WINDOWS_FORBIDDEN_NAME.test(part) || WINDOWS_RESERVED_NAME.test(part) || /[. ]$/.test(part)))) throw new Error(`Path cannot be represented safely on this device: ${path}`); } }
function validateRelative(path: string): void { validateSyncRelativePath(path); }
function cloudRelative(mapping: LocalMapping, path: string | null): string | undefined { if (path === null) return undefined; if (!mapping.cloudPath) return path; if (path === mapping.cloudPath) return ''; return path.startsWith(`${mapping.cloudPath}/`) ? path.slice(mapping.cloudPath.length + 1) : undefined; }
function cloudJoin(mapping: LocalMapping, path: string): string { return mapping.cloudPath ? (path ? `${mapping.cloudPath}/${path}` : mapping.cloudPath) : path; }
function cloudParent(mapping: LocalMapping, path: string): string { const index = path.lastIndexOf('/'); const localParent = index === -1 ? '' : path.slice(0, index); return cloudJoin(mapping, localParent); }
function localConflictPath(path: string, deviceName: string): string { const extension = extname(path); const base = extension ? path.slice(0, -extension.length) : path; const safeDevice = deviceName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '-').slice(0, 80) || 'Device'; return `${base} (Conflict - ${safeDevice} - ${new Date().toISOString().slice(0, 10)})${extension}`; }
function contained(root: string, candidate: string): boolean { const value = relative(root, candidate); return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !value.includes(`${sep}..${sep}`)); }
function limited(value: string, length: number): string { const output = value.trim().slice(0, length); if (!output) throw new Error('A device name is required.'); return output; }
function mimeFor(name: string): string | undefined { const extension = extname(name).toLowerCase(); return extension === '.txt' ? 'text/plain' : extension === '.md' ? 'text/markdown' : extension === '.json' ? 'application/json' : undefined; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function nonEmpty(value: string | undefined): string | undefined { return value && value.length ? value : undefined; }
function expandHome(path: string): string { return path.replace(/^~(?=$|[\\/])/, homedir()); }
function comparableSyncPath(path: string): string { return path.normalize('NFD').toLocaleLowerCase('en-US'); }
function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean { return platform === 'win32' || platform === 'darwin'; }
function sameLocalPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean { const pathResolve = platform === 'win32' ? windowsPath.resolve : resolve; const normalizedLeft = pathResolve(left); const normalizedRight = pathResolve(right); return isCaseInsensitivePlatform(platform) ? comparableSyncPath(normalizedLeft) === comparableSyncPath(normalizedRight) : normalizedLeft === normalizedRight; }
function sameLocalObject(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean { const leftDev = String(left.dev); const leftIno = String(left.ino); return (leftDev !== '0' || leftIno !== '0') && leftDev === String(right.dev) && leftIno === String(right.ino); }
async function sameRealPath(left: string, right: string): Promise<boolean> { try { return await realpath(left) === await realpath(right); } catch { return false; } }
function hasStableLocalIdentity(entry: LocalEntry): boolean { return entry.dev !== 0 && entry.ino !== 0; }
function sameLocalIdentity(left: LocalEntry, right: LocalEntry): boolean { return left.isDirectory === right.isDirectory && hasStableLocalIdentity(left) && hasStableLocalIdentity(right) && left.dev === right.dev && left.ino === right.ino; }
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }
function isMissingPathError(error: unknown): boolean { return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'; }

function startProgress(initial: boolean): SyncProgress {
  const timestamp = new Date().toISOString();
  return { phase: 'scanning', initial, filesTotal: 0, filesDone: 0, foldersTotal: 0, foldersDone: 0, bytesTotal: 0, bytesDone: 0, excludedFiles: 0, excludedFolders: 0, excludedBytes: 0, startedAt: timestamp, updatedAt: timestamp };
}
function mergeProgress(current: SyncProgress | null | undefined, patch: Partial<SyncProgress>): SyncProgress {
  return { ...(current ?? startProgress(false)), ...patch, updatedAt: new Date().toISOString() };
}
function finishProgress(current: SyncProgress | null): SyncProgress {
  return mergeProgress(current, {
    phase: 'complete',
    filesDone: Math.max(current?.filesDone ?? 0, current?.filesTotal ?? 0),
    foldersDone: Math.max(current?.foldersDone ?? 0, current?.foldersTotal ?? 0),
    bytesDone: Math.max(current?.bytesDone ?? 0, current?.bytesTotal ?? 0),
    completedAt: new Date().toISOString(),
  });
}

export async function claimSyncPairing(serverUrl: string, token: string | undefined, input: { code: string; deviceId: string; name: string; platform: string; clientVersion: string; localPath: string }): Promise<SyncPairingClaim> {
  const parsed = new URL(serverUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Server URL must use http or https.');
  if (token !== undefined && (!token || token.length < 12)) throw new Error('A Continental Cloud token is required.');
  let response: Response;
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' }); if (token) headers.set('X-Continental-Token', token);
    response = await fetch(`${parsed.toString().replace(/\/$/, '')}/api/sync/pairing/claim`, { method: 'POST', headers, body: JSON.stringify(input) });
  } catch (error) { throw new SyncApiError(error instanceof Error ? error.message : 'Network request failed.'); }
  const payload = await response.json().catch(() => undefined) as { data?: SyncPairingClaim; error?: { message?: string; code?: string } } | undefined;
  if (!response.ok) throw new SyncApiError(payload?.error?.message ?? `Server returned HTTP ${response.status}.`, response.status, payload?.error?.code);
  if (!payload?.data) throw new SyncApiError('Pairing response was empty.');
  return payload.data;
}
