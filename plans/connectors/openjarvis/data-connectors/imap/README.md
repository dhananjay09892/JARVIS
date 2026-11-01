# Generic IMAP mail

**Kind:** data connector (read-first) · **Auth:** username + password / app password · **Platform:** Any · **Risk tier:** R1 · **Priority:** P2
**Reference implementation:** [`src/openjarvis/connectors/imap.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/imap.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Read mail from any IMAP provider (Fastmail, iCloud, Yahoo, self-hosted).

## How a user connects it
1. Find your provider's IMAP host, port and security (TLS/STARTTLS).
2. Create an app password if the provider supports it.
3. In JARVIS: Settings → Connectors → IMAP → enter host, port, security, user, password.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/imap.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** Token or key entered once, validated with a test call, stored in the OS keychain.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- The shared read-only reader already exists: `bridge/connectors/imap-reader.mjs` (task C09; TLS only, EXAMINE + BODY.PEEK, host allow-list, UID cursor) with a fake server in `imap-testserver.mjs`. This connector adds host/port fields and the private/loopback address block on top.
- OpenJarvis blocks private/loopback IPs for IMAP hosts (SSRF protection); keep that rule.
- Enforce TLS; refuse plain IMAP.

**Provider facts (checked 2026-11-01):** Fastmail `imap.fastmail.com:993` SSL/TLS, app password (fastmail.help, "Setting up K-9 Mail"); iCloud Mail `imap.mail.me.com:993` SSL, app-specific password, username is the part before `@icloud.com` (full address as a fallback) (support.apple.com/kb/HT1625); Yahoo Mail `imap.mail.yahoo.com:993` SSL/TLS, app password (Yahoo help SLN4075, as summarised in n8n's Yahoo IMAP credential docs). Outlook.com/Microsoft 365 no longer take passwords over IMAP; that is task C21.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect imap`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-11-01 · C20.** `bridge/connectors/imap.mjs` (id `imap`, "Email (IMAP)"), registered in the bridge and added to the morning briefing's mail sources. Built on the shared read-only reader from C09 (no new dependency, no OpenJarvis code ported; its private-address rule kept). Connect: paste pattern with username, app password and a new optional **server** field (`setup.serverLabel`; "host" or "host:port", port 993 by default), checked for shape in the Settings route and again in the adapter. Fastmail, iCloud (me.com, mac.com) and Yahoo addresses fill in the host themselves; iCloud tries the name before the @ first, as Apple asks. Gmail and Outlook addresses are pointed to their own connectors. **TLS only:** implicit TLS 1.2+, certificate checked against the host name; port 143 (plain/STARTTLS) is refused with "setup-needed". **SSRF:** local-only names (`.local`, `.internal`, `localhost`, `home.arpa`) and private, loopback, link-local, CGNAT and unique-local addresses are refused (`egress`) before any socket, at connect **and** at every sync/test (DNS can change), and the real socket's own lookup is guarded too (`guardedLookup` from `bridge/net.mjs`), so there is no rebinding window. The host typed is the connector's whole egress allow-list. Inbox only, EXAMINE + BODY.PEEK; document ids `<host>/<uidvalidity>-<uid>`; the sync cursor is tied to the server, so reconnecting elsewhere starts a fresh sync. Credentials (`host`, `port`, `username`, `password`) are stored only after a working login. Tests (`imap.test.mjs`, 18): server parsing, private/loopback/link-local/local-name refusal, a host that turns private between connect and sync, unknown host, port 143, known-provider fill-in and iCloud username, fixture inbox sync, incremental sync through the document store, wrong/revoked password with no secret in logs, injection fixture, throttling backoff, offline, erase, no writes/tools, kill switches, Test button. Left: live check (C22). Not supported: STARTTLS-only servers and local bridges such as Proton Mail Bridge (it listens on 127.0.0.1 with STARTTLS, so both rules refuse it; allowing it would need an owner decision on a loopback exception). Folders other than the inbox are not synced.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
