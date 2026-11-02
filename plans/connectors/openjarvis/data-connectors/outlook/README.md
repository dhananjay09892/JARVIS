# Outlook / Microsoft 365 mail

**Kind:** data connector (read-first) · **Auth:** OAuth (Microsoft Graph, `Mail.Read`) · **Platform:** Any · **Risk tier:** R1 · **Priority:** P2
**Reference implementation:** [`src/openjarvis/connectors/outlook.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/outlook.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Read Outlook mail (Inbox only, as in OpenJarvis). OpenJarvis reads it over IMAP with an app password; JARVIS reads it over Microsoft Graph instead (see *Decision* below).

## How a user connects it
1. Microsoft Entra admin centre → App registrations → New registration. Supported accounts: *any Entra ID tenant + personal Microsoft accounts*.
2. Authentication → add platform *Mobile and desktop applications* → custom redirect URI `http://localhost`.
3. API permissions → Microsoft Graph → Delegated → **Mail.Read** only.
4. Copy the *Application (client) ID*. No client secret (it is a public client).
5. In JARVIS: Settings → Connectors → Outlook mail → paste the client ID → Connect → approve on Microsoft's page.

Tokens stay on the user's machine, in the OS keychain (plan 39 / Q20), never in plain JSON or the relay (plan 41). Disconnect forgets them locally; to also withdraw consent on Microsoft's side, remove the app at https://account.live.com/consent/Manage (personal) or https://myapps.microsoft.com (work).

## Decision (C21, checked 2026-11-02)
- **App-password IMAP is gone.** Microsoft disabled basic auth for Exchange Online (work/school) in October 2022, and for Outlook.com personal accounts on 16 September 2024; app passwords stopped working for IMAP with it ([Slipstick summary of Microsoft's announcement](https://www.slipstick.com/outlook/outlook-com-modern-authentication-questions/)). The OpenJarvis approach no longer works, so nothing is ported from it.
- **Graph `Mail.Read` over IMAP + XOAUTH2.** IMAP with OAuth needs `IMAP.AccessAsUser.All`, which can change and delete mail. Graph's delegated `Mail.Read` is read-only and includes the body (`Mail.ReadBasic` does not). Smallest scope wins (vetting rule 3).
- **Not the Microsoft MCP server (Work IQ / Graph MCP, preview).** It needs a work tenant with admin consent and does not cover personal Outlook.com accounts; revisit for work accounts when it leaves preview.
- **Not OpenJarvis as a sidecar (option B):** its connector is the IMAP one above.
- **Graph facts used** ([message: delta](https://learn.microsoft.com/graph/api/message-delta), [redirect URI rules](https://learn.microsoft.com/entra/identity-platform/reply-url)): delta takes `$select`, `$filter=receivedDateTime ge …` only on the first request (later ones follow `@odata.nextLink` / `@odata.deltaLink`); page size via `Prefer: odata.maxpagesize`; deletions and moves out of the folder arrive as `@removed`; delta can return changes outside the filter; localhost redirect ports are ignored, while `http://127.0.0.1` needs a manifest edit (so JARVIS sends the browser to `http://localhost:<port>` and still binds 127.0.0.1 only).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/outlook.mjs` (Graph) with the shared sign-in `bridge/connectors/microsoft-oauth.mjs`, implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth 2.0 authorization code + PKCE for a public client, `common` tenant, scopes `Mail.Read offline_access`; refresh tokens rotate; stored in the OS keychain.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Many organisations disable IMAP; for work accounts prefer Microsoft's Work IQ MCP / Graph (preview) with tenant admin consent. *(Decided in C21: Graph `Mail.Read`; see Decision.)*
- Only the Inbox is synced in OpenJarvis; decide folder scope for JARVIS. *(C21: Inbox only; more folders would be a follow-up.)*

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect outlook`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-11-02 · C21.** `bridge/connectors/outlook.mjs` (id `outlook`, "Outlook mail"), registered in the bridge and added to the morning briefing's mail sources. New shared `bridge/connectors/microsoft-oauth.mjs` (public client, PKCE, `common` tenant, Mail.Read + offline_access, rotating refresh tokens, a pasted client secret refused, the app registration under its own `microsoft` credential id) for later Graph connectors; the one-shot loopback listener moved out of `google-oauth.mjs` into `oauth-loopback.mjs` (unchanged for Google, plus a `publicHost` option). Sync: Inbox `messages/delta`, 30-day lookback on the first round, `maxPerSync` 50 with the nextLink kept as the cursor, deltaLink between rounds, a 410/400 on an old token restarts the round, `@removed` and drafts become deletion markers, links accepted back only for our own Graph path. Read-only `search_mail` tool (`$search` on the Inbox, quoted, max 10). Tests: `microsoft-oauth.test.mjs` (10) and `outlook.test.mjs` (20, incl. the shared pack: injection, auth failure, revoked, rate limit, offline, erase, no writes, kill switches). Left: live check (C22: register the app, connect a real mailbox). Not done: folders other than the Inbox; national clouds; withdrawing consent at Microsoft from JARVIS (no endpoint for public clients).

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
