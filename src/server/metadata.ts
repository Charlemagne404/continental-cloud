import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type ActivityEvent, type ChangeEvent, type FileNode, type JobStatus, type SavedSearch, type SyncDevice, type SyncMapping, type SyncOperation, type SyncPairing, type SyncPolicy, type SyncProgress, type Tag, type UploadSession } from '../shared/types.js';
import { normalizeSyncPolicy } from '../shared/sync-policy.js';
import type { DiskEntry } from './storage.js';
import { parentPath } from './paths.js';

type NodeRow = {
  id: string; relative_path: string; parent_path: string; name: string; is_directory: number; mime_type: string | null;
  size: number; created_at: string; modified_at: string; checksum: string | null; revision: number; favorite: number; trashed_at: string | null;
};

function now(): string { return new Date().toISOString(); }
function node(row: NodeRow): FileNode {
  return { id: row.id, relativePath: row.relative_path, parentPath: row.parent_path, name: row.name, isDirectory: Boolean(row.is_directory), mimeType: row.mime_type, size: row.size, createdAt: row.created_at, modifiedAt: row.modified_at, checksum: row.checksum, revision: row.revision ?? 1, favorite: Boolean(row.favorite), trashedAt: row.trashed_at };
}
function json<T>(value: string): T { return JSON.parse(value) as T; }

export class MetadataDatabase {
  private db!: DatabaseSync;
  private changeListener?: (change: ChangeEvent) => void;
  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, parent_path TEXT NOT NULL, name TEXT NOT NULL,
        is_directory INTEGER NOT NULL, mime_type TEXT, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL, checksum TEXT, revision INTEGER NOT NULL DEFAULT 1, favorite INTEGER NOT NULL DEFAULT 0, trashed_at TEXT
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
        status TEXT NOT NULL, created_at TEXT NOT NULL, temp_name TEXT NOT NULL, sync_context TEXT, result_node_id TEXT
      );
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, node_id TEXT, path TEXT, detail TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_created ON activity(created_at DESC);
      CREATE TABLE IF NOT EXISTS change_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, operation TEXT NOT NULL DEFAULT 'modify', node_id TEXT, path TEXT, previous_path TEXT, revision INTEGER, checksum TEXT, device_id TEXT, detail TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS change_journal_node ON change_journal(node_id, sequence);
      CREATE INDEX IF NOT EXISTS change_journal_path ON change_journal(path, sequence);
      CREATE TABLE IF NOT EXISTS sync_devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, client_version TEXT NOT NULL,
        created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_processed_change INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_mappings (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES sync_devices(id) ON DELETE CASCADE,
        cloud_path TEXT NOT NULL, local_path TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        last_processed_change INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT, status TEXT NOT NULL DEFAULT 'idle', last_error TEXT,
        policy TEXT NOT NULL DEFAULT '{}', progress TEXT,
        UNIQUE(device_id, cloud_path)
      );
      CREATE TABLE IF NOT EXISTS sync_pairings (
        id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, cloud_path TEXT NOT NULL, policy TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, claimed_at TEXT, device_id TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_pairings_expiry ON sync_pairings(expires_at, claimed_at);
      CREATE TABLE IF NOT EXISTS sync_idempotency (
        key TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES sync_devices(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);
      CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS node_tags (node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(node_id, tag_id));
      CREATE TABLE IF NOT EXISTS saved_searches (id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, filters TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_history (id TEXT PRIMARY KEY, state TEXT NOT NULL, free_bytes INTEGER, total_bytes INTEGER, used_bytes INTEGER, checked_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS health_history_checked ON health_history(checked_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(node_id UNINDEXED, name, relative_path);
    `);
    // The application predates schema migrations. These additive upgrades keep an
    // existing private drive usable without requiring a one-off migration command.
    for (const statement of [
      'ALTER TABLE nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE upload_sessions ADD COLUMN sync_context TEXT',
      'ALTER TABLE upload_sessions ADD COLUMN result_node_id TEXT',
      "ALTER TABLE change_journal ADD COLUMN operation TEXT NOT NULL DEFAULT 'modify'",
      'ALTER TABLE change_journal ADD COLUMN previous_path TEXT',
      'ALTER TABLE change_journal ADD COLUMN revision INTEGER',
      'ALTER TABLE change_journal ADD COLUMN checksum TEXT',
      'ALTER TABLE change_journal ADD COLUMN device_id TEXT',
      'ALTER TABLE sync_mappings ADD COLUMN policy TEXT NOT NULL DEFAULT \'{}\'',
      'ALTER TABLE sync_mappings ADD COLUMN progress TEXT',
    ]) { try { this.db.exec(statement); } catch (error: unknown) { if (!String(error).includes('duplicate column name')) throw error; } }
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
    this.db.prepare(`INSERT INTO nodes (id,relative_path,parent_path,name,is_directory,mime_type,size,created_at,modified_at,checksum,revision,favorite,trashed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,0,NULL)`).run(id, entry.relativePath, parentPath(entry.relativePath), entry.name, Number(entry.isDirectory), mimeType, entry.size, entry.birthtime.toISOString() || timestamp, entry.mtime.toISOString() || timestamp, null);
    this.upsertFts(id, entry.name, entry.relativePath);
    return this.getNode(id)!;
  }

  createNode(relativePath: string, name: string, isDirectory: boolean, size = 0, mimeType: string | null = null): FileNode {
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO nodes (id,relative_path,parent_path,name,is_directory,mime_type,size,created_at,modified_at,checksum,revision,favorite,trashed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,0,NULL)`).run(id, relativePath, parentPath(relativePath), name, Number(isDirectory), mimeType, size, timestamp, timestamp, null);
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
  tagsForNode(nodeId: string): Tag[] { return this.db.prepare('SELECT t.id,t.name,t.color FROM tags t JOIN node_tags nt ON nt.tag_id=t.id WHERE nt.node_id=? ORDER BY t.name COLLATE NOCASE').all(nodeId).map((row: any) => ({ id: row.id, name: row.name, color: row.color })); }
  listTags(): Tag[] { return this.db.prepare('SELECT id,name,color FROM tags ORDER BY name COLLATE NOCASE').all().map((row: any) => ({ id: row.id, name: row.name, color: row.color })); }
  setNodeTags(nodeId: string, names: string[]): Tag[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM node_tags WHERE node_id=?').run(nodeId);
      for (const raw of [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 20)) {
        const name = raw.slice(0, 48); let tag = this.db.prepare('SELECT id FROM tags WHERE name=? COLLATE NOCASE').get(name) as { id: string } | undefined;
        if (!tag) { const id = randomUUID(); const count = Number((this.db.prepare('SELECT COUNT(*) as count FROM tags').get() as { count: number }).count); const color = ['#85b9ae', '#dcc281', '#9ba8dd', '#d88f9c', '#87bd86'][count % 5]!; this.db.prepare('INSERT INTO tags(id,name,color,created_at) VALUES(?,?,?,?)').run(id, name, color, now()); tag = { id }; }
        this.db.prepare('INSERT INTO node_tags(node_id,tag_id) VALUES(?,?)').run(nodeId, tag.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.tagsForNode(nodeId);
  }
  saveSearch(name: string, query: string, filters: Record<string, string | number | boolean>): SavedSearch { const value = { id: randomUUID(), name, query, filters, createdAt: now() }; this.db.prepare('INSERT INTO saved_searches(id,name,query,filters,created_at) VALUES(?,?,?,?,?)').run(value.id, value.name, value.query, JSON.stringify(value.filters), value.createdAt); return value; }
  listSavedSearches(): SavedSearch[] { return this.db.prepare('SELECT * FROM saved_searches ORDER BY created_at DESC').all().map((row: any) => ({ id: row.id, name: row.name, query: row.query, filters: json(row.filters), createdAt: row.created_at })); }
  deleteSavedSearch(id: string): boolean { return Number(this.db.prepare('DELETE FROM saved_searches WHERE id=?').run(id).changes) === 1; }
  searchSuggestions(query: string): string[] { const value = `%${query.replace(/[%_]/g, '\\$&')}%`; return this.db.prepare('SELECT name FROM nodes WHERE trashed_at IS NULL AND name LIKE ? ESCAPE \'\\\' ORDER BY modified_at DESC LIMIT 8').all(value).map((row: any) => row.name); }
  duplicateGroups(): Array<{ checksum: string; count: number; bytes: number; items: FileNode[] }> {
    const groups = this.db.prepare('SELECT checksum,COUNT(*) as count,MAX(size) as bytes FROM nodes WHERE trashed_at IS NULL AND is_directory=0 AND checksum IS NOT NULL GROUP BY checksum HAVING COUNT(*) > 1 ORDER BY count DESC').all() as Array<{ checksum: string; count: number; bytes: number }>;
    return groups.map((group) => ({ ...group, items: (this.db.prepare('SELECT * FROM nodes WHERE checksum=? AND trashed_at IS NULL ORDER BY modified_at DESC').all(group.checksum) as NodeRow[]).map(node) }));
  }
  usageByFolder(): Array<{ folder: string; bytes: number; files: number }> { return this.db.prepare("SELECT CASE WHEN instr(relative_path,'/')=0 THEN 'My drive' ELSE substr(relative_path,1,instr(relative_path,'/')-1) END as folder,COALESCE(SUM(size),0) as bytes,COUNT(*) as files FROM nodes WHERE trashed_at IS NULL AND is_directory=0 GROUP BY folder ORDER BY bytes DESC LIMIT 20").all().map((row: any) => ({ folder: row.folder, bytes: Number(row.bytes), files: Number(row.files) })); }
  usageByType(): Array<{ type: string; bytes: number; files: number }> { return this.db.prepare("SELECT COALESCE(NULLIF(substr(mime_type,1,instr(mime_type,'/')-1),''),'other') as type,COALESCE(SUM(size),0) as bytes,COUNT(*) as files FROM nodes WHERE trashed_at IS NULL AND is_directory=0 GROUP BY type ORDER BY bytes DESC LIMIT 20").all().map((row: any) => ({ type: row.type, bytes: Number(row.bytes), files: Number(row.files) })); }
  recordHealth(input: { state: string; freeBytes?: number; totalBytes?: number; usedBytes?: number | null }): void { this.db.prepare('INSERT INTO health_history(id,state,free_bytes,total_bytes,used_bytes,checked_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), input.state, input.freeBytes ?? null, input.totalBytes ?? null, input.usedBytes ?? null, now()); this.db.prepare('DELETE FROM health_history WHERE id NOT IN (SELECT id FROM health_history ORDER BY checked_at DESC LIMIT 180)').run(); }
  healthHistory(): Array<{ state: string; freeBytes: number | null; totalBytes: number | null; usedBytes: number | null; checkedAt: string }> { return this.db.prepare('SELECT state,free_bytes,total_bytes,used_bytes,checked_at FROM health_history ORDER BY checked_at DESC LIMIT 60').all().map((row: any) => ({ state: row.state, freeBytes: row.free_bytes, totalBytes: row.total_bytes, usedBytes: row.used_bytes, checkedAt: row.checked_at })); }
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
    this.db.prepare('UPDATE nodes SET size=?, mime_type=?, modified_at=?, revision=revision+1, trashed_at=NULL WHERE id=?').run(size, mimeType, now(), id);
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
        this.db.prepare('UPDATE nodes SET relative_path=?,parent_path=?,name=?,modified_at=?,revision=revision + CASE WHEN id=? THEN 1 ELSE 0 END WHERE id=?').run(next, parentPath(next), nextName, now(), id, row.id);
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
      this.db.prepare('UPDATE nodes SET trashed_at=?,revision=revision + CASE WHEN id=? THEN 1 ELSE 0 END WHERE relative_path=? OR relative_path LIKE ?').run(deletedAt, id, originalPath, `${originalPath}/%`);
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
    this.db.prepare('UPDATE nodes SET trashed_at=NULL,revision=revision + CASE WHEN id=? THEN 1 ELSE 0 END WHERE relative_path=? OR relative_path LIKE ?').run(item.node.id, restoredPath, `${restoredPath}/%`);
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
    this.db.prepare(`INSERT INTO upload_sessions (id,parent_path,name,mime_type,size,chunk_size,chunk_count,received_chunks,status,created_at,temp_name,sync_context,result_node_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(session.id, session.parentPath, session.name, session.mimeType, session.size, session.chunkSize, session.chunkCount, JSON.stringify([]), session.status, session.createdAt, tempName, session.sync ? JSON.stringify(session.sync) : null, null);
  }
  getUpload(id: string): (UploadSession & { tempName: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(id) as any;
    return row ? { id: row.id, parentPath: row.parent_path, name: row.name, mimeType: row.mime_type, size: row.size, chunkSize: row.chunk_size, chunkCount: row.chunk_count, receivedChunks: json<number[]>(row.received_chunks), status: row.status, createdAt: row.created_at, tempName: row.temp_name, sync: row.sync_context ? json(row.sync_context) : undefined, resultNodeId: row.result_node_id ?? undefined } : undefined;
  }
  updateUploadChunks(id: string, receivedChunks: number[]): void { this.db.prepare('UPDATE upload_sessions SET received_chunks=? WHERE id=?').run(JSON.stringify(receivedChunks), id); }
  updateUploadStatus(id: string, status: UploadSession['status']): void { this.db.prepare('UPDATE upload_sessions SET status=? WHERE id=?').run(status, id); }
  completeUpload(id: string, nodeId: string): void { this.db.prepare("UPDATE upload_sessions SET status='complete',result_node_id=? WHERE id=?").run(nodeId, id); }
  findUploadByIdempotency(deviceId: string, key: string): UploadSession | undefined {
    const row = this.db.prepare("SELECT * FROM upload_sessions WHERE json_extract(sync_context, '$.deviceId')=? AND json_extract(sync_context, '$.idempotencyKey')=? AND status IN ('active','complete') ORDER BY created_at DESC LIMIT 1").get(deviceId, key) as any;
    return row ? this.getUpload(row.id) : undefined;
  }
  deleteUpload(id: string): void { this.db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id); }
  staleUploads(before: string): Array<{ id: string; tempName: string }> { return this.db.prepare(`SELECT id,temp_name FROM upload_sessions WHERE status IN ('active','cancelled','failed') AND created_at < ?`).all(before).map((r: any) => ({ id: r.id, tempName: r.temp_name })); }
  addActivity(action: string, nodeId: string | null, path: string | null, detail: string | null = null): void {
    this.db.prepare('INSERT INTO activity (id,action,node_id,path,detail,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), action, nodeId, path, detail, now());
  }
  listActivity(limit = 100): ActivityEvent[] {
    return this.db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?').all(limit).map((row: any) => ({ id: row.id, action: row.action, nodeId: row.node_id, path: row.path, detail: row.detail, createdAt: row.created_at }));
  }
  addChange(action: string, nodeId: string | null, path: string | null, detail: string | null = null, options: { operation?: SyncOperation; previousPath?: string | null; revision?: number | null; checksum?: string | null; deviceId?: string | null } = {}): number {
    const operation = options.operation ?? operationFor(action);
    const result = this.db.prepare('INSERT INTO change_journal (action,operation,node_id,path,previous_path,revision,checksum,device_id,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(action, operation, nodeId, path, options.previousPath ?? null, options.revision ?? null, options.checksum ?? null, options.deviceId ?? null, detail, now());
    const sequence = Number(result.lastInsertRowid);
    this.changeListener?.({ sequence, action, operation, nodeId, path, previousPath: options.previousPath ?? null, revision: options.revision ?? null, checksum: options.checksum ?? null, deviceId: options.deviceId ?? null, detail, createdAt: now() });
    return sequence;
  }
  listChanges(after = 0, limit = 250): ChangeEvent[] {
    return this.db.prepare('SELECT * FROM change_journal WHERE sequence>? ORDER BY sequence ASC LIMIT ?').all(after, limit).map((row: any) => ({ sequence: Number(row.sequence), action: row.action, operation: row.operation ?? operationFor(row.action), nodeId: row.node_id, path: row.path, previousPath: row.previous_path ?? null, revision: row.revision ?? null, checksum: row.checksum ?? null, deviceId: row.device_id ?? null, detail: row.detail, createdAt: row.created_at }));
  }
  setChangeListener(listener: (change: ChangeEvent) => void): void { this.changeListener = listener; }
  latestChangeSequence(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0) as value FROM change_journal').get() as { value: number }).value); }
  upsertSyncDevice(input: { id: string; name: string; platform: string; clientVersion: string }): SyncDevice {
    const existing = this.db.prepare('SELECT * FROM sync_devices WHERE id=?').get(input.id) as any;
    const timestamp = now();
    if (existing) {
      if (existing.revoked_at) throw new Error('SYNC_DEVICE_REVOKED');
      this.db.prepare('UPDATE sync_devices SET name=?,platform=?,client_version=?,last_seen_at=? WHERE id=?').run(input.name, input.platform, input.clientVersion, timestamp, input.id);
    } else {
      this.db.prepare('INSERT INTO sync_devices (id,name,platform,client_version,created_at,last_seen_at,last_processed_change,revoked_at) VALUES (?,?,?,?,?,?,0,NULL)')
        .run(input.id, input.name, input.platform, input.clientVersion, timestamp, timestamp);
    }
    return this.getSyncDevice(input.id)!;
  }
  getSyncDevice(id: string): SyncDevice | undefined {
    const row = this.db.prepare('SELECT * FROM sync_devices WHERE id=?').get(id) as any;
    return row ? device(row) : undefined;
  }
  listSyncDevices(): SyncDevice[] { return this.db.prepare('SELECT * FROM sync_devices ORDER BY last_seen_at DESC').all().map(device); }
  revokeSyncDevice(id: string): boolean { return Number(this.db.prepare('UPDATE sync_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), id).changes) === 1; }
  touchSyncDevice(id: string): void { this.db.prepare('UPDATE sync_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL').run(now(), id); }
  upsertSyncMapping(input: { id: string; deviceId: string; cloudPath: string; localPath: string; paused?: boolean; policy?: SyncPolicy }): SyncMapping {
    const policy = normalizeSyncPolicy(input.policy);
    const existing = this.db.prepare('SELECT id FROM sync_mappings WHERE device_id=? AND cloud_path=?').get(input.deviceId, input.cloudPath) as { id: string } | undefined;
    if (existing && existing.id !== input.id) {
      this.db.prepare('UPDATE sync_mappings SET local_path=?,paused=?,policy=? WHERE id=?').run(input.localPath, Number(input.paused === true), JSON.stringify(policy), existing.id);
      return this.getSyncMapping(existing.id)!;
    }
    this.db.prepare(`INSERT INTO sync_mappings (id,device_id,cloud_path,local_path,paused,last_processed_change,last_sync_at,status,last_error,policy,progress)
      VALUES (?,?,?,?,?,0,NULL,'idle',NULL,?,NULL)
      ON CONFLICT(id) DO UPDATE SET cloud_path=excluded.cloud_path,local_path=excluded.local_path,paused=excluded.paused,policy=excluded.policy`)
      .run(input.id, input.deviceId, input.cloudPath, input.localPath, Number(input.paused === true), JSON.stringify(policy));
    return this.getSyncMapping(input.id)!;
  }
  getSyncMapping(id: string): SyncMapping | undefined {
    const row = this.db.prepare('SELECT * FROM sync_mappings WHERE id=?').get(id) as any;
    return row ? mapping(row) : undefined;
  }
  listSyncMappings(deviceId?: string): SyncMapping[] {
    const rows = deviceId ? this.db.prepare('SELECT * FROM sync_mappings WHERE device_id=? ORDER BY cloud_path').all(deviceId) : this.db.prepare('SELECT * FROM sync_mappings ORDER BY cloud_path').all();
    return rows.map(mapping);
  }
  updateSyncMapping(id: string, input: { paused?: boolean; lastProcessedChange?: number; status?: string; lastError?: string | null; progress?: SyncProgress | null }): SyncMapping | undefined {
    const current = this.getSyncMapping(id); if (!current) return undefined;
    this.db.prepare('UPDATE sync_mappings SET paused=?,last_processed_change=?,last_sync_at=?,status=?,last_error=?,progress=? WHERE id=?')
      .run(Number(input.paused ?? current.paused), input.lastProcessedChange ?? current.lastProcessedChange, now(), input.status ?? current.status, input.lastError === undefined ? current.lastError : input.lastError, input.progress === undefined ? (current.progress ? JSON.stringify(current.progress) : null) : input.progress ? JSON.stringify(input.progress) : null, id);
    const next = this.getSyncMapping(id)!;
    this.db.prepare('UPDATE sync_devices SET last_processed_change=MAX(last_processed_change,?),last_seen_at=? WHERE id=?').run(next.lastProcessedChange, now(), next.deviceId);
    return next;
  }
  createSyncPairing(input: { id: string; codeHash: string; cloudPath: string; policy: SyncPolicy; createdAt: string; expiresAt: string }): SyncPairing {
    this.db.prepare('INSERT INTO sync_pairings (id,code_hash,cloud_path,policy,created_at,expires_at,claimed_at,device_id) VALUES (?,?,?,?,?, ?,NULL,NULL)')
      .run(input.id, input.codeHash, input.cloudPath, JSON.stringify(input.policy), input.createdAt, input.expiresAt);
    return this.getSyncPairing(input.id)!;
  }
  getSyncPairing(id: string): SyncPairing | undefined {
    const row = this.db.prepare('SELECT * FROM sync_pairings WHERE id=?').get(id) as any;
    return row ? pairing(row) : undefined;
  }
  getSyncPairingByHash(codeHash: string): SyncPairing | undefined {
    const row = this.db.prepare('SELECT * FROM sync_pairings WHERE code_hash=?').get(codeHash) as any;
    return row ? pairing(row) : undefined;
  }
  claimSyncPairing(codeHash: string, at: string, deviceId: string): SyncPairing | undefined {
    const row = this.db.prepare('SELECT * FROM sync_pairings WHERE code_hash=? AND claimed_at IS NULL AND expires_at>?').get(codeHash, at) as any;
    if (!row) return undefined;
    const result = this.db.prepare('UPDATE sync_pairings SET claimed_at=?,device_id=? WHERE id=? AND claimed_at IS NULL AND expires_at>?').run(at, deviceId, row.id, at);
    return Number(result.changes) === 1 ? this.getSyncPairing(row.id) : undefined;
  }
  listNodesByPrefix(relativePath: string): FileNode[] {
    return (this.db.prepare('SELECT * FROM nodes WHERE trashed_at IS NULL AND (relative_path=? OR relative_path LIKE ?) ORDER BY LENGTH(relative_path),relative_path COLLATE NOCASE').all(relativePath, relativePath ? `${relativePath}/%` : '%') as NodeRow[]).map(node);
  }
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

function operationFor(action: string): SyncOperation {
  if (action === 'folder_created') return 'folder_create';
  if (action === 'trashed' || action === 'permanently_deleted') return 'delete';
  if (action === 'restored') return 'restore';
  if (action === 'renamed') return 'rename';
  if (action === 'moved') return 'move';
  if (action === 'copied') return 'create';
  return 'modify';
}
function device(row: any): SyncDevice { return { id: row.id, name: row.name, platform: row.platform, clientVersion: row.client_version, createdAt: row.created_at, lastSeenAt: row.last_seen_at, lastProcessedChange: Number(row.last_processed_change), revokedAt: row.revoked_at }; }
function mapping(row: any): SyncMapping { return { id: row.id, deviceId: row.device_id, cloudPath: row.cloud_path, localPath: row.local_path, policy: parsePolicy(row.policy), paused: Boolean(row.paused), lastProcessedChange: Number(row.last_processed_change), lastSyncAt: row.last_sync_at, status: row.status, lastError: row.last_error, progress: parseProgress(row.progress) }; }
function pairing(row: any): SyncPairing { return { id: row.id, cloudPath: row.cloud_path, policy: parsePolicy(row.policy), createdAt: row.created_at, expiresAt: row.expires_at, claimedAt: row.claimed_at, deviceId: row.device_id }; }
function parsePolicy(value: unknown): SyncPolicy {
  try {
    return normalizeSyncPolicy(typeof value === 'string' ? JSON.parse(value) : value);
  } catch { /* old or malformed metadata receives the safe default below */ }
  return normalizeSyncPolicy(undefined);
}
function parseProgress(value: unknown): SyncProgress | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? { ...(parsed as object), excludedFolders: typeof (parsed as Partial<SyncProgress>).excludedFolders === 'number' ? (parsed as Partial<SyncProgress>).excludedFolders : 0 } as SyncProgress : null;
  } catch { return null; }
}

export function metadataPath(storageRoot: string): string { return join(storageRoot, '.continental', 'metadata.db'); }
