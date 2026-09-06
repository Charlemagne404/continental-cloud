import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeUploadPlans, droppedSelection, normalizeUploadPath, validateUploadSelection } from '../client/upload-selection.js';

type LegacyEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: () => void) => void;
  createReader?: () => { readEntries: (success: (entries: LegacyEntry[]) => void, error?: () => void) => void };
};

function testFile(name: string, contents: string, relativePath = ''): File {
  const file = new File([contents], name, { type: 'text/plain', lastModified: 1 });
  Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: relativePath });
  return file;
}

function fileEntry(name: string, file: File): LegacyEntry {
  return { isFile: true, isDirectory: false, name, file: (resolve) => resolve(file) };
}

function directoryEntry(name: string, children: LegacyEntry[]): LegacyEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let read = false;
      return { readEntries: (resolve) => { if (read) resolve([]); else { read = true; resolve(children); } } };
    },
  };
}

test('folder drops use entry paths once and retain empty directories', async () => {
  const readme = testFile('README.md', 'read me');
  const source = testFile('index.ts', 'export {}');
  const root = directoryEntry('Project', [
    fileEntry('README.md', readme),
    directoryEntry('src', [fileEntry('index.ts', source)]),
    directoryEntry('empty', []),
  ]);
  const transfer = {
    // Chromium can expose the same files here without their folder prefix.
    // Entry traversal must win instead of uploading a second flattened copy.
    files: [readme, source],
    items: [{ kind: 'file', webkitGetAsEntry: () => root }],
  } as unknown as DataTransfer;

  const selection = await droppedSelection(transfer);
  assert.deepEqual(selection.plans.map((plan) => plan.relativePath), ['Project/README.md', 'Project/src/index.ts']);
  assert.deepEqual(selection.folders, ['Project', 'Project/src', 'Project/empty']);
});

test('folder drops support the modern filesystem handle API', async () => {
  const document = testFile('document.txt', 'content');
  const fileHandle = {
    kind: 'file' as const,
    name: 'document.txt',
    file: document,
    getFile() { return Promise.resolve(this.file); },
  };
  const directoryHandle = {
    kind: 'directory' as const,
    name: 'Modern folder',
    async *values() { yield fileHandle; },
  };
  const transfer = {
    files: [document],
    items: [{ kind: 'file', getAsFileSystemHandle: async () => directoryHandle }],
  } as unknown as DataTransfer;

  const selection = await droppedSelection(transfer);
  assert.deepEqual(selection.plans.map((plan) => plan.relativePath), ['Modern folder/document.txt']);
  assert.deepEqual(selection.folders, ['Modern folder']);
});

test('folder discovery progress stays cumulative across multiple dropped entries', async () => {
  const first = directoryEntry('First', [fileEntry('one.txt', testFile('one.txt', '1'))]);
  const second = directoryEntry('Second', [fileEntry('two.txt', testFile('two.txt', '2'))]);
  const progress: Array<{ files: number; folders: number }> = [];
  await droppedSelection({ files: [], items: [
    { kind: 'file', webkitGetAsEntry: () => first },
    { kind: 'file', webkitGetAsEntry: () => second },
  ] } as unknown as DataTransfer, (value) => progress.push(value));
  assert.deepEqual(progress.at(-1), { files: 2, folders: 2 });
});

test('structured file-list fallback preserves nested folder paths', async () => {
  const file = testFile('settings.json', '{}', 'Project/config/settings.json');
  const transfer = { files: [file], items: [] } as unknown as DataTransfer;
  const selection = await droppedSelection(transfer);
  assert.equal(selection.plans[0]?.relativePath, 'Project/config/settings.json');
});

test('folder selection validation rejects collisions before any upload starts', () => {
  const file = testFile('same.txt', 'file');
  const other = testFile('same.txt', 'other');
  assert.throws(() => dedupeUploadPlans([
    { file, relativePath: 'Project/same.txt' },
    { file: other, relativePath: 'Project/same.txt' },
  ]), /duplicate files/);
  assert.throws(() => validateUploadSelection([{ file, relativePath: 'Project' }], ['Project']), /file and a folder/);
  assert.equal(normalizeUploadPath('café/readme.md'), 'café/readme.md');
  assert.throws(() => normalizeUploadPath('../readme.md'), /unsafe/);
});

test('flat file selections keep same-named files for server-side suffixing', () => {
  const first = testFile('same.txt', 'first');
  const second = testFile('same.txt', 'second');
  const plans = dedupeUploadPlans([
    { file: first, relativePath: 'same.txt' },
    { file: second, relativePath: 'same.txt' },
  ], true);
  assert.equal(plans.length, 2);
});
