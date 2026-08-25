import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'dist', 'public');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(root, 'public'), target, { recursive: true });
