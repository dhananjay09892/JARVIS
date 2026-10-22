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

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
