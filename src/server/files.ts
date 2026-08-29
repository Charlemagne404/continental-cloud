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
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.ts': 'text/typescript; charset=utf-8', '.tsx': 'text/typescript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8', '.go': 'text/x-go; charset=utf-8', '.rs': 'text/x-rust; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.zip': 'application/zip',
};
export function mimeFromName(name: string): string | null { return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'; }
export function isPreviewable(mime: string | null): boolean { return Boolean(mime && ((mime.startsWith('image/') && mime !== 'image/svg+xml') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf' || mime.startsWith('text/') || mime === 'application/json')); }

export class FileService {
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
    const normalized = normalizeRelativePath(relativePath);
    await this.syncDirectory(normalized);
    return this.db.listChildren(normalized, sort, direction);
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
    await this.storage.assertParentSafe(joinRelative(targetParent, name));
    const relativePath = joinRelative(targetParent, name);
    if (await this.exists(relativePath)) throw fail.conflict('An item with that name already exists.');
    await mkdir(this.storage.pathForNew(relativePath), { mode: 0o750 });
    const created = this.db.createNode(relativePath, name, true);
    this.record('folder_created', created.id, relativePath, null, { operation: 'folder_create', revision: created.revision, deviceId });
    return created;
  }

  async rename(id: string, inputName: unknown, deviceId?: string): Promise<FileNode> {
    const item = await this.getNode(id);
    const name = normalizeFileName(inputName);
    const target = joinRelative(item.parentPath, name);
    if (target === item.relativePath) return item;
    if (await this.exists(target)) throw fail.conflict('An item with that name already exists.');
    await this.storage.assertParentSafe(target);
    await rename(await this.storage.pathFor(item.relativePath), this.storage.pathForNew(target));
    this.db.movePrefix(item.id, item.relativePath, target);
    const moved = this.db.getNode(id)!;
    this.record('renamed', id, target, null, { operation: 'rename', previousPath: item.relativePath, revision: moved.revision, checksum: moved.checksum, deviceId });
    return moved;
  }

  async move(id: string, targetParentInput: unknown, deviceId?: string): Promise<FileNode> {
    const item = await this.getNode(id);
    const targetParent = normalizeRelativePath(targetParentInput);
    const target = joinRelative(targetParent, item.name);
    if (target === item.relativePath) return item;
    if (item.isDirectory && (targetParent === item.relativePath || targetParent.startsWith(`${item.relativePath}/`))) throw fail.conflict('A folder cannot be moved into itself.');
    await this.storage.assertParentSafe(target);
    if (await this.exists(target)) throw fail.conflict('An item with that name already exists in the destination.');
    await rename(await this.storage.pathFor(item.relativePath), this.storage.pathForNew(target));
    this.db.movePrefix(item.id, item.relativePath, target);
    const moved = this.db.getNode(id)!;
    this.record('moved', id, target, null, { operation: 'move', previousPath: item.relativePath, revision: moved.revision, checksum: moved.checksum, deviceId });
    return moved;
  }

  async relocate(id: string, targetInput: unknown, deviceId?: string): Promise<FileNode> {
    const item = await this.getNode(id);
    const target = normalizeRelativePath(targetInput, { allowEmpty: false });
    if (target === item.relativePath) return item;
    if (item.isDirectory && (target.startsWith(`${item.relativePath}/`) || item.relativePath.startsWith(`${target}/`))) throw fail.conflict('A folder cannot be moved into itself or replace an ancestor.');
    await this.storage.assertParentSafe(target);
    if (await this.exists(target)) throw fail.conflict('An item with that name already exists in the destination.');
    await rename(await this.storage.pathFor(item.relativePath), this.storage.pathForNew(target));
    this.db.movePrefix(item.id, item.relativePath, target);
    const moved = this.db.getNode(id)!;
    const operation = item.parentPath === moved.parentPath ? 'rename' : item.name === moved.name ? 'move' : 'move';
    this.record(operation === 'rename' ? 'renamed' : 'moved', id, target, null, { operation, previousPath: item.relativePath, revision: moved.revision, checksum: moved.checksum, deviceId });
    return moved;
  }

  async copy(id: string, targetParentInput: unknown, deviceId?: string): Promise<FileNode> {
    const item = await this.getNode(id);
    const targetParent = normalizeRelativePath(targetParentInput);
    if (item.isDirectory && (targetParent === item.relativePath || targetParent.startsWith(`${item.relativePath}/`))) throw fail.conflict('A folder cannot be copied into itself.');
    const target = await this.availablePath(targetParent, item.name);
    await this.storage.assertParentSafe(target);
    await copyWithoutSymlinks(await this.storage.pathFor(item.relativePath), this.storage.pathForNew(target));
    const indexed = await this.indexTree(target);
    const created = indexed.find((entry) => entry.relativePath === target);
    if (!created) throw new Error('Copied item was not indexed.');
    this.record('copied', created.id, target, item.relativePath, { operation: 'create', revision: created.revision, checksum: created.checksum, deviceId });
    return created;
  }

  async trash(id: string, deviceId?: string): Promise<string> {
    const item = await this.getNode(id);
    const storageKey = randomUUID();
    await this.storage.requireReady();
    await rename(await this.storage.pathFor(item.relativePath), this.storage.trashPath(storageKey));
    const trashId = this.db.markTrashed(id, item.relativePath, storageKey);
    const trashed = this.db.getNode(id)!;
    this.record('trashed', id, item.relativePath, null, { operation: item.isDirectory ? 'folder_delete' : 'delete', revision: trashed.revision, checksum: trashed.checksum, deviceId });
    return trashId;
  }

  async restoreTrash(id: string, deviceId?: string): Promise<FileNode> {
    await this.storage.requireReady();
    const item = this.db.getTrash(id); if (!item) throw fail.notFound('Trash item not found.');
    const target = await this.availablePath(parentPath(item.originalPath), basename(item.originalPath));
    await this.storage.assertParentSafe(target);
    await rename(this.storage.trashPath(item.storageKey), this.storage.pathForNew(target));
    const restored = this.db.restoreTrash(id, target); if (!restored) throw new Error('Unable to restore trash metadata.');
    this.record('restored', restored.id, target, item.originalPath, { operation: 'restore', previousPath: item.originalPath, revision: restored.revision, checksum: restored.checksum, deviceId });
    return restored;
  }

  async permanentlyDeleteTrash(id: string): Promise<void> {
    await this.storage.requireReady();
    const item = this.db.getTrash(id); if (!item) throw fail.notFound('Trash item not found.');
    await rm(this.storage.trashPath(item.storageKey), { recursive: true, force: false, maxRetries: 2 });
    this.db.removeTrash(id);
    this.record('permanently_deleted', item.node.id, item.originalPath);
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
    const folder = join(this.storage.internalRoot, 'versions', existing.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const versionPath = join(folder, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await rename(destination, versionPath);
    const versionId = this.db.createVersion(existing.id, versionPath, existing.name, existing.mimeType, info.size);
    return { versionId, versionPath };
  }

  /** A deterministic, human-readable name that never overwrites another device's work. */
  async conflictPath(parent: string, name: string, deviceName: string): Promise<string> {
    const extension = extname(name); const stem = extension ? name.slice(0, -extension.length) : name;
    const date = new Date().toISOString().slice(0, 10);
    const safeDevice = deviceName.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80) || 'Device';
    return this.availablePath(parent, `${stem} (Conflict - ${safeDevice} - ${date})${extension}`);
  }

  async restoreVersion(versionId: string, deviceId?: string): Promise<FileNode> {
    const version = this.db.getVersion(versionId); if (!version) throw fail.notFound('Version not found.');
    const item = await this.getNode(version.nodeId);
    const activePath = await this.storage.pathFor(item.relativePath);
    const versionPath = await this.storage.internalExisting(version.storedPath);
    const versionInfo = await lstat(versionPath);
    const folder = join(this.storage.internalRoot, 'versions', item.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const currentPath = join(folder, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    const stagedPath = join(this.storage.internalRoot, 'temp', `${randomUUID()}.restore`);
    await copyFile(versionPath, stagedPath);
    await rename(activePath, currentPath);
    try { await rename(stagedPath, activePath); } catch (error) { await rename(currentPath, activePath); throw error; }
    this.db.createVersion(item.id, currentPath, item.name, item.mimeType, (await lstat(currentPath)).size);
    const restored = this.db.updateFileAfterUpload(item.id, versionInfo.size, item.mimeType);
    this.record('version_restored', item.id, item.relativePath, versionId, { operation: 'modify', revision: restored.revision, checksum: restored.checksum, deviceId });
    return restored;
  }

  async restoreVersionAsCopy(versionId: string): Promise<FileNode> {
    const version = this.db.getVersion(versionId); if (!version) throw fail.notFound('Version not found.');
    const item = await this.getNode(version.nodeId); const target = await this.availablePath(item.parentPath, item.name);
    await this.storage.assertParentSafe(target); await copyFile(await this.storage.internalExisting(version.storedPath), this.storage.pathForNew(target));
    const info = await lstat(await this.storage.pathFor(target)); const created = this.db.createNode(target, basename(target), false, info.size, item.mimeType);
    this.record('version_restored_as_copy', created.id, target, versionId, { operation: 'create', revision: created.revision, checksum: created.checksum });
    return created;
  }

  async thumbnail(id: string): Promise<string | undefined> {
    const item = await this.getNode(id);
    if (!item.mimeType?.startsWith('image/') || item.mimeType === 'image/svg+xml') return undefined;
    const source = await this.storage.pathFor(item.relativePath);
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

async function copyWithoutSymlinks(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw fail.forbidden('Symlinks cannot be copied into Continental Cloud.');
  if (info.isFile()) { await copyFile(source, destination); return; }
  if (!info.isDirectory()) throw fail.badRequest('Only regular files and folders are supported.');
  await mkdir(destination, { mode: 0o750 });
  for (const entry of await readdir(source)) await copyWithoutSymlinks(join(source, entry), join(destination, entry));
}
