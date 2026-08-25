import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActivityEvent, ChangeEvent, FileNode, JobStatus, UploadSession } from '../shared/types.js';
import type { DiskEntry } from './storage.js';
import { parentPath } from './paths.js';

type NodeRow = {
  id: string; relative_path: string; parent_path: string; name: string; is_directory: number; mime_type: string | null;
  size: number; created_at: string; modified_at: string; checksum: string | null; favorite: number; trashed_at: string | null;
};

function now(): string { return new Date().toISOString(); }
function node(row: NodeRow): FileNode {
  return { id: row.id, relativePath: row.relative_path, parentPath: row.parent_path, name: row.name, isDirectory: Boolean(row.is_directory), mimeType: row.mime_type, size: row.size, createdAt: row.created_at, modifiedAt: row.modified_at, checksum: row.checksum, favorite: Boolean(row.favorite), trashedAt: row.trashed_at };
}
function json<T>(value: string): T { return JSON.parse(value) as T; }

export class MetadataDatabase {
  private db!: DatabaseSync;
  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, parent_path TEXT NOT NULL, name TEXT NOT NULL,
        is_directory INTEGER NOT NULL, mime_type TEXT, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL, checksum TEXT, favorite INTEGER NOT NULL DEFAULT 0, trashed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS nodes_parent_active ON nodes(parent_path, trashed_at);
      CREATE INDEX IF NOT EXISTS nodes_modified_active ON nodes(modified_at DESC) WHERE trashed_at IS NULL;
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, stored_path TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL, mime_type TEXT, size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trash_items (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), storage_key TEXT NOT NULL UNIQUE,
        original_path TEXT NOT NULL, deleted_at TEXT NOT NULL, name TEXT NOT NULL, is_directory INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS upload_sessions (
        id TEXT PRIMARY KEY, parent_path TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT, size INTEGER NOT NULL,
        chunk_size INTEGER NOT NULL, chunk_count INTEGER NOT NULL, received_chunks TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL, created_at TEXT NOT NULL, temp_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, node_id TEXT, path TEXT, detail TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_created ON activity(created_at DESC);
      CREATE TABLE IF NOT EXISTS change_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, node_id TEXT, path TEXT, detail TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS change_journal_node ON change_journal(node_id, sequence);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(node_id UNINDEXED, name, relative_path);
    `);
  }

  close(): void { this.db?.close(); }
  health(): { ok: boolean } { this.db.prepare('SELECT 1').get(); return { ok: true }; }

  upsertDiskEntry(entry: DiskEntry, mimeType: string | null = null): FileNode {
    const existing = this.db.prepare('SELECT * FROM nodes WHERE relative_path = ?').get(entry.relativePath) as NodeRow | undefined;
    const timestamp = now();
    if (existing) {
      this.db.prepare(`UPDATE nodes SET parent_path=?, name=?, is_directory=?, mime_type=COALESCE(?, mime_type), size=?, modified_at=?, trashed_at=NULL WHERE id=?`)
        .run(parentPath(entry.relativePath), entry.name, Number(entry.isDirectory), mimeType, entry.size, entry.mtime.toISOString(), existing.id);
      this.upsertFts(existing.id, entry.name, entry.relativePath);
      return this.getNode(existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO nodes (id,relative_path,parent_path,name,is_directory,mime_type,size,created_at,modified_at,checksum,favorite,trashed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL)`).run(id, entry.relativePath, parentPath(entry.relativePath), entry.name, Number(entry.isDirectory), mimeType, entry.size, entry.birthtime.toISOString() || timestamp, entry.mtime.toISOString() || timestamp, null);
    this.upsertFts(id, entry.name, entry.relativePath);
    return this.getNode(id)!;
  }

  createNode(relativePath: string, name: string, isDirectory: boolean, size = 0, mimeType: string | null = null): FileNode {
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO nodes (id,relative_path,parent_path,name,is_directory,mime_type,size,created_at,modified_at,checksum,favorite,trashed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL)`).run(id, relativePath, parentPath(relativePath), name, Number(isDirectory), mimeType, size, timestamp, timestamp, null);
    this.upsertFts(id, name, relativePath);
    return this.getNode(id)!;
  }

  getNode(id: string): FileNode | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as NodeRow | undefined;
    return row ? node(row) : undefined;
  }
  getActiveNodeByPath(relativePath: string): FileNode | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE relative_path=? AND trashed_at IS NULL').get(relativePath) as NodeRow | undefined;
    return row ? node(row) : undefined;
  }
  listChildren(parent: string, sort: string = 'name', direction: string = 'asc'): FileNode[] {
    const order = sort === 'modified' ? 'modified_at' : sort === 'size' ? 'size' : 'name COLLATE NOCASE';
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    return (this.db.prepare(`SELECT * FROM nodes WHERE parent_path=? AND trashed_at IS NULL ORDER BY is_directory DESC, ${order} ${dir}`).all(parent) as NodeRow[]).map(node);
  }
  listRecent(limit = 60): FileNode[] {
    return (this.db.prepare('SELECT * FROM nodes WHERE trashed_at IS NULL AND is_directory=0 ORDER BY modified_at DESC LIMIT ?').all(limit) as NodeRow[]).map(node);
  }
  listFavorites(): FileNode[] {
    return (this.db.prepare('SELECT * FROM nodes WHERE trashed_at IS NULL AND favorite=1 ORDER BY modified_at DESC').all() as NodeRow[]).map(node);
  }
  search(query: string, limit = 100, filters: { extension?: string; type?: string; favorite?: boolean; trashed?: boolean; minSize?: number; maxSize?: number; before?: string; after?: string; path?: string } = {}): FileNode[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    const where = this.searchWhere(filters);
    if (!terms.length) return (this.db.prepare(`SELECT * FROM nodes WHERE ${where.sql} ORDER BY modified_at DESC LIMIT ?`).all(...where.params, limit) as NodeRow[]).map(node);
    const expression = terms.map((term) => `${term.replaceAll('"', '')}*`).join(' AND ');
    const indexed = this.db.prepare(`SELECT n.* FROM files_fts f JOIN nodes n ON n.id=f.node_id WHERE files_fts MATCH ? AND ${where.sql} ORDER BY rank LIMIT ?`).all(expression, ...where.params, limit) as NodeRow[];
    if (indexed.length) return indexed.map(node);
    // FTS tokenizer differences should not make names undiscoverable. This fallback
    // is also useful for punctuation-heavy project names and remains parameterized.
    const termsSql = terms.map(() => '(name LIKE ? OR relative_path LIKE ?)').join(' AND ');
    const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    return (this.db.prepare(`SELECT * FROM nodes WHERE ${where.sql} AND ${termsSql} ORDER BY modified_at DESC LIMIT ?`).all(...where.params, ...params, limit) as NodeRow[]).map(node);
  }
  setFavorite(id: string, favorite: boolean): FileNode | undefined {
    this.db.prepare('UPDATE nodes SET favorite=?, modified_at=? WHERE id=? AND trashed_at IS NULL').run(Number(favorite), now(), id);
    return this.getNode(id);
  }
  updateFileAfterUpload(id: string, size: number, mimeType: string | null): FileNode {
    this.db.prepare('UPDATE nodes SET size=?, mime_type=?, modified_at=?, trashed_at=NULL WHERE id=?').run(size, mimeType, now(), id);
    return this.getNode(id)!;
  }
  setChecksum(id: string, checksum: string): FileNode {
    this.db.prepare('UPDATE nodes SET checksum=? WHERE id=?').run(checksum, id);
    return this.getNode(id)!;
  }
  movePrefix(id: string, from: string, to: string): void {
    const rows = this.db.prepare('SELECT id,relative_path,name FROM nodes WHERE relative_path=? OR relative_path LIKE ? ORDER BY LENGTH(relative_path) ASC').all(from, `${from}/%`) as Array<{ id: string; relative_path: string; name: string }>;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const suffix = row.relative_path === from ? '' : row.relative_path.slice(from.length);
        const next = `${to}${suffix}`;
        const nextName = next.includes('/') ? next.slice(next.lastIndexOf('/') + 1) : next;
        this.db.prepare('UPDATE nodes SET relative_path=?,parent_path=?,name=?,modified_at=? WHERE id=?').run(next, parentPath(next), nextName, now(), row.id);
        this.upsertFts(row.id, nextName, next);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (!rows.length) throw new Error(`No node metadata found for ${id}`);
  }
  markTrashed(id: string, originalPath: string, storageKey: string): string {
    const itemId = randomUUID(); const deletedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE nodes SET trashed_at=? WHERE relative_path=? OR relative_path LIKE ?').run(deletedAt, originalPath, `${originalPath}/%`);
      const target = this.getNode(id);
      if (!target) throw new Error('Missing node.');
      this.db.prepare('INSERT INTO trash_items (id,node_id,storage_key,original_path,deleted_at,name,is_directory) VALUES (?,?,?,?,?,?,?)')
        .run(itemId, id, storageKey, originalPath, deletedAt, target.name, Number(target.isDirectory));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return itemId;
  }
  listTrash(): Array<{ id: string; originalPath: string; deletedAt: string; node: FileNode }> {
    const rows = this.db.prepare(`SELECT t.id as trash_id,t.original_path,t.deleted_at,n.* FROM trash_items t JOIN nodes n ON n.id=t.node_id ORDER BY t.deleted_at DESC`).all() as Array<NodeRow & { trash_id: string; original_path: string; deleted_at: string }>;
    return rows.map((row) => ({ id: row.trash_id, originalPath: row.original_path, deletedAt: row.deleted_at, node: node(row) }));
  }
  expiredTrash(before: string): Array<{ id: string }> { return this.db.prepare('SELECT id FROM trash_items WHERE deleted_at < ? ORDER BY deleted_at ASC').all(before).map((row: any) => ({ id: row.id })); }
  getTrash(id: string): { id: string; storageKey: string; originalPath: string; node: FileNode } | undefined {
    const row = this.db.prepare(`SELECT t.id as trash_id,t.storage_key,t.original_path,n.* FROM trash_items t JOIN nodes n ON n.id=t.node_id WHERE t.id=?`).get(id) as (NodeRow & { trash_id: string; storage_key: string; original_path: string }) | undefined;
    return row ? { id: row.trash_id, storageKey: row.storage_key, originalPath: row.original_path, node: node(row) } : undefined;
  }
  restoreTrash(id: string, restoredPath: string): FileNode | undefined {
    const item = this.getTrash(id); if (!item) return undefined;
    // Path rewrites use their own transaction. The filesystem move is deliberately
    // reconciled on startup if a process dies between that move and this update.
    this.movePrefix(item.node.id, item.originalPath, restoredPath);
    this.db.prepare('UPDATE nodes SET trashed_at=NULL WHERE relative_path=? OR relative_path LIKE ?').run(restoredPath, `${restoredPath}/%`);
    this.db.prepare('DELETE FROM trash_items WHERE id=?').run(id);
    return this.getNode(item.node.id);
  }
  removeTrash(id: string): { storageKey: string } | undefined {
    const item = this.getTrash(id); if (!item) return undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM trash_items WHERE id=?').run(id);
      this.deleteFtsForPath(item.originalPath, false);
      this.db.prepare('DELETE FROM nodes WHERE relative_path=? OR relative_path LIKE ?').run(item.originalPath, `${item.originalPath}/%`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { storageKey: item.storageKey };
  }
  createVersion(nodeId: string, storedPath: string, originalName: string, mimeType: string | null, size: number): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO versions (id,node_id,stored_path,original_name,mime_type,size,created_at) VALUES (?,?,?,?,?,?,?)').run(id, nodeId, storedPath, originalName, mimeType, size, now());
    return id;
  }
  deleteVersion(id: string): void { this.db.prepare('DELETE FROM versions WHERE id=?').run(id); }
  listVersions(nodeId: string): Array<{ id: string; storedPath: string; originalName: string; mimeType: string | null; size: number; createdAt: string }> {
    return this.db.prepare('SELECT id,stored_path,original_name,mime_type,size,created_at FROM versions WHERE node_id=? ORDER BY created_at DESC').all(nodeId)
      .map((row: any) => ({ id: row.id, storedPath: row.stored_path, originalName: row.original_name, mimeType: row.mime_type, size: row.size, createdAt: row.created_at }));
  }
  versionsBeyondRetention(nodeId: string, retain: number): Array<{ id: string; storedPath: string }> {
    return this.db.prepare('SELECT id,stored_path FROM versions WHERE node_id=? ORDER BY created_at DESC LIMIT -1 OFFSET ?').all(nodeId, retain)
      .map((row: any) => ({ id: row.id, storedPath: row.stored_path }));
  }
  getVersion(versionId: string): { id: string; nodeId: string; storedPath: string } | undefined {
    const row = this.db.prepare('SELECT id,node_id,stored_path FROM versions WHERE id=?').get(versionId) as { id: string; node_id: string; stored_path: string } | undefined;
    return row ? { id: row.id, nodeId: row.node_id, storedPath: row.stored_path } : undefined;
  }
  createUpload(session: UploadSession, tempName: string): void {
    this.db.prepare(`INSERT INTO upload_sessions (id,parent_path,name,mime_type,size,chunk_size,chunk_count,received_chunks,status,created_at,temp_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(session.id, session.parentPath, session.name, session.mimeType, session.size, session.chunkSize, session.chunkCount, JSON.stringify([]), session.status, session.createdAt, tempName);
  }
  getUpload(id: string): (UploadSession & { tempName: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(id) as any;
    return row ? { id: row.id, parentPath: row.parent_path, name: row.name, mimeType: row.mime_type, size: row.size, chunkSize: row.chunk_size, chunkCount: row.chunk_count, receivedChunks: json<number[]>(row.received_chunks), status: row.status, createdAt: row.created_at, tempName: row.temp_name } : undefined;
  }
  updateUploadChunks(id: string, receivedChunks: number[]): void { this.db.prepare('UPDATE upload_sessions SET received_chunks=? WHERE id=?').run(JSON.stringify(receivedChunks), id); }
  updateUploadStatus(id: string, status: UploadSession['status']): void { this.db.prepare('UPDATE upload_sessions SET status=? WHERE id=?').run(status, id); }
  deleteUpload(id: string): void { this.db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id); }
  staleUploads(before: string): Array<{ id: string; tempName: string }> { return this.db.prepare(`SELECT id,temp_name FROM upload_sessions WHERE status IN ('active','cancelled','failed') AND created_at < ?`).all(before).map((r: any) => ({ id: r.id, tempName: r.temp_name })); }
  addActivity(action: string, nodeId: string | null, path: string | null, detail: string | null = null): void {
    this.db.prepare('INSERT INTO activity (id,action,node_id,path,detail,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), action, nodeId, path, detail, now());
  }
  listActivity(limit = 100): ActivityEvent[] {
    return this.db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?').all(limit).map((row: any) => ({ id: row.id, action: row.action, nodeId: row.node_id, path: row.path, detail: row.detail, createdAt: row.created_at }));
  }
  addChange(action: string, nodeId: string | null, path: string | null, detail: string | null = null): number {
    return Number(this.db.prepare('INSERT INTO change_journal (action,node_id,path,detail,created_at) VALUES (?,?,?,?,?)').run(action, nodeId, path, detail, now()).lastInsertRowid);
  }
  listChanges(after = 0, limit = 250): ChangeEvent[] {
    return this.db.prepare('SELECT * FROM change_journal WHERE sequence>? ORDER BY sequence ASC LIMIT ?').all(after, limit).map((row: any) => ({ sequence: Number(row.sequence), action: row.action, nodeId: row.node_id, path: row.path, detail: row.detail, createdAt: row.created_at }));
  }
  latestChangeSequence(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0) as value FROM change_journal').get() as { value: number }).value); }
  startJob(kind: string, detail: string | null = null): string {
    const id = randomUUID(); this.db.prepare('INSERT INTO jobs (id,kind,state,detail,created_at,completed_at) VALUES (?,?,\'running\',?,?,NULL)').run(id, kind, detail, now()); return id;
  }
  finishJob(id: string, state: 'complete' | 'failed', detail: string | null = null): void { this.db.prepare('UPDATE jobs SET state=?,detail=?,completed_at=? WHERE id=?').run(state, detail, now(), id); }
  listJobs(limit = 25): JobStatus[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit).map((row: any) => ({ id: row.id, kind: row.kind, state: row.state, detail: row.detail, createdAt: row.created_at, completedAt: row.completed_at }));
  }
  usage(): number { return this.total('nodes', 'trashed_at IS NULL AND is_directory=0'); }
  storageBreakdown(): { managedBytes: number; trashBytes: number; versionBytes: number } {
    return { managedBytes: this.usage(), trashBytes: this.total('nodes', 'trashed_at IS NOT NULL AND is_directory=0'), versionBytes: this.total('versions', '1=1') };
  }
  removeMissing(activePaths: Set<string>): number {
    const current = this.db.prepare('SELECT id,relative_path FROM nodes WHERE trashed_at IS NULL').all() as Array<{ id: string; relative_path: string }>;
    const absent = current.filter((row) => !activePaths.has(row.relative_path));
    for (const row of absent) { this.db.prepare('DELETE FROM files_fts WHERE node_id=?').run(row.id); this.db.prepare('DELETE FROM nodes WHERE id=?').run(row.id); }
    return absent.length;
  }
  removeActivePathPrefix(relativePath: string): void {
    this.deleteFtsForPath(relativePath, true);
    this.db.prepare('DELETE FROM nodes WHERE trashed_at IS NULL AND (relative_path=? OR relative_path LIKE ?)').run(relativePath, `${relativePath}/%`);
  }
  private upsertFts(id: string, name: string, path: string): void {
    this.db.prepare('DELETE FROM files_fts WHERE node_id=?').run(id);
    this.db.prepare('INSERT INTO files_fts (node_id,name,relative_path) VALUES (?,?,?)').run(id, name, path);
  }
  private total(table: 'nodes' | 'versions', where: string): number { return Number((this.db.prepare(`SELECT COALESCE(SUM(size),0) as total FROM ${table} WHERE ${where}`).get() as { total: number }).total); }
  private searchWhere(filters: { extension?: string; type?: string; favorite?: boolean; trashed?: boolean; minSize?: number; maxSize?: number; before?: string; after?: string; path?: string }): { sql: string; params: Array<string | number> } {
    const clauses: string[] = [filters.trashed ? 'trashed_at IS NOT NULL' : 'trashed_at IS NULL']; const params: Array<string | number> = [];
    if (filters.extension) { clauses.push('name LIKE ?'); params.push(`%.${filters.extension.replace(/^\./, '').replace(/[%_]/g, '\\$&')}`); }
    if (filters.type) { clauses.push('mime_type LIKE ?'); params.push(`${filters.type.replace(/[%_]/g, '\\$&')}%`); }
    if (filters.favorite !== undefined) { clauses.push('favorite=?'); params.push(Number(filters.favorite)); }
    if (filters.minSize !== undefined) { clauses.push('size>=?'); params.push(filters.minSize); }
    if (filters.maxSize !== undefined) { clauses.push('size<=?'); params.push(filters.maxSize); }
    if (filters.before) { clauses.push('modified_at<?'); params.push(filters.before); }
    if (filters.after) { clauses.push('modified_at>?'); params.push(filters.after); }
    if (filters.path) { clauses.push('(relative_path=? OR relative_path LIKE ?)'); params.push(filters.path, `${filters.path}/%`); }
    return { sql: clauses.join(' AND '), params };
  }
  private deleteFtsForPath(relativePath: string, activeOnly: boolean): void {
    const active = activeOnly ? ' AND trashed_at IS NULL' : '';
    const rows = this.db.prepare(`SELECT id FROM nodes WHERE (relative_path=? OR relative_path LIKE ?)${active}`).all(relativePath, `${relativePath}/%`) as Array<{ id: string }>;
    for (const row of rows) this.db.prepare('DELETE FROM files_fts WHERE node_id=?').run(row.id);
  }
}

export function metadataPath(storageRoot: string): string { return join(storageRoot, '.continental', 'metadata.db'); }
