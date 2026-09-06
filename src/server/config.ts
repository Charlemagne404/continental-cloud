import { resolve } from 'node:path';
import type { CloudConfig } from '../shared/types.js';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`Invalid positive integer: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function origin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  const normalized = value.trim();
  try { parsed = new URL(normalized); } catch { throw new Error(`Invalid allowed origin: ${value}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`CLOUD_ALLOWED_ORIGIN must be an HTTP(S) origin without a path: ${value}`);
  }
  return parsed.origin;
}

export function loadConfig(env = process.env): CloudConfig {
  const environment = (env.NODE_ENV?.trim().toLowerCase() || 'development');
  const storagePath = env.CLOUD_STORAGE_PATH?.trim() || './storage';
  const host = env.CLOUD_HOST?.trim() || '127.0.0.1';
  if (/[\u0000-\u001f\u007f]/.test(host)) throw new Error('CLOUD_HOST contains control characters.');
  const config: CloudConfig = {
    storagePath: resolve(storagePath),
    expectedStorageId: env.CLOUD_STORAGE_ID || undefined,
    allowStorageInitialization: bool(env.CLOUD_ALLOW_STORAGE_INIT, environment !== 'production'),
    host,
    port: integer(env.CLOUD_PORT, 8787),
    authToken: env.CLOUD_AUTH_TOKEN || undefined,
    authDisabled: bool(env.CLOUD_AUTH_DISABLED, false),
    allowedOrigin: origin(env.CLOUD_ALLOWED_ORIGIN || undefined),
    maxUploadBytes: integer(env.CLOUD_MAX_UPLOAD_BYTES, 4 * 1024 * 1024 * 1024 * 1024),
    uploadChunkBytes: integer(env.CLOUD_UPLOAD_CHUNK_BYTES, 8 * 1024 * 1024),
    versionRetention: integer(env.CLOUD_VERSION_RETENTION, 25),
    trashRetentionDays: integer(env.CLOUD_TRASH_RETENTION_DAYS, 30),
    minFreeBytes: integer(env.CLOUD_MIN_FREE_BYTES, 1024 * 1024 * 1024),
    appVersion: env.CLOUD_APP_VERSION ?? '0.1.0',
    environment,
  };
  if (config.environment === 'production' && config.authDisabled) {
    throw new Error('CLOUD_AUTH_DISABLED is forbidden in production.');
  }
  if (!config.authDisabled && !config.authToken) {
    throw new Error('CLOUD_AUTH_TOKEN is required unless CLOUD_AUTH_DISABLED=true (development only).');
  }
  if (config.environment === 'production' && !config.expectedStorageId) {
    throw new Error('CLOUD_STORAGE_ID is required in production to fail closed if the storage mount disappears.');
  }
  if (config.uploadChunkBytes > config.maxUploadBytes) throw new Error('CLOUD_UPLOAD_CHUNK_BYTES cannot exceed CLOUD_MAX_UPLOAD_BYTES.');
  return config;
}
