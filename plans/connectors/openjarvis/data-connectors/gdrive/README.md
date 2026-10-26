# Google Drive

**Kind:** data connector (read-first) · **Auth:** oauth · **Platform:** Any · **Risk tier:** R1 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/gdrive.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/gdrive.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Search and read Docs, Sheets, PDFs and files for cited answers (plan 33).

## How a user connects it
1. Create or reuse the Google Cloud project; enable the Drive API.
2. Reuse the Desktop-app OAuth client (Client ID/Secret).
3. Add yourself as a test user and the redirect URI.
4. In JARVIS: Settings → Connectors → Google Drive → paste credentials → approve read-only access.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/gdrive.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth with PKCE/loopback redirect and refresh-token handling; scopes requested per capability, read-only first.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Index metadata first, content on demand; respect folder allow-lists (plan 14/33).
- Official remote Drive/Docs/Sheets MCP servers exist in developer preview; evaluate as an alternative.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect gdrive`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Vendor facts (checked 2026-10-26)
- Scope: `drive.readonly`. It is the smallest scope that can list the owner's existing files *and* export a Doc's text; `drive.metadata.readonly` cannot export and `drive.file` only sees files the app created or the owner picks. Google marks it restricted (a security assessment only matters if the app is ever published; a personal project with the owner as test user is fine). Sources: [files.export](https://developers.google.com/workspace/drive/api/v3/reference/files/export), [changes.list](https://developers.google.com/workspace/drive/api/v3/reference/changes/list).
- `files.export` (GET `/drive/v3/files/{id}/export?mimeType=…`) is limited to 10 MB of exported content. Docs → `text/plain`; Sheets → `text/csv` exports only the first sheet.
- Change tracking: `changes.getStartPageToken`, then `changes.list?pageToken=…`; `nextPageToken` and `newStartPageToken` do not expire. `pageSize` default 100, max 1000. `includeRemoved` reports deletions and lost access.
- Drive signals rate limits as 429 or as 403 with reason `rateLimitExceeded`/`userRateLimitExceeded`; both are now backed off by the shared `http.mjs`.

## Build log
- **2026-10-26 · C08.** `bridge/connectors/gdrive.mjs`, registered in the bridge. Read-only (`drive.readonly` via the shared Google OAuth module C04; `write`/`subscribe` false; GET only). Full sync takes the change start token first, then lists non-trashed, non-folder files modified in the last 365 days, newest first, 100 a page, at most 5 pages a run with the rest in the cursor (`{"v":1,"st","f"}` during a full sync, `{"v":1,"s"}` after). Incremental sync by change token with `includeRemoved`; removed or trashed files yield deletion markers (C96) so the store drops them; a refused token restarts one full sync. Google Docs are exported as text and Sheets as CSV (first sheet; capped at 150,000 characters); a file Google refuses to export is kept as details only; every other file (PDF, Office, images, Slides) is listed by name, type, owner, editor, size and date, never downloaded. Folders and shortcuts are not stored. Two read tools: `search_files` (Drive full-text search, the phrase escaped as a query literal so it cannot add clauses, ≤25 results, no contents) and `read_file` (a Doc/Sheet's text up to 20,000 characters, details only for other files), results wrapped as untrusted. Shared changes: `http.mjs` gained `text()` for export bodies and now treats Google's 403 rate-limit reasons as rate limits (also helps Calendar); `google-oauth.mjs` gained `authorizedText()`. Written fresh against Google's v3 reference, not ported from OpenJarvis. Tests: the shared test pack plus card/scope, full sync and export types, start-token order, incremental with deletions, deletion end to end through the store, page budget resume for files and changes, refused token, refused export, 403 rate limit, long text, odd ids/links, bad cursors, query escaping, both tools, Test and disconnect-revokes. Left: folder allow-list and shared drives (C97); real sign-in is C05; scheduled sync (plan 12) and semantic index (plans 07/33); reading PDFs/Office files would need a local text extractor and its own task.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
