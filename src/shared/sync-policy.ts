import { DEFAULT_PROJECT_SYNC_EXCLUDES, type SyncPolicy } from './types.js';

/**
 * Returns a fresh policy so callers can safely persist or modify the result.
 * Project mode keeps source and lock files while omitting common generated data.
 */
export function defaultSyncPolicy(preset: 'project' | 'exact' = 'project'): SyncPolicy {
  return preset === 'exact'
    ? { preset: 'exact', exclude: [] }
    : { preset: 'project', exclude: [...DEFAULT_PROJECT_SYNC_EXCLUDES] };
}

export function normalizeSyncPolicy(input: unknown): SyncPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaultSyncPolicy();
  const value = input as { preset?: unknown; exclude?: unknown };
  if (value.preset === 'exact') return defaultSyncPolicy('exact');
  if (value.preset !== undefined && value.preset !== 'project') throw new Error('Sync policy preset must be project or exact.');
  if (value.exclude === undefined) return defaultSyncPolicy();
  if (!Array.isArray(value.exclude)) throw new Error('Sync policy exclusions must be an array.');
  const exclude = [...new Set(value.exclude.map((entry) => normalizePattern(entry)))];
  if (exclude.length > 100) throw new Error('A sync policy may contain at most 100 exclusions.');
  return { preset: 'project', exclude };
}

/** Patterns are slash-separated. A bare pattern matches any path segment; `/**` matches a subtree. */
export function syncPathExcluded(path: string, policy: SyncPolicy): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  return policy.exclude.some((pattern) => {
    if (!pattern.includes('/')) return normalized.split('/').some((segment) => globMatch(segment, pattern));
    if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3).replace(/\/+$/, '');
      if (!base.includes('/')) return normalized.split('/').some((segment) => globMatch(segment, base));
      return normalized === base || normalized.startsWith(`${base}/`);
    }
    return globMatch(normalized, pattern);
  });
}

function normalizePattern(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Each sync exclusion must be a string.');
  const pattern = value.trim().replaceAll('\\', '/');
  if (!pattern || pattern.length > 255 || pattern.startsWith('/') || pattern.includes('\0') || pattern.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid sync exclusion: ${value}`);
  }
  return pattern;
}

function globMatch(value: string, pattern: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') { expression += '.*'; index++; }
    else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`).test(value);
}
