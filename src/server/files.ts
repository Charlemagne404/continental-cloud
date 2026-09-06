import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';
import type { FileNode } from '../shared/types.js';
import { fail } from './errors.js';
import { MetadataDatabase } from './metadata.js';
import { joinRelative, normalizeFileName, normalizeRelativePath, parentPath, resolveExistingNoSymlink } from './paths.js';
import { Storage, type DiskEntry } from './storage.js';

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json', '.jsonl': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript',
  '.css': 'text/css', '.scss': 'text/x-scss', '.less': 'text/x-less', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.xhtml': 'application/xhtml+xml',
  '.py': 'text/x-python', '.go': 'text/x-go', '.rs': 'text/x-rust', '.c': 'text/x-c', '.h': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.cs': 'text/x-csharp', '.csx': 'text/x-csharp', '.fs': 'text/x-fsharp', '.fsx': 'text/x-fsharp', '.vb': 'text/x-visual-basic', '.java': 'text/x-java-source', '.kt': 'text/x-kotlin', '.swift': 'text/x-swift', '.rb': 'text/x-ruby', '.php': 'application/x-php', '.sql': 'application/sql',
  '.csproj': 'application/xml', '.fsproj': 'application/xml', '.vbproj': 'application/xml', '.props': 'application/xml', '.targets': 'application/xml', '.resx': 'application/xml', '.sln': 'text/plain',
  '.sh': 'text/x-shellscript', '.bash': 'text/x-shellscript', '.zsh': 'text/x-shellscript', '.fish': 'text/x-shellscript', '.yml': 'text/yaml', '.yaml': 'text/yaml', '.toml': 'application/toml', '.ini': 'text/plain', '.conf': 'text/plain', '.log': 'text/plain',
  '.pdf': 'application/pdf', '.rtf': 'application/rtf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon', '.heic': 'image/heic', '.heif': 'image/heif', '.jxl': 'image/jxl', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.mka': 'audio/x-matroska',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.bz2': 'application/x-bzip2', '.xz': 'application/x-xz', '.zst': 'application/zstd', '.iso': 'application/x-iso9660-image', '.dmg': 'application/x-apple-diskimage', '.jar': 'application/java-archive', '.apk': 'application/vnd.android.package-archive', '.wasm': 'application/wasm',
};
const MIME_TOKEN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
export function mimeFromName(name: string): string | null { return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'; }
/** Browser-provided types are only hints. Keep them opaque and header-safe. */
export function normalizeMimeType(input: unknown, name: string): string | null {
  const fallback = mimeFromName(name);
  if (typeof input !== 'string') return fallback;
  const value = input.trim().split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return value.length <= 127 && MIME_TOKEN.test(value) ? value : fallback;
}
export function mediaType(mime: string | null | undefined): string { return (mime ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''; }
export function isPreviewable(mime: string | null): boolean {
  const type = mediaType(mime);
  return Boolean(type && ((type.startsWith('image/') && type !== 'image/svg+xml') || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf' || type.startsWith('text/') || type === 'application/json'));
}
export function isUnsafeInlineMime(mime: string | null | undefined): boolean {
  const type = mediaType(mime);
  return type === 'text/html' || type === 'application/xhtml+xml' || type === 'application/xml' || type === 'text/xml' || type === 'image/svg+xml';
}

export class FileService {
  private readonly folderCreationLocks = new Map<string, Promise<void>>();
  private mutationQueue: Promise<void> = Promise.resolve();
  constructor(readonly storage: Storage, readonly db: MetadataDatabase) {}

  async syncDirectory(relativePath = ''): Promise<FileNode[]> {
    const entries = await this.storage.list(relativePath);
    const present = new Set(entries.map((entry) => entry.relativePath));
    const known = this.db.listChildren(relativePath, 'name');
    for (const entry of entries) this.db.upsertDiskEntry(entry, entry.isDirectory ? null : mimeFromName(entry.name));
    // A direct-directory check keeps browsing correct after external changes without
    // paying the cost of a full NAS scan on every request.
    for (const stale of known) {
      if (!present.has(stale.relativePath)) this.removeActiveMetadata(stale);
    }
    return this.db.listChildren(relativePath);
  }

  async list(relativePath: string, sort?: string, direction?: string): Promise<FileNode[]> {
    return this.withMutationLock(async () => {
      const normalized = normalizeRelativePath(relativePath);
      await this.syncDirectory(normalized);
      return this.db.listChildren(normalized, sort, direction);
    });
  }

  async listPage(relativePath: string, sort = 'name', direction = 'asc', limit = 100, offset = 0): Promise<{ items: FileNode[]; hasMore: boolean; offset: number; limit: number }> {
    return this.withMutationLock(async () => {
      const normalized = normalizeRelativePath(relativePath);
      const pageLimit = Number.isSafeInteger(limit) ? Math.min(250, Math.max(1, limit)) : 100;
      const pageOffset = Number.isSafeInteger(offset) ? Math.min(1_000_000, Math.max(0, offset)) : 0;
      await this.syncDirectory(normalized);
      const page = this.db.listChildrenPage(normalized, sort, direction, pageLimit, pageOffset);
      return { ...page, offset: pageOffset, limit: pageLimit };
    });
  }

  async getNode(id: string): Promise<FileNode> {
    const file = this.db.getNode(id);
    if (!file || file.trashedAt) throw fail.notFound();
    await this.storage.pathFor(file.relativePath);
    return file;
  }

  async createFolder(parent: unknown, inputName: unknown, deviceId?: string): Promise<FileNode> {
    const targetParent = normalizeRelativePath(parent);
    const name = normalizeFileName(inputName);
    const relativePath = joinRelative(targetParent, name);
    return this.withMutationLock(() => this.withLock(this.folderCreationLocks, relativePath, async () => {
      await this.storage.assertParentSafe(relativePath);
      if (await this.exists(relativePath)) throw fail.conflict('An item with that name already exists.');
      const folderPath = this.storage.pathForNew(relativePath);
      try { await mkdir(folderPath, { mode: 0o750 }); }
      catch (error: unknown) {
        if ((error as { code?: string }).code === 'EEXIST') throw fail.conflict('An item with that name already exists.');
        throw error;
      }
      let created: FileNode;
      try { created = this.db.createNode(relativePath, name, true); }
      catch (error) {
        await rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      this.record('folder_created', created.id, relativePath, null, { operation: 'folder_create', revision: created.revision, deviceId });
      return created;
    }));
  }

  async rename(id: string, inputName: unknown, deviceId?: string): Promise<FileNode> {
    return this.withMutationLock(async () => {
      const item = await this.getNode(id);
      const name = normalizeFileName(inputName);
      const target = joinRelative(item.parentPath, name);
      if (target === item.relativePath) return item;
      if (await this.exists(target)) throw fail.conflict('An item with that name already exists.');
      await this.storage.assertParentSafe(target);
      const sourcePath = await this.storage.pathFor(item.relativePath);
      const targetPath = this.storage.pathForNew(target);
      await rename(sourcePath, targetPath);
      try { this.db.movePrefix(item.id, item.relativePath, target); }
      catch (error) { await rollbackRename(targetPath, sourcePath); throw error; }
      const moved = this.db.getNode(id)!;
      this.record('renamed', id, target, null, { operation: 'rename', previousPath: item.relativePath, revision: moved.revision, checksum: moved.checksum, deviceId });
      return moved;
    });
  }

  async move(id: string, targetParentInput: unknown, deviceId?: string): Promise<FileNode> {
    return this.withMutationLock(async () => {
      const item = await this.getNode(id);
      const targetParent = normalizeRelativePath(targetParentInput);
      const target = joinRelative(targetParent, item.name);
      if (target === item.relativePath) return item;
      if (item.isDirectory && (targetParent === item.relativePath || targetParent.startsWith(`${item.relativePath}/`))) throw fail.conflict('A folder cannot be moved into itself.');
      await this.storage.assertParentSafe(target);
      if (await this.exists(target)) throw fail.conflict('An item with that name already exists in the destination.');
      const sourcePath = await this.storage.pathFor(item.relativePath);
      const targetPath = this.storage.pathForNew(target);
      await rename(sourcePath, targetPath);
      try { this.db.movePrefix(item.id, item.relativePath, target); }
      catch (error) { await rollbackRename(targetPath, sourcePath); throw error; }
      const moved = this.db.getNode(id)!;
      this.record('moved', id, target, null, { operation: 'move', previousPath: item.relativePath, revision: moved.revision, checksum: moved.checksum, deviceId });
      return moved;
    });
  }

  async relocate(id: string, targetInput: unknown, deviceId?: string): Promise<FileNode> {
    return this.withMutationLock(async () => {
      const item = await this.getNode(id);
      const target = normalizeRelativePath(targetInput, { allowEmpty: false });
      if (target === item.relativePath) return item;
      if (item.isDirectory && (target.startsWith(`${item.relativePath}/`) || item.relativePath.startsWith(`${target}/`))) throw fail.conflict('A folder cannot be moved into itself or replace an ancestor.');
      await this.storage.assertParentSafe(target);
      if (await this.exists(target)) throw fail.conflict('An item with that name already exists in the destination.');
      const sourcePath = await this.storage.pathFor(item.relativePath);
      const targetPath = this.storage.pathForNew(target);
      await rename(sourcePath, targetPath);
      try { this.db.movePrefix(item.id, item.relativePath, target); }
      catch (error) { await rollbackRename(targetPath, sourcePath); throw error; }
      const moved = this.db.getNode(id)!;
      const operation = item.parentPath === moved.parentPath ? 'rename' : 'move';
      this.record(operation === 'rename' ? 'renamed' : 'moved', id, target, null, { operation, previousPath: item.relativePath, revision: moved.revision, checksum: moved.checksum, deviceId });
      return moved;
    });
  }

  async copy(id: string, targetParentInput: unknown, deviceId?: string): Promise<FileNode> {
    return this.withMutationLock(async () => {
      const item = await this.getNode(id);
      const targetParent = normalizeRelativePath(targetParentInput);
      if (item.isDirectory && (targetParent === item.relativePath || targetParent.startsWith(`${item.relativePath}/`))) throw fail.conflict('A folder cannot be copied into itself.');
      const target = await this.availablePath(targetParent, item.name);
      await this.storage.assertParentSafe(target);
      const targetPath = this.storage.pathForNew(target);
      let destinationCreated = false;
      try {
        await copyWithoutSymlinks(await this.storage.pathFor(item.relativePath), targetPath, () => { destinationCreated = true; });
        const indexed = await this.indexTree(target);
        const created = indexed.find((entry) => entry.relativePath === target);
        if (!created) throw new Error('Copied item was not indexed.');
        this.record('copied', created.id, target, item.relativePath, { operation: 'create', revision: created.revision, checksum: created.checksum, deviceId });
        return created;
      } catch (error) {
        if (destinationCreated) {
          await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
          this.db.removeActivePathPrefix(target);
        }
        throw error;
      }
    });
  }

  async trash(id: string, deviceId?: string): Promise<string> {
    return this.withMutationLock(async () => {
      const item = await this.getNode(id);
      const storageKey = randomUUID();
      await this.storage.requireReady();
      await resolveExistingNoSymlink(this.storage.trashRoot, '');
      const sourcePath = await this.storage.pathFor(item.relativePath);
      const trashPath = this.storage.trashPath(storageKey);
      await rename(sourcePath, trashPath);
      let trashId: string;
      try { trashId = this.db.markTrashed(id, item.relativePath, storageKey); }
      catch (error) { await rollbackRename(trashPath, sourcePath); throw error; }
      const trashed = this.db.getNode(id)!;
      this.record('trashed', id, item.relativePath, null, { operation: item.isDirectory ? 'folder_delete' : 'delete', revision: trashed.revision, checksum: trashed.checksum, deviceId });
      return trashId;
    });
  }

  async restoreTrash(id: string, deviceId?: string): Promise<FileNode> {
    return this.withMutationLock(async () => {
      await this.storage.requireReady();
      await resolveExistingNoSymlink(this.storage.trashRoot, '');
      const item = this.db.getTrash(id); if (!item) throw fail.notFound('Trash item not found.');
      const target = await this.availablePath(parentPath(item.originalPath), basename(item.originalPath));
      await this.storage.assertParentSafe(target);
      const trashPath = this.storage.trashPath(item.storageKey);
      const trashInfo = await lstat(await resolveExistingNoSymlink(this.storage.trashRoot, item.storageKey));
      if (item.node.isDirectory ? !trashInfo.isDirectory() : !trashInfo.isFile()) throw fail.conflict('The Trash data does not match its metadata. Reconcile the cloud before restoring it.');
      const destination = this.storage.pathForNew(target);
      await rename(trashPath, destination);
      let restored: FileNode | undefined;
      try { restored = this.db.restoreTrash(id, target); }
      catch (error) { await rollbackRename(destination, trashPath); throw error; }
      if (!restored) throw new Error('Unable to restore trash metadata.');
      this.record('restored', restored.id, target, item.originalPath, { operation: 'restore', previousPath: item.originalPath, revision: restored.revision, checksum: restored.checksum, deviceId });
      return restored;
    });
  }

  async permanentlyDeleteTrash(id: string): Promise<void> {
    await this.withMutationLock(async () => {
      await this.storage.requireReady();
      const item = this.db.getTrash(id); if (!item) throw fail.notFound('Trash item not found.');
      await resolveExistingNoSymlink(this.storage.trashRoot, '');
      await rm(this.storage.trashPath(item.storageKey), { recursive: true, force: true, maxRetries: 2 });
      this.db.removeTrash(id);
      this.record('permanently_deleted', item.node.id, item.originalPath);
    });
  }

  async emptyTrash(): Promise<number> {
    const entries = this.db.listTrash();
    for (const entry of entries) await this.permanentlyDeleteTrash(entry.id);
    return entries.length;
  }

  async cleanupTrashOlderThan(days: number): Promise<number> {
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stale = this.db.expiredTrash(before);
    for (const item of stale) await this.permanentlyDeleteTrash(item.id);
    return stale.length;
  }

  async prepareOverwrite(relativePath: string, existing: FileNode): Promise<{ versionId: string; versionPath: string }> {
    const destination = await this.storage.pathFor(relativePath);
    const info = await lstat(destination);
    if (!info.isFile()) throw fail.conflict('A folder cannot be overwritten by a file upload.');
    await resolveExistingNoSymlink(this.storage.internalRoot, 'versions');
    const folder = join(this.storage.internalRoot, 'versions', existing.id);
    await ensurePrivateDirectory(folder);
    const versionPath = join(folder, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await rename(destination, versionPath);
    try {
      const versionId = this.db.createVersion(existing.id, versionPath, existing.name, existing.mimeType, info.size);
      return { versionId, versionPath };
    } catch (error) {
      await rename(versionPath, destination).catch(() => undefined);
      throw error;
    }
  }

  /** A deterministic, human-readable name that never overwrites another device's work. */
  async conflictPath(parent: string, name: string, deviceName: string): Promise<string> {
    const extension = extname(name); const stem = extension ? name.slice(0, -extension.length) : name;
    const date = new Date().toISOString().slice(0, 10);
    const safeDevice = deviceName.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80) || 'Device';
    return this.availablePath(parent, `${stem} (Conflict - ${safeDevice} - ${date})${extension}`);
  }

  async restoreVersion(versionId: string, deviceId?: string): Promise<FileNode> {
    return this.withMutationLock(async () => {
      const version = this.db.getVersion(versionId); if (!version) throw fail.notFound('Version not found.');
      const item = await this.getNode(version.nodeId);
      const activePath = await this.storage.pathFor(item.relativePath);
      const versionPath = await this.storage.internalExisting(version.storedPath);
      const versionInfo = await lstat(versionPath);
      await resolveExistingNoSymlink(this.storage.internalRoot, 'versions');
      await resolveExistingNoSymlink(this.storage.internalRoot, 'temp');
      const folder = join(this.storage.internalRoot, 'versions', item.id);
      await ensurePrivateDirectory(folder);
      const currentPath = join(folder, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
      const stagedPath = join(this.storage.internalRoot, 'temp', `${randomUUID()}.restore`);
      await copyFile(versionPath, stagedPath);
      await rename(activePath, currentPath);
      try { await rename(stagedPath, activePath); } catch (error) { await rename(currentPath, activePath); throw error; }
      try {
        this.db.createVersion(item.id, currentPath, item.name, item.mimeType, (await lstat(currentPath)).size);
        const restored = this.db.updateFileAfterUpload(item.id, versionInfo.size, item.mimeType);
        this.record('version_restored', item.id, item.relativePath, versionId, { operation: 'modify', revision: restored.revision, checksum: restored.checksum, deviceId });
        return restored;
      } catch (error) {
        await rm(activePath, { force: true }).catch(() => undefined);
        await rename(currentPath, activePath).catch(() => undefined);
        throw error;
      }
    });
  }

  async restoreVersionAsCopy(versionId: string): Promise<FileNode> {
    return this.withMutationLock(async () => {
      const version = this.db.getVersion(versionId); if (!version) throw fail.notFound('Version not found.');
      const item = await this.getNode(version.nodeId); const target = await this.availablePath(item.parentPath, item.name);
      await this.storage.assertParentSafe(target);
      const destination = this.storage.pathForNew(target);
      let destinationCreated = false;
      try {
        await copyFile(await this.storage.internalExisting(version.storedPath), destination, constants.COPYFILE_EXCL);
        destinationCreated = true;
        const info = await lstat(await this.storage.pathFor(target)); const created = this.db.createNode(target, basename(target), false, info.size, item.mimeType);
        this.record('version_restored_as_copy', created.id, target, versionId, { operation: 'create', revision: created.revision, checksum: created.checksum });
        return created;
      } catch (error) {
        if (destinationCreated) {
          await rm(destination, { force: true }).catch(() => undefined);
          this.db.removeActivePathPrefix(target);
        }
        throw error;
      }
    });
  }

  async resolveConflict(conflictId: string, originalPathInput: unknown, choiceInput: unknown): Promise<{ choice: 'keep-cloud' | 'keep-incoming' | 'keep-both' | 'dismiss'; path: string; node?: FileNode }> {
    const conflict = await this.getNode(conflictId);
    if (conflict.isDirectory) throw fail.badRequest('Folder conflicts must be resolved from the sync client.');
    const originalPath = normalizeRelativePath(originalPathInput, { allowEmpty: false });
    const choice = choiceInput;
    if (choice !== 'keep-cloud' && choice !== 'keep-incoming' && choice !== 'keep-both' && choice !== 'dismiss') throw fail.badRequest('Unsupported conflict resolution.');
    if (choice === 'keep-cloud') {
      await this.trash(conflict.id);
      this.db.addActivity('conflict_resolved', conflict.id, conflict.relativePath, 'choice=keep-cloud');
      return { choice, path: conflict.relativePath };
    }
    if (choice === 'keep-incoming') {
      return this.withMutationLock(async () => {
        const original = this.db.getActiveNodeByPath(originalPath);
        if (!original) throw fail.conflict('The original cloud copy is no longer active; keep the incoming copy separately or resolve it from the drive.');
        const version = await this.prepareOverwrite(originalPath, original);
        try {
          await rename(await this.storage.pathFor(conflict.relativePath), this.storage.pathForNew(originalPath));
        } catch (error) {
          await rename(version.versionPath, this.storage.pathForNew(originalPath)).catch(() => undefined);
          this.db.deleteVersion(version.versionId);
          throw error;
        }
        let updated = this.db.updateFileAfterUpload(original.id, conflict.size, conflict.mimeType);
        if (conflict.checksum) updated = this.db.setChecksum(updated.id, conflict.checksum);
        this.db.removeActivePathPrefix(conflict.relativePath);
        this.db.addActivity('conflict_resolved', conflict.id, originalPath, 'choice=keep-incoming');
        this.record('conflict_resolved', updated.id, updated.relativePath, 'choice=keep-incoming', { operation: 'modify', revision: updated.revision, checksum: updated.checksum });
        return { choice, path: updated.relativePath, node: updated };
      });
    }
    this.db.addActivity('conflict_resolved', conflict.id, conflict.relativePath, `choice=${choice}`);
    return { choice, path: conflict.relativePath, node: conflict };
  }

  async verifyRecovery(): Promise<{ healthy: boolean; checkedFiles: number; checkedVersions: number; checkedTrash: number; missingFiles: number; missingVersions: number; missingTrash: number; mismatchedFiles: number; checkedAt: string; detail: string; issues: string[] }> {
    await this.storage.requireReady();
    const job = this.db.startJob('integrity_check');
    const checkedAt = new Date().toISOString();
    try {
      let checkedFiles = 0; let checkedVersions = 0; let checkedTrash = 0; let missingFiles = 0; let missingVersions = 0; let missingTrash = 0; let mismatchedFiles = 0;
      const issues: string[] = [];
      for (const item of this.db.listActiveNodes()) {
        try {
          const info = await resolveExistingNoSymlink(this.storage.dataRoot, item.relativePath);
          const disk = await lstat(info);
          const validType = item.isDirectory ? disk.isDirectory() : disk.isFile();
          if (!validType || (!item.isDirectory && disk.size !== item.size)) {
            mismatchedFiles++;
            if (issues.length < 20) issues.push(`${item.relativePath}: metadata does not match storage`);
          }
          checkedFiles++;
        } catch {
          missingFiles++;
          if (issues.length < 20) issues.push(`${item.relativePath}: missing from storage`);
        }
      }
      for (const version of this.db.listStoredVersions()) {
        try { const info = await lstat(await this.storage.internalExisting(version.storedPath)); if (!info.isFile() || info.size !== version.size) { if (issues.length < 20) issues.push(`version ${version.id}: metadata does not match storage`); missingVersions++; } else checkedVersions++; }
        catch { missingVersions++; if (issues.length < 20) issues.push(`version ${version.id}: missing from storage`); }
      }
      for (const item of this.db.listTrashRecords()) {
        try { const info = await lstat(await resolveExistingNoSymlink(this.storage.trashRoot, item.storageKey)); const expectedDirectory = item.node.isDirectory; if (expectedDirectory !== info.isDirectory()) { if (issues.length < 20) issues.push(`Trash ${item.originalPath}: metadata does not match storage`); missingTrash++; } else checkedTrash++; }
        catch { missingTrash++; if (issues.length < 20) issues.push(`Trash ${item.originalPath}: missing from storage`); }
      }
      const healthy = missingFiles === 0 && missingVersions === 0 && missingTrash === 0 && mismatchedFiles === 0;
      const detail = `Checked ${checkedFiles} active entries, ${checkedVersions} versions, and ${checkedTrash} Trash items${healthy ? '; no missing or mismatched data found.' : `; found ${missingFiles + missingVersions + missingTrash + mismatchedFiles} issue${missingFiles + missingVersions + missingTrash + mismatchedFiles === 1 ? '' : 's'}.`}`;
      this.db.finishJob(job, healthy ? 'complete' : 'failed', detail);
      this.db.addActivity('integrity_checked', null, null, detail);
      return { healthy, checkedFiles, checkedVersions, checkedTrash, missingFiles, missingVersions, missingTrash, mismatchedFiles, checkedAt, detail, issues };
    } catch (error) {
      this.db.finishJob(job, 'failed', error instanceof Error ? error.message.slice(0, 500) : 'Integrity check failed.');
      throw error;
    }
  }

  async thumbnail(id: string): Promise<string | undefined> {
    const item = await this.getNode(id);
    if (!item.mimeType?.startsWith('image/') || item.mimeType === 'image/svg+xml') return undefined;
    const source = await this.storage.pathFor(item.relativePath);
    await resolveExistingNoSymlink(this.storage.internalRoot, 'thumbnails');
    const key = createHash('sha256').update(`${item.id}:${item.modifiedAt}:${item.size}`).digest('hex');
    const output = join(this.storage.internalRoot, 'thumbnails', `${key}.webp`);
    try { await lstat(output); return output; } catch { /* generate below */ }
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      await sharp(source, { limitInputPixels: 80_000_000, failOn: 'none' }).rotate().resize(560, 360, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(temporary);
      await rename(temporary, output);
      return output;
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return undefined;
    }
  }

  async reconcile(): Promise<{ indexed: number; removed: number }> {
    return this.withMutationLock(async () => {
      await this.storage.requireReady();
      const job = this.db.startJob('reconcile');
      try {
        const seen = new Set<string>(); let indexed = 0;
        for await (const entry of this.storage.walk()) {
          seen.add(entry.relativePath);
          this.db.upsertDiskEntry(entry, entry.isDirectory ? null : mimeFromName(entry.name)); indexed++;
        }
        const removed = this.db.removeMissing(seen);
        this.db.finishJob(job, 'complete', `Indexed ${indexed} entries; removed ${removed} stale records.`);
        this.record('reconciled', null, null, `indexed=${indexed};removed=${removed}`);
        return { indexed, removed };
      } catch (error) {
        this.db.finishJob(job, 'failed', error instanceof Error ? error.message.slice(0, 500) : 'Unknown error');
        throw error;
      }
    });
  }

  async pruneVersions(nodeId: string, retain: number): Promise<number> {
    const stale = this.db.versionsBeyondRetention(nodeId, retain);
    for (const version of stale) {
      await rm(await this.storage.internalExisting(version.storedPath), { force: true });
      this.db.deleteVersion(version.id);
    }
    return stale.length;
  }

  private async indexTree(relativePath: string): Promise<FileNode[]> {
    const found: FileNode[] = [];
    const root = await this.diskEntry(relativePath);
    found.push(this.db.upsertDiskEntry(root, root.isDirectory ? null : mimeFromName(root.name)));
    if (root.isDirectory) for await (const entry of this.storage.walk(relativePath)) found.push(this.db.upsertDiskEntry(entry, entry.isDirectory ? null : mimeFromName(entry.name)));
    return found;
  }
  private async diskEntry(relativePath: string): Promise<DiskEntry> {
    const path = await this.storage.pathFor(relativePath); const info = await lstat(path);
    return { relativePath, name: basename(relativePath), isDirectory: info.isDirectory(), size: info.size, birthtime: info.birthtime, mtime: info.mtime };
  }
  private async availablePath(parent: string, requestedName: string): Promise<string> {
    const name = normalizeFileName(requestedName); const extension = extname(name); const stem = extension ? name.slice(0, -extension.length) : name;
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const candidate = joinRelative(parent, attempt === 0 ? name : `${stem} (${attempt})${extension}`);
      if (!(await this.exists(candidate))) return candidate;
    }
    throw fail.conflict('Could not find an available file name.');
  }
  private async exists(relativePath: string): Promise<boolean> {
    try { await lstat(this.storage.pathForNew(relativePath)); return true; } catch (error: unknown) { if ((error as { code?: string }).code === 'ENOENT') return false; throw error; }
  }
  private async withLock<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    locks.set(key, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }
  async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    this.mutationQueue = current;
    await previous;
    try { return await action(); }
    finally { release(); }
  }
  private removeActiveMetadata(item: FileNode): void {
    // Reconciliation owns full recovery; direct-folder refresh only removes a stale
    // missing leaf. It never touches trash or the internal version store.
    if (!item.trashedAt) this.db.removeActivePathPrefix(item.relativePath);
  }
  private record(action: string, nodeId: string | null, path: string | null, detail: string | null = null, options: { operation?: import('../shared/types.js').SyncOperation; previousPath?: string | null; revision?: number | null; checksum?: string | null; deviceId?: string } = {}): void {
    this.db.addActivity(action, nodeId, path, detail);
    this.db.addChange(action, nodeId, path, detail, options);
  }
}

async function copyWithoutSymlinks(source: string, destination: string, markCreated?: () => void): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw fail.forbidden('Symlinks cannot be copied into Continental Cloud.');
  if (info.isFile()) { await copyFile(source, destination, constants.COPYFILE_EXCL); markCreated?.(); return; }
  if (!info.isDirectory()) throw fail.badRequest('Only regular files and folders are supported.');
  await mkdir(destination, { mode: 0o750 });
  markCreated?.();
  for (const entry of await readdir(source)) await copyWithoutSymlinks(join(source, entry), join(destination, entry));
}

async function rollbackRename(from: string, to: string): Promise<void> {
  try { await rename(from, to); }
  catch { throw fail.unavailable('The storage changed while metadata was being updated. Reconcile the cloud before retrying.'); }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const existing = await lstat(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw fail.unavailable('Private storage layout is invalid; writes are blocked.');
    return;
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error: unknown) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) throw fail.unavailable('Private storage layout is invalid; writes are blocked.');
}
