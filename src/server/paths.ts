import { lstat, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fail } from './errors.js';

const RESERVED = new Set(['.continental', '.trash']);

/** Normalizes an application-relative POSIX path and rejects every escape form. */
export function normalizeRelativePath(input: unknown, { allowEmpty = true }: { allowEmpty?: boolean } = {}): string {
  if (typeof input !== 'string') throw fail.badRequest('A path must be a string.');
  if (input.includes('\0') || input.includes('\\')) throw fail.badRequest('The path contains forbidden characters.');
  if (input.startsWith('/') || input.endsWith('/')) throw fail.badRequest('Paths must be relative and cannot have a trailing slash.');
  if (input === '') {
    if (allowEmpty) return '';
    throw fail.badRequest('A name is required.');
  }
  const parts = input.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw fail.badRequest('The path contains an invalid segment.');
    if (RESERVED.has(part)) throw fail.forbidden('Internal storage paths are never accessible through the API.');
    if (part.length > 255) throw fail.badRequest('A file name cannot exceed 255 characters.');
  }
  return parts.join('/');
}

export function normalizeFileName(input: unknown): string {
  const name = normalizeRelativePath(input, { allowEmpty: false });
  if (name.includes('/')) throw fail.badRequest('A file name cannot include a path separator.');
  return name;
}

export function parentPath(path: string): string {
  const point = path.lastIndexOf('/');
  return point === -1 ? '' : path.slice(0, point);
}

export function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`${sep}..${sep}`))) return;
  throw fail.forbidden('The requested path escapes the storage root.');
}

/** Resolves a relative path without dereferencing any symlink on its route. */
export async function resolveExistingNoSymlink(root: string, path: string): Promise<string> {
  const normalized = normalizeRelativePath(path);
  const candidate = join(root, ...normalized.split('/').filter(Boolean));
  assertContained(root, candidate);
  let current = root;
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink()) throw fail.forbidden('The storage root cannot be a symlink.');
    for (const segment of normalized.split('/').filter(Boolean)) {
      current = join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw fail.forbidden('Symlinks are not available through Continental Cloud.');
    }
    // A second containment check protects against unusual platform resolution behavior.
    assertContained(await realpath(root), await realpath(candidate));
    return candidate;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') throw fail.notFound();
    throw error;
  }
}

export async function assertNoSymlink(root: string, path: string): Promise<void> {
  await resolveExistingNoSymlink(root, path);
}
