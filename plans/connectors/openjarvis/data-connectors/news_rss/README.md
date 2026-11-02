# News / RSS feeds

**Kind:** data connector (read-first) · **Auth:** none (config list) · **Platform:** Any · **Risk tier:** R0 · **Priority:** P2
**Reference implementation:** [`src/openjarvis/connectors/news_rss.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/news_rss.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Headlines from RSS and Atom feeds you choose.

## How a user connects it
1. In JARVIS: Settings → Connectors → News → add feed URLs.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/news_rss.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** No credentials.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R0); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- OpenJarvis blocks private IPs for feed fetches (SSRF); keep that rule.
- Treat all feed text as untrusted (prompt injection, plan 08).

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect news_rss`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-11-02 · C25.** `bridge/connectors/news_rss.mjs`, registered in the bridge, with `feed-fetch.mjs` and `feed-parser.mjs` beside it. Written fresh (no OpenJarvis code; only its private-address rule); no new dependency, and the sidecar option was not needed. **The list on the card is the egress allow-list:** up to 50 feeds, https on the normal port only, no credentials in the address, no local or private host. `createHttp` cannot serve a feed (its host list is fixed and it refuses redirects), so feeds use their own guarded fetch: DNS answers are checked at connection time on the addresses actually dialled, so DNS rebinding gets nowhere; loopback, private, link-local, metadata, CGNAT, multicast and reserved ranges are blocked, with the IPv6 forms that wrap them (mapped, NAT64, 6to4, Teredo). Up to 3 redirects, each re-checked and only on the same site (`www.` aside): a feed that moved elsewhere stops with a message and the owner adds the new address. 5 MB cap on the decompressed body (gzip bombs stop too), 15 s per request, no cookies. The parser handles RSS 0.9x/2.0, RSS 1.0 and Atom, refuses a DOCTYPE with an internal subset (no XXE, no entity bombs) and runs in linear time. ETag and Last-Modified sit in the cursor per feed, with a hash per item, so a sync yields only new or edited items. Retry-After is honoured; a longer limit is left alone until it passes. One bad feed fails alone and shows on the card; the sync fails only when every feed did. `get_headlines` reads up to 12 feeds live. Documents are class `public`; as with other connectors, what reaches a cloud model follows the session's existing rules. Changing the list erases what was kept and syncs again (the card's rule for all settings). Left: live check (no `needs-you` task, since no account is involved: add a real feed on the card); no background refresh, so sync is by "Sync now" until plan 12's scheduler or a `watch()` runs it; plain-http feeds and non-standard ports are refused on purpose.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
