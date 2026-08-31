# Continental Cloud Sync protocol

Continental Cloud Sync is a trusted-device protocol layered over the private Continental Cloud API. The reference Node daemon runs on Windows, macOS, and Linux, and is designed for a Tailscale-oriented deployment. It uses the normal `X-Continental-Token` authentication header. Sync endpoints additionally require `X-Continental-Device` after registration. Devices never mount or receive direct access to the NAS.

## Pairing, device, and mapping lifecycle

The web console can create a short-lived pairing request with `POST /api/sync/pairing`. The server stores only a SHA-256 hash of the displayed six-block code, plus the selected cloud path and policy. The target device then submits the code, its token, a locally generated device UUID, and the intended local folder to `POST /api/sync/pairing/claim`. A successful claim marks the code used, registers the trusted device, and creates the mapping. A code cannot be claimed twice and expires after 15 minutes.

Without pairing, a client may use the explicit lifecycle:

1. Generate and persist a UUID locally.
2. `POST /api/sync/devices` with `deviceId`, `name`, `platform`, and `clientVersion`.
3. `POST /api/sync/mappings` with a local mapping UUID, `cloudPath`, `localPath`, `paused` state, and `policy`.
4. On first use only, request `GET /api/sync/snapshot?path=<cloud path>`. Apply it safely, record its cursor, and acknowledge it through `POST /api/sync/ack`.
5. Thereafter request `GET /api/sync/changes?after=<cursor>&limit=<1..1000>`. The response has ordered `changes`, `nextCursor`, and `hasMore`; keep paging before advancing past a page.

The reference client offers two policies. `project` is the default and excludes common dependency, virtual-environment, build, cache, coverage, and temporary paths; `exact` has no policy exclusions and still applies the normal symlink, traversal, and platform-name safety checks. Excluded local paths are never uploaded or deleted remotely, and an excluded remote path is never downloaded.

The server stores device name/platform/version, last seen time, last processed change, and mapping state. A revoked device receives a forbidden response and must create a new identity; revocation is available through `DELETE /api/sync/devices/:id`.

## Journal contract

`change_journal.sequence` is a storage-local, monotonically increasing integer. A change contains:

```json
{
  "sequence": 18431,
  "operation": "modify",
  "nodeId": "opaque UUID",
  "path": "Projects/Meridian/src/app.ts",
  "previousPath": null,
  "revision": 17,
  "checksum": "sha256 hex",
  "deviceId": "origin device UUID",
  "createdAt": "2026-08-26T12:00:00.000Z"
}
```

Operations are `create`, `modify`, `delete`, `rename`, `move`, `folder_create`, `folder_delete`, and `restore`. `path` and `previousPath` let a mapping detect moves into or out of its selected subtree; `nodeId` remains stable across rename/move. The journal, not `/api/sync/events`, is the correctness mechanism. SSE merely says that another journal fetch may be worthwhile.

Clients may ignore their own `deviceId` changes after updating their local state, but must still advance their cursor. They must acknowledge a cursor only after every relevant local operation through that sequence is safely complete. A missing node while processing an earlier modification is valid if a later delete in the same journal window superseded it.

`SyncProgress` is an advisory persisted mapping summary. It reports initial versus routine sync, scan/transfer/completion/error phase, file/folder totals and completions, bytes, and excluded files/folders. A client may send it with `POST /api/sync/ack`; the journal cursor remains the correctness boundary.

## Writes and conflicts

Files use the dedicated resumable upload route:

1. `POST /api/sync/uploads` with `parentPath`, `name`, `size`, optional `mimeType`, stable `idempotencyKey`, optional `nodeId`, and optional `baseRevision`.
2. PUT only the absent chunks to `/api/sync/uploads/:id/chunks/:index`.
3. `POST /api/sync/uploads/:id/complete`.

Upload sessions are disk-backed and resumable; the same idempotency key returns the original session. Chunk bytes are bounded by the server's configured upload chunk size. Completion streams and hashes the staging file, moves the old cloud file into version history when appropriate, then atomically renames staged bytes into `data/`.

When a supplied `nodeId`/`baseRevision` no longer matches the active remote node, the server does not overwrite it. It writes a conflict copy with the device's friendly name, emits a `sync_conflict` activity event, and returns `conflict: true` and `conflictPath`. Clients must retain both files locally. Rename, move, and delete use `POST /api/sync/mutations` with a required base revision; stale mutations return `409 CONFLICT` rather than destructively guessing.

## Safety rules for clients

- Treat all remote paths as untrusted; reject escapes, symlinks, unrepresentable Windows names, and case collisions.
- Use platform-native config locations and path separators; the logical protocol path is always a validated `/`-separated relative path.
- Persist local node/revision state and pending operations atomically outside the mapped tree.
- Do not treat an absent/mounted-differently root as a deletion. Store and verify a local root realpath/device identity.
- Download to a same-directory temporary file, verify the server checksum when supplied, then atomically rename.
- Keep local edits made while offline queued. On reconnection, fetch the journal, then submit queued changes with their original base revisions before applying remote writes.
- Send local deletes to sync mutations so the server places the item in Continental Cloud Trash. A restore is an ordinary `restore` journal event.
- Install desktop auto-start only for the current user: launchd on macOS, a systemd user unit on Linux, or a limited Windows logon task. The installer never requests administrator/root access and does not remove the sync config during uninstall.

No binary-delta protocol is defined in v1. File bytes are streamed in bounded chunks, and a matching SHA-256/current revision avoids a needless transfer.
