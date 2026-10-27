# Notion

**Kind:** data connector (read-first) · **Auth:** integration token · **Platform:** Any · **Risk tier:** R1 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/notion.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/notion.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Read pages and databases for notes, wikis and project tracking.

## How a user connects it
1. Create an internal integration at notion.so/profile/integrations; copy the secret (starts with ntn_).
2. Share each page or database you want indexed with the integration (page menu → Connections).
3. In JARVIS: Settings → Connectors → Notion → paste the secret.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/notion.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** Token or key entered once, validated with a test call, stored in the OS keychain.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- The integration only sees pages explicitly shared; explain this in the UI to avoid "0 pages" confusion.
- Notion also ships an official hosted MCP server; evaluate it as the preferred route, with this connector as local-first fallback.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect notion`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-10-27 · C11.** `bridge/connectors/notion.mjs`, registered in the bridge. Paste pattern: the secret (`ntn_…`, older `secret_…`) is checked with `GET /v1/users/me` and stored only if that works; the card shows the workspace name and explains that the integration only sees pages shared with it (and the Test button says so when nothing is shared). Read-only by construction: only `POST /v1/search`, `GET /v1/pages/{id}` and `GET /v1/blocks/{id}/children` on `api.notion.com` (its whole egress allow-list), `Notion-Version: 2026-03-11`. Sync: search pages newest edit first down to a `last_edited_time` watermark (ids seen in the watermark minute are remembered, since Notion rounds to the minute); first sync takes the newest 500; each sync reads the blocks of at most 25 pages, the rest wait in the cursor `{"v":1,"w","e","p"}`. Pages moved to the trash since the watermark (search with `in_trash`) and pages that answer 404 (unshared) become deletion markers (C96). Block-to-text: headings, lists, to-dos, toggles, quotes, callouts, code, equations, tables, columns and synced blocks (children to depth 3, at most 1,000 blocks / 40 requests per page); files and images named, never downloaded; child pages and databases only named; `meeting_notes` (and the old `transcription`) named. Database rows get their properties as `Name: value` lines. Rate limits: paced to one request every 340 ms (Notion: 180 requests/min, "an average of 3 per second", per connection; 429 `rate_limited` with Retry-After in seconds, honoured by http.mjs). One read tool, `search_pages` (title search, max 10 results, wrapped as untrusted). Facts checked 2026-10-27 against developers.notion.com (versioning, 2026-03-11 upgrade guide, request limits, search). Written fresh against Notion's docs; not ported from OpenJarvis. Alternatives: Notion's hosted MCP server (`mcp.notion.com/mcp`) is already an optional tool route in `src/config.ts` (live, cloud, OAuth); this connector is the local-first route that keeps a searchable local copy and needs no Notion OAuth app. Tests: fake Notion API, full vetting test pack, connect via Settings (bad/wrong secret stores nothing), fixture sync with ids/timestamps/links/block text, database properties, block pagination and size cap, incremental through the document store, trash/unshare deletions, `since` and initial cap, pacing, injection fixture, revoked secret, disconnect + erase, tool bounds. Left: live check with a real integration (C12); data sources (databases) themselves are not documents yet, only their rows; a page unshared without being edited only leaves when it is still pending (otherwise retention ages it out); Notion OAuth (public integration) is not needed for a personal setup and is not built.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
