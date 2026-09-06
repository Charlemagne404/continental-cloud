export type UploadPlan = { file: File; relativePath: string };
export type UploadSelection = { plans: UploadPlan[]; folders: string[] };

type LegacyFileEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: () => void) => void;
  createReader?: () => LegacyDirectoryReader;
};
type LegacyDirectoryReader = { readEntries: (success: (entries: LegacyFileEntry[]) => void, error?: () => void) => void };
type FileSystemHandleLike = {
  kind: 'file' | 'directory';
  name: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterable<unknown>;
  entries?: () => AsyncIterable<unknown>;
};
type DropNode = { name: string; kind: 'file' | 'directory'; getFile?: () => Promise<File>; readChildren?: () => Promise<DropNode[]> };

const pathEncoder = new TextEncoder();

export function toUploadPlans(files: FileList | File[], preservePaths: boolean): UploadPlan[] {
  return Array.from(files).map((file) => ({
    file,
    relativePath: preservePaths ? ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name) : file.name,
  }));
}

export function dedupeUploadPlans(plans: UploadPlan[]): UploadPlan[] {
  const byPath = new Map<string, UploadPlan>();
  const byPortablePath = new Map<string, string>();
  for (const plan of plans) {
    const existing = byPath.get(plan.relativePath);
    if (existing) {
      if (existing.file.size !== plan.file.size || existing.file.lastModified !== plan.file.lastModified || existing.file.type !== plan.file.type) {
        throw new Error('The selected folder contains duplicate files at “' + plan.relativePath + '”.');
      }
      continue;
    }
    const portablePath = plan.relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    const portableExisting = byPortablePath.get(portablePath);
    if (portableExisting && portableExisting !== plan.relativePath) {
      throw new Error('The selected folder contains files that differ only by letter case: “' + portableExisting + '” and “' + plan.relativePath + '”.');
    }
    byPortablePath.set(portablePath, plan.relativePath);
    byPath.set(plan.relativePath, plan);
  }
  return [...byPath.values()];
}

export function dedupeUploadFolders(folders: string[]): string[] {
  const unique = new Set<string>();
  const portable = new Map<string, string>();
  for (const folder of folders) {
    const portablePath = folder.normalize('NFC').toLocaleLowerCase('en-US');
    const existing = portable.get(portablePath);
    if (existing && existing !== folder) throw new Error('The selected folder contains directories that differ only by letter case: “' + existing + '” and “' + folder + '”.');
    portable.set(portablePath, folder);
    unique.add(folder);
  }
  return [...unique];
}

export function validateUploadSelection(plans: UploadPlan[], explicitFolders: string[]): void {
  const filePaths = new Set(plans.map((plan) => plan.relativePath));
  const folderPaths = new Set<string>();
  const addAncestors = (path: string): void => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) folderPaths.add(parts.slice(0, index).join('/'));
  };
  for (const folder of explicitFolders) {
    folderPaths.add(folder);
    addAncestors(folder);
  }
  for (const plan of plans) addAncestors(plan.relativePath);

  for (const filePath of filePaths) {
    if (folderPaths.has(filePath)) throw new Error('The selected folder contains both a file and a folder named “' + filePath + '”.');
    let parent = uploadParent(filePath);
    while (parent) {
      if (filePaths.has(parent)) throw new Error('The selected folder contains a file inside the file “' + parent + '”.');
      parent = uploadParent(parent);
    }
  }

  const portable = new Map<string, { path: string; kind: 'file' | 'folder' }>();
  for (const [kind, paths] of [['file', filePaths] as const, ['folder', folderPaths] as const]) {
    for (const path of paths) {
      const key = path.normalize('NFC').toLocaleLowerCase('en-US');
      const previous = portable.get(key);
      if (previous && (previous.path !== path || previous.kind !== kind)) {
        throw new Error('The selected folder contains paths that differ only by letter case: “' + previous.path + '” and “' + path + '”.');
      }
      portable.set(key, { path, kind });
    }
  }
}

export function normalizeUploadPath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.endsWith('/')) throw new Error('This file has an unsafe or unsupported path: ' + value);
  const parts = value.split('/');
  const normalized = parts.map((part) => part.normalize('NFC'));
  if (!normalized.length || normalized.some((part) => !part || part === '.' || part === '..' || ['.continental', '.trash'].includes(part.toLowerCase()) || pathEncoder.encode(part).byteLength > 255)) {
    throw new Error('This file has an unsafe or unsupported path: ' + value);
  }
  return normalized.join('/');
}

/**
 * Reads a browser drop while the DataTransfer is still live. Entry APIs are
 * preferred because they retain directory structure; flattened files are only
 * used when entry traversal is unavailable or cannot be completed safely.
 */
export async function droppedSelection(dataTransfer: DataTransfer): Promise<UploadSelection> {
  const fallback = toUploadPlans(dataTransfer.files, true);
  const items = Array.from(dataTransfer.items ?? []);
  const entries: DropNode[] = [];
  const handlePromises: Array<Promise<DropNode | undefined>> = [];
  let hasDirectoryEntry = false;
  let hasFileItem = false;

  // Capture all synchronous entry handles and start modern handle promises
  // before the event handler returns. Some browsers protect DataTransfer data
  // after the drop event has finished dispatching.
  for (const item of items) {
    if (item.kind !== 'file') continue;
    hasFileItem = true;
    const candidate = item as unknown as {
      webkitGetAsEntry?: () => LegacyFileEntry | null;
      getAsEntry?: () => LegacyFileEntry | null;
      getAsFileSystemHandle?: () => Promise<FileSystemHandleLike | null>;
    };
    const legacy = candidate.webkitGetAsEntry?.() ?? candidate.getAsEntry?.();
    if (legacy) {
      const node = legacyNode(legacy);
      entries.push(node);
      hasDirectoryEntry ||= node.kind === 'directory';
      continue;
    }
    if (candidate.getAsFileSystemHandle) {
      try {
        const handlePromise = candidate.getAsFileSystemHandle();
        handlePromises.push(Promise.resolve(handlePromise).then((handle) => handle ? handleNode(handle) : undefined).catch(() => undefined));
      } catch {
        // Use the file-list fallback below if the browser rejects this optional API.
      }
    }
  }
  for (const node of (await Promise.all(handlePromises)).filter((entry): entry is DropNode => Boolean(entry))) {
    entries.push(node);
    hasDirectoryEntry ||= node.kind === 'directory';
  }

  if (!entries.length) {
    if (!fallback.length && hasFileItem) throw new Error('Could not read the dropped folder. Try the folder picker instead.');
    return { plans: fallback, folders: [] };
  }
  try {
    const discovered: UploadSelection = { plans: [], folders: [] };
    for (const entry of entries) {
      const selection = await walkDropEntry(entry);
      discovered.plans.push(...selection.plans);
      discovered.folders.push(...selection.folders);
    }
    if (discovered.plans.length || discovered.folders.length) return discovered;
    return { plans: fallback, folders: [] };
  } catch (error) {
    // A structured webkitRelativePath fallback is still safe for a partially
    // readable folder. Never flatten a directory drop to the current cloud
    // folder: that silently destroys the user's folder structure.
    const fallbackKeepsStructure = fallback.some((plan) => plan.relativePath.includes('/'));
    if (fallback.length && (!hasDirectoryEntry || fallbackKeepsStructure)) return { plans: fallback, folders: [] };
    throw error instanceof Error ? error : new Error('Could not read the dropped folder.');
  }
}

export async function walkDropEntry(entry: DropNode, prefix = ''): Promise<UploadSelection> {
  const selection: UploadSelection = { plans: [], folders: [] };
  const pending: Array<{ entry: DropNode; prefix: string }> = [{ entry, prefix }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const path = current.prefix ? current.prefix + '/' + current.entry.name : current.entry.name;
    if (current.entry.kind === 'file' && current.entry.getFile) {
      selection.plans.push({ file: await current.entry.getFile(), relativePath: path });
    } else if (current.entry.kind === 'directory' && current.entry.readChildren) {
      selection.folders.push(path);
      const children = await current.entry.readChildren();
      for (let index = children.length - 1; index >= 0; index--) pending.push({ entry: children[index], prefix: path });
    } else {
      throw new Error('Could not read the dropped folder structure.');
    }
    visited++;
    if (visited % 64 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return selection;
}

function legacyNode(entry: LegacyFileEntry): DropNode {
  if (entry.isFile && entry.file) {
    return { name: entry.name, kind: 'file', getFile: () => new Promise<File>((resolve, reject) => {
      try { entry.file!(resolve, reject); } catch (error) { reject(error); }
    }) };
  }
  if (entry.isDirectory && entry.createReader) {
    return { name: entry.name, kind: 'directory', readChildren: async () => {
      const reader = entry.createReader!();
      const children: DropNode[] = [];
      for (;;) {
        const batch = await new Promise<LegacyFileEntry[]>((resolve, reject) => {
          try { reader.readEntries(resolve, reject); } catch (error) { reject(error); }
        });
        if (!batch.length) return children;
        children.push(...batch.map(legacyNode));
      }
    } };
  }
  throw new Error('Could not read the dropped folder structure.');
}

function handleNode(handle: FileSystemHandleLike): DropNode {
  if (handle.kind === 'file' && handle.getFile) return { name: handle.name, kind: 'file', getFile: () => handle.getFile!() };
  if (handle.kind === 'directory') {
    return { name: handle.name, kind: 'directory', readChildren: async () => {
      const iterator = handle.values?.() ?? handle.entries?.();
      if (!iterator) throw new Error('Could not read the dropped folder structure.');
      const children: DropNode[] = [];
      for await (const value of iterator) {
        const child = Array.isArray(value) ? value[1] : value;
        if (!child || typeof child !== 'object') throw new Error('Could not read the dropped folder structure.');
        children.push(handleNode(child as FileSystemHandleLike));
      }
      return children;
    } };
  }
  throw new Error('Could not read the dropped folder structure.');
}

export function uploadParent(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}
