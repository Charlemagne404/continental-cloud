import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SyncUploadContext, UploadSession } from '../shared/types.js';
import type { FileNode } from '../shared/types.js';
import { fail } from './errors.js';
import { FileService, mimeFromName } from './files.js';
import { normalizeFileName, normalizeRelativePath, joinRelative } from './paths.js';

export class UploadService {
  private versionRetention: number;
  constructor(private readonly files: FileService, private readonly maxUploadBytes: number, private readonly chunkBytes: number, versionRetention = 25) { this.versionRetention = versionRetention; }
  setVersionRetention(retain: number): void { this.versionRetention = retain; }

  async start(input: { parentPath?: unknown; name?: unknown; size?: unknown; mimeType?: unknown; overwrite?: unknown; sync?: SyncUploadContext }): Promise<UploadSession> {
    const parentPath = normalizeRelativePath(input.parentPath ?? '');
    const name = normalizeFileName(input.name);
    const size = typeof input.size === 'number' && Number.isSafeInteger(input.size) && input.size >= 0 ? input.size : NaN;
    if (!Number.isFinite(size)) throw fail.badRequest('Upload size must be a non-negative integer.');
    if (size > this.maxUploadBytes) throw fail.tooLarge(`Files may not exceed ${this.maxUploadBytes} bytes.`);
    const mimeType = typeof input.mimeType === 'string' && input.mimeType.length <= 255 ? input.mimeType : mimeFromName(name);
    const sync = input.sync;
    if (sync) {
      const prior = this.files.db.findUploadByIdempotency(sync.deviceId, sync.idempotencyKey);
      if (prior) return prior;
    }
    const overwrite = input.overwrite === true || Boolean(sync);
    const target = joinRelative(parentPath, name);
    await this.files.storage.assertParentSafe(target);
    const existing = this.files.db.getActiveNodeByPath(target);
    if (existing?.isDirectory) throw fail.conflict('A folder already has that name.');
    if (existing && !overwrite) throw fail.conflict('A file with that name already exists. Choose a different name or replace it.');
    const id = randomUUID();
    const session: UploadSession = { id, parentPath, name, mimeType, size, chunkSize: this.chunkBytes, chunkCount: Math.max(1, Math.ceil(size / this.chunkBytes)), receivedChunks: [], status: 'active', createdAt: new Date().toISOString(), sync };
    const tempName = `${id}.part`;
    const tempPath = join(this.files.storage.internalRoot, 'temp', tempName);
    const handle = await open(tempPath, 'wx', 0o600);
    try { await handle.truncate(size); } finally { await handle.close(); }
    this.files.db.createUpload(session, tempName);
    return session;
  }

  async writeChunk(uploadId: string, index: number, stream: AsyncIterable<Uint8Array>, declaredLength?: number): Promise<UploadSession> {
    const session = this.files.db.getUpload(uploadId);
    if (!session) throw fail.notFound('Upload session not found.');
    if (session.status !== 'active') throw fail.conflict('This upload is no longer active.');
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunkCount) throw fail.badRequest('Chunk index is outside the upload range.');
    const expected = index === session.chunkCount - 1 ? session.size - (index * session.chunkSize) : session.chunkSize;
    if (declaredLength !== undefined && declaredLength !== expected) throw fail.badRequest('Chunk Content-Length does not match its expected size.');
    const handle = await open(join(this.files.storage.internalRoot, 'temp', session.tempName), 'r+');
    let written = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.from(value);
        written += chunk.byteLength;
        if (written > expected) throw fail.tooLarge('Upload chunk exceeded its expected size.');
        await handle.write(chunk, 0, chunk.byteLength, (index * session.chunkSize) + written - chunk.byteLength);
      }
      if (written !== expected) throw fail.badRequest(`Chunk has ${written} bytes; expected ${expected}.`);
    } catch (error) {
      this.files.db.updateUploadStatus(uploadId, 'failed');
      throw error;
    } finally { await handle.close(); }
    const receivedChunks = [...new Set([...session.receivedChunks, index])].sort((a, b) => a - b);
    this.files.db.updateUploadChunks(uploadId, receivedChunks);
    return { ...session, receivedChunks };
  }

  async complete(uploadId: string): Promise<{ node: FileNode; versionCreated: boolean; conflict: boolean; conflictPath?: string }> {
    const session = this.files.db.getUpload(uploadId);
    if (!session) throw fail.notFound('Upload session not found.');
    if (session.status === 'complete' && session.resultNodeId) {
      const node = this.files.db.getNode(session.resultNodeId); if (node) return { node, versionCreated: false, conflict: Boolean(session.sync && node.relativePath !== joinRelative(session.parentPath, session.name)), conflictPath: node.relativePath };
    }
    if (session.status !== 'active') throw fail.conflict('This upload is no longer active.');
    if (session.receivedChunks.length !== session.chunkCount || session.receivedChunks.some((value, index) => value !== index)) throw fail.conflict('All upload chunks must arrive before completion.');
    await this.files.storage.requireReady();
    const requestedTarget = joinRelative(session.parentPath, session.name);
    let target = requestedTarget;
    await this.files.storage.assertParentSafe(target);
    const tempPath = join(this.files.storage.internalRoot, 'temp', session.tempName);
    const checksum = await sha256File(tempPath);
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
    } catch (error) {
      if (movedVersion) {
        await rename(movedVersion.versionPath, this.files.storage.pathForNew(target)).catch(() => undefined);
        this.files.db.deleteVersion(movedVersion.versionId);
      }
      this.files.db.updateUploadStatus(uploadId, 'failed');
      throw error;
    }
    let node = existing;
    if (node) node = this.files.db.updateFileAfterUpload(node.id, session.size, session.mimeType);
    else node = this.files.db.createNode(target, session.name, false, session.size, session.mimeType);
    node = this.files.db.setChecksum(node.id, checksum);
    this.files.db.completeUpload(uploadId, node.id);
    const detail = conflict ? `conflict_copy_of=${requestedTarget}` : versionCreated ? 'replaced_existing_file' : null;
    this.files.db.addActivity(conflict ? 'sync_conflict' : 'uploaded', node.id, target, detail);
    this.files.db.addChange(conflict ? 'sync_conflict' : 'uploaded', node.id, target, detail, { operation: existing ? 'modify' : 'create', revision: node.revision, checksum: node.checksum, deviceId: session.sync?.deviceId });
    if (versionCreated) await this.files.pruneVersions(node.id, this.versionRetention);
    return { node: node!, versionCreated, conflict, conflictPath: conflict ? target : undefined };
  }

  async cancel(uploadId: string): Promise<void> {
    const session = this.files.db.getUpload(uploadId);
    if (!session) throw fail.notFound('Upload session not found.');
    await rm(join(this.files.storage.internalRoot, 'temp', session.tempName), { force: true });
    this.files.db.updateUploadStatus(uploadId, 'cancelled');
  }

  async cleanupOlderThan(hours = 24): Promise<number> {
    const before = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const stale = this.files.db.staleUploads(before);
    for (const item of stale) {
      await rm(join(this.files.storage.internalRoot, 'temp', item.tempName), { force: true });
      this.files.db.deleteUpload(item.id);
    }
    return stale.length;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
