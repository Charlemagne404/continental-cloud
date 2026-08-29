# Continental Cloud

Continental Cloud is a private, self-hosted drive for the Continental ecosystem. It is an application layer over ordinary files on a disk or mounted Time Capsule—not a replacement filesystem, not a database blob store, and not a wrapper around an existing cloud platform.

It is designed to bind to loopback and sit behind a Tailscale-only Caddy listener. Do not put its port directly on a public interface.

## What v0.1 includes

- Responsive PWA file manager: grid/list, breadcrumbs, drag-and-drop multi-file uploads, progress, cancellation/retry, search, recents, favorites, metadata, activity, dark/light appearance, and mobile navigation.
- Direct disk storage with a private internal directory for SQLite metadata, chunk staging, thumbnails, historical versions, and trash.
- Filesystem-backed create, rename, move, copy, download, trash/restore/permanent delete, image thumbnails, previews, and version restoration.
- Chunked upload API that writes each request directly to a temporary disk file; incomplete data is never moved into `data/`.
- SQLite metadata and FTS search, with fast current-folder synchronization and an explicit full reconciliation command for external changes.
- Indexed filter search, streamed folder `.tar` downloads, a durable sync change journal, version retention, and persistent maintenance-job history.
- Continental Cloud Sync: selective live folder mappings, trusted-device records, resumable chunk transfers, version-preconditioned writes, conflict copies, offline queues, native folder watching, and conservative periodic reconciliation.
- A persistent storage identity that prevents a vanished mountpoint from being initialized as empty storage in production.
- Token-based auth abstraction, session-only HTTP-only browser cookie, path/symlink protections, mutation origin checks, strict security headers, and protected internal paths.

## Storage layout and recovery

```text
$CLOUD_STORAGE_PATH/
├── data/                 # Your normal, mountable files
├── .continental/
│   ├── storage-id         # Mount identity; record this outside the NAS
│   ├── metadata.db        # SQLite metadata (WAL sidecars may exist)
│   ├── thumbnails/
│   ├── versions/
│   └── temp/
└── .trash/
```

`data/` remains legible without Continental Cloud. If the application is broken, mount the disk and access or copy those files normally. To preserve application state during backups, include the complete storage root—including `.continental`, `.trash`, and SQLite WAL/SHM sidecars.

The database indexes the filesystem; it never contains file contents. The drive browser rechecks only the open folder. Run a reconciliation after adding or changing many files directly on the NAS.

## Run locally

Requires Node 24+ (for `node:sqlite`) and npm.

```bash
cp .env.example .env
# Set a long, random CLOUD_AUTH_TOKEN in .env
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8787`, enter the configured token once, and use the generated browser session. During development, `npm run dev` watches the TypeScript build and server.

Useful maintenance commands:

```bash
npm run doctor
npm run scan       # full metadata reconciliation
npm run cleanup    # remove abandoned upload staging files after 24h
```

The executable produced by the build exposes the same commands as `cloud doctor`, `cloud scan`, `cloud reconcile`, and `cloud cleanup`.

## Time Capsule / production initialization

Never allow automatic initialization against a production mountpoint after its first setup.

1. Mount the Time Capsule at `/mnt/continental-cloud` and make it writable by the service account.
2. For the one-time initialization only, use a local, non-public development invocation:

   ```bash
   NODE_ENV=development CLOUD_STORAGE_PATH=/mnt/continental-cloud \
   CLOUD_ALLOW_STORAGE_INIT=true CLOUD_AUTH_TOKEN='long-random-token' npm run doctor
   ```

3. Record the generated identity somewhere outside the mounted disk:

   ```bash
   cat /mnt/continental-cloud/.continental/storage-id
   ```

4. In production set `NODE_ENV=production`, `CLOUD_STORAGE_PATH=/mnt/continental-cloud`, that exact `CLOUD_STORAGE_ID`, a strong `CLOUD_AUTH_TOKEN`, and `CLOUD_ALLOW_STORAGE_INIT=false`.

With that configuration, a missing mount, unreadable identity, wrong disk, symlinked storage root, or unwritable data directory is reported as offline and all API writes are blocked. It will not create a new `.continental/storage-id` in the empty mountpoint.

## Docker and Tailscale

`docker-compose.yml` mounts `/mnt/continental-cloud` and publishes only `127.0.0.1:8787`. Set `CLOUD_STORAGE_ID` and `CLOUD_AUTH_TOKEN` in an uncommitted environment file, then run:

```bash
docker compose up -d --build
```

Use Caddy or `tailscale serve` to make the loopback service available exclusively on the tailnet. [Caddyfile.example](Caddyfile.example) is deliberately only a starting point: use your actual tailnet DNS name or bind Caddy to your Tailscale interface. Do not create a public IPv4 firewall rule, Caddy site, or Tailscale Funnel for this service.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLOUD_STORAGE_PATH` | `./storage` | Storage-root path; its `data/` child holds normal files. |
| `CLOUD_STORAGE_ID` | unset | Required in production; must match `.continental/storage-id`. |
| `CLOUD_ALLOW_STORAGE_INIT` | true outside production | One-time layout initialization. Set false for production. |
| `CLOUD_HOST` / `CLOUD_PORT` | `127.0.0.1` / `8787` | App listener. Keep loopback in production. |
| `CLOUD_AUTH_TOKEN` | unset | Required unless explicitly using development-only disabled auth. |
| `CLOUD_AUTH_DISABLED` | false | Development only; forbidden in production. |
| `CLOUD_ALLOWED_ORIGIN` | unset | Optional explicit browser origin for mutations. |
| `CLOUD_MAX_UPLOAD_BYTES` | 20 GiB | Maximum individual upload size. |
| `CLOUD_UPLOAD_CHUNK_BYTES` | 8 MiB | Disk-streamed browser upload chunk size. |
| `CLOUD_VERSION_RETENTION` | 25 | Number of previous versions retained per file. |
| `CLOUD_TRASH_RETENTION_DAYS` | 30 | Age at which `cloud cleanup` permanently removes Trash items. |
| `CLOUD_MIN_FREE_BYTES` | 1 GiB | Free-space health-warning threshold. |
| `CLOUD_APP_VERSION` | `0.1.0` | Returned by `/api/health`. |

## API outline

All `/api/*` requests require `X-Continental-Token` or the browser session established at `POST /api/session`.

```text
GET    /api/files?path=&sort=&direction=
POST   /api/files/folder
GET    /api/files/:id
PATCH  /api/files/:id                    rename, move, copy, favorite
DELETE /api/files/:id                    move to Trash
GET    /api/files/:id/download|content
GET    /api/files/:id/thumbnail|versions

POST   /api/uploads
PUT    /api/uploads/:id/chunks/:index
POST   /api/uploads/:id/complete
DELETE /api/uploads/:id
GET    /api/uploads/:id                   inspect received chunks for a resumable client

GET    /api/search?q=
GET    /api/changes?after=&limit=         # monotonic change journal for sync clients
POST   /api/sync/devices                  # register a trusted desktop device
GET    /api/sync/devices                  # device and selected-folder status
DELETE /api/sync/devices/:id              # revoke a device
GET    /api/sync/changes?after=&limit=    # authoritative enriched change journal
GET    /api/sync/snapshot?path=           # one-time mapping bootstrap only
POST   /api/sync/mappings | /api/sync/ack
POST   /api/sync/uploads                  # resumable, base-revision-aware upload
PUT    /api/sync/uploads/:id/chunks/:n
POST   /api/sync/uploads/:id/complete
POST   /api/sync/mutations | /api/sync/folders
GET    /api/sync/events                   # advisory SSE: journal remains authoritative
GET    /api/jobs                           # reconciliation and maintenance history
GET    /api/recent | /api/favorites | /api/activity
GET    /api/trash
POST   /api/trash/:id/restore | /api/trash/empty
DELETE /api/trash/:id
POST   /api/versions/:id/restore
GET    /api/storage | /api/health
POST   /api/storage/reconcile
```

Responses use JSON, consistent error codes, UTC ISO timestamps, and opaque UUIDs. The route surface keeps browser and desktop clients on the same storage, version-history, Trash, and authorization model.

## Reliability model and current boundaries

Filesystem and SQLite transactions cannot be one atomic transaction. Continental Cloud therefore writes uploads to `temp/`, only exposes them after a same-volume rename into `data/`, and retains overwritten bytes under `versions/`. The drive performs reconciliation to repair metadata drift after out-of-band changes or an interrupted operation. Keep periodic backups and test restoration—software cannot make an SMB/Wi-Fi disk reliable.

Continental ID, multi-user authorization, sharing/public links, advanced media transcoding, cloud-only placeholders, block-level binary delta sync, and collaboration editing remain intentionally out of scope. Sync is deliberately a private, trusted-device feature: it uses the existing token/Tailscale boundary and never exposes the underlying NAS directly.

## Continental Cloud Sync

The desktop client is a small native Node daemon for Windows, macOS, and Linux. It uses recursive `fs.watch` on Windows and macOS, watches each directory on Linux, listens to advisory server-sent change notifications, and falls back to a conservative ten-minute reconciliation. It does **not** poll and rescan the whole tree every few seconds. If a native recursive watcher is unavailable, it falls back to per-directory watchers and keeps the mapping safe.

Install/build Continental Cloud normally, then on each device:

```bash
cloud-sync init --server https://cloud.your-tailnet.ts.net --token 'your-cloud-token' --name 'MacBook'
cloud-sync map add --cloud /Projects/Meridian --local "$HOME/Continental Cloud/Meridian"
cloud-sync start
```

In Windows PowerShell, use a normal Windows path, for example:

```powershell
cloud-sync map add --cloud /Projects/Meridian --local "$env:USERPROFILE\Continental Cloud\Meridian"
cloud-sync start
```

Useful controls are `cloud-sync status`, `cloud-sync sync` for a manual run, `cloud-sync pause <mapping-id>`, and `cloud-sync resume <mapping-id>`. The device ID, selected mappings, cursor, local node/revision state, pending operations, and interrupted-transfer information are held in a restrictive config file under the platform config directory: `%LOCALAPPDATA%\Continental Cloud Sync` on Windows, `~/Library/Application Support/Continental Cloud Sync` on macOS, or `$XDG_CONFIG_HOME/continental-cloud-sync` on Linux. Use `--config <path>` for automation or isolated tests.

Mappings are selective and names need not match: cloud `/Projects/Meridian` can map to any safe local directory. The initial snapshot is only for mapping setup; routine synchronization consumes journal changes since the stored cursor. Downloads stream through an adjacent temporary file and atomically rename only after the checksum matches. A changed or missing local root, symlink, unsafe path, or device mount identity causes sync to stop rather than infer deletions.

If two devices upload from the same base revision, the server preserves the existing file and stores the later upload as `name (Conflict - Device - YYYY-MM-DD).ext`. It records `sync_conflict` in activity/history and the desktop client surfaces it in status. Cloud deletes go to the normal Cloud Trash, and connected mappings remove their corresponding local copy. Restores from Trash are journaled as `restore` and download normally.

The web app's **Sync & Devices** view shows trusted devices, selected mappings, current status/errors, conflicts, and supports revocation. It intentionally does not try to remotely browse a device's local filesystem or turn private sync into MDM.

See [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md) for the stable protocol contract and client-author notes.

## Verification

```bash
npm test       # integration, security, reliability, and sync tests
npm run lint   # strict TypeScript check
npm run build  # production artifact
```

The tests use temporary local directories only; no Time Capsule, Caddy, Tailscale service, or live deployment is required.
