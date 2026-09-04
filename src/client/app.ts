type FileItem = {
  id: string;
  relativePath: string;
  parentPath: string;
  name: string;
  isDirectory: boolean;
  mimeType: string | null;
  size: number;
  createdAt: string;
  modifiedAt: string;
  favorite: boolean;
  trashedAt: string | null;
  checksum?: string | null;
  revision?: number;
  previewable?: boolean;
};
type View = 'drive' | 'recent' | 'favorites' | 'activity' | 'sync' | 'operations' | 'trash' | 'search';
type UploadPlan = { file: File; relativePath: string };
type UploadRecord = { localId: string; file: File; relativePath: string; parentPath: string; id?: string; progress: number; state: 'uploading' | 'error' | 'complete'; error?: string; controller?: AbortController };
type Notice = { message: string; tone: 'warning' | 'error' | 'info' };
type OfflineOperation = { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown; label: string };
type PageData = { path: string; items: FileItem[]; hasMore: boolean; offset: number; limit: number; nextOffset: number | null };
type Tag = { id: string; name: string; color: string };
type SavedSearch = { id: string; name: string; query: string; filters: Record<string, string | number | boolean>; createdAt: string };
type Activity = { id: string; action: string; nodeId: string | null; path: string | null; detail: string | null; createdAt: string };
type SyncProgress = { phase: string; initial: boolean; filesTotal: number; filesDone: number; foldersTotal: number; foldersDone: number; bytesTotal: number; bytesDone: number; excludedFiles: number; excludedFolders: number; excludedBytes: number };
type SyncMapping = { id: string; cloudPath: string; localPath: string; policy: { preset: 'project' | 'exact'; exclude: string[] }; paused: boolean; status: string; lastError: string | null; progress: SyncProgress | null };
type SyncDeviceView = { id: string; name: string; platform: string; clientVersion: string; lastSeenAt: string; revokedAt: string | null; mappings: SyncMapping[] };
type ConflictView = Activity & { originalPath: string; node: FileItem; cloud: FileItem | null };
type PairingView = { id: string; code: string; cloudPath: string; expiresAt: string; qr?: string };
type InstallerPlatform = 'windows' | 'macos' | 'linux';
type OperationsData = {
  storage: { freeBytes?: number; totalBytes?: number; usedBytes: number; detail?: string; breakdown: { managedBytes: number; trashBytes: number; versionBytes: number }; history: Array<{ freeBytes: number | null; totalBytes: number | null }> };
  jobs: Array<{ kind: string; state: string; detail: string | null; createdAt: string }>;
  failedJobs: Array<{ kind: string; detail: string | null }>;
  uploads: unknown[];
  usage: { folders: Array<{ folder: string; bytes: number }>; types: Array<{ type: string; bytes: number }> };
  retention: { versionRetention: number; trashRetentionDays: number; trashItems: number; expiringTrash: number };
  lastIntegrityCheck: Activity | null;
};

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const shell = $('#app');
const sidebar = $('#cloud-sidebar');
const mobileNav = $('.mobile-nav') as HTMLButtonElement;
const navScrim = $('.nav-scrim') as HTMLButtonElement;
const fileList = $('#file-list');
const loading = $('#loading');
const empty = $('#empty');
const emptyTitle = $('#empty-title');
const emptyCopy = $('#empty-copy');
const emptyAction = $('#empty-action') as HTMLButtonElement;
const details = $('#details');
const statusBanner = $('#status-banner');
const pagination = $('#pagination-controls');
const authDialog = $('#auth-dialog') as HTMLDialogElement;
const previewDialog = $('#preview-dialog') as HTMLDialogElement;
const mobileDetailsDialog = $('#mobile-details-dialog') as HTMLDialogElement;
const versionsDialog = $('#versions-dialog') as HTMLDialogElement;
const syncSetupDialog = $('#sync-setup-dialog') as HTMLDialogElement;
const pairingDialog = $('#sync-pairing-dialog') as HTMLDialogElement;
const state = {
  view: 'drive' as View,
  path: '',
  selected: new Set<string>(),
  items: [] as FileItem[],
  viewMode: (localStorage.getItem('cloud-view') ?? 'grid') as 'grid' | 'list',
  sort: 'name',
  direction: 'asc',
  nextOffset: 0,
  hasMore: false,
  loadingMore: false,
  uploads: [] as UploadRecord[],
  searchTimer: 0,
  syncRefreshTimer: 0,
  clipboard: null as { ids: string[]; mode: 'cut' | 'copy' } | null,
  searchFilters: {} as Record<string, string>,
  lastSearch: '',
  gallery: [] as FileItem[],
  notice: null as Notice | null,
  loadError: null as string | null,
  connectionState: 'unknown' as 'unknown' | 'ready' | 'offline' | 'misconfigured',
  storageWarning: '',
  offlineCache: localStorage.getItem('cloud-offline-cache') === 'true',
};
const SNAPSHOT_PREFIX = 'continental-cloud-snapshot:';
let pairingPoll: number | undefined;
let installerPoll: number | undefined;
let activePairing: PairingView | undefined;
let activityTimer: number | undefined;

class Api {
  private token(): string | null { return sessionStorage.getItem('continental-cloud-token'); }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    const token = this.token();
    if (token) headers.set('X-Continental-Token', token);
    const response = await fetch('/api' + path, { ...init, headers, credentials: 'same-origin' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? 'Request failed (' + response.status + ')'), { status: response.status, code: body.error?.code });
    return body.data as T;
  }
  async download(path: string, body: unknown): Promise<Blob> {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const token = this.token();
    if (token) headers.set('X-Continental-Token', token);
    const response = await fetch('/api' + path, { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(new Error(error.error?.message ?? `Download failed (${response.status})`), { status: response.status, code: error.error?.code });
    }
    return response.blob();
  }
  json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return this.request<T>(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async chunk<T>(path: string, data: Blob, signal: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.size) }, body: data, signal });
  }
}
const api = new Api();

function human(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const level = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / 1024 ** level).toFixed(level ? 1 : 0) + ' ' + units[level];
}
function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(date);
}
function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
function glyph(item: FileItem): string {
  if (item.isDirectory) return '▰';
  if (item.mimeType?.startsWith('image/')) return '◉';
  if (item.mimeType?.startsWith('video/')) return '▶';
  if (item.mimeType?.startsWith('audio/')) return '♫';
  if (item.mimeType === 'application/pdf') return '▤';
  if (item.mimeType?.includes('json') || item.mimeType?.startsWith('text/')) return '‹›';
  return '◇';
}
function isImage(item: FileItem): boolean { return Boolean(item.mimeType?.startsWith('image/') && item.mimeType !== 'image/svg+xml'); }
function showDialog(dialog: HTMLDialogElement): void { if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog: HTMLDialogElement): void { if (dialog.open) dialog.close(); }
function showAuth(): void {
  showDialog(authDialog);
  window.setTimeout(() => ($('#token-input') as HTMLInputElement).focus(), 0);
}
function toast(message: string, error = false, undo?: () => void): void {
  const node = document.createElement('div');
  node.className = 'toast' + (error ? ' error' : '');
  const text = document.createElement('span');
  text.textContent = message;
  node.append(text);
  if (undo) {
    const button = document.createElement('button');
    button.className = 'quiet-button';
    button.textContent = 'Undo';
    button.addEventListener('click', () => { undo(); node.remove(); });
    node.append(button);
  }
  $('#toasts').append(node);
  window.setTimeout(() => node.remove(), 7000);
}

function privateCacheUrl(path: string): string {
  if (!state.offlineCache) return path;
  return path + (path.includes('?') ? '&' : '?') + 'offline-cache=1';
}
function snapshotKey(view = state.view, path = state.path): string { return SNAPSHOT_PREFIX + view + ':' + path; }
function saveSnapshot(key: string, items: FileItem[]): void {
  if (!state.offlineCache) return;
  try { localStorage.setItem(key, JSON.stringify(items.slice(0, 500))); } catch { /* a full browser quota must not block browsing */ }
}
function readSnapshot(key: string): FileItem[] | null {
  if (!state.offlineCache) return null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(value) ? value as FileItem[] : null;
  } catch { return null; }
}
function clearSnapshots(): void {
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key?.startsWith(SNAPSHOT_PREFIX)) localStorage.removeItem(key);
  }
}
async function clearPrivateCache(): Promise<void> {
  const message = { type: 'clear-private-cache' };
  try {
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(message);
    else (await navigator.serviceWorker.ready).active?.postMessage(message);
  } catch { /* service workers are optional */ }
}
function setNotice(message: string, tone: Notice['tone'] = 'info'): void { state.notice = { message, tone }; renderStatusBanner(); }
function renderStatusBanner(): void {
  statusBanner.replaceChildren();
  const messages: Array<{ text: string; tone: Notice['tone'] }> = [];
  if (state.notice) messages.push({ text: state.notice.message, tone: state.notice.tone });
  if (state.connectionState === 'offline' || state.connectionState === 'misconfigured') messages.push({ text: state.storageWarning || 'Storage is unavailable. Writes are blocked until it is healthy again.', tone: 'error' });
  else if (state.storageWarning) messages.push({ text: state.storageWarning, tone: 'warning' });
  if (!navigator.onLine) messages.push({ text: 'Offline mode: file changes that are safe to queue will wait on this browser.', tone: 'warning' });
  const queue = offlineOperations();
  if (queue.length) messages.push({ text: queue.length + ' queued change' + (queue.length === 1 ? '' : 's') + ' waiting for a connection.', tone: 'warning' });
  if (!messages.length) { statusBanner.hidden = true; return; }
  const tone = messages.some((item) => item.tone === 'error') ? 'error' : messages.some((item) => item.tone === 'warning') ? 'warning' : 'info';
  statusBanner.className = 'status-banner ' + tone;
  for (const message of messages) {
    const text = document.createElement('span');
    text.textContent = message.text;
    statusBanner.append(text);
  }
  if (state.notice) {
    const retry = document.createElement('button');
    retry.className = 'quiet-button';
    retry.dataset.action = 'retry';
    retry.textContent = 'Retry';
    statusBanner.append(retry);
  }
  if (queue.length) {
    const retry = document.createElement('button');
    retry.className = 'quiet-button';
    retry.dataset.action = 'retry-offline';
    retry.textContent = 'Retry queued';
    const clear = document.createElement('button');
    clear.className = 'quiet-button';
    clear.dataset.action = 'clear-offline';
    clear.textContent = 'Clear queue';
    statusBanner.append(retry, clear);
  }
  statusBanner.hidden = false;
}

function emptyContent(): { title: string; copy: string; action: string; actionLabel: string } {
  if (state.loadError) return { title: 'Could not load this view', copy: state.loadError, action: 'retry', actionLabel: 'Try again' };
  if (state.view === 'search') return { title: 'No matching files', copy: 'Try a broader name, remove a filter, or search another folder.', action: 'clear-search', actionLabel: 'Clear search' };
  if (state.view === 'recent') return { title: 'Nothing recent yet', copy: 'Files you change will appear here.', action: 'browse-drive', actionLabel: 'Browse my drive' };
  if (state.view === 'favorites') return { title: 'No favorites yet', copy: 'Star a file or folder to keep it close at hand.', action: 'browse-drive', actionLabel: 'Browse my drive' };
  if (state.view === 'trash') return { title: 'Trash is empty', copy: 'Deleted files will stay recoverable until the configured retention period ends.', action: 'browse-drive', actionLabel: 'Browse my drive' };
  if (state.path) return { title: 'This folder is empty', copy: 'Add a file, create a folder, or drop something here.', action: 'new', actionLabel: 'Add to cloud' };
  return { title: 'This space is ready', copy: 'Bring in a file, create a folder, or drop something here.', action: 'new', actionLabel: 'Add to cloud' };
}
function renderEmpty(visible: boolean, custom?: { title: string; copy: string; action?: string; actionLabel?: string }): void {
  if (!visible) { empty.hidden = true; return; }
  const content = custom ?? emptyContent();
  emptyTitle.textContent = content.title;
  emptyCopy.textContent = content.copy;
  emptyAction.textContent = content.actionLabel ?? 'Try again';
  emptyAction.dataset.action = content.action ?? 'retry';
  emptyAction.hidden = !content.action;
  empty.hidden = false;
}

function setFileListSemantics(kind: 'files' | 'region', label: string): void {
  fileList.setAttribute('role', kind === 'files' ? 'list' : 'region');
  fileList.setAttribute('aria-label', label);
}

async function refresh(): Promise<void> {
  window.clearTimeout(state.syncRefreshTimer);
  loading.hidden = false;
  fileList.replaceChildren();
  pagination.replaceChildren();
  pagination.hidden = true;
  state.selected.clear();
  state.loadError = null;
  state.hasMore = false;
  state.nextOffset = 0;
  renderSelection();
  renderDetails();
  try {
    if (state.view === 'drive') {
      const params = new URLSearchParams({ path: state.path, sort: state.sort, direction: state.direction, limit: '100', offset: '0' });
      const data = await api.request<PageData>('/files?' + params);
      state.items = data.items;
      state.hasMore = data.hasMore;
      state.nextOffset = data.nextOffset ?? data.offset + data.items.length;
      renderBreadcrumbs();
      saveSnapshot(snapshotKey(), state.items);
    } else if (state.view === 'recent') {
      state.items = await api.request<FileItem[]>('/recent');
      saveSnapshot(snapshotKey(), state.items);
    } else if (state.view === 'favorites') {
      state.items = await api.request<FileItem[]>('/favorites');
      saveSnapshot(snapshotKey(), state.items);
    } else if (state.view === 'search') {
      if (state.lastSearch) await runSearch(state.lastSearch, false);
      else state.items = [];
    } else if (state.view === 'trash') {
      const trash = await api.request<Array<{ id: string; originalPath: string; deletedAt: string; node: FileItem }>>('/trash');
      state.items = trash.map((entry) => ({ ...entry.node, id: entry.id, relativePath: entry.originalPath, modifiedAt: entry.deletedAt }));
    } else if (state.view === 'activity') {
      await renderActivity();
      return;
    } else if (state.view === 'sync') {
      await renderSync();
      return;
    } else if (state.view === 'operations') {
      await renderOperations();
      return;
    }
    state.notice = null;
    renderItems();
  } catch (error: any) {
    const cached = state.view === 'drive' || state.view === 'recent' || state.view === 'favorites' ? readSnapshot(snapshotKey()) : null;
    if (cached) {
      state.items = cached;
      state.notice = { message: 'Showing the last saved list from this browser. It may be out of date.', tone: 'warning' };
      renderItems();
    } else {
      state.items = [];
      state.loadError = error?.message ?? 'The server did not return this view.';
      handleError(error, false);
      renderItems();
    }
  } finally {
    loading.hidden = true;
    renderStatusBanner();
  }
}

async function loadMore(): Promise<void> {
  if (state.view !== 'drive' || !state.hasMore || state.loadingMore) return;
  state.loadingMore = true;
  const button = pagination.querySelector('button');
  if (button) { button.disabled = true; button.textContent = 'Loading…'; }
  try {
    const params = new URLSearchParams({ path: state.path, sort: state.sort, direction: state.direction, limit: '100', offset: String(state.nextOffset) });
    const data = await api.request<PageData>('/files?' + params);
    state.items.push(...data.items);
    state.hasMore = data.hasMore;
    state.nextOffset = data.nextOffset ?? data.offset + data.items.length;
    saveSnapshot(snapshotKey(), state.items);
    renderItems();
  } catch (error) { handleError(error); }
  finally { state.loadingMore = false; }
}

function renderItems(): void {
  setFileListSemantics('files', 'Files');
  fileList.className = 'file-grid ' + (state.viewMode === 'list' ? 'list' : '');
  fileList.replaceChildren();
  renderEmpty(state.items.length === 0);
  const emptySync = document.querySelector<HTMLElement>('#empty-sync-button');
  if (emptySync) emptySync.hidden = state.view !== 'drive';
  const fragment = document.createDocumentFragment();
  for (const item of state.items) fragment.append(renderCard(item));
  fileList.append(fragment);
  pagination.replaceChildren();
  if (state.view === 'drive' && state.hasMore) {
    const button = document.createElement('button');
    button.className = 'quiet-button';
    button.dataset.action = 'load-more';
    button.textContent = 'Load more files';
    pagination.append(button);
    pagination.hidden = false;
  }
  updateLabels();
}
function renderCard(item: FileItem): HTMLElement {
  const wrapper = document.createElement('article');
  wrapper.className = 'file-list-item';
  wrapper.setAttribute('role', 'listitem');
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'file-card ' + (item.isDirectory ? 'folder' : '') + (state.selected.has(item.id) ? ' selected' : '');
  card.dataset.id = item.id;
  card.dataset.modified = shortDate(item.modifiedAt);
  card.setAttribute('aria-label', item.name + ', ' + (item.isDirectory ? 'folder' : human(item.size) + ' file') + '. Select to show details.');
  const thumb = document.createElement('span');
  thumb.className = 'file-thumb';
  if (isImage(item)) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.src = privateCacheUrl('/api/files/' + item.id + '/thumbnail');
    image.onerror = () => thumb.replaceChildren(glyphNode(item));
    thumb.append(image);
  } else thumb.append(glyphNode(item));
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = item.name;
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = item.isDirectory ? 'Folder' : human(item.size) + ' · ' + shortDate(item.modifiedAt);
  card.append(thumb, name, meta);
  if (item.favorite) {
    const favorite = document.createElement('span');
    favorite.className = 'file-favorite';
    favorite.textContent = '✦';
    favorite.setAttribute('aria-hidden', 'true');
    card.append(favorite);
  }
  card.draggable = state.view !== 'trash';
  card.addEventListener('dragstart', (event) => {
    if (!state.selected.has(item.id)) selectItem(item, event as unknown as MouseEvent);
    event.dataTransfer?.setData('application/x-continental-node', item.id);
  });
  if (item.isDirectory) {
    card.addEventListener('dragover', (event) => event.preventDefault());
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData('application/x-continental-node');
      if (id) void moveNodes([id], item.relativePath);
      else if (event.dataTransfer) void uploadDropped(event.dataTransfer, item.relativePath);
    });
  }
  card.addEventListener('click', (event) => selectItem(item, event));
  card.addEventListener('dblclick', () => openItem(item));
  const actions = document.createElement('div');
  actions.className = 'file-card-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'quiet-button';
  open.textContent = state.view === 'trash' ? 'Select' : 'Open';
  open.setAttribute('aria-label', state.view === 'trash' ? 'Select ' + item.name : 'Open ' + item.name);
  open.addEventListener('click', (event) => { event.stopPropagation(); openItem(item); });
  const detail = document.createElement('button');
  detail.type = 'button';
  detail.className = 'quiet-button';
  detail.textContent = 'Details';
  detail.setAttribute('aria-label', 'Show details for ' + item.name);
  detail.addEventListener('click', (event) => { event.stopPropagation(); showDetails(item); });
  actions.append(open, detail);
  wrapper.append(card, actions);
  return wrapper;
}
function glyphNode(item: FileItem): HTMLElement {
  const value = document.createElement('span');
  value.className = 'file-glyph';
  value.textContent = glyph(item);
  return value;
}
function selectItem(item: FileItem, event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey) {
    if (state.selected.has(item.id)) state.selected.delete(item.id);
    else state.selected.add(item.id);
  } else {
    state.selected.clear();
    state.selected.add(item.id);
  }
  renderSelection();
  renderItems();
  renderDetails();
}
function openItem(item: FileItem): void {
  if (state.view === 'trash') { selectItem(item, new MouseEvent('click')); return; }
  if (item.isDirectory) { state.view = 'drive'; state.path = item.relativePath; void refresh(); return; }
  void preview(item);
}
function showDetails(item = selectedItems()[0]): void {
  if (!item) return toast('Select one item first.', true);
  state.selected.clear();
  state.selected.add(item.id);
  renderSelection();
  renderItems();
  renderDetails();
  const host = $('#mobile-details-content');
  host.replaceChildren();
  appendDetails(host, item, true);
  showDialog(mobileDetailsDialog);
}
function openSelected(): void {
  const items = selectedItems();
  if (items.length !== 1) return toast('Choose one item to open.', true);
  openItem(items[0]);
}
function renderSelection(): void {
  const actions = $('#selection-actions');
  const count = state.selected.size;
  actions.hidden = !count || state.view === 'activity';
  $('#selection-count').textContent = count + ' selected';
  const open = actions.querySelector<HTMLElement>('[data-action="open-selected"]');
  if (open) open.hidden = state.view === 'trash';
}
function selectedItems(): FileItem[] { return state.items.filter((item) => state.selected.has(item.id)); }

function renderBreadcrumbs(): void {
  const crumbs = $('#breadcrumbs');
  crumbs.replaceChildren();
  crumbs.append(crumb('My drive', ''));
  let current = '';
  for (const part of state.path.split('/').filter(Boolean)) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    crumbs.append(sep);
    current = current ? current + '/' + part : part;
    crumbs.append(crumb(part, current));
  }
}
function crumb(label: string, path: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'crumb-button';
  button.textContent = label;
  button.addEventListener('click', () => { state.view = 'drive'; state.path = path; void refresh(); });
  return button;
}
function updateLabels(): void {
  const name: Record<View, string> = { drive: state.path ? state.path.split('/').at(-1)! : 'My drive', recent: 'Recent', favorites: 'Favorites', activity: 'Activity', sync: 'Folder sync', operations: 'Recovery & operations', trash: 'Trash', search: 'Search' };
  $('#section-title').textContent = name[state.view];
  $('#section-kicker').textContent = state.view === 'trash' ? 'RECOVERABLE DELETION' : state.view === 'search' ? 'SEARCH RESULTS' : state.view === 'sync' ? 'PRIVATE DEVICE SYNC' : state.view === 'operations' ? 'RECOVERY CENTER' : 'PRIVATE STORAGE';
  ($('#search-tools') as HTMLElement).hidden = !['search', 'activity'].includes(state.view);
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
}

function appendDetails(host: HTMLElement, item: FileItem, mobile: boolean): void {
  if (isImage(item) && state.view !== 'trash') {
    const image = document.createElement('img');
    image.className = 'details-preview';
    image.alt = item.name;
    image.src = privateCacheUrl('/api/files/' + item.id + '/thumbnail');
    host.append(image);
  }
  if (mobile) {
    const title = document.createElement('p');
    title.className = 'eyebrow';
    title.textContent = item.isDirectory ? 'FOLDER' : 'FILE';
    host.append(title);
  } else {
    const title = document.createElement('h2');
    title.className = 'detail-name';
    title.textContent = item.name;
    host.append(title);
  }
  const rows: Array<[string, string]> = [
    ['Type', item.isDirectory ? 'Folder' : (item.mimeType ?? 'File')],
    ['Size', item.isDirectory ? '—' : human(item.size)],
    ['Modified', shortDate(item.modifiedAt)],
    ['Location', item.relativePath || 'My drive'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'detail-row';
    const key = document.createElement('span');
    key.textContent = label;
    const field = document.createElement('b');
    field.textContent = value;
    row.append(key, field);
    host.append(row);
  }
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  if (state.view === 'trash') {
    actions.append(detailButton('Restore', () => void restoreTrash(item.id)), detailButton('Delete permanently', () => void deleteTrash(item.id)));
  } else {
    if (!item.isDirectory) actions.append(detailButton('Preview', () => void preview(item)), detailButton('Download', () => download(item)));
    else actions.append(detailButton('Download archive', () => download(item)), detailButton('Set up sync', () => openSyncSetup(item.relativePath)));
    actions.append(detailButton(item.favorite ? 'Remove favorite' : 'Add to favorites', () => void favoriteItems()), detailButton('Tags', () => void assignTags(item)));
    if (!item.isDirectory) actions.append(detailButton('Version history', () => void versions(item)));
  }
  host.append(actions);
}
function renderDetails(): void {
  details.replaceChildren();
  const item = selectedItems()[0];
  if (!item) {
    const hint = document.createElement('div');
    hint.className = 'details-empty';
    hint.textContent = state.view === 'trash' ? 'Select an item to restore it or remove it permanently.' : 'Select a file to see its details.';
    details.append(hint);
    return;
  }
  if (state.selected.size > 1) {
    const hint = document.createElement('div');
    hint.className = 'details-empty';
    hint.textContent = state.selected.size + ' items selected.';
    details.append(hint);
    return;
  }
  appendDetails(details, item, false);
}
function detailButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}
async function assignTags(item: FileItem): Promise<void> {
  try {
    const existing = await api.request<Array<{ name: string }>>('/files/' + item.id + '/tags');
    const value = prompt('Tags (comma-separated)', existing.map((tag) => tag.name).join(', '));
    if (value === null) return;
    await api.request('/files/' + item.id + '/tags', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: value.split(',').map((tag) => tag.trim()).filter(Boolean) }) });
    toast('Tags updated.');
    renderDetails();
  } catch (error) { handleError(error); }
}

async function renderActivity(): Promise<void> {
  const events = await api.request<Activity[]>('/activity');
  const query = (state.searchFilters.activity ?? '').toLowerCase();
  const filtered = events.filter((event) => !query || (event.action + ' ' + (event.path ?? '') + ' ' + (event.detail ?? '')).toLowerCase().includes(query));
  state.items = [];
  setFileListSemantics('region', 'Activity');
  fileList.className = 'file-grid list';
  fileList.replaceChildren();
  renderEmpty(filtered.length === 0, { title: query ? 'No matching activity' : 'No activity yet', copy: query ? 'Try a different activity or file name.' : 'Changes to this private drive will appear here.', action: query ? 'clear-activity-filter' : undefined, actionLabel: query ? 'Clear filter' : undefined });
  const tools = $('#search-tools');
  tools.hidden = false;
  tools.replaceChildren();
  const label = document.createElement('label');
  label.htmlFor = 'activity-filter';
  label.textContent = 'Filter activity';
  const input = document.createElement('input');
  input.id = 'activity-filter';
  input.type = 'search';
  input.placeholder = 'Action, device, or file';
  input.setAttribute('aria-label', 'Filter activity by action, device, or file');
  input.value = state.searchFilters.activity ?? '';
  input.addEventListener('input', () => { state.searchFilters.activity = input.value; void renderActivity(); });
  label.append(input);
  tools.append(label);
  for (const event of filtered) {
    const wrapper = document.createElement('article');
    wrapper.className = 'file-list-item';
    const card = document.createElement('article');
    card.className = 'file-card';
    const title = document.createElement('span');
    title.className = 'file-name';
    title.textContent = event.action.replaceAll('_', ' ');
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = (event.path ?? 'Cloud') + ' · ' + shortDate(event.createdAt);
    card.append(title, meta);
    if (event.detail) {
      const detail = document.createElement('small');
      detail.className = 'file-meta';
      detail.textContent = event.detail;
      card.append(detail);
    }
    if (event.nodeId) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'quiet-button';
      open.textContent = 'Open file';
      open.addEventListener('click', async () => {
        try { openItem(await api.request<FileItem>('/files/' + event.nodeId)); }
        catch { toast('This item is no longer available.', true); }
      });
      card.append(open);
    }
    wrapper.append(card);
    fileList.append(wrapper);
  }
  updateLabels();
  window.clearTimeout(activityTimer);
  activityTimer = window.setTimeout(() => { if (state.view === 'activity') void renderActivity(); }, 15_000);
}

async function renderSync(): Promise<void> {
  const [devices, conflicts] = await Promise.all([api.request<SyncDeviceView[]>('/sync/devices'), api.request<ConflictView[]>('/sync/conflicts')]);
  state.items = [];
  setFileListSemantics('region', 'Sync devices and conflicts');
  fileList.className = 'sync-panel';
  fileList.replaceChildren();
  renderEmpty(false);
  const summary = document.createElement('section');
  summary.className = 'sync-summary';
  const text = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = devices.length ? devices.length + ' trusted device' + (devices.length === 1 ? '' : 's') : 'Set up your first sync device';
  const copy = document.createElement('p');
  copy.textContent = 'Create a one-time pairing code, claim it from a desktop agent, and keep selected folders synchronized across your devices.';
  text.append(heading, copy);
  const pair = document.createElement('button');
  pair.className = 'quiet-button';
  pair.textContent = 'Pair device';
  pair.addEventListener('click', () => openPairing());
  const setup = document.createElement('button');
  setup.className = 'primary';
  setup.textContent = 'Download sync app';
  setup.addEventListener('click', () => openSyncSetup());
  const actions = document.createElement('div');
  actions.className = 'mapping-actions';
  actions.append(setup, pair);
  summary.append(text, actions);
  fileList.append(summary);
  for (const device of devices) {
    const card = document.createElement('section');
    card.className = 'device-card';
    const head = document.createElement('header');
    const identity = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = device.name;
    const meta = document.createElement('p');
    meta.textContent = device.platform + ' · client ' + device.clientVersion + ' · seen ' + shortDate(device.lastSeenAt);
    identity.append(title, meta);
    head.append(identity);
    if (!device.revokedAt) {
      const revoke = document.createElement('button');
      revoke.className = 'quiet-button danger';
      revoke.textContent = 'Revoke device';
      revoke.addEventListener('click', async () => {
        if (!confirm('Revoke ' + device.name + '? Its saved token will no longer authorize sync requests.')) return;
        try { await api.request('/sync/devices/' + device.id, { method: 'DELETE' }); toast(device.name + ' was revoked.'); await refresh(); }
        catch (error) { handleError(error); }
      });
      head.append(revoke);
    } else {
      const revoked = document.createElement('span');
      revoked.className = 'sync-status error';
      revoked.textContent = 'Revoked';
      head.append(revoked);
    }
    const mappings = document.createElement('div');
    mappings.className = 'mapping-list';
    if (!device.mappings.length) {
      const none = document.createElement('p');
      none.className = 'sync-empty';
      none.textContent = 'No folders selected on this device.';
      mappings.append(none);
    }
    for (const mapping of device.mappings) {
      const row = document.createElement('article');
      row.className = 'mapping-row';
      const paths = document.createElement('div');
      const cloud = document.createElement('b');
      cloud.textContent = '/' + (mapping.cloudPath || 'My drive');
      const local = document.createElement('small');
      local.textContent = mapping.localPath + ' · ' + (mapping.policy.preset === 'project' ? 'Coding project profile' : 'Exact mirror');
      paths.append(cloud, local);
      const controls = document.createElement('div');
      controls.className = 'mapping-actions';
      const status = document.createElement('span');
      status.className = 'sync-status ' + (mapping.paused ? 'paused' : mapping.status === 'error' || mapping.progress?.phase === 'error' ? 'error' : '');
      status.textContent = mapping.paused ? 'Paused' : mapping.status === 'idle' ? (mapping.progress?.phase === 'complete' ? 'Synced' : 'Ready') : mapping.status;
      const toggle = document.createElement('button');
      toggle.className = 'quiet-button';
      toggle.textContent = mapping.paused ? 'Resume' : 'Pause';
      toggle.addEventListener('click', () => void updateMapping(device.id, mapping.id, { paused: !mapping.paused }));
      const edit = document.createElement('button');
      edit.className = 'quiet-button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => void editMapping(device.id, mapping));
      controls.append(status, toggle, edit);
      row.append(paths, controls);
      if (mapping.progress && mapping.progress.phase !== 'complete') {
        const progress = document.createElement('small');
        progress.className = 'mapping-progress';
        progress.textContent = syncProgressLabel(mapping.progress);
        row.append(progress);
      }
      if (mapping.progress && (mapping.progress.excludedFiles || mapping.progress.excludedFolders)) {
        const excluded = document.createElement('small');
        excluded.className = 'mapping-progress';
        const parts: string[] = [];
        if (mapping.progress.excludedFiles) parts.push(mapping.progress.excludedFiles + ' file' + (mapping.progress.excludedFiles === 1 ? '' : 's'));
        if (mapping.progress.excludedFolders) parts.push(mapping.progress.excludedFolders + ' folder' + (mapping.progress.excludedFolders === 1 ? '' : 's'));
        excluded.textContent = parts.join(' and ') + ' excluded by profile.';
        row.append(excluded);
      }
      if (mapping.lastError) {
        const error = document.createElement('small');
        error.className = 'mapping-error';
        error.textContent = mapping.lastError;
        row.append(error);
      }
      mappings.append(row);
    }
    const addMapping = document.createElement('button');
    addMapping.className = 'quiet-button';
    addMapping.textContent = '+ Add folder mapping';
    addMapping.addEventListener('click', () => void addMappingForDevice(device.id));
    mappings.append(addMapping);
    card.append(head, mappings);
    fileList.append(card);
  }
  if (conflicts.length) {
    const card = document.createElement('section');
    card.className = 'device-card conflicts-card';
    const heading = document.createElement('h2');
    heading.textContent = 'Conflict resolver';
    const copy = document.createElement('p');
    copy.textContent = 'Incoming copies stay separate until you choose what should become the cloud file. Every replacement preserves the previous cloud content as a version.';
    card.append(heading, copy);
    for (const conflict of conflicts.slice(0, 20)) {
      const row = document.createElement('article');
      row.className = 'conflict-choice';
      const remote = document.createElement('div');
      const remoteTitle = document.createElement('b');
      remoteTitle.textContent = 'Cloud copy';
      const remoteDetail = document.createElement('small');
      remoteDetail.textContent = conflict.cloud ? conflict.cloud.name + ' · ' + human(conflict.cloud.size) + ' · ' + shortDate(conflict.cloud.modifiedAt) : conflict.originalPath + ' · no active cloud copy';
      remote.append(remoteTitle, remoteDetail);
      const incoming = document.createElement('div');
      const incomingTitle = document.createElement('b');
      incomingTitle.textContent = 'Incoming device copy';
      const incomingDetail = document.createElement('small');
      incomingDetail.textContent = conflict.node.name + ' · ' + human(conflict.node.size) + ' · ' + shortDate(conflict.node.modifiedAt);
      incoming.append(incomingTitle, incomingDetail);
      const actions = document.createElement('div');
      actions.className = 'conflict-actions';
      for (const option of [['keep-cloud', 'Keep cloud'], ['keep-incoming', 'Keep incoming'], ['keep-both', 'Keep both'], ['dismiss', 'Dismiss']] as const) {
        const button = document.createElement('button');
        button.className = 'quiet-button' + (option[0] === 'keep-incoming' ? ' primary' : '');
        button.textContent = option[1];
        button.addEventListener('click', () => void resolveConflict(conflict, option[0]));
        actions.append(button);
      }
      const rename = document.createElement('button');
      rename.className = 'quiet-button';
      rename.textContent = 'Rename incoming';
      rename.addEventListener('click', () => void renameConflict(conflict));
      actions.append(rename);
      incoming.append(actions);
      row.append(remote, incoming);
      card.append(row);
    }
    fileList.append(card);
  }
  updateLabels();
}
function syncProgressLabel(progress: { initial: boolean; phase: string; filesDone: number; filesTotal: number; foldersDone: number; foldersTotal: number; bytesDone: number; bytesTotal: number }): string {
  const prefix = progress.initial ? 'Initial sync' : 'Syncing';
  if (progress.phase === 'scanning') return prefix + ': scanning local folder';
  if (progress.bytesTotal) return prefix + ': ' + human(progress.bytesDone) + ' / ' + human(progress.bytesTotal) + ' · ' + progress.filesDone + '/' + progress.filesTotal + ' files';
  return prefix + ': ' + progress.filesDone + '/' + progress.filesTotal + ' files · ' + progress.foldersDone + '/' + progress.foldersTotal + ' folders';
}
async function resolveConflict(conflict: ConflictView, choice: 'keep-cloud' | 'keep-incoming' | 'keep-both' | 'dismiss'): Promise<void> {
  if ((choice === 'keep-cloud' || choice === 'keep-incoming') && !confirm(choice === 'keep-incoming' ? 'Replace the cloud copy with the incoming copy? The current cloud file will remain in version history.' : 'Move the incoming conflict copy to Trash?')) return;
  try {
    await api.json('/sync/conflicts/' + conflict.node.id + '/resolve', 'POST', { originalPath: conflict.originalPath, choice });
    toast(choice === 'keep-incoming' ? 'Incoming copy is now the cloud file.' : choice === 'keep-cloud' ? 'Cloud copy kept; incoming copy moved to Trash.' : 'Conflict marked as resolved.');
    await refresh();
  } catch (error) { handleError(error); }
}
async function renameConflict(conflict: ConflictView): Promise<void> {
  const name = prompt('New name for the incoming copy', conflict.node.name);
  if (!name) return;
  try { await api.json('/files/' + conflict.node.id, 'PATCH', { action: 'rename', name }); toast('Incoming copy renamed.'); await refresh(); }
  catch (error) { handleError(error); }
}
function syncSetupCommand(): string { return 'cloud-sync setup --server ' + location.origin; }
function detectedInstallerPlatform(): InstallerPlatform {
  const agent = navigator.userAgent.toLowerCase();
  return agent.includes('windows') ? 'windows' : agent.includes('mac os') || agent.includes('macintosh') ? 'macos' : 'linux';
}
function installerLabel(platform: InstallerPlatform): string { return platform === 'windows' ? 'Windows' : platform === 'macos' ? 'macOS' : 'Linux'; }
function openSyncSetup(cloudPath = ''): void {
  if (installerPoll !== undefined) window.clearInterval(installerPoll);
  installerPoll = undefined;
  ($('#sync-setup-command') as HTMLElement).textContent = syncSetupCommand();
  ($('#sync-download-cloud') as HTMLInputElement).value = cloudPath;
  ($('#sync-download-status') as HTMLElement).hidden = true;
  document.querySelectorAll<HTMLButtonElement>('[data-installer-platform]').forEach((button) => button.classList.toggle('primary', button.dataset.installerPlatform === detectedInstallerPlatform()));
  showDialog(syncSetupDialog);
}
async function copySyncCommand(): Promise<void> {
  const command = syncSetupCommand();
  try {
    await navigator.clipboard.writeText(command);
    toast('Setup command copied.');
  } catch {
    toast(command);
  }
}
async function downloadSyncInstaller(platform: InstallerPlatform): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('[data-installer-platform="' + platform + '"]');
  if (button) button.disabled = true;
  const status = $('#sync-download-status');
  try {
    const cloudPath = ($('#sync-download-cloud') as HTMLInputElement).value.trim();
    const preset = ($('#sync-download-profile') as HTMLSelectElement).value === 'exact' ? 'exact' : 'project';
    const pairing = await api.json<PairingView>('/sync/pairing', 'POST', { cloudPath, policy: { preset } });
    const blob = await api.download('/sync/installer', { platform, code: pairing.code });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = platform === 'windows' ? 'Continental Cloud Sync.cmd' : platform === 'macos' ? 'Continental Cloud Sync.zip' : 'continental-cloud-sync.sh';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 60_000);
    status.textContent = 'Downloaded for ' + installerLabel(platform) + '. Open it on that computer; it will ask where to keep the folder. This setup link expires ' + dateTime(pairing.expiresAt) + '.';
    status.hidden = false;
    if (installerPoll !== undefined) window.clearInterval(installerPoll);
    installerPoll = window.setInterval(() => { void checkInstallerPairing(pairing.id); }, 2500);
  } catch (error) { handleError(error); }
  finally { if (button) button.disabled = false; }
}
async function checkInstallerPairing(id: string): Promise<void> {
  try {
    const pairing = await api.request<PairingView & { state: 'pending' | 'claimed' | 'expired'; deviceId: string | null }>('/sync/pairing/' + id);
    const status = $('#sync-download-status');
    if (pairing.state === 'claimed') { status.textContent = 'Computer connected. The first sync is running there now.'; toast('A computer joined folder sync.'); void refresh(); }
    else if (pairing.state === 'expired') status.textContent = 'This download link expired. Download a fresh installer to try again.';
    if (pairing.state !== 'pending' && installerPoll !== undefined) { window.clearInterval(installerPoll); installerPoll = undefined; }
  } catch { /* setup status polling is non-essential */ }
}
async function downloadPairingInstaller(platform: InstallerPlatform): Promise<void> {
  if (!activePairing) return toast('Create a pairing code first.', true);
  const button = document.querySelector<HTMLButtonElement>('[data-pairing-installer-platform="' + platform + '"]');
  if (button) button.disabled = true;
  try {
    const blob = await api.download('/sync/installer', { platform, code: activePairing.code });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = platform === 'windows' ? 'Continental Cloud Sync.cmd' : platform === 'macos' ? 'Continental Cloud Sync.zip' : 'continental-cloud-sync.sh';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 60_000);
    toast('Installer downloaded for ' + installerLabel(platform) + '.');
  } catch (error) { handleError(error); }
  finally { if (button) button.disabled = false; }
}
function openPairing(cloudPath = ''): void {
  if (pairingPoll !== undefined) window.clearInterval(pairingPoll);
  if (installerPoll !== undefined) window.clearInterval(installerPoll);
  installerPoll = undefined;
  activePairing = undefined;
  ($('#pair-cloud-path') as HTMLInputElement).value = cloudPath;
  ($('#pair-profile') as HTMLSelectElement).value = 'project';
  ($('#pairing-result') as HTMLElement).hidden = true;
  ($('#pairing-token') as HTMLElement).textContent = '';
  ($('#pairing-command') as HTMLElement).textContent = '';
  ($('#pairing-status') as HTMLElement).textContent = 'Waiting for the device…';
  const qr = $('#pairing-qr') as HTMLImageElement;
  qr.hidden = true;
  qr.removeAttribute('src');
  showDialog(pairingDialog);
}
async function createPairing(): Promise<void> {
  const cloudPath = ($('#pair-cloud-path') as HTMLInputElement).value.trim();
  const preset = ($('#pair-profile') as HTMLSelectElement).value === 'exact' ? 'exact' : 'project';
  try {
    const pairing = await api.json<PairingView>('/sync/pairing', 'POST', { cloudPath, policy: { preset }, serverUrl: location.origin });
    ($('#pairing-token') as HTMLElement).textContent = pairing.code;
    activePairing = pairing;
    ($('#pairing-command') as HTMLElement).textContent = 'cloud-sync pair --server ' + location.origin + ' --code ' + pairing.code + ' --local "<local-folder>"';
    if (pairing.qr) {
      const qr = $('#pairing-qr') as HTMLImageElement;
      qr.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pairing.qr);
      qr.hidden = false;
    }
    ($('#pairing-result') as HTMLElement).hidden = false;
    ($('#pairing-status') as HTMLElement).textContent = 'Waiting for the device… expires ' + dateTime(pairing.expiresAt) + '.';
    if (pairingPoll !== undefined) window.clearInterval(pairingPoll);
    pairingPoll = window.setInterval(() => { void checkPairing(pairing.id); }, 2500);
  } catch (error) { handleError(error); }
}
async function checkPairing(id: string): Promise<void> {
  try {
    const pairing = await api.request<PairingView & { state: 'pending' | 'claimed' | 'expired'; deviceId: string | null }>('/sync/pairing/' + id);
    const status = $('#pairing-status');
    status.textContent = pairing.state === 'claimed' ? 'Device claimed this code. You can close this window.' : pairing.state === 'expired' ? 'This code expired. Create another one.' : 'Waiting for the device…';
    if (pairing.state !== 'pending' && pairingPoll !== undefined) {
      window.clearInterval(pairingPoll);
      pairingPoll = undefined;
      if (pairing.state === 'claimed') void refresh();
    }
  } catch { /* status polling is non-essential */ }
}
async function updateMapping(deviceId: string, mappingId: string, body: { paused?: boolean; status?: string }): Promise<void> {
  try { await api.json('/sync/devices/' + deviceId + '/mappings/' + mappingId, 'PATCH', body); toast(body.paused ? 'Mapping paused.' : 'Mapping resumed.'); await refresh(); }
  catch (error) { handleError(error); }
}
async function addMappingForDevice(deviceId: string): Promise<void> {
  const cloudPath = prompt('Cloud folder (blank is My drive)', '');
  if (cloudPath === null) return;
  const localPath = prompt('Local folder path');
  if (!localPath) return;
  const exact = confirm('Use Exact mirror? Choose Cancel for the Coding project profile, which skips dependencies and generated files.');
  try { await api.json('/sync/devices/' + deviceId + '/mappings', 'POST', { id: crypto.randomUUID(), cloudPath, localPath, policy: { preset: exact ? 'exact' : 'project' } }); toast('Folder mapping added.'); await refresh(); }
  catch (error) { handleError(error); }
}
async function editMapping(deviceId: string, mapping: SyncMapping): Promise<void> {
  const localPath = prompt('Local folder path', mapping.localPath);
  if (!localPath) return;
  try { await api.json('/sync/devices/' + deviceId + '/mappings', 'POST', { id: mapping.id, cloudPath: mapping.cloudPath, localPath, paused: mapping.paused, policy: mapping.policy }); toast('Mapping updated.'); await refresh(); }
  catch (error) { handleError(error); }
}

function operationCard(title: string): HTMLElement {
  const node = document.createElement('section');
  node.className = 'operation-card';
  const heading = document.createElement('h2');
  heading.textContent = title;
  node.append(heading);
  return node;
}
function operationButton(label: string, action: () => void, danger = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'quiet-button' + (danger ? ' danger' : '');
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}
function metric(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'metric-row';
  const name = document.createElement('span');
  name.textContent = label;
  const valueNode = document.createElement('b');
  valueNode.textContent = value;
  row.append(name, valueNode);
  return row;
}
async function renderOperations(): Promise<void> {
  const data = await api.request<OperationsData>('/operations');
  state.items = [];
  setFileListSemantics('region', 'Recovery operations');
  fileList.className = 'operations-panel';
  fileList.replaceChildren();
  renderEmpty(false);
  const health = operationCard('Storage integrity & recovery');
  const last = document.createElement('p');
  last.textContent = human(data.storage.usedBytes) + ' managed · ' + human(data.storage.freeBytes) + ' free · ' + (data.lastIntegrityCheck ? 'last checked ' + dateTime(data.lastIntegrityCheck.createdAt) : 'integrity has not been checked yet');
  health.append(last);
  if (data.storage.detail) {
    const detail = document.createElement('p');
    detail.textContent = data.storage.detail;
    health.append(detail);
  }
  const explanation = document.createElement('p');
  explanation.textContent = 'The check verifies that indexed files, versions, and Trash entries still exist with matching metadata. It does not claim that an external backup has been restored.';
  health.append(explanation);
  const bars = document.createElement('div');
  bars.className = 'health-bars';
  for (const entry of data.storage.history.slice(0, 30).reverse()) {
    const bar = document.createElement('i');
    bar.style.height = entry.freeBytes && entry.totalBytes ? Math.max(8, (entry.freeBytes / entry.totalBytes) * 100) + '%' : '8%';
    bars.append(bar);
  }
  const healthControls = document.createElement('div');
  healthControls.className = 'operation-controls';
  healthControls.append(operationButton('Run integrity check', async () => {
    try {
      const result = await api.json<{ healthy: boolean; detail: string; issues: string[] }>('/operations/recovery-check', 'POST', {});
      toast(result.healthy ? 'Integrity check passed.' : 'Integrity check found ' + result.issues.length + ' issue' + (result.issues.length === 1 ? '' : 's') + '.', !result.healthy);
      await refresh();
    } catch (error) { handleError(error); }
  }));
  health.append(bars, healthControls);
  const jobs = operationCard('Reconciliation & jobs');
  for (const job of data.jobs.slice(0, 6)) jobs.append(metric(job.kind + ' · ' + job.state, shortDate(job.createdAt)));
  if (data.failedJobs.length) {
    const failed = document.createElement('p');
    failed.textContent = data.failedJobs[0].kind + ': ' + (data.failedJobs[0].detail ?? 'failed');
    jobs.append(failed);
  }
  const jobControls = document.createElement('div');
  jobControls.className = 'operation-controls';
  jobControls.append(operationButton('Run reconciliation', async () => {
    try { const result = await api.json<{ indexed: number; removed: number }>('/storage/reconcile', 'POST', {}); toast('Reconciled ' + result.indexed + ' entries; removed ' + result.removed + ' stale records.'); await refresh(); }
    catch (error) { handleError(error); }
  }));
  jobControls.append(operationButton('Clean orphaned uploads (' + data.uploads.length + ')', async () => {
    try { const result = await api.json<{ removedUploads: number }>('/operations/cleanup', 'POST', { includeTrash: false }); toast('Removed ' + result.removedUploads + ' abandoned uploads.'); await refresh(); }
    catch (error) { handleError(error); }
  }));
  if (data.retention.trashItems) jobControls.append(operationButton('Expire retained Trash', async () => {
    try { const result = await api.json<{ removedTrash: number }>('/operations/cleanup', 'POST', { includeTrash: true }); toast('Removed ' + result.removedTrash + ' expired Trash item' + (result.removedTrash === 1 ? '' : 's') + '.'); await refresh(); }
    catch (error) { handleError(error); }
  }, true));
  jobs.append(jobControls);
  const usage = operationCard('Usage by folder and type');
  for (const entry of data.usage.folders.slice(0, 4)) usage.append(metric(entry.folder, human(entry.bytes)));
  for (const entry of data.usage.types.slice(0, 4)) usage.append(metric(entry.type, human(entry.bytes)));
  const retention = operationCard('Retention policy');
  const policy = document.createElement('p');
  policy.textContent = data.retention.trashItems + ' items in Trash; ' + data.retention.expiringTrash + ' expire within 7 days.';
  const versionsLabel = document.createElement('label');
  versionsLabel.htmlFor = 'version-retention';
  versionsLabel.textContent = 'Versions to keep';
  const versionsInput = document.createElement('input');
  versionsInput.id = 'version-retention';
  versionsInput.type = 'number';
  versionsInput.min = '1';
  versionsInput.max = '1000';
  versionsInput.value = String(data.retention.versionRetention);
  versionsLabel.append(versionsInput);
  const daysLabel = document.createElement('label');
  daysLabel.htmlFor = 'trash-retention';
  daysLabel.textContent = 'Trash days to keep';
  const daysInput = document.createElement('input');
  daysInput.id = 'trash-retention';
  daysInput.type = 'number';
  daysInput.min = '1';
  daysInput.max = '3650';
  daysInput.value = String(data.retention.trashRetentionDays);
  daysLabel.append(daysInput);
  const save = operationButton('Apply retention rules', async () => {
    try {
      await api.json('/operations/retention', 'PATCH', { versionRetention: Number(versionsInput.value), trashRetentionDays: Number(daysInput.value) });
      toast('Retention rules updated and saved.');
      await refresh();
    } catch (error) { handleError(error); }
  });
  retention.append(policy, versionsLabel, daysLabel, save);
  const offline = operationCard('Browser privacy & offline access');
  const offlineCopy = document.createElement('p');
  offlineCopy.textContent = 'Keep this off on shared browsers. When enabled, this browser may retain recent folder lists and explicitly requested previews until you lock the cloud.';
  const offlineLabel = document.createElement('label');
  offlineLabel.className = 'offline-setting';
  offlineLabel.htmlFor = 'offline-cache';
  const offlineInput = document.createElement('input');
  offlineInput.id = 'offline-cache';
  offlineInput.type = 'checkbox';
  offlineInput.checked = state.offlineCache;
  offlineInput.addEventListener('change', () => {
    state.offlineCache = offlineInput.checked;
    localStorage.setItem('cloud-offline-cache', String(state.offlineCache));
    if (!state.offlineCache) { clearSnapshots(); void clearPrivateCache(); }
    toast(state.offlineCache ? 'Private browser caching enabled.' : 'Private browser cache cleared.');
    renderStatusBanner();
  });
  offlineLabel.append(offlineInput, document.createTextNode('Allow recent lists and previews to be cached on this browser'));
  offline.append(offlineCopy, offlineLabel, operationButton('Lock cloud now', () => void lockCloud()));
  for (const node of [health, jobs, usage, retention, offline]) fileList.append(node);
  updateLabels();
}

async function preview(item: FileItem): Promise<void> {
  const host = $('#preview-content');
  host.replaceChildren();
  const content = privateCacheUrl('/api/files/' + item.id + '/content');
  try {
    if (isImage(item)) {
      state.gallery = state.items.filter(isImage);
      const element = document.createElement('img');
      element.src = content;
      element.alt = item.name;
      host.append(element);
      const nav = document.createElement('div');
      nav.className = 'preview-actions';
      const index = state.gallery.findIndex((entry) => entry.id === item.id);
      for (const pair of [['← Previous', -1], ['Next →', 1]] as const) {
        const button = document.createElement('button');
        button.className = 'quiet-button';
        button.textContent = pair[0];
        button.disabled = index + pair[1] < 0 || index + pair[1] >= state.gallery.length;
        button.addEventListener('click', () => void preview(state.gallery[index + pair[1]]));
        nav.append(button);
      }
      host.append(nav);
    } else if (item.mimeType?.startsWith('video/')) {
      const element = document.createElement('video');
      element.src = content;
      element.controls = true;
      element.autoplay = true;
      host.append(element);
    } else if (item.mimeType?.startsWith('audio/')) {
      const element = document.createElement('audio');
      element.src = content;
      element.controls = true;
      element.autoplay = true;
      host.append(element);
    } else if (item.mimeType === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.src = content;
      frame.title = item.name;
      const pages = document.createElement('div');
      pages.className = 'preview-actions';
      for (let page = 1; page <= 6; page++) {
        const link = document.createElement('a');
        link.className = 'quiet-button';
        link.textContent = 'Page ' + page;
        link.href = content + '#page=' + page;
        link.target = 'pdf-preview';
        link.addEventListener('click', () => { frame.src = content + '#page=' + page; });
        pages.append(link);
      }
      host.append(frame, pages);
    } else if (item.mimeType?.startsWith('text/') || item.mimeType?.includes('json')) {
      const result = await fetch(content, { headers: tokenHeader(), credentials: 'same-origin' });
      if (!result.ok) throw new Error('Could not read preview.');
      const text = await result.text();
      const textHost = document.createElement('pre');
      textHost.textContent = text.slice(0, 1_000_000) + (text.length > 1_000_000 ? '\n\n[Preview limited to 1 MB]' : '');
      const actions = document.createElement('div');
      actions.className = 'preview-actions';
      if (item.mimeType?.includes('markdown')) {
        const rendered = document.createElement('article');
        rendered.className = 'markdown-preview';
        for (const line of text.split('\n').slice(0, 1000)) {
          const node = document.createElement(line.startsWith('# ') ? 'h2' : line.startsWith('## ') ? 'h3' : 'p');
          node.textContent = line.replace(/^#{1,2}\s*/, '');
          rendered.append(node);
        }
        actions.append(detailButton('Rendered Markdown', () => host.replaceChildren(rendered, actions)));
      }
      actions.append(detailButton('Edit and save version', () => editTextFile(item, text)));
      host.append(textHost, actions);
    } else {
      const message = document.createElement('p');
      message.textContent = 'A preview is not available for this file. Download it to open it in the appropriate application.';
      host.append(message, detailButton('Download', () => download(item)));
    }
    showDialog(previewDialog);
  } catch (error) { handleError(error); }
}
async function editTextFile(item: FileItem, content: string): Promise<void> {
  const host = $('#preview-content');
  host.replaceChildren();
  const editor = document.createElement('textarea');
  editor.value = content;
  editor.setAttribute('aria-label', 'Edit ' + item.name);
  editor.style.width = '100%';
  editor.style.height = '100%';
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Save new version';
  save.addEventListener('click', async () => {
    try {
      const file = new File([editor.value], item.name, { type: item.mimeType ?? 'text/plain' });
      await uploadFilesAt(toUploadPlans([file], false), item.parentPath, true);
      closeDialog(previewDialog);
      toast('Saving a new version…');
    } catch (error) { handleError(error); }
  });
  host.append(editor, save);
}
function tokenHeader(): HeadersInit {
  const token = sessionStorage.getItem('continental-cloud-token');
  return token ? { 'X-Continental-Token': token } : {};
}
function download(item: FileItem): void {
  const anchor = document.createElement('a');
  anchor.href = '/api/files/' + item.id + '/' + (item.isDirectory ? 'archive' : 'download');
  anchor.download = item.isDirectory ? item.name + '.tar' : item.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function versions(item: FileItem): Promise<void> {
  try {
    const list = await api.request<Array<{ id: string; size: number; createdAt: string; mimeType?: string | null; originalName?: string }>>('/files/' + item.id + '/versions');
    if (!list.length) return toast('No earlier versions yet.');
    const host = $('#versions-content');
    host.replaceChildren();
    const layout = document.createElement('div');
    layout.className = 'versions-layout';
    const timeline = document.createElement('div');
    timeline.className = 'version-timeline';
    const previewHost = document.createElement('div');
    previewHost.className = 'version-preview';
    const show = async (version: typeof list[number], button?: HTMLButtonElement) => {
      timeline.querySelectorAll('.version-row').forEach((row) => row.classList.remove('active'));
      button?.classList.add('active');
      previewHost.replaceChildren();
      const url = '/api/versions/' + version.id + '/content';
      const mime = version.mimeType ?? 'application/octet-stream';
      if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
        const image = document.createElement('img');
        image.src = privateCacheUrl(url);
        image.alt = version.originalName ?? item.name;
        previewHost.append(image);
      } else if (mime.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = privateCacheUrl(url);
        video.controls = true;
        previewHost.append(video);
      } else if (mime.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = privateCacheUrl(url);
        audio.controls = true;
        previewHost.append(audio);
      } else if (mime === 'application/pdf') {
        const frame = document.createElement('iframe');
        frame.src = privateCacheUrl(url);
        frame.title = version.originalName ?? item.name;
        previewHost.append(frame);
      } else if (mime.startsWith('text/') || mime.includes('json')) {
        const result = await fetch(url, { headers: tokenHeader(), credentials: 'same-origin' });
        if (!result.ok) throw new Error('Could not load that version.');
        const text = document.createElement('pre');
        text.textContent = (await result.text()).slice(0, 1_000_000);
        previewHost.append(text);
      } else {
        const message = document.createElement('p');
        message.textContent = 'This version is a binary file. Download it to inspect it.';
        previewHost.append(message);
      }
      const actions = document.createElement('div');
      actions.className = 'preview-actions';
      const downloadVersion = document.createElement('a');
      downloadVersion.className = 'quiet-button';
      downloadVersion.href = url;
      downloadVersion.download = version.originalName ?? item.name;
      downloadVersion.textContent = 'Download';
      const copy = operationButton('Restore as new copy', async () => {
        try { const restored = await api.json<FileItem>('/versions/' + version.id + '/restore-copy', 'POST', {}); toast('Restored ' + restored.name + ' as a separate copy.'); await refresh(); }
        catch (error) { handleError(error); }
      });
      const overwrite = operationButton('Restore current file', async () => {
        try { await api.json('/versions/' + version.id + '/restore', 'POST', {}); toast('Version restored; the previous current file is preserved.'); closeDialog(versionsDialog); await refresh(); }
        catch (error) { handleError(error); }
      });
      actions.append(downloadVersion, copy, overwrite);
      previewHost.append(actions);
    };
    for (const version of list) {
      const row = document.createElement('button');
      row.className = 'version-row';
      row.textContent = shortDate(version.createdAt) + ' · ' + human(version.size);
      row.addEventListener('click', () => void show(version, row));
      timeline.append(row);
    }
    layout.append(timeline, previewHost);
    host.append(layout);
    showDialog(versionsDialog);
    await show(list[0], timeline.firstElementChild as HTMLButtonElement);
  } catch (error) { handleError(error); }
}

async function uploadFiles(files: FileList | File[], replace = false): Promise<void> { return uploadFilesAt(toUploadPlans(files, false), state.path, replace); }
async function uploadFolder(files: FileList | File[]): Promise<void> { return uploadFilesAt(toUploadPlans(files, true), state.path, false); }
async function uploadFilesAt(plans: UploadPlan[], parentPath: string, replace = false): Promise<void> {
  if (!plans.length) return toast('That folder did not contain any files.', true);
  try {
    const safePlans = plans.map((plan) => ({ ...plan, relativePath: normalizeUploadPath(plan.relativePath) }));
    await ensureUploadFolders(safePlans, parentPath);
    for (const plan of safePlans) {
      const record: UploadRecord = { localId: crypto.randomUUID(), file: plan.file, relativePath: plan.relativePath, parentPath: uploadJoin(parentPath, uploadParent(plan.relativePath)), progress: 0, state: 'uploading' };
      state.uploads.push(record);
      renderUploads();
      void uploadFile(record, replace);
    }
    toast(safePlans.length + ' file' + (safePlans.length === 1 ? '' : 's') + ' queued from the folder.');
  } catch (error) { handleError(error); }
}
function toUploadPlans(files: FileList | File[], preservePaths: boolean): UploadPlan[] {
  return Array.from(files).map((file) => ({ file, relativePath: preservePaths ? ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name) : file.name }));
}
async function ensureUploadFolders(plans: UploadPlan[], rootPath: string): Promise<void> {
  const folders = new Set<string>();
  for (const plan of plans) {
    const parts = plan.relativePath.split('/').slice(0, -1);
    for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'));
  }
  for (const folder of [...folders].sort((left, right) => left.split('/').length - right.split('/').length)) {
    const parentPath = uploadJoin(rootPath, uploadParent(folder));
    const name = folder.split('/').at(-1)!;
    const listing = await api.request<PageData>('/files?path=' + encodeURIComponent(parentPath) + '&limit=250&offset=0');
    const existing = listing.items.find((item) => item.name === name);
    if (existing) {
      if (!existing.isDirectory) throw new Error('Cannot create folder ' + folder + ': a file already has that name.');
    } else await api.json('/files/folder', 'POST', { parentPath, name });
  }
}
function normalizeUploadPath(value: string): string {
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) throw new Error('Unsafe folder entry: ' + value);
  return parts.join('/');
}
function uploadParent(path: string): string { const index = path.lastIndexOf('/'); return index === -1 ? '' : path.slice(0, index); }
function uploadJoin(left: string, right: string): string { return [left, right].filter(Boolean).join('/'); }
type BrowserFileEntry = { isFile: boolean; isDirectory: boolean; name: string; file?: (success: (file: File) => void, error?: () => void) => void; createReader?: () => BrowserDirectoryReader };
type BrowserDirectoryReader = { readEntries: (success: (entries: BrowserFileEntry[]) => void, error?: () => void) => void };
async function uploadDropped(dataTransfer: DataTransfer, parentPath: string): Promise<void> {
  try { await uploadFilesAt(await droppedPlans(dataTransfer), parentPath); }
  catch (error) { handleError(error); }
}
async function droppedPlans(dataTransfer: DataTransfer): Promise<UploadPlan[]> {
  const entries: BrowserFileEntry[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    const entry = (item as unknown as { webkitGetAsEntry?: () => BrowserFileEntry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length) return (await Promise.all(entries.map((entry) => walkDropEntry(entry)))).flat();
  return toUploadPlans(dataTransfer.files, true);
}
async function walkDropEntry(entry: BrowserFileEntry, prefix = ''): Promise<UploadPlan[]> {
  const path = prefix ? prefix + '/' + entry.name : entry.name;
  if (entry.isFile && entry.file) return [{ file: await new Promise<File>((resolve, reject) => entry.file!(resolve, reject)), relativePath: path }];
  if (!entry.isDirectory || !entry.createReader) return [];
  const children: BrowserFileEntry[] = [];
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise<BrowserFileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map((child) => walkDropEntry(child, path)))).flat();
}
async function uploadFile(record: UploadRecord, replace: boolean, parentPath = state.path): Promise<void> {
  try {
    const session = await api.json<{ id: string; chunkSize: number; chunkCount: number }>('/uploads', 'POST', { parentPath: record.parentPath || parentPath, name: record.file.name, size: record.file.size, mimeType: record.file.type || undefined, overwrite: replace });
    record.id = session.id;
    for (let index = 0; index < session.chunkCount; index++) {
      const controller = new AbortController();
      record.controller = controller;
      const start = index * session.chunkSize;
      await api.chunk('/uploads/' + session.id + '/chunks/' + index, record.file.slice(start, Math.min(record.file.size, start + session.chunkSize)), controller.signal);
      record.progress = (index + 1) / session.chunkCount;
      renderUploads();
    }
    await api.json('/uploads/' + session.id + '/complete', 'POST', {});
    record.state = 'complete';
    record.progress = 1;
    toast(record.relativePath + ' is in your cloud.');
    await refresh();
  } catch (error: any) {
    if (error.name === 'AbortError') { record.state = 'error'; record.error = 'Cancelled'; }
    else if (error.status === 409 && !replace && confirm('“' + record.relativePath + '” already exists. Replace it and preserve a version?')) { record.state = 'uploading'; record.progress = 0; renderUploads(); await uploadFile(record, true, parentPath); return; }
    else { record.state = 'error'; record.error = error.message ?? 'Upload failed'; }
    toast(record.relativePath + ': ' + record.error, true);
  } finally {
    renderUploads();
    if (record.state === 'complete') window.setTimeout(() => { state.uploads = state.uploads.filter((item) => item !== record); renderUploads(); }, 1800);
  }
}
function renderUploads(): void {
  const dock = $('#upload-dock');
  dock.replaceChildren();
  dock.hidden = state.uploads.length === 0;
  for (const record of state.uploads) {
    const row = document.createElement('div');
    row.className = 'upload-item';
    const name = document.createElement('b');
    name.textContent = record.relativePath;
    const button = document.createElement('button');
    button.textContent = record.state === 'uploading' ? 'Cancel' : record.state === 'error' ? 'Retry' : 'Done';
    button.disabled = record.state === 'complete';
    button.addEventListener('click', () => {
      if (record.state === 'uploading') {
        record.controller?.abort();
        if (record.id) api.request('/uploads/' + record.id, { method: 'DELETE' }).catch(() => undefined);
      } else if (record.state === 'error') {
        record.state = 'uploading';
        record.progress = 0;
        record.error = undefined;
        void uploadFile(record, false);
        renderUploads();
      }
    });
    const status = document.createElement('span');
    status.className = 'upload-status';
    status.textContent = record.state === 'error' ? record.error ?? 'Failed' : Math.round(record.progress * 100) + '%';
    const track = document.createElement('div');
    track.className = 'upload-progress';
    const bar = document.createElement('i');
    bar.style.width = record.progress * 100 + '%';
    track.append(bar);
    row.append(name, button, status, track);
    dock.append(row);
  }
}

async function favoriteItems(): Promise<void> {
  try {
    for (const item of selectedItems()) {
      const operation = { method: 'PATCH' as const, path: '/files/' + item.id, body: { action: 'favorite', favorite: !item.favorite }, label: 'favorite change' };
      if (!navigator.onLine) queueOffline(operation);
      else await api.json(operation.path, operation.method, operation.body);
    }
    if (navigator.onLine) await refresh();
  } catch (error) { handleError(error); }
}
function setClipboard(mode: 'cut' | 'copy'): void {
  const ids = [...state.selected];
  if (!ids.length) return;
  state.clipboard = { ids, mode };
  toast(ids.length + ' item' + (ids.length === 1 ? '' : 's') + ' ' + (mode === 'cut' ? 'ready to move' : 'copied') + '.');
}
async function moveNodes(ids: string[], parentPath: string): Promise<void> {
  try { for (const id of ids) await api.json('/files/' + id, 'PATCH', { action: 'move', parentPath }); toast(ids.length + ' item' + (ids.length === 1 ? '' : 's') + ' moved.'); await refresh(); }
  catch (error) { handleError(error); }
}
async function pasteClipboard(): Promise<void> {
  if (!state.clipboard) return toast('Copy or cut files first.', true);
  const { ids, mode } = state.clipboard;
  try {
    for (const id of ids) await api.json('/files/' + id, 'PATCH', { action: mode === 'cut' ? 'move' : 'copy', parentPath: state.path });
    if (mode === 'cut') state.clipboard = null;
    toast(ids.length + ' item' + (ids.length === 1 ? '' : 's') + ' ' + (mode === 'cut' ? 'moved' : 'copied') + '.');
    await refresh();
  } catch (error) { handleError(error); }
}
function downloadItems(): void { for (const item of selectedItems()) download(item); }
async function duplicateItems(): Promise<void> {
  const items = selectedItems();
  try { for (const item of items) await api.json('/files/' + item.id, 'PATCH', { action: 'copy', parentPath: item.parentPath }); await refresh(); toast(items.length + ' duplicate' + (items.length === 1 ? '' : 's') + ' created.'); }
  catch (error) { handleError(error); }
}
async function actionItems(action: 'rename' | 'move' | 'copy' | 'delete' | 'restore'): Promise<void> {
  const items = selectedItems();
  if (!items.length) return;
  if (state.view === 'trash') {
    if (action === 'restore' || action === 'delete') {
      try {
        const result = await api.json<{ restored?: number; deleted?: number }>('/trash/bulk', 'POST', { action, ids: items.map((item) => item.id) });
        toast(action === 'restore' ? (result.restored ?? 0) + ' item' + (items.length === 1 ? '' : 's') + ' restored.' : (result.deleted ?? 0) + ' item' + (items.length === 1 ? '' : 's') + ' permanently deleted.');
        await refresh();
      } catch (error) { handleError(error); }
    }
    return;
  }
  if (action === 'restore') return;
  try {
    if (action === 'delete') {
      if (!confirm('Move ' + items.length + ' item' + (items.length === 1 ? '' : 's') + ' to Trash?')) return;
      const trashIds: string[] = [];
      for (const item of items) {
        if (!navigator.onLine) return toast('Trash needs a server connection.', true);
        const result = await api.request<{ trashId: string }>('/files/' + item.id, { method: 'DELETE' });
        trashIds.push(result.trashId);
      }
      toast(items.length + ' item' + (items.length === 1 ? '' : 's') + ' moved to Trash.', false, () => void Promise.all(trashIds.map((id) => api.json('/trash/' + id + '/restore', 'POST', {}))).then(() => { toast('Restored.'); return refresh(); }).catch(handleError));
    } else if (action === 'rename') {
      if (items.length !== 1) return toast('Choose one item to rename.', true);
      const name = prompt('New name', items[0].name);
      if (!name) return;
      const operation = { method: 'PATCH' as const, path: '/files/' + items[0].id, body: { action, name }, label: 'rename' };
      if (!navigator.onLine) queueOffline(operation);
      else await api.json(operation.path, operation.method, operation.body);
    } else {
      const destination = prompt((action === 'move' ? 'Move' : 'Copy') + ' into folder path (blank is My drive)', '');
      if (destination === null) return;
      for (const item of items) {
        const operation = { method: 'PATCH' as const, path: '/files/' + item.id, body: { action, parentPath: destination }, label: action + ' change' };
        if (!navigator.onLine && action === 'move') queueOffline(operation);
        else if (!navigator.onLine) return toast('Copy needs a server connection.', true);
        else await api.json(operation.path, operation.method, operation.body);
      }
    }
    if (navigator.onLine) await refresh();
  } catch (error) { handleError(error); }
}
async function restoreTrash(id: string): Promise<void> {
  try { await api.json('/trash/' + id + '/restore', 'POST', {}); toast('Restored to your drive.'); closeDialog(mobileDetailsDialog); await refresh(); }
  catch (error) { handleError(error); }
}
async function deleteTrash(id: string): Promise<void> {
  if (!confirm('Permanently delete this item? This cannot be undone.')) return;
  try { await api.request('/trash/' + id, { method: 'DELETE' }); toast('Permanently deleted.'); closeDialog(mobileDetailsDialog); await refresh(); }
  catch (error) { handleError(error); }
}

function renderSearchTools(): void {
  const host = $('#search-tools');
  host.replaceChildren();
  host.hidden = false;
  const summary = document.createElement('div');
  summary.className = 'search-summary';
  const count = document.createElement('span');
  count.textContent = state.items.length + ' result' + (state.items.length === 1 ? '' : 's');
  summary.append(count);
  const clear = document.createElement('button');
  clear.className = 'quiet-button';
  clear.textContent = 'Clear filters';
  clear.addEventListener('click', () => { state.searchFilters = {}; void runSearch(state.lastSearch); });
  summary.append(clear);
  host.append(summary);
  const field = (labelText: string, name: string, type = 'text'): HTMLInputElement => {
    const label = document.createElement('label');
    const id = 'search-filter-' + name;
    label.htmlFor = id;
    label.textContent = labelText;
    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.name = name;
    input.value = state.searchFilters[name] ?? '';
    input.addEventListener('change', () => { state.searchFilters[name] = input.value; void runSearch(state.lastSearch); });
    label.append(input);
    host.append(label);
    return input;
  };
  const typeLabel = document.createElement('label');
  typeLabel.htmlFor = 'search-filter-type';
  typeLabel.textContent = 'Type';
  const type = document.createElement('select');
  type.id = 'search-filter-type';
  for (const option of [['', 'Any'], ['image', 'Image'], ['text', 'Text/code'], ['application/pdf', 'PDF']] as const) {
    const node = document.createElement('option');
    node.value = option[0];
    node.textContent = option[1];
    type.append(node);
  }
  type.value = state.searchFilters.type ?? '';
  type.addEventListener('change', () => { state.searchFilters.type = type.value; void runSearch(state.lastSearch); });
  typeLabel.append(type);
  host.append(typeLabel);
  field('Folder', 'path');
  field('Min size', 'minSize', 'number');
  field('Max size', 'maxSize', 'number');
  field('After', 'after', 'date');
  field('Before', 'before', 'date');
  const duplicates = document.createElement('button');
  duplicates.className = 'quiet-button';
  duplicates.textContent = 'Find duplicates';
  duplicates.addEventListener('click', () => void showDuplicates());
  const saved = document.createElement('button');
  saved.className = 'quiet-button';
  saved.textContent = 'Save search';
  saved.addEventListener('click', async () => {
    const name = prompt('Name this saved search');
    if (!name) return;
    try { await api.json('/saved-searches', 'POST', { name, query: state.lastSearch, filters: state.searchFilters }); toast('Saved search added.'); await renderSearchToolsAsync(); }
    catch (error) { handleError(error); }
  });
  host.append(duplicates, saved);
  void renderSearchToolsAsync();
}
async function renderSearchToolsAsync(): Promise<void> {
  if (state.view !== 'search') return;
  const host = $('#search-tools');
  host.querySelectorAll('.tag-filters, .saved-searches').forEach((node) => node.remove());
  let tags: Tag[];
  let searches: SavedSearch[];
  try {
    [tags, searches] = await Promise.all([api.request<Tag[]>('/tags'), api.request<SavedSearch[]>('/saved-searches')]);
  } catch (error) {
    handleError(error, false);
    return;
  }
  if (state.view !== 'search') return;
  const tagHost = document.createElement('div');
  tagHost.className = 'tag-filters';
  const label = document.createElement('span');
  label.textContent = 'Tags';
  tagHost.append(label);
  const all = document.createElement('button');
  all.className = 'quiet-button tag-filter' + (state.searchFilters.tag ? '' : ' active');
  all.textContent = 'All';
  all.addEventListener('click', () => { delete state.searchFilters.tag; void runSearch(state.lastSearch); });
  tagHost.append(all);
  for (const tag of tags) {
    const button = document.createElement('button');
    button.className = 'quiet-button tag-filter' + (state.searchFilters.tag === tag.name ? ' active' : '');
    button.textContent = tag.name;
    button.style.color = tag.color;
    button.addEventListener('click', () => { state.searchFilters.tag = tag.name; void runSearch(state.lastSearch); });
    tagHost.append(button);
  }
  host.append(tagHost);
  const savedHost = document.createElement('details');
  savedHost.className = 'saved-searches';
  const summary = document.createElement('summary');
  summary.textContent = searches.length ? 'Saved searches (' + searches.length + ')' : 'Saved searches';
  savedHost.append(summary);
  const list = document.createElement('div');
  list.className = 'saved-search-list';
  for (const search of searches) {
    const item = document.createElement('span');
    item.className = 'saved-search-item';
    const load = document.createElement('button');
    load.className = 'quiet-button';
    load.textContent = search.name;
    load.addEventListener('click', () => { state.searchFilters = Object.fromEntries(Object.entries(search.filters).map(([key, value]) => [key, String(value)])); state.lastSearch = search.query; ($('#search') as HTMLInputElement).value = search.query; void runSearch(search.query); });
    const remove = document.createElement('button');
    remove.className = 'quiet-button delete-saved';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Delete saved search ' + search.name);
    remove.addEventListener('click', async () => { if (!confirm('Delete saved search “' + search.name + '”?')) return; try { await api.request('/saved-searches/' + search.id, { method: 'DELETE' }); toast('Saved search deleted.'); await renderSearchToolsAsync(); } catch (error) { handleError(error); } });
    item.append(load, remove);
    list.append(item);
  }
  savedHost.append(list);
  host.append(savedHost);
}
async function runSearch(query: string, refreshTools = true): Promise<void> {
  state.lastSearch = query;
  state.view = 'search';
  const params = new URLSearchParams({ q: query });
  for (const [key, value] of Object.entries(state.searchFilters)) if (value) params.set(key, value);
  try {
    state.items = await api.request<FileItem[]>('/search?' + params);
    state.loadError = null;
    if (refreshTools) renderSearchTools();
    renderItems();
  } catch (error) { state.loadError = (error as Error).message; handleError(error); renderItems(); }
}
async function showDuplicates(): Promise<void> {
  try {
    const groups = await api.request<Array<{ checksum: string; count: number; bytes: number; items: FileItem[] }>>('/duplicates');
    state.items = groups.flatMap((group) => group.items);
    state.view = 'search';
    renderSearchTools();
    renderItems();
    toast(groups.length ? groups.length + ' duplicate groups found.' : 'No duplicates with matching content were found.');
  } catch (error) { handleError(error); }
}
async function updateSuggestions(query: string): Promise<void> {
  if (!query) return;
  try {
    const list = await api.request<string[]>('/search/suggestions?q=' + encodeURIComponent(query));
    const host = $('#search-suggestions') as HTMLDataListElement;
    host.replaceChildren(...list.map((value) => { const option = document.createElement('option'); option.value = value; return option; }));
  } catch { /* suggestions are non-essential */ }
}

function offlineOperations(): OfflineOperation[] {
  try {
    const value = JSON.parse(localStorage.getItem('continental-offline-operations') ?? '[]');
    return Array.isArray(value) ? value as OfflineOperation[] : [];
  } catch { return []; }
}
function queueOffline(operation: OfflineOperation): void {
  const queue = offlineOperations();
  queue.push(operation);
  localStorage.setItem('continental-offline-operations', JSON.stringify(queue.slice(-100)));
  toast(operation.label + ' queued until you are online.');
  renderStatusBanner();
}
async function flushOfflineQueue(): Promise<void> {
  if (!navigator.onLine) return;
  const queue = offlineOperations();
  if (!queue.length) return;
  const remaining: OfflineOperation[] = [];
  for (let index = 0; index < queue.length; index++) {
    const operation = queue[index];
    try { await api.json(operation.path, operation.method, operation.body); }
    catch (error: any) {
      remaining.push(...queue.slice(index));
      if (error?.status !== 401) toast('Could not apply queued ' + operation.label + ': ' + (error?.message ?? 'unknown error'), true);
      break;
    }
  }
  localStorage.setItem('continental-offline-operations', JSON.stringify(remaining));
  renderStatusBanner();
  if (!remaining.length) { toast(queue.length + ' queued change' + (queue.length === 1 ? '' : 's') + ' applied.'); await refresh(); }
}
function clearOfflineQueue(): void {
  if (!offlineOperations().length) return;
  if (!confirm('Clear queued changes from this browser? They will not be applied to the cloud.')) return;
  localStorage.removeItem('continental-offline-operations');
  toast('Queued changes cleared.');
  renderStatusBanner();
}
async function lockCloud(): Promise<void> {
  try { await api.request('/session', { method: 'DELETE' }); } catch { /* always clear local private state */ }
  sessionStorage.removeItem('continental-cloud-token');
  localStorage.removeItem('continental-offline-operations');
  clearSnapshots();
  await clearPrivateCache();
  state.items = [];
  state.selected.clear();
  state.notice = null;
  state.connectionState = 'unknown';
  renderStatusBanner();
  closeDialog(previewDialog);
  closeDialog(mobileDetailsDialog);
  closeDialog(versionsDialog);
  closeDialog(syncSetupDialog);
  closeDialog(pairingDialog);
  showAuth();
}
async function checkHealth(): Promise<boolean> {
  try {
    const health = await api.request<{ state: string; storage: { state: string; freeBytes?: number; totalBytes?: number; detail?: string }; version: string }>('/health');
    const storage = await api.request<{ usedBytes: number | null; freeBytes?: number; totalBytes?: number; state: 'ready' | 'offline' | 'misconfigured'; detail?: string; warnings?: string[] }>('/storage');
    state.connectionState = storage.state;
    state.storageWarning = storage.warnings?.[0] ?? (storage.state === 'ready' ? '' : health.storage.detail ?? storage.detail ?? 'Storage unavailable.');
    const ready = health.state === 'ready' && storage.state === 'ready';
    $('#connection-label').textContent = ready ? 'Storage online' : state.storageWarning || 'Storage offline';
    $('#connection-dot').parentElement!.className = 'connection ' + (ready ? 'ready' : 'offline');
    $('#storage-label').textContent = storage.totalBytes ? human(storage.usedBytes) + ' used' : 'Unavailable';
    ($('#storage-meter') as HTMLElement).style.width = storage.totalBytes && storage.usedBytes !== null ? Math.min(100, (storage.usedBytes / storage.totalBytes) * 100) + '%' : '0%';
    renderStatusBanner();
    return true;
  } catch (error: any) {
    if (error?.status === 401) showAuth();
    else {
      state.connectionState = 'offline';
      state.storageWarning = 'Storage could not be reached. Cached content, if enabled, is shown only as a last-known view.';
      $('#connection-label').textContent = 'Storage unavailable';
      $('#connection-dot').parentElement!.className = 'connection offline';
      renderStatusBanner();
    }
    return false;
  }
}
function handleError(error: any, showToast = true): void {
  if (error?.status === 401) { showAuth(); return; }
  const message = error?.message ?? 'Something went wrong.';
  state.notice = { message, tone: 'error' };
  renderStatusBanner();
  if (showToast) toast(message, true);
}
function toggleNav(): void {
  const open = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  shell.classList.toggle('nav-open', open);
  navScrim.hidden = !open;
  mobileNav.setAttribute('aria-expanded', String(open));
  mobileNav.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}
function closeNav(): void {
  sidebar.classList.remove('open');
  shell.classList.remove('nav-open');
  navScrim.hidden = true;
  mobileNav.setAttribute('aria-expanded', 'false');
  mobileNav.setAttribute('aria-label', 'Open navigation');
}

function bindEvents(): void {
  document.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'new') showDialog($('#new-dialog') as HTMLDialogElement);
    else if (action === 'mobile-nav') toggleNav();
    else if (action === 'close-nav') closeNav();
    else if (action === 'theme') { document.documentElement.classList.toggle('light'); localStorage.setItem('cloud-theme', document.documentElement.classList.contains('light') ? 'light' : 'dark'); }
    else if (action === 'lock') void lockCloud();
    else if (action === 'grid' || action === 'list') { state.viewMode = action; localStorage.setItem('cloud-view', action); document.querySelectorAll('[data-action="grid"],[data-action="list"]').forEach((node) => node.setAttribute('aria-pressed', String(node.getAttribute('data-action') === action))); void refresh(); }
    else if (action === 'sort') { state.sort = state.sort === 'name' ? 'modified' : state.sort === 'modified' ? 'size' : 'name'; state.direction = state.sort === 'name' ? 'asc' : 'desc'; $('#sort-button').textContent = state.sort[0].toUpperCase() + state.sort.slice(1) + ' ↕'; void refresh(); }
    else if (action === 'favorite') void favoriteItems();
    else if (action === 'download') downloadItems();
    else if (action === 'open-selected') openSelected();
    else if (action === 'details-selected') showDetails();
    else if (action === 'cut') setClipboard('cut');
    else if (action === 'copy-clipboard') setClipboard('copy');
    else if (action === 'paste') void pasteClipboard();
    else if (action === 'duplicate') void duplicateItems();
    else if (action === 'load-more') void loadMore();
    else if (action === 'retry' || action === 'retry-view') { state.notice = null; void refresh(); }
    else if (action === 'retry-offline') void flushOfflineQueue();
    else if (action === 'clear-offline') clearOfflineQueue();
    else if (action === 'browse-drive') { state.view = 'drive'; state.path = ''; void refresh(); }
    else if (action === 'clear-search') { state.lastSearch = ''; state.searchFilters = {}; ($('#search') as HTMLInputElement).value = ''; state.view = 'drive'; void refresh(); }
    else if (action === 'clear-activity-filter') { delete state.searchFilters.activity; void renderActivity(); }
    else if (action === 'open-sync') { state.view = 'sync'; state.path = ''; void refresh(); }
    else if (['rename', 'move', 'copy', 'delete', 'restore'].includes(action ?? '')) void actionItems(action as 'rename' | 'move' | 'copy' | 'delete' | 'restore');
    else if (action === 'close-preview') closeDialog(previewDialog);
    else if (action === 'close-mobile-details') closeDialog(mobileDetailsDialog);
    else if (action === 'close-versions') closeDialog(versionsDialog);
    else if (action === 'create-pairing') void createPairing();
    else if (action === 'copy-sync-command') void copySyncCommand();
    else if (action === 'download-sync-installer' && (button.dataset.platform === 'windows' || button.dataset.platform === 'macos' || button.dataset.platform === 'linux')) void downloadSyncInstaller(button.dataset.platform);
    else if (action === 'download-pairing-installer' && (button.dataset.platform === 'windows' || button.dataset.platform === 'macos' || button.dataset.platform === 'linux')) void downloadPairingInstaller(button.dataset.platform);
    else if (action === 'copy-pairing-command') {
      const command = ($('#pairing-command') as HTMLElement).textContent ?? '';
      const copy = navigator.clipboard?.writeText(command);
      if (copy) copy.then(() => toast('Setup command copied.')).catch(() => toast('Copy the setup command manually.', true));
      else toast('Copy the setup command manually.', true);
    } else if (action === 'close-sync-pairing') {
      if (pairingPoll !== undefined) { window.clearInterval(pairingPoll); pairingPoll = undefined; }
      closeDialog(pairingDialog);
    } else if (action === 'close-sync-setup') {
      if (installerPoll !== undefined) { window.clearInterval(installerPoll); installerPoll = undefined; }
      closeDialog(syncSetupDialog);
    } else if (action === 'refresh-sync') {
      if (installerPoll !== undefined) { window.clearInterval(installerPoll); installerPoll = undefined; }
      closeDialog(syncSetupDialog);
      toast('Looking for your computer…');
      void refresh();
    } else if (action === 'close-sync-mapping') closeDialog($('#sync-mapping-dialog') as HTMLDialogElement);
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (event.key === 'Escape') {
      if (sidebar.classList.contains('open')) { closeNav(); return; }
      if (previewDialog.open || mobileDetailsDialog.open || versionsDialog.open || syncSetupDialog.open || pairingDialog.open || authDialog.open) return;
      state.selected.clear();
      renderSelection();
      renderItems();
      renderDetails();
      return;
    }
    if (target.matches('input,textarea,[contenteditable=true]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); state.items.forEach((item) => state.selected.add(item.id)); renderSelection(); renderItems(); renderDetails(); }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); setClipboard('copy'); }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x') { event.preventDefault(); setClipboard('cut'); }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); void pasteClipboard(); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { if (state.selected.size) { event.preventDefault(); void actionItems('delete'); } }
    if (previewDialog.open && state.gallery.length && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const image = state.gallery.find((entry) => privateCacheUrl('/api/files/' + entry.id + '/content') === (document.querySelector('#preview-content img') as HTMLImageElement | null)?.src.replace(location.origin, ''));
      const index = image ? state.gallery.indexOf(image) : -1;
      const next = state.gallery[index + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (next) { event.preventDefault(); void preview(next); }
    }
  });
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view as View; state.path = ''; state.lastSearch = ''; state.searchFilters = {}; ($('#search') as HTMLInputElement).value = ''; closeNav(); void refresh(); }));
  document.querySelectorAll<HTMLElement>('[data-new-choice]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    closeDialog($('#new-dialog') as HTMLDialogElement);
    if (button.dataset.newChoice === 'files') ($('#file-input') as HTMLInputElement).click();
    else if (button.dataset.newChoice === 'folder-upload') ($('#folder-input') as HTMLInputElement).click();
    else {
      const name = prompt('Name your folder');
      if (!name) return;
      try {
        const operation = { method: 'POST' as const, path: '/files/folder', body: { parentPath: state.path, name }, label: 'new folder' };
        if (!navigator.onLine) queueOffline(operation);
        else { await api.json(operation.path, operation.method, operation.body); await refresh(); }
      } catch (error) { handleError(error); }
    }
  }));
  ($('#file-input') as HTMLInputElement).addEventListener('change', (event) => { const input = event.target as HTMLInputElement; if (input.files?.length) void uploadFiles(input.files); input.value = ''; });
  ($('#folder-input') as HTMLInputElement).addEventListener('change', (event) => { const input = event.target as HTMLInputElement; if (input.files?.length) void uploadFolder(input.files); input.value = ''; });
  const dropzone = $('#dropzone');
  for (const kind of ['dragenter', 'dragover']) dropzone.addEventListener(kind, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
  for (const kind of ['dragleave', 'drop']) dropzone.addEventListener(kind, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); });
  dropzone.addEventListener('drop', (event) => { const dataTransfer = (event as DragEvent).dataTransfer; if (dataTransfer) void uploadDropped(dataTransfer, state.path); });
  $('#search').addEventListener('input', (event) => {
    const query = (event.target as HTMLInputElement).value.trim();
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(async () => { if (!query) { state.lastSearch = ''; state.view = 'drive'; state.searchFilters = {}; await refresh(); } else { void updateSuggestions(query); await runSearch(query); } }, 240);
  });
  window.addEventListener('online', () => { toast('Back online. Syncing queued changes…'); void flushOfflineQueue(); });
  window.addEventListener('offline', () => { toast('Offline: supported file actions will be queued.', true); renderStatusBanner(); });
  navScrim.hidden = true;
  mobileNav.setAttribute('aria-expanded', 'false');
  ($('#auth-form') as HTMLFormElement).addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = ($('#token-input') as HTMLInputElement).value;
    sessionStorage.setItem('continental-cloud-token', token);
    try {
      await api.json('/session', 'POST', {});
      sessionStorage.removeItem('continental-cloud-token');
      await checkHealth();
      closeDialog(authDialog);
      ($('#auth-error') as HTMLElement).hidden = true;
      await flushOfflineQueue();
      await refresh();
    } catch {
      sessionStorage.removeItem('continental-cloud-token');
      const error = $('#auth-error');
      error.textContent = 'Could not authenticate with that token.';
      error.hidden = false;
    }
  });
}

if (localStorage.getItem('cloud-theme') === 'light') document.documentElement.classList.add('light');
document.querySelectorAll('[data-action="grid"],[data-action="list"]').forEach((node) => node.setAttribute('aria-pressed', String(node.getAttribute('data-action') === state.viewMode)));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
bindEvents();
void checkHealth().then((ok) => { if (ok) void refresh(); });
