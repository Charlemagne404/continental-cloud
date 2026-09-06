import { access, constants, lstat, mkdir, open, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CloudConfig, StorageStatus } from '../shared/types.js';
import { fail } from './errors.js';
import { assertContained, joinRelative, normalizeRelativePath, parentPath, resolveExistingNoSymlink } from './paths.js';

class StorageLayoutError extends Error {}

export interface DiskEntry {
  relativePath: string;
  name: string;
  isDirectory: boolean;
  size: number;
  birthtime: Date;
  mtime: Date;
}

export class Storage {
  readonly dataRoot: string;
  readonly internalRoot: string;
  readonly trashRoot: string;
  private status: StorageStatus = { state: 'offline', detail: 'Storage has not been checked yet.' };
  private lastWritableProbe = 0;
  private writable = false;

  constructor(private readonly config: CloudConfig) {
    this.dataRoot = join(config.storagePath, 'data');
    this.internalRoot = join(config.storagePath, '.continental');
    this.trashRoot = join(config.storagePath, '.trash');
  }

  async initialize(): Promise<StorageStatus> {
    try {
      await lstat(this.config.storagePath);
    } catch (error: unknown) {
      if (!this.config.allowStorageInitialization || (error as { code?: string }).code !== 'ENOENT') return this.setOffline('Storage mount is unavailable.');
      await mkdir(this.config.storagePath, { recursive: true, mode: 0o750 });
    }
    const rootStat = await lstat(this.config.storagePath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return this.setMisconfigured('CLOUD_STORAGE_PATH must be a real directory, not a symlink.');
    try { await this.assertExistingLayout(); }
    catch (error: unknown) { return error instanceof StorageLayoutError ? this.setMisconfigured(error.message) : this.setOffline('Storage layout cannot be inspected safely.'); }
    const idPath = join(this.internalRoot, 'storage-id');
    try { await this.assertExistingFile(idPath); }
    catch (error: unknown) { return error instanceof StorageLayoutError ? this.setMisconfigured(error.message) : this.setOffline('Cannot inspect the storage identity file safely.'); }
    let storageId: string;
    try {
      storageId = (await readFile(idPath, 'utf8')).trim();
      if (!storageId) return this.setMisconfigured('Storage identity file is empty.');
      if (this.config.expectedStorageId && storageId !== this.config.expectedStorageId) return this.setMisconfigured('Storage identity does not match CLOUD_STORAGE_ID.');
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'ENOENT') return this.setOffline('Cannot read the storage identity file.');
      // Never make a new identity when a production mount is missing: an empty mountpoint is not blank storage.
      if (!this.config.allowStorageInitialization || this.config.expectedStorageId) return this.setOffline('Storage identity is missing; refusing to treat this as empty storage.');
      try { await this.ensureLayout(); }
      catch (error: unknown) { return error instanceof StorageLayoutError ? this.setMisconfigured(error.message) : this.setOffline('Storage layout cannot be prepared safely.'); }
      storageId = randomUUID();
      try { await writeFile(idPath, `${storageId}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
      catch (writeError: unknown) {
        if ((writeError as { code?: string }).code !== 'EEXIST') throw writeError;
        storageId = (await readFile(idPath, 'utf8')).trim();
        if (!storageId) return this.setMisconfigured('Storage identity file is empty.');
      }
    }
    try { await this.ensureLayout(); }
    catch (error: unknown) { return error instanceof StorageLayoutError ? this.setMisconfigured(error.message) : this.setOffline('Storage layout cannot be prepared safely.'); }
    await this.probeWritable();
    return this.setReady(storageId);
  }

  async refresh(): Promise<StorageStatus> {
    const started = performance.now();
    const idPath = join(this.internalRoot, 'storage-id');
    try {
      const root = await lstat(this.config.storagePath);
      if (root.isSymbolicLink() || !root.isDirectory()) return this.setMisconfigured('Storage root changed to a non-directory or symlink.');
      await this.assertExistingLayout();
      await this.assertExistingFile(idPath);
      const storageId = (await readFile(idPath, 'utf8')).trim();
      if (!storageId || (this.config.expectedStorageId && storageId !== this.config.expectedStorageId)) return this.setOffline('Storage identity is missing or does not match.');
      await access(this.dataRoot, constants.R_OK | constants.W_OK);
      if (Date.now() - this.lastWritableProbe > 30_000) await this.probeWritable();
      if (!this.writable) return this.setOffline('Storage is mounted but not writable. Writes are blocked.');
      const fs = await statfs(this.config.storagePath);
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      const detail = freeBytes < this.config.minFreeBytes ? `Free space is below the configured safety reserve (${this.config.minFreeBytes} bytes).` : undefined;
      return this.setReady(storageId, freeBytes, Number(fs.blocks) * Number(fs.bsize), performance.now() - started, detail);
    } catch (error: unknown) {
      if (error instanceof StorageLayoutError) return this.setMisconfigured(error.message);
      return this.setOffline('Storage mount cannot be read safely. Writes are blocked.');
    }
  }

  getStatus(): StorageStatus { return this.status; }

  async requireReady(): Promise<void> {
    const status = await this.refresh();
    if (status.state !== 'ready') throw fail.unavailable(status.detail ?? 'Storage is unavailable.');
  }

  async pathFor(relativePath: string): Promise<string> {
    await this.requireReady();
    return resolveExistingNoSymlink(this.dataRoot, normalizeRelativePath(relativePath));
  }

  /** Validates metadata-derived paths before touching private version/thumbnail state. */
  async internalExisting(candidate: string): Promise<string> {
    assertContained(this.internalRoot, candidate);
    const rel = relative(this.internalRoot, candidate);
    return resolveExistingNoSymlink(this.internalRoot, rel);
  }

  trashPath(storageKey: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storageKey)) throw fail.forbidden('Invalid private Trash storage key.');
    return join(this.trashRoot, storageKey);
  }

  pathForNew(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const candidate = join(this.dataRoot, ...normalized.split('/').filter(Boolean));
    assertContained(this.dataRoot, candidate);
    return candidate;
  }

  async assertParentSafe(relativePath: string): Promise<string> {
    await this.requireReady();
    const parent = parentPath(normalizeRelativePath(relativePath));
    const resolved = await resolveExistingNoSymlink(this.dataRoot, parent);
    if (!(await lstat(resolved)).isDirectory()) throw fail.conflict('The destination parent is not a folder.');
    return resolved;
  }

  async list(relativePath = ''): Promise<DiskEntry[]> {
    await this.requireReady();
    const normalized = normalizeRelativePath(relativePath);
    const folder = await resolveExistingNoSymlink(this.dataRoot, normalized);
    if (!(await lstat(folder)).isDirectory()) throw fail.badRequest('The requested path is not a folder.');
    const entries = await readdir(folder, { withFileTypes: true });
    const result: DiskEntry[] = [];
    for (const entry of entries) {
      const child = joinRelative(normalized, entry.name);
      const childPath = join(folder, entry.name);
      const item = await lstat(childPath);
      if (item.isSymbolicLink()) continue;
      if (!item.isFile() && !item.isDirectory()) continue;
      result.push({ relativePath: child, name: entry.name, isDirectory: item.isDirectory(), size: item.size, birthtime: item.birthtime, mtime: item.mtime });
    }
    return result;
  }

  async *walk(relativePath = ''): AsyncGenerator<DiskEntry> {
    for (const entry of await this.list(relativePath)) {
      yield entry;
      if (entry.isDirectory) yield* this.walk(entry.relativePath);
    }
  }

  createReadStream(relativePath: string) {
    return createReadStream(this.pathForNew(normalizeRelativePath(relativePath)), { flags: 'r' });
  }

  private async ensureLayout(): Promise<void> {
    await this.ensureDirectory(this.dataRoot, 0o750);
    await this.ensureDirectory(this.internalRoot, 0o700);
    await this.ensureDirectory(join(this.internalRoot, 'thumbnails'), 0o700);
    await this.ensureDirectory(join(this.internalRoot, 'versions'), 0o700);
    await this.ensureDirectory(join(this.internalRoot, 'temp'), 0o700);
    await this.ensureDirectory(this.trashRoot, 0o700);
    await this.assertExistingLayout();
  }

  private async ensureDirectory(directory: string, mode: number): Promise<void> {
    try {
      const existing = await lstat(directory);
      if (existing.isSymbolicLink()) throw new StorageLayoutError('Storage layout contains a symlink; writes are blocked.');
      if (!existing.isDirectory()) throw new StorageLayoutError('Storage layout contains a non-directory; writes are blocked.');
      return;
    } catch (error: unknown) {
      if (error instanceof StorageLayoutError) throw error;
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    await mkdir(directory, { mode });
    const created = await lstat(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new StorageLayoutError('Storage layout contains a symlink or non-directory; writes are blocked.');
  }

  private async assertExistingLayout(): Promise<void> {
    const directories = [
      this.dataRoot,
      this.internalRoot,
      join(this.internalRoot, 'thumbnails'),
      join(this.internalRoot, 'versions'),
      join(this.internalRoot, 'temp'),
      this.trashRoot,
    ];
    for (const directory of directories) {
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink()) throw new StorageLayoutError('Storage layout contains a symlink; writes are blocked.');
        if (!info.isDirectory()) throw new StorageLayoutError('Storage layout contains a non-directory; writes are blocked.');
      } catch (error: unknown) {
        if (error instanceof StorageLayoutError) throw error;
        if ((error as { code?: string }).code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  private async assertExistingFile(file: string): Promise<void> {
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new StorageLayoutError('Storage identity must be a regular file; writes are blocked.');
      if (!info.isFile()) throw new StorageLayoutError('Storage identity must be a regular file; writes are blocked.');
    } catch (error: unknown) {
      if (error instanceof StorageLayoutError) throw error;
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
  }

  /** A real write catches SMB read-only mounts that access(W_OK) can miss. */
  private async probeWritable(): Promise<void> {
    const probe = join(this.internalRoot, `.write-probe-${randomUUID()}`);
    this.lastWritableProbe = Date.now();
    try {
      const handle = await open(probe, 'wx', 0o600);
      await handle.close();
      await rm(probe, { force: true });
      this.writable = true;
    } catch {
      this.writable = false;
    }
  }

  private setReady(storageId: string, freeBytes?: number, totalBytes?: number, latencyMs?: number, detail?: string): StorageStatus {
    this.status = { state: 'ready', storageId, freeBytes, totalBytes, writable: this.writable, latencyMs: Math.round(latencyMs ?? 0), checkedAt: new Date().toISOString(), detail };
    return this.status;
  }
  private setOffline(detail: string): StorageStatus { this.status = { state: 'offline', detail }; return this.status; }
  private setMisconfigured(detail: string): StorageStatus { this.status = { state: 'misconfigured', detail }; return this.status; }
}
