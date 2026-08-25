type FileItem = { id: string; relativePath: string; parentPath: string; name: string; isDirectory: boolean; mimeType: string | null; size: number; createdAt: string; modifiedAt: string; favorite: boolean; trashedAt: string | null; previewable?: boolean };
type View = 'drive' | 'recent' | 'favorites' | 'activity' | 'trash' | 'search';
type UploadRecord = { localId: string; file: File; id?: string; progress: number; state: 'uploading' | 'error' | 'complete'; error?: string; controller?: AbortController };
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const state = { view: 'drive' as View, path: '', selected: new Set<string>(), items: [] as FileItem[], viewMode: (localStorage.getItem('cloud-view') ?? 'grid') as 'grid' | 'list', sort: 'name', direction: 'asc', uploads: [] as UploadRecord[], searchTimer: 0, clipboard: null as { ids: string[]; mode: 'cut' | 'copy' } | null };
const fileList = $('#file-list'); const loading = $('#loading'); const empty = $('#empty'); const details = $('#details'); const authDialog = $('#auth-dialog') as HTMLDialogElement; const previewDialog = $('#preview-dialog') as HTMLDialogElement;

class Api {
  private token(): string | null { return sessionStorage.getItem('continental-cloud-token'); }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers); const token = this.token(); if (token) headers.set('X-Continental-Token', token);
    const response = await fetch(`/api${path}`, { ...init, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `Request failed (${response.status})`), { status: response.status, code: body.error?.code });
    return body.data as T;
  }
  json<T>(path: string, method = 'GET', body?: unknown): Promise<T> { return this.request<T>(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  async chunk<T>(path: string, data: Blob, signal: AbortSignal): Promise<T> { return this.request<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.size) }, body: data, signal }); }
}
const api = new Api();

function human(bytes: number | undefined | null): string { if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—'; if (bytes === 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const level = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** level).toFixed(level ? 1 : 0)} ${units[level]}`; }
function shortDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(date); }
function glyph(item: FileItem): string { if (item.isDirectory) return '▰'; if (item.mimeType?.startsWith('image/')) return '◉'; if (item.mimeType?.startsWith('video/')) return '▶'; if (item.mimeType?.startsWith('audio/')) return '♫'; if (item.mimeType === 'application/pdf') return '▤'; if (item.mimeType?.includes('json') || item.mimeType?.startsWith('text/')) return '‹›'; return '◇'; }
function isImage(item: FileItem): boolean { return Boolean(item.mimeType?.startsWith('image/') && item.mimeType !== 'image/svg+xml'); }
function toast(message: string, error = false): void { const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message; $('#toasts').append(node); window.setTimeout(() => node.remove(), 4200); }

async function refresh(): Promise<void> {
  loading.hidden = false; fileList.replaceChildren(); empty.hidden = true; state.selected.clear(); renderSelection(); renderDetails();
  try {
    if (state.view === 'drive') {
      const data = await api.request<{ path: string; items: FileItem[] }>(`/files?path=${encodeURIComponent(state.path)}&sort=${state.sort}&direction=${state.direction}`); state.items = data.items; renderBreadcrumbs();
    } else if (state.view === 'recent') { state.items = await api.request<FileItem[]>('/recent'); }
    else if (state.view === 'favorites') { state.items = await api.request<FileItem[]>('/favorites'); }
    else if (state.view === 'search') { /* items set by search */ }
    else if (state.view === 'trash') {
      const trash = await api.request<Array<{ id: string; originalPath: string; deletedAt: string; node: FileItem }>>('/trash');
      state.items = trash.map((entry) => ({ ...entry.node, id: entry.id, relativePath: entry.originalPath, modifiedAt: entry.deletedAt }));
    } else if (state.view === 'activity') { await renderActivity(); return; }
    renderItems();
  } catch (error) { handleError(error); }
  finally { loading.hidden = true; }
}

function renderItems(): void {
  fileList.className = `file-grid ${state.viewMode === 'list' ? 'list' : ''}`; fileList.replaceChildren();
  empty.hidden = state.items.length > 0 || state.view === 'activity';
  const fragment = document.createDocumentFragment();
  for (const item of state.items) fragment.append(renderCard(item));
  fileList.append(fragment); updateLabels();
}
function renderCard(item: FileItem): HTMLElement {
  const card = document.createElement('button'); card.type = 'button'; card.className = `file-card ${item.isDirectory ? 'folder' : ''}${state.selected.has(item.id) ? ' selected' : ''}`; card.dataset.id = item.id; card.dataset.modified = shortDate(item.modifiedAt); card.setAttribute('role', 'listitem');
  const thumb = document.createElement('span'); thumb.className = 'file-thumb';
  if (isImage(item)) { const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.src = `/api/files/${item.id}/thumbnail`; image.onerror = () => { thumb.replaceChildren(glyphNode(item)); }; thumb.append(image); } else thumb.append(glyphNode(item));
  const name = document.createElement('span'); name.className = 'file-name'; name.textContent = item.name;
  const meta = document.createElement('span'); meta.className = 'file-meta'; meta.textContent = item.isDirectory ? 'Folder' : `${human(item.size)} · ${shortDate(item.modifiedAt)}`;
  card.append(thumb, name, meta);
  if (item.favorite) { const favorite = document.createElement('span'); favorite.className = 'file-favorite'; favorite.textContent = '✦'; card.append(favorite); }
  card.draggable = state.view !== 'trash'; card.addEventListener('dragstart', (event) => { if (!state.selected.has(item.id)) selectItem(item, event as unknown as MouseEvent); event.dataTransfer?.setData('application/x-continental-node', item.id); });
  if (item.isDirectory) { card.addEventListener('dragover', (event) => event.preventDefault()); card.addEventListener('drop', (event) => { event.preventDefault(); const id = event.dataTransfer?.getData('application/x-continental-node'); const files = event.dataTransfer?.files; if (id) void moveNodes([id], item.relativePath); else if (files?.length) void uploadFilesAt(files, item.relativePath); }); }
  card.addEventListener('click', (event) => selectItem(item, event));
  card.addEventListener('dblclick', () => openItem(item));
  card.addEventListener('keydown', (event) => { if (event.key === 'Enter') openItem(item); });
  return card;
}
function glyphNode(item: FileItem): HTMLElement { const value = document.createElement('span'); value.className = 'file-glyph'; value.textContent = glyph(item); return value; }
function selectItem(item: FileItem, event: MouseEvent): void { if (event.metaKey || event.ctrlKey) state.selected.has(item.id) ? state.selected.delete(item.id) : state.selected.add(item.id); else { state.selected.clear(); state.selected.add(item.id); } renderSelection(); renderItems(); renderDetails(); }
function openItem(item: FileItem): void { if (state.view === 'trash') { selectItem(item, new MouseEvent('click')); return; } if (item.isDirectory) { state.view = 'drive'; state.path = item.relativePath; refresh(); return; } preview(item); }
function renderSelection(): void { const actions = $('#selection-actions'); const count = state.selected.size; actions.hidden = !count || state.view === 'activity'; $('#selection-count').textContent = `${count} selected`; }
function selectedItems(): FileItem[] { return state.items.filter((item) => state.selected.has(item.id)); }

function renderBreadcrumbs(): void {
  const crumbs = $('#breadcrumbs'); crumbs.replaceChildren(); const root = crumb('My drive', ''); crumbs.append(root);
  let current = ''; for (const part of state.path.split('/').filter(Boolean)) { const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = '/'; crumbs.append(sep); current = current ? `${current}/${part}` : part; crumbs.append(crumb(part, current)); }
}
function crumb(label: string, path: string): HTMLButtonElement { const button = document.createElement('button'); button.className = 'crumb-button'; button.textContent = label; button.addEventListener('click', () => { state.view = 'drive'; state.path = path; refresh(); }); return button; }
function updateLabels(): void { const name: Record<View, string> = { drive: state.path ? state.path.split('/').at(-1)! : 'My drive', recent: 'Recent', favorites: 'Favorites', activity: 'Activity', trash: 'Trash', search: 'Search' }; $('#section-title').textContent = name[state.view]; $('#section-kicker').textContent = state.view === 'trash' ? 'RECOVERABLE DELETION' : state.view === 'search' ? 'SEARCH RESULTS' : 'PRIVATE STORAGE'; document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view)); }

function renderDetails(): void {
  details.replaceChildren(); const item = selectedItems()[0];
  if (!item) { const hint = document.createElement('div'); hint.className = 'details-empty'; hint.textContent = state.view === 'trash' ? 'Select an item to restore it or remove it permanently.' : 'Select a file to see its details.'; details.append(hint); return; }
  if (state.selected.size > 1) { const hint = document.createElement('div'); hint.className = 'details-empty'; hint.textContent = `${state.selected.size} items selected.`; details.append(hint); return; }
  if (isImage(item) && state.view !== 'trash') { const image = document.createElement('img'); image.className = 'details-preview'; image.alt = ''; image.src = `/api/files/${item.id}/thumbnail`; details.append(image); }
  const title = document.createElement('h2'); title.className = 'detail-name'; title.textContent = item.name; details.append(title);
  for (const [label, value] of [['Type', item.isDirectory ? 'Folder' : (item.mimeType ?? 'File')], ['Size', item.isDirectory ? '—' : human(item.size)], ['Modified', shortDate(item.modifiedAt)], ['Location', item.relativePath || 'My drive']]) { const row = document.createElement('div'); row.className = 'detail-row'; const key = document.createElement('span'); key.textContent = label; const field = document.createElement('b'); field.textContent = value; row.append(key, field); details.append(row); }
  const actions = document.createElement('div'); actions.className = 'detail-actions';
  if (state.view === 'trash') { actions.append(detailButton('Restore', () => restoreTrash(item.id)), detailButton('Delete permanently', () => deleteTrash(item.id))); }
  else { if (!item.isDirectory) actions.append(detailButton('Preview', () => preview(item)), detailButton('Download', () => download(item))); else actions.append(detailButton('Download archive', () => download(item))); actions.append(detailButton(item.favorite ? 'Remove favorite' : 'Add to favorites', () => favoriteItems())); if (!item.isDirectory) actions.append(detailButton('Version history', () => versions(item))); }
  details.append(actions);
}
function detailButton(label: string, action: () => void): HTMLButtonElement { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', action); return button; }

async function renderActivity(): Promise<void> { const events = await api.request<Array<{ id: string; action: string; path: string | null; detail: string | null; createdAt: string }>>('/activity'); state.items = []; fileList.className = 'file-grid list'; fileList.replaceChildren(); empty.hidden = events.length > 0; for (const event of events) { const card = document.createElement('article'); card.className = 'file-card'; const title = document.createElement('span'); title.className = 'file-name'; title.textContent = event.action.replaceAll('_', ' '); const meta = document.createElement('span'); meta.className = 'file-meta'; meta.textContent = `${event.path ?? 'Cloud'} · ${shortDate(event.createdAt)}`; card.append(title, meta); fileList.append(card); } updateLabels(); loading.hidden = true; }

async function preview(item: FileItem): Promise<void> {
  const host = $('#preview-content'); host.replaceChildren(); const content = `/api/files/${item.id}/content`;
  try {
    if (item.mimeType?.startsWith('image/')) { const element = document.createElement('img'); element.src = content; element.alt = item.name; host.append(element); }
    else if (item.mimeType?.startsWith('video/')) { const element = document.createElement('video'); element.src = content; element.controls = true; element.autoplay = true; host.append(element); }
    else if (item.mimeType?.startsWith('audio/')) { const element = document.createElement('audio'); element.src = content; element.controls = true; element.autoplay = true; host.append(element); }
    else if (item.mimeType === 'application/pdf') { const frame = document.createElement('iframe'); frame.src = content; frame.title = item.name; host.append(frame); }
    else if (item.mimeType?.startsWith('text/') || item.mimeType?.includes('json')) { const result = await fetch(content, { headers: tokenHeader() }); if (!result.ok) throw new Error('Could not read preview.'); const text = await result.text(); const code = document.createElement('pre'); code.textContent = text.slice(0, 1_000_000) + (text.length > 1_000_000 ? '\n\n[Preview limited to 1 MB]' : ''); host.append(code); }
    else { toast('A preview is not available for this file.'); return; }
    previewDialog.showModal();
  } catch (error) { handleError(error); }
}
function tokenHeader(): HeadersInit { const token = sessionStorage.getItem('continental-cloud-token'); return token ? { 'X-Continental-Token': token } : {}; }
function download(item: FileItem): void { const anchor = document.createElement('a'); anchor.href = `/api/files/${item.id}/${item.isDirectory ? 'archive' : 'download'}`; anchor.download = item.isDirectory ? `${item.name}.tar` : item.name; document.body.append(anchor); anchor.click(); anchor.remove(); }

async function uploadFiles(files: FileList | File[], replace = false): Promise<void> {
  return uploadFilesAt(files, state.path, replace);
}
async function uploadFilesAt(files: FileList | File[], parentPath: string, replace = false): Promise<void> {
  for (const file of Array.from(files)) { const record: UploadRecord = { localId: crypto.randomUUID(), file, progress: 0, state: 'uploading' }; state.uploads.push(record); renderUploads(); void uploadFile(record, replace, parentPath); }
}
async function uploadFile(record: UploadRecord, replace: boolean, parentPath = state.path): Promise<void> {
  try {
    const session = await api.json<{ id: string; chunkSize: number; chunkCount: number }>('/uploads', 'POST', { parentPath, name: record.file.name, size: record.file.size, mimeType: record.file.type || undefined, overwrite: replace }); record.id = session.id;
    for (let index = 0; index < session.chunkCount; index++) { const controller = new AbortController(); record.controller = controller; const start = index * session.chunkSize; await api.chunk(`/uploads/${session.id}/chunks/${index}`, record.file.slice(start, Math.min(record.file.size, start + session.chunkSize)), controller.signal); record.progress = (index + 1) / session.chunkCount; renderUploads(); }
    await api.json(`/uploads/${session.id}/complete`, 'POST', {}); record.state = 'complete'; record.progress = 1; toast(`${record.file.name} is in your cloud.`); await refresh();
  } catch (error: any) {
    if (error.name === 'AbortError') { record.state = 'error'; record.error = 'Cancelled'; } else if (error.status === 409 && !replace && confirm(`“${record.file.name}” already exists. Replace it and preserve a version?`)) { record.state = 'uploading'; record.progress = 0; renderUploads(); await uploadFile(record, true, parentPath); return; } else { record.state = 'error'; record.error = error.message ?? 'Upload failed'; }
    toast(`${record.file.name}: ${record.error}`, true);
  } finally { renderUploads(); if (record.state === 'complete') window.setTimeout(() => { state.uploads = state.uploads.filter((item) => item !== record); renderUploads(); }, 1800); }
}
function renderUploads(): void { const dock = $('#upload-dock'); dock.replaceChildren(); dock.hidden = state.uploads.length === 0; for (const record of state.uploads) { const row = document.createElement('div'); row.className = 'upload-item'; const name = document.createElement('b'); name.textContent = record.file.name; const button = document.createElement('button'); button.textContent = record.state === 'uploading' ? 'Cancel' : record.state === 'error' ? 'Retry' : 'Done'; button.disabled = record.state === 'complete'; button.addEventListener('click', () => { if (record.state === 'uploading') { record.controller?.abort(); if (record.id) api.request(`/uploads/${record.id}`, { method: 'DELETE' }).catch(() => undefined); } else if (record.state === 'error') { record.state = 'uploading'; record.progress = 0; record.error = undefined; void uploadFile(record, false); renderUploads(); } }); const status = document.createElement('span'); status.className = 'upload-status'; status.textContent = record.state === 'error' ? record.error ?? 'Failed' : `${Math.round(record.progress * 100)}%`; const track = document.createElement('div'); track.className = 'upload-progress'; const bar = document.createElement('i'); bar.style.width = `${record.progress * 100}%`; track.append(bar); row.append(name, button, status, track); dock.append(row); } }

async function favoriteItems(): Promise<void> { for (const item of selectedItems()) await api.json(`/files/${item.id}`, 'PATCH', { action: 'favorite', favorite: !item.favorite }); await refresh(); }
function setClipboard(mode: 'cut' | 'copy'): void { const ids = [...state.selected]; if (!ids.length) return; state.clipboard = { ids, mode }; toast(`${ids.length} item${ids.length === 1 ? '' : 's'} ${mode === 'cut' ? 'ready to move' : 'copied'}.`); }
async function moveNodes(ids: string[], parentPath: string): Promise<void> { try { for (const id of ids) await api.json(`/files/${id}`, 'PATCH', { action: 'move', parentPath }); toast(`${ids.length} item${ids.length === 1 ? '' : 's'} moved.`); await refresh(); } catch (error) { handleError(error); } }
async function pasteClipboard(): Promise<void> { if (!state.clipboard) return toast('Copy or cut files first.', true); const { ids, mode } = state.clipboard; try { for (const id of ids) await api.json(`/files/${id}`, 'PATCH', { action: mode === 'cut' ? 'move' : 'copy', parentPath: state.path }); if (mode === 'cut') state.clipboard = null; toast(`${ids.length} item${ids.length === 1 ? '' : 's'} ${mode === 'cut' ? 'moved' : 'copied'}.`); await refresh(); } catch (error) { handleError(error); } }
function downloadItems(): void { for (const item of selectedItems()) download(item); }
async function duplicateItems(): Promise<void> { const items = selectedItems(); try { for (const item of items) await api.json(`/files/${item.id}`, 'PATCH', { action: 'copy', parentPath: item.parentPath }); await refresh(); toast(`${items.length} duplicate${items.length === 1 ? '' : 's'} created.`); } catch (error) { handleError(error); } }
async function actionItems(action: 'rename' | 'move' | 'copy' | 'delete'): Promise<void> { const items = selectedItems(); if (!items.length) return; if (state.view === 'trash') { if (action === 'delete') for (const item of items) await deleteTrash(item.id); return; } try { if (action === 'delete') { if (!confirm(`Move ${items.length} item${items.length === 1 ? '' : 's'} to Trash?`)) return; for (const item of items) await api.request(`/files/${item.id}`, { method: 'DELETE' }); } else if (action === 'rename') { if (items.length !== 1) return toast('Choose one item to rename.', true); const name = prompt('New name', items[0].name); if (!name) return; await api.json(`/files/${items[0].id}`, 'PATCH', { action, name }); } else { const destination = prompt(`${action === 'move' ? 'Move' : 'Copy'} into folder path (blank is My drive)`, ''); if (destination === null) return; for (const item of items) await api.json(`/files/${item.id}`, 'PATCH', { action, parentPath: destination }); } await refresh(); } catch (error) { handleError(error); } }
async function restoreTrash(id: string): Promise<void> { try { await api.json(`/trash/${id}/restore`, 'POST', {}); toast('Restored to your drive.'); await refresh(); } catch (error) { handleError(error); } }
async function deleteTrash(id: string): Promise<void> { if (!confirm('Permanently delete this item? This cannot be undone.')) return; try { await api.request(`/trash/${id}`, { method: 'DELETE' }); toast('Permanently deleted.'); await refresh(); } catch (error) { handleError(error); } }
async function versions(item: FileItem): Promise<void> { try { const list = await api.request<Array<{ id: string; size: number; createdAt: string }>>(`/files/${item.id}/versions`); if (!list.length) return toast('No earlier versions yet.'); const choice = prompt(`Versions:\n${list.map((entry, i) => `${i + 1}. ${shortDate(entry.createdAt)} · ${human(entry.size)}`).join('\n')}\n\nEnter a version number to restore:`); const index = Number(choice) - 1; if (!Number.isInteger(index) || !list[index]) return; if (!confirm('Restore this version? The current file will be kept as a new version.')) return; await api.json(`/versions/${list[index].id}/restore`, 'POST', {}); toast('Version restored.'); await refresh(); } catch (error) { handleError(error); } }

function handleError(error: any): void { if (error?.status === 401) { authDialog.showModal(); return; } toast(error?.message ?? 'Something went wrong.', true); }
async function checkHealth(): Promise<void> { try { const health = await api.request<{ state: string; storage: { freeBytes?: number; totalBytes?: number; detail?: string }; version: string }>('/health'); const storage = await api.request<{ usedBytes: number | null; freeBytes?: number; totalBytes?: number; state: string }>('/storage'); const ready = health.state === 'ready'; $('#connection-label').textContent = ready ? 'Storage online' : health.storage.detail ?? 'Storage offline'; $('#connection-dot').parentElement!.className = `connection ${ready ? 'ready' : 'offline'}`; $('#storage-label').textContent = storage.totalBytes ? `${human(storage.usedBytes)} used` : 'Unavailable'; ($('#storage-meter') as HTMLElement).style.width = storage.totalBytes && storage.usedBytes !== null ? `${Math.min(100, (storage.usedBytes / storage.totalBytes) * 100)}%` : '0%'; } catch (error) { if ((error as any).status === 401) authDialog.showModal(); else { $('#connection-label').textContent = 'Storage unavailable'; $('#connection-dot').parentElement!.className = 'connection offline'; } } }

function bindEvents(): void {
  document.addEventListener('click', (event) => { const button = (event.target as Element).closest<HTMLElement>('[data-action]'); if (!button) return; const action = button.dataset.action; if (action === 'new') ($('#new-dialog') as HTMLDialogElement).showModal(); if (action === 'mobile-nav') $('.sidebar').classList.toggle('open'); if (action === 'theme') { document.documentElement.classList.toggle('light'); localStorage.setItem('cloud-theme', document.documentElement.classList.contains('light') ? 'light' : 'dark'); } if (action === 'grid' || action === 'list') { state.viewMode = action; localStorage.setItem('cloud-view', action); refresh(); } if (action === 'sort') { state.sort = state.sort === 'name' ? 'modified' : state.sort === 'modified' ? 'size' : 'name'; state.direction = state.sort === 'name' ? 'asc' : 'desc'; $('#sort-button').textContent = `${state.sort[0].toUpperCase()}${state.sort.slice(1)} ↕`; refresh(); } if (action === 'favorite') void favoriteItems(); if (action === 'download') downloadItems(); if (action === 'cut') setClipboard('cut'); if (action === 'copy-clipboard') setClipboard('copy'); if (action === 'paste') void pasteClipboard(); if (action === 'duplicate') void duplicateItems(); if (['rename', 'move', 'copy', 'delete'].includes(action ?? '')) void actionItems(action as 'rename' | 'move' | 'copy' | 'delete'); if (action === 'close-preview') previewDialog.close(); });
  document.addEventListener('keydown', (event) => { const target = event.target as HTMLElement; if (target.matches('input,textarea,[contenteditable=true]')) return; if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); state.items.forEach((item) => state.selected.add(item.id)); renderSelection(); renderItems(); renderDetails(); } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); setClipboard('copy'); } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x') { event.preventDefault(); setClipboard('cut'); } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); void pasteClipboard(); } else if (event.key === 'Delete' || event.key === 'Backspace') { if (state.selected.size) { event.preventDefault(); void actionItems('delete'); } } else if (event.key === 'Enter' && state.selected.size === 1) openItem(selectedItems()[0]); else if (event.key === 'Escape') { state.selected.clear(); renderSelection(); renderItems(); renderDetails(); } });
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view as View; state.path = ''; state.selected.clear(); $('.sidebar').classList.remove('open'); refresh(); }));
  document.querySelectorAll<HTMLElement>('[data-new-choice]').forEach((button) => button.addEventListener('click', async (event) => { event.preventDefault(); ($('#new-dialog') as HTMLDialogElement).close(); if (button.dataset.newChoice === 'files') $('#file-input').click(); else { const name = prompt('Name your folder'); if (!name) return; try { await api.json('/files/folder', 'POST', { parentPath: state.path, name }); await refresh(); } catch (error) { handleError(error); } } }));
  $('#file-input').addEventListener('change', (event) => { const input = event.target as HTMLInputElement; if (input.files?.length) void uploadFiles(input.files); input.value = ''; });
  const dropzone = $('#dropzone'); for (const kind of ['dragenter', 'dragover']) dropzone.addEventListener(kind, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); }); for (const kind of ['dragleave', 'drop']) dropzone.addEventListener(kind, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); }); dropzone.addEventListener('drop', (event) => { const files = (event as DragEvent).dataTransfer?.files; if (files?.length) void uploadFiles(files); });
  $('#search').addEventListener('input', (event) => { const query = (event.target as HTMLInputElement).value.trim(); window.clearTimeout(state.searchTimer); state.searchTimer = window.setTimeout(async () => { if (!query) { state.view = 'drive'; await refresh(); return; } try { state.view = 'search'; state.items = await api.request<FileItem[]>(`/search?q=${encodeURIComponent(query)}`); renderItems(); } catch (error) { handleError(error); } }, 240); });
  ($('#auth-form') as HTMLFormElement).addEventListener('submit', async (event) => { event.preventDefault(); const token = ($('#token-input') as HTMLInputElement).value; sessionStorage.setItem('continental-cloud-token', token); try { await api.json('/session', 'POST', {}); sessionStorage.removeItem('continental-cloud-token'); await checkHealth(); authDialog.close(); ($('#auth-error') as HTMLElement).hidden = true; await refresh(); } catch { sessionStorage.removeItem('continental-cloud-token'); const error = $('#auth-error'); error.textContent = 'Could not authenticate with that token.'; error.hidden = false; } });
}

if (localStorage.getItem('cloud-theme') === 'light') document.documentElement.classList.add('light');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
bindEvents(); void checkHealth().then(refresh);
