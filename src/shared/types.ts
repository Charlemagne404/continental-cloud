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
  nodeId: string | null;
  path: string | null;
  detail: string | null;
  createdAt: string;
}

export interface JobStatus {
  id: string;
  kind: string;
  state: 'running' | 'complete' | 'failed';
  detail: string | null;
  createdAt: string;
  completedAt: string | null;
}
