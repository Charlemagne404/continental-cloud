import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import type { ServerResponse } from 'node:http';
import { fail } from './errors.js';

const BLOCK = 512;

/** Streams a conventional tar archive without buffering user files in memory. */
export async function streamTar(response: ServerResponse, source: string, name: string): Promise<void> {
  response.writeHead(200, {
    'Content-Type': 'application/x-tar',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.tar`)}`,
    'Cache-Control': 'no-store',
  });
  await append(response, source, safeArchivePath(name));
  response.end(Buffer.alloc(BLOCK * 2));
}

async function append(response: ServerResponse, source: string, archivePath: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw fail.forbidden('Symlinks cannot be included in a Cloud archive.');
  if (info.isDirectory()) {
    await write(response, header(`${archivePath}/`, 0, info.mtime, '5'));
    for (const entry of await readdir(source)) await append(response, join(source, entry), `${archivePath}/${safeArchivePath(entry)}`);
    return;
  }
  if (!info.isFile()) return;
  await write(response, header(archivePath, info.size, info.mtime, '0'));
  for await (const chunk of createReadStream(source)) await write(response, Buffer.from(chunk));
  const remainder = info.size % BLOCK;
  if (remainder) await write(response, Buffer.alloc(BLOCK - remainder));
}

function safeArchivePath(input: string): string {
  const value = posix.normalize(input.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (!value || value === '.' || value.startsWith('../') || value.includes('/../') || value.includes('\0')) throw fail.badRequest('Unsafe archive path.');
  return value.slice(0, 255);
}

function header(name: string, size: number, mtime: Date, type: '0' | '5'): Buffer {
  const result = Buffer.alloc(BLOCK);
  const encoded = Buffer.from(name);
  if (encoded.length > 100) {
    const split = name.lastIndexOf('/', 155);
    if (split <= 0 || Buffer.byteLength(name.slice(0, split)) > 155 || Buffer.byteLength(name.slice(split + 1)) > 100) throw fail.badRequest('This path is too long to download as a tar archive.');
    put(result, name.slice(split + 1), 0, 100); put(result, name.slice(0, split), 345, 155);
  } else put(result, name, 0, 100);
  octal(result, 0o600, 100, 8); octal(result, 0, 108, 8); octal(result, 0, 116, 8); octal(result, size, 124, 12); octal(result, Math.floor(mtime.getTime() / 1000), 136, 12);
  result.fill(0x20, 148, 156); result[156] = type.charCodeAt(0); put(result, 'ustar', 257, 6); put(result, '00', 263, 2);
  let sum = 0; for (const byte of result) sum += byte; octal(result, sum, 148, 8);
  return result;
}
function put(target: Buffer, value: string, offset: number, length: number): void { Buffer.from(value).copy(target, offset, 0, length); }
function octal(target: Buffer, value: number, offset: number, length: number): void { const text = value.toString(8).padStart(length - 1, '0'); target.write(`${text}\0`, offset, length, 'ascii'); }
function write(response: ServerResponse, chunk: Buffer): Promise<void> { return response.write(chunk) ? Promise.resolve() : new Promise((resolve) => response.once('drain', resolve)); }
