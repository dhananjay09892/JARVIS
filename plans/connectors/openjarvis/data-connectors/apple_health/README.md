# Apple Health

**Kind:** data connector (read-first) · **Auth:** local · **Platform:** macOS / export file · **Risk tier:** R2-sensitive · **Priority:** P2
**Reference implementation:** [`src/openjarvis/connectors/apple_health.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/apple_health.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Steps, sleep, heart rate and workouts from the HealthKit database or an exported XML.

## How a user connects it
1. Option A (macOS with HealthKit sync): grant Full Disk Access to the app.
2. Option B: on iPhone open Health → profile → Export All Health Data, unzip, and place export.xml in the JARVIS connectors folder.
3. In JARVIS: Settings → Connectors → Apple Health → pick the source.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/apple_health.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** No network credential; needs OS file/permission access, requested with a plain-language explanation.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R2-sensitive); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Apple has no MCP server; the iOS app route (plan 40) is the long-term way to bridge HealthKit.
- Export files are huge; stream-parse and aggregate locally.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect apple_health`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
