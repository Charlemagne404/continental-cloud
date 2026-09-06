import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SyncUploadContext, UploadSession } from '../shared/types.js';
import type { FileNode } from '../shared/types.js';
import { fail } from './errors.js';
import { FileService, normalizeMimeType } from './files.js';
import { normalizeFileName, normalizeRelativePath, joinRelative } from './paths.js';

export class UploadService {
  private versionRetention: number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly targetLocks = new Map<string, Promise<void>>();
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  constructor(private readonly files: FileService, private readonly maxUploadBytes: number, private readonly chunkBytes: number, versionRetention = 25) { this.versionRetention = versionRetention; }
  setVersionRetention(retain: number): void { this.versionRetention = retain; }

  async start(input: { parentPath?: unknown; name?: unknown; size?: unknown; mimeType?: unknown; overwrite?: unknown; sync?: SyncUploadContext }): Promise<UploadSession> {
    const parentPath = normalizeRelativePath(input.parentPath ?? '');
    const name = normalizeFileName(input.name);
    const size = typeof input.size === 'number' && Number.isSafeInteger(input.size) && input.size >= 0 ? input.size : NaN;
    if (!Number.isFinite(size)) throw fail.badRequest('Upload size must be a non-negative integer.');
    if (size > this.maxUploadBytes) throw fail.tooLarge(`This file is larger than the configured upload limit of ${this.maxUploadBytes} bytes.`);
    const mimeType = normalizeMimeType(input.mimeType, name);
    const sync = input.sync;
    const overwrite = input.overwrite === true || Boolean(sync);
    const create = async (): Promise<UploadSession> => {
      if (sync) {
        const prior = this.files.db.findUploadByIdempotency(sync.deviceId, sync.idempotencyKey);
        if (prior) {
          if (!sameUploadRequest(prior, { parentPath, name, mimeType, size, overwrite, sync })) throw fail.conflict('This idempotency key is already being used for a different upload.');
          return withoutPrivateUploadFields(prior);
        }
      }
      const target = joinRelative(parentPath, name);
      await this.files.storage.assertParentSafe(target);
      await this.files.syncDirectory(parentPath);
      const existing = this.files.db.getActiveNodeByPath(target);
      if (existing?.isDirectory) throw fail.conflict('A folder already has that name.');
      if (existing && !overwrite) throw fail.conflict('A file with that name already exists. Choose a different name or replace it.');
      await this.files.storage.internalExisting(join(this.files.storage.internalRoot, 'temp'));
      const id = randomUUID();
      const session: UploadSession = { id, parentPath, name, mimeType, size, overwrite, chunkSize: this.chunkBytes, chunkCount: Math.max(1, Math.ceil(size / this.chunkBytes)), receivedChunks: [], status: 'active', createdAt: new Date().toISOString(), sync };
      const tempName = `${id}.part`;
      const tempPath = join(this.files.storage.internalRoot, 'temp', tempName);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(tempPath, 'wx', 0o600);
        await handle.truncate(size);
        await handle.sync();
      } catch (error: unknown) {
        if (handle) await rm(tempPath, { force: true }).catch(() => undefined);
        rethrowUploadStorageError(error);
      } finally { await handle?.close(); }
      try { this.files.db.createUpload(session, tempName); }
      catch (error: unknown) { await rm(tempPath, { force: true }).catch(() => undefined); throw error; }
      return session;
    };
    const guardedCreate = () => this.files.withMutationLock(create);
    return sync ? this.withMapLock(this.idempotencyLocks, `${sync.deviceId}\0${sync.idempotencyKey}`, guardedCreate) : guardedCreate();
  }

  async writeChunk(uploadId: string, index: number, stream: AsyncIterable<Uint8Array>, declaredLength?: number): Promise<UploadSession> {
    return this.withLock(uploadId, async () => {
      const session = this.files.db.getUpload(uploadId);
      if (!session) { discardStream(stream); throw fail.notFound('Upload session not found.'); }
      if (session.status !== 'active') { discardStream(stream); throw fail.conflict('This upload is no longer active.'); }
      if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunkCount) { discardStream(stream); throw fail.badRequest('Chunk index is outside the upload range.'); }
      const expected = index === session.chunkCount - 1 ? session.size - (index * session.chunkSize) : session.chunkSize;
      if (declaredLength !== undefined && declaredLength !== expected) { discardStream(stream); throw fail.badRequest('Chunk Content-Length does not match its expected size.'); }
      try { await this.files.storage.requireReady(); } catch (error) { discardStream(stream); throw error; }
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let written = 0;
      try {
        const stagedPath = await this.files.storage.internalExisting(uploadTempPath(this.files, session));
        handle = await open(stagedPath, 'r+');
        for await (const value of stream) {
          const chunk = value instanceof Uint8Array ? value : Buffer.from(value);
          if (written + chunk.byteLength > expected) throw fail.tooLarge('Upload chunk exceeded its expected size.');
          await writeFully(handle, chunk, (index * session.chunkSize) + written);
          written += chunk.byteLength;
        }
        if (written !== expected) throw fail.badRequest(`Chunk has ${written} bytes; expected ${expected}.`);
        // A resumable session must never report a chunk before its bytes are
        // flushed to the filesystem. A retry can safely rewrite the same range.
        await handle.sync();
      } catch (error: unknown) {
        discardStream(stream);
        rethrowUploadStorageError(error);
      } finally { await handle?.close(); }
      const receivedChunks = [...new Set([...session.receivedChunks, index])].sort((a, b) => a - b);
      this.files.db.updateUploadChunks(uploadId, receivedChunks);
      return { ...session, receivedChunks };
    });
  }

  async complete(uploadId: string): Promise<{ node: FileNode; versionCreated: boolean; conflict: boolean; conflictPath?: string }> {
    return this.withLock(uploadId, async () => {
      const session = this.files.db.getUpload(uploadId);
      if (!session) throw fail.notFound('Upload session not found.');
      if (session.status === 'complete' && session.resultNodeId) {
        const node = this.files.db.getNode(session.resultNodeId); if (node) return { node, versionCreated: false, conflict: Boolean(session.sync && node.relativePath !== joinRelative(session.parentPath, session.name)), conflictPath: node.relativePath };
      }
      if (session.status !== 'active') throw fail.conflict('This upload is no longer active.');
      if (session.receivedChunks.length !== session.chunkCount || session.receivedChunks.some((value, index) => value !== index)) throw fail.conflict('All upload chunks must arrive before completion.');
      return this.files.withMutationLock(() => this.withMapLock(this.targetLocks, `parent:${session.parentPath}`, async () => {
        await this.files.storage.requireReady();
        await this.files.storage.internalExisting(join(this.files.storage.internalRoot, 'temp'));
        const requestedTarget = joinRelative(session.parentPath, session.name);
        let target = requestedTarget;
        await this.files.storage.assertParentSafe(target);
        await this.files.syncDirectory(session.parentPath);
        const tempPath = uploadTempPath(this.files, session);
        let tempInfo: Awaited<ReturnType<typeof lstat>>;
        try { tempInfo = await lstat(tempPath); }
        catch (error: unknown) {
          if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
            this.files.db.updateUploadStatus(uploadId, 'failed');
            throw fail.conflict('The staged upload data is no longer available. Retry the upload.');
          }
          rethrowUploadStorageError(error);
        }
        if (!tempInfo.isFile() || tempInfo.size !== session.size) {
          this.files.db.updateUploadStatus(uploadId, 'failed');
          throw fail.conflict('The staged upload data is incomplete. Retry the upload.');
        }
        let checksum: string;
        try { checksum = await sha256File(tempPath); }
        catch (error: unknown) {
          if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
            this.files.db.updateUploadStatus(uploadId, 'failed');
            throw fail.conflict('The staged upload data is no longer available. Retry the upload.');
          }
          rethrowUploadStorageError(error);
        }
        let existing = this.files.db.getActiveNodeByPath(target);
        const staleBase = Boolean(session.sync && (session.sync.nodeId
          ? !existing || existing.id !== session.sync.nodeId || (session.sync.baseRevision !== undefined && existing.revision !== session.sync.baseRevision)
          : existing));
        let conflict = false;
        if (staleBase) {
          target = await this.files.conflictPath(session.parentPath, session.name, session.sync?.deviceName ?? session.sync!.deviceId.slice(0, 8));
          existing = undefined;
          conflict = true;
        }
        let versionCreated = false;
        let movedVersion: { versionId: string; versionPath: string } | undefined;
        if (existing) {
          if (existing.isDirectory) throw fail.conflict('Cannot replace a folder with an upload.');
          if (!session.overwrite) throw fail.conflict('A file appeared at this path while the upload was in progress. Choose replace and retry.');
          movedVersion = await this.files.prepareOverwrite(target, existing);
          versionCreated = true;
        } else {
          try {
            await lstat(this.files.storage.pathForNew(target));
            throw fail.conflict('A file appeared at this path while the upload was in progress.');
          } catch (error: unknown) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
        }
        try {
          await rename(tempPath, this.files.storage.pathForNew(target));
        } catch (error: unknown) {
          await restorePreparedOverwrite(target, movedVersion, this.files);
          rethrowUploadStorageError(error);
        }
        let node: FileNode;
        const action = conflict ? 'sync_conflict' : 'uploaded';
        const detail = conflict ? `conflict_copy_of=${requestedTarget}` : versionCreated ? 'replaced_existing_file' : null;
        try {
          node = this.files.db.finalizeUpload({ uploadId, target, size: session.size, mimeType: session.mimeType, checksum, existingNodeId: existing?.id, action, detail, operation: existing ? 'modify' : 'create', deviceId: session.sync?.deviceId });
        } catch (error: unknown) {
          await rollbackCommittedUpload(uploadId, target, movedVersion, this.files);
          if (error instanceof Error && ['UPLOAD_TARGET_CHANGED', 'UPLOAD_SESSION_CHANGED'].includes(error.message)) throw fail.conflict('The upload target changed while it was completing. Retry the upload.');
          throw error;
        }
        if (versionCreated) {
          try { await this.files.pruneVersions(node.id, this.versionRetention); } catch { /* retention cleanup must not turn a committed upload into a retry */ }
        }
        return { node, versionCreated, conflict, conflictPath: conflict ? target : undefined };
      }));
    });
  }

  async cancel(uploadId: string): Promise<void> {
    await this.withLock(uploadId, async () => {
      const session = this.files.db.getUpload(uploadId);
      if (!session) throw fail.notFound('Upload session not found.');
      if (session.status === 'complete') throw fail.conflict('This upload is already complete.');
      if (session.status === 'cancelled') return;
      await this.files.storage.requireReady();
      await rm(uploadTempPath(this.files, session), { force: true });
      this.files.db.updateUploadStatus(uploadId, 'cancelled');
    });
  }

  async cleanupOlderThan(hours = 24): Promise<number> {
    await this.files.storage.requireReady();
    const before = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const stale = this.files.db.staleUploads(before);
    let removed = 0;
    for (const item of stale) {
      await this.withLock(item.id, async () => {
        const session = this.files.db.getUpload(item.id);
        if (!session || session.status === 'complete' || session.createdAt >= before) return;
        await rm(uploadTempPath(this.files, session), { force: true });
        this.files.db.deleteUpload(item.id);
        removed++;
      });
    }
    return removed;
  }

  private async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    return this.withMapLock(this.locks, id, action);
  }

  private async withMapLock<T>(locks: Map<string, Promise<void>>, id: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => turn);
    locks.set(id, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (locks.get(id) === current) locks.delete(id);
    }
  }
}

function discardStream(stream: AsyncIterable<Uint8Array>): void {
  const resumable = stream as AsyncIterable<Uint8Array> & { resume?: () => void };
  resumable.resume?.();
}

async function writeFully(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
    if (!result.bytesWritten) throw new Error('The storage stopped accepting upload data.');
    offset += result.bytesWritten;
  }
}

function rethrowUploadStorageError(error: unknown): never {
  if (error instanceof Error && error.name === 'CloudError') throw error;
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'ENOSPC' || code === 'EDQUOT') throw fail.unavailable('The storage volume does not have enough free space for this upload.');
  if (code === 'EFBIG') throw fail.tooLarge('The storage filesystem cannot hold a file of this size.');
  if (code === 'ENAMETOOLONG') throw fail.badRequest('The destination name or path is too long for the storage filesystem.');
  if (code === 'EEXIST') throw fail.conflict('The upload target changed while it was completing. Retry the upload.');
  if (code === 'ENOENT') throw fail.conflict('The upload destination is no longer available. Retry the upload.');
  if (['EACCES', 'EIO', 'ENODEV', 'ENOTDIR', 'ENXIO', 'EPERM', 'EROFS', 'ESTALE', 'EXDEV'].includes(code)) throw fail.unavailable('The storage volume could not complete this upload.');
  throw error;
}

function sameUploadRequest(prior: UploadSession, input: { parentPath: string; name: string; mimeType: string | null; size: number; overwrite: boolean; sync: SyncUploadContext }): boolean {
  return prior.parentPath === input.parentPath && prior.name === input.name && prior.mimeType === input.mimeType && prior.size === input.size && prior.overwrite === input.overwrite
    && prior.sync?.deviceId === input.sync.deviceId && prior.sync.idempotencyKey === input.sync.idempotencyKey && prior.sync.nodeId === input.sync.nodeId && prior.sync.baseRevision === input.sync.baseRevision;
}

function withoutPrivateUploadFields(session: UploadSession & { tempName?: string }): UploadSession {
  const { tempName: _tempName, ...publicSession } = session;
  return publicSession;
}

function uploadTempPath(files: FileService, session: UploadSession & { tempName: string }): string {
  if (session.tempName !== `${session.id}.part`) throw fail.unavailable('The upload metadata is invalid; retry the upload.');
  return join(files.storage.internalRoot, 'temp', session.tempName);
}

async function restorePreparedOverwrite(target: string, movedVersion: { versionId: string; versionPath: string } | undefined, files: FileService): Promise<void> {
  if (!movedVersion) return;
  try {
    await rename(movedVersion.versionPath, files.storage.pathForNew(target));
    files.db.deleteVersion(movedVersion.versionId);
  } catch (error: unknown) { rethrowUploadStorageError(error); }
}

async function rollbackCommittedUpload(uploadId: string, target: string, movedVersion: { versionId: string; versionPath: string } | undefined, files: FileService): Promise<void> {
  try {
    await rm(files.storage.pathForNew(target), { force: true });
    await restorePreparedOverwrite(target, movedVersion, files);
    files.db.updateUploadStatus(uploadId, 'failed');
  } catch (error: unknown) { rethrowUploadStorageError(error); }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
