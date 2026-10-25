# Gmail (API)

**Kind:** data connector (read-first) · **Auth:** oauth · **Platform:** Any · **Risk tier:** R1 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/gmail.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/gmail.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Read email messages and threads (gmail.readonly scope) for search, summaries and briefings.

## How a user connects it
1. In Google Cloud Console create a project and enable the Gmail API.
2. Create an OAuth client of type "Desktop app"; copy the Client ID and Client Secret.
3. Add your own address as a test user on the OAuth consent screen (needed while the app is unverified).
4. No redirect URI to register: Desktop clients accept a loopback redirect on any port (`http://127.0.0.1:<port>`), and JARVIS picks a free port for each sign-in (checked 2026-10-25 against Google's "OAuth 2.0 for Desktop Apps"). OpenJarvis instead uses a fixed http://localhost:8789/callback.
5. In JARVIS: Settings → Connectors → Gmail → paste Client ID and Secret (once; every Google connector reuses them) → approve Google's consent page (read-only).

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/gmail.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth with PKCE/loopback redirect and refresh-token handling; scopes requested per capability, read-only first.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Alternative path: Google's official remote Gmail MCP server (developer preview since May 2026) or the Claude/Anthropic-hosted Gmail connector. Compared in C06: both run the owner's mail through a hosted service and give JARVIS no local copy to search offline, erase per connector or keep within the policy engine's per-source grants, and the hosted connector is tied to a Claude account rather than to the owner's own OAuth client. We built our own read-only adapter; the MCP server stays an option for a later write capability.
- Shares one Google OAuth client with Calendar, Drive, Tasks and Contacts: build one Google auth module, request scopes per connector.
- Writes (drafts, send, label) are separate scopes and a separate, approval-gated capability (plans 15, 20).

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect gmail`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## API facts (checked 2026-10-25)
- Sync: full sync = `users.getProfile` (current `historyId`) + `users.messages.list` + `users.messages.get?format=full`; partial sync = `users.history.list?startHistoryId=…&historyTypes=messageAdded`. An out-of-range `startHistoryId` returns **404** and the client must full-sync; history records are kept "typically at least a week", sometimes less ([Synchronize clients](https://developers.google.com/workspace/gmail/api/guides/sync)).
- Quota: **6,000 units per user per minute**; `messages.get` costs 20 units (**60 with `format=full`/`raw`/`html`**), `messages.list` 5, `history.list` 2, `getProfile` 1 ([Usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)). So one sync fetches at most 50 full messages (~3,000 units) and carries the rest in the cursor.

## Build log
- **2026-10-25 · C06.** `bridge/connectors/gmail.mjs`, registered in the bridge. Read-only (`gmail.readonly` only, via the shared Google OAuth module C04); `write` and `subscribe` capabilities are false. Full sync of the newest messages (spam/trash excluded by Gmail, drafts skipped), then incremental sync by history id with a 404 → full-sync fallback; at most 50 full messages per sync, the rest kept in the cursor (`{"v":1,"h":historyId,"p":[pending ids]}`), checkpoints every 10 messages. Each message → a `messages`-class document (subject, sender, recipients, date, plain-text body or HTML reduced to text, charset honoured, attachments listed by name/type and never downloaded, link back to the Gmail thread). One read tool, `search_mail` (Gmail search syntax, ≤10 results, metadata + snippet only), results wrapped as untrusted. Settings: the card gained **Sync now** (`POST /connectors/:id/sync`, resumes from the stored cursor and keeps documents in the C02 store) for every connector with `sync()`. Tests: the shared test pack (untrusted sync, injection, auth failure, revoked token, rate limit, offline, erase, writes denied, kill switches) plus full/incremental sync, history 404, the per-sync cap, `since`, deleted messages, bad cursors, MIME/HTML/charset/attachments, the search tool, Test and disconnect-revokes; and a Sync now route test. Left: scheduled background sync (plan 12 event bus) — today sync runs on "Sync now"; semantic index (plans 07/33); real sign-in is C05; any write capability (drafts/send) would be its own task and scope.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
