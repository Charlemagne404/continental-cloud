export type StorageState = 'ready' | 'offline' | 'misconfigured';

export interface CloudConfig {
  storagePath: string;
  expectedStorageId?: string;
  allowStorageInitialization: boolean;
  host: string;
  port: number;
  authToken?: string;
  authDisabled: boolean;
  allowedOrigin?: string;
  maxUploadBytes: number;
  uploadChunkBytes: number;
  versionRetention: number;
  trashRetentionDays: number;
  minFreeBytes: number;
  appVersion: string;
  environment: string;
}

export interface FileNode {
  id: string;
  relativePath: string;
  parentPath: string;
  name: string;
  isDirectory: boolean;
  mimeType: string | null;
  size: number;
  createdAt: string;
  modifiedAt: string;
  checksum: string | null;
  /** Monotonic per-node revision. Sync clients use this as their write precondition. */
  revision: number;
  favorite: boolean;
  trashedAt: string | null;
}

export interface StorageStatus {
  state: StorageState;
  storageId?: string;
  detail?: string;
  freeBytes?: number;
  totalBytes?: number;
  writable?: boolean;
  latencyMs?: number;
  checkedAt?: string;
}

export interface UploadSession {
  id: string;
  parentPath: string;
  name: string;
  mimeType: string | null;
  size: number;
  chunkSize: number;
  chunkCount: number;
  receivedChunks: number[];
  status: 'active' | 'failed' | 'complete' | 'cancelled';
  createdAt: string;
  sync?: SyncUploadContext;
  resultNodeId?: string;
}

export interface ActivityEvent {
  id: string;
  action: string;
  nodeId: string | null;
  path: string | null;
  detail: string | null;
  createdAt: string;
}

export interface ChangeEvent {
  sequence: number;
  action: string;
  operation: SyncOperation;
  nodeId: string | null;
  path: string | null;
  previousPath: string | null;
  revision: number | null;
  checksum: string | null;
  deviceId: string | null;
  detail: string | null;
  createdAt: string;
}

export type SyncOperation = 'create' | 'modify' | 'delete' | 'rename' | 'move' | 'folder_create' | 'folder_delete' | 'restore';

export interface SyncUploadContext {
  deviceId: string;
  deviceName?: string;
  nodeId?: string;
  baseRevision?: number;
  idempotencyKey: string;
}

export interface SyncDevice {
  id: string;
  name: string;
  platform: string;
  clientVersion: string;
  createdAt: string;
  lastSeenAt: string;
  lastProcessedChange: number;
  revokedAt: string | null;
}

export interface SyncMapping {
  id: string;
  deviceId: string;
  cloudPath: string;
  localPath: string;
  policy: SyncPolicy;
  paused: boolean;
  lastProcessedChange: number;
  lastSyncAt: string | null;
  status: string;
  lastError: string | null;
  progress: SyncProgress | null;
}

export type SyncPolicyPreset = 'project' | 'exact';

export interface SyncPolicy {
  /** `project` omits generated dependencies/caches; `exact` mirrors every safe entry. */
  preset: SyncPolicyPreset;
  exclude: string[];
}

export const DEFAULT_PROJECT_SYNC_EXCLUDES = [
  '.DS_Store', 'Thumbs.db',
  'node_modules/**', '.venv/**', 'venv/**',
  'dist/**', 'build/**', '.next/**', '.nuxt/**', '.turbo/**',
  'coverage/**', 'target/**', '.cache/**', '.parcel-cache/**', '__pycache__/**',
  '*.swp', '*.swo', '*.tmp',
];

export type SyncProgressPhase = 'idle' | 'scanning' | 'syncing' | 'complete' | 'error';

export interface SyncProgress {
  phase: SyncProgressPhase;
  initial: boolean;
  filesTotal: number;
  filesDone: number;
  foldersTotal: number;
  foldersDone: number;
  bytesTotal: number;
  bytesDone: number;
  excludedFiles: number;
  excludedFolders: number;
  excludedBytes: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SyncPairing {
  id: string;
  cloudPath: string;
  policy: SyncPolicy;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  deviceId: string | null;
}

export interface SyncPairingClaim {
  device: SyncDevice;
  mapping: SyncMapping;
  /** A device-scoped credential issued after a one-time pairing. */
  token?: string;
}

export interface JobStatus {
  id: string;
  kind: string;
  state: 'running' | 'complete' | 'failed';
  detail: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}
