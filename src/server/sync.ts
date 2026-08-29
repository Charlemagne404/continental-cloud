import { EventEmitter } from 'node:events';
import type { ChangeEvent, FileNode, SyncDevice, SyncMapping, SyncOperation, UploadSession } from '../shared/types.js';
import { fail } from './errors.js';
import { FileService } from './files.js';
import { MetadataDatabase } from './metadata.js';
import { normalizeFileName, normalizeRelativePath } from './paths.js';
import { UploadService } from './uploads.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, label: string, limit: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw fail.badRequest(`A valid ${label} is required.`);
  return value.trim();
};

/** Notifications reduce latency only. The SQLite journal is always authoritative. */
export class SyncNotifier {
  private readonly events = new EventEmitter();
  publish(change: ChangeEvent): void { this.events.emit('change', change); }
  onChange(listener: (change: ChangeEvent) => void): () => void { this.events.on('change', listener); return () => this.events.off('change', listener); }
}

export class SyncService {
  constructor(private readonly db: MetadataDatabase, private readonly files: FileService, private readonly uploads: UploadService) {}

  registerDevice(input: { deviceId?: unknown; name?: unknown; platform?: unknown; clientVersion?: unknown }): SyncDevice {
    const id = text(input.deviceId, 'device ID', 36);
    if (!UUID.test(id)) throw fail.badRequest('Device ID must be a UUID.');
    try { return this.db.upsertSyncDevice({ id, name: text(input.name, 'device name', 120), platform: text(input.platform, 'platform', 48), clientVersion: text(input.clientVersion, 'client version', 48) }); }
    catch (error: unknown) { if (error instanceof Error && error.message === 'SYNC_DEVICE_REVOKED') throw fail.forbidden('This sync device has been revoked. Create a new device identity to reconnect.'); throw error; }
  }

  devices(): Array<SyncDevice & { mappings: SyncMapping[] }> {
    return this.db.listSyncDevices().map((device) => ({ ...device, mappings: this.db.listSyncMappings(device.id) }));
  }
  mappingForDevice(deviceId: string, input: { id?: unknown; cloudPath?: unknown; localPath?: unknown; paused?: unknown }): SyncMapping { return this.mapping(deviceId, input); }
  setMappingFromConsole(deviceId: string, mappingId: string, input: { paused?: unknown; status?: unknown }): SyncMapping { return this.setMappingStatus(deviceId, mappingId, input); }
  revokeDevice(id: string): void { if (!UUID.test(id) || !this.db.revokeSyncDevice(id)) throw fail.notFound('Sync device not found or already revoked.'); }

  mapping(deviceId: string, input: { id?: unknown; cloudPath?: unknown; localPath?: unknown; paused?: unknown }): SyncMapping {
    this.requireDevice(deviceId);
    const id = text(input.id, 'mapping ID', 36); if (!UUID.test(id)) throw fail.badRequest('Mapping ID must be a UUID.');
    const cloudPath = normalizeRelativePath(input.cloudPath ?? '');
    const localPath = text(input.localPath, 'local path', 1024);
    return this.db.upsertSyncMapping({ id, deviceId, cloudPath, localPath, paused: input.paused === true });
  }
  mappings(deviceId: string): SyncMapping[] { this.requireDevice(deviceId); return this.db.listSyncMappings(deviceId); }
  setMappingStatus(deviceId: string, mappingId: string, input: { paused?: unknown; cursor?: unknown; status?: unknown; error?: unknown }): SyncMapping {
    this.mappingOwnedBy(deviceId, mappingId);
    const cursor = input.cursor === undefined ? undefined : safeCursor(input.cursor);
    const status = input.status === undefined ? undefined : text(input.status, 'mapping status', 48);
    const error = input.error === undefined ? undefined : input.error === null ? null : text(input.error, 'mapping error', 1000);
    return this.db.updateSyncMapping(mappingId, { paused: input.paused === undefined ? undefined : input.paused === true, lastProcessedChange: cursor, status, lastError: error })!;
  }

  state(deviceId: string): { sequence: number; device: SyncDevice; mappings: SyncMapping[] } {
    const device = this.requireDevice(deviceId); return { sequence: this.db.latestChangeSequence(), device, mappings: this.db.listSyncMappings(deviceId) };
  }
  changes(deviceId: string, after: number, limit: number): { changes: ChangeEvent[]; nextCursor: number; hasMore: boolean } {
    this.requireDevice(deviceId);
    const changes = this.db.listChanges(after, limit);
    this.db.touchSyncDevice(deviceId);
    return { changes, nextCursor: changes.at(-1)?.sequence ?? after, hasMore: changes.length === limit };
  }
  snapshot(deviceId: string, cloudPath: unknown): { cursor: number; nodes: FileNode[] } {
    this.requireDevice(deviceId); const path = normalizeRelativePath(cloudPath ?? '');
    return { cursor: this.db.latestChangeSequence(), nodes: this.db.listNodesByPrefix(path) };
  }

  async startUpload(deviceId: string, input: { parentPath?: unknown; name?: unknown; size?: unknown; mimeType?: unknown; nodeId?: unknown; baseRevision?: unknown; idempotencyKey?: unknown }): Promise<UploadSession> {
    const device = this.requireDevice(deviceId);
    const nodeId = input.nodeId === undefined || input.nodeId === null ? undefined : text(input.nodeId, 'node ID', 36);
    if (nodeId && !UUID.test(nodeId)) throw fail.badRequest('Node ID must be a UUID.');
    const baseRevision = input.baseRevision === undefined || input.baseRevision === null ? undefined : safeRevision(input.baseRevision);
    const idempotencyKey = text(input.idempotencyKey, 'idempotency key', 128);
    return this.uploads.start({ parentPath: input.parentPath, name: input.name, size: input.size, mimeType: input.mimeType, sync: { deviceId, deviceName: device.name, nodeId, baseRevision, idempotencyKey } });
  }
  uploadForDevice(deviceId: string, uploadId: string): UploadSession {
    this.requireDevice(deviceId); const upload = this.db.getUpload(uploadId);
    if (!upload) throw fail.notFound('Sync upload not found.');
    if (upload.sync?.deviceId !== deviceId) throw fail.forbidden('This upload belongs to another device.');
    return upload;
  }

  async mutation(deviceId: string, input: { operation?: unknown; nodeId?: unknown; baseRevision?: unknown; name?: unknown; parentPath?: unknown; targetPath?: unknown }): Promise<FileNode | { trashed: true }> {
    this.requireDevice(deviceId);
    const operation = text(input.operation, 'sync operation', 32);
    const id = text(input.nodeId, 'node ID', 36); if (!UUID.test(id)) throw fail.badRequest('Node ID must be a UUID.');
    const base = safeRevision(input.baseRevision);
    const current = this.db.getNode(id);
    if (!current || current.trashedAt) throw fail.conflict('The remote item no longer exists; refresh sync changes before retrying.');
    if (current.revision !== base) throw fail.conflict('The remote item changed on another device. Its current version was preserved.');
    if (operation === 'rename') return this.files.rename(id, normalizeFileName(input.name), deviceId);
    if (operation === 'move') return this.files.move(id, normalizeRelativePath(input.parentPath ?? ''), deviceId);
    if (operation === 'relocate') return this.files.relocate(id, normalizeRelativePath(input.targetPath, { allowEmpty: false }), deviceId);
    if (operation === 'delete' || operation === 'folder_delete') { await this.files.trash(id, deviceId); return { trashed: true }; }
    throw fail.badRequest('Unsupported sync mutation.');
  }

  async createFolder(deviceId: string, input: { parentPath?: unknown; name?: unknown }): Promise<FileNode> {
    this.requireDevice(deviceId); return this.files.createFolder(normalizeRelativePath(input.parentPath ?? ''), normalizeFileName(input.name), deviceId);
  }

  private requireDevice(deviceId: string): SyncDevice {
    if (!UUID.test(deviceId)) throw fail.badRequest('Device ID must be a UUID.');
    const device = this.db.getSyncDevice(deviceId);
    if (!device) throw fail.unauthorized();
    if (device.revokedAt) throw fail.forbidden('This sync device has been revoked.');
    this.db.touchSyncDevice(deviceId); return device;
  }
  private mappingOwnedBy(deviceId: string, mappingId: string): SyncMapping {
    this.requireDevice(deviceId); const mapping = this.db.getSyncMapping(mappingId);
    if (!mapping || mapping.deviceId !== deviceId) throw fail.notFound('Sync mapping not found.'); return mapping;
  }
}

function safeCursor(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw fail.badRequest('Change cursor must be a non-negative integer.'); return value; }
function safeRevision(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw fail.badRequest('Base revision must be a positive integer.'); return value; }
