# GitHub notifications

**Kind:** data connector (read-first) · **Auth:** personal access token · **Platform:** Any · **Risk tier:** R1 · **Priority:** P2
**Reference implementation:** [`src/openjarvis/connectors/github_notifications.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/github_notifications.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Unread GitHub notifications (reviews requested, mentions, CI).

## How a user connects it
1. Create a **classic** Personal Access Token at github.com/settings/tokens with only the `notifications` scope. Fine-grained tokens do not work: GitHub's notifications endpoints "only support authentication using a personal access token (classic)" (checked 2026-11-02).
2. In JARVIS: Settings → Connectors → GitHub notifications → paste the token. JARVIS refuses a token with any other scope, and stores nothing.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/github_notifications.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** Token or key entered once, validated with a test call, stored in the OS keychain.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Feeds "build failed / review requested" alerts (plan 12). Use the smallest scope. There is no fine-grained option, and `notifications` is wider than reading: it also allows marking threads read and changing watches and subscriptions. JARVIS calls none of those, and the card says so.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect github_notifications`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-11-02 · C23.** `bridge/connectors/github_notifications.mjs`, registered in the bridge; written fresh against GitHub's REST docs (nothing taken from OpenJarvis). Paste pattern with a classic token: `GET /user` must work and `X-OAuth-Scopes` must be exactly `notifications`, otherwise nothing is stored (fine-grained tokens are refused before any call, because they cannot work). Read-only by construction: only `GET /user` and `GET /notifications` on `api.github.com`, its whole egress allow-list. Sync mirrors the unread inbox: `If-Modified-Since` from the last `Last-Modified`, no request at all inside `X-Poll-Interval` ("Sync now" included), only new or updated threads yielded, threads that left the list removed (never when the list ran past 10 pages of 50). The cursor is tied to the login, so another account's token cannot get the old account's 304. One read tool, `list_unread`, for a live answer. `http.mjs` gained `response()` (status, headers, a 304 as an answer) and now recognises GitHub's rate limits on a 403 (`x-ratelimit-remaining: 0`, `retry-after`, "secondary rate limit"), which used to read as a refused token; after a limit the adapter makes no call until the reset. Left: the real-account check (C24), scheduled polling and alerts (plan 12), and whether a thread read on GitHub bumps `Last-Modified`: the docs do not say, so it may stay in JARVIS until the next change arrives (C24 can tell). GitHub Enterprise is not covered.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
