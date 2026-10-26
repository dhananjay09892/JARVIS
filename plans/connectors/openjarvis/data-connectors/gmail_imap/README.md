# Gmail (IMAP + app password)

**Kind:** data connector (read-first) · **Auth:** oauth (app password stored like OAuth) · **Platform:** Any · **Risk tier:** R1 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/gmail_imap.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/gmail_imap.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Read Gmail over IMAP with an app password; simplest setup, no Cloud project.

## How a user connects it
1. Enable 2-step verification on your Google account.
2. Create an App Password for "Mail" at myaccount.google.com/apppasswords.
3. IMAP is always on for personal Gmail accounts since January 2025 (the Enable IMAP toggle was removed; checked 2026-10-26). Workspace admins can still turn IMAP or app passwords off.
4. In JARVIS: Settings → Connectors → Gmail (simple: app password) → enter address and the 16-character app password (spaces are fine).

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/gmail_imap.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth with PKCE/loopback redirect and refresh-token handling; scopes requested per capability, read-only first.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- OpenJarvis syncs the last 500 messages by default (configurable).
- App passwords are broad (full mailbox); label this clearly and prefer the OAuth read-only connector when the user can do the Cloud setup.
- Some Workspace admins disable app passwords.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect gmail_imap`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-10-26 · C09.** Shared read-only IMAP reader `bridge/connectors/imap-reader.mjs` (no dependency: a small RFC 3501 client) and `bridge/connectors/gmail_imap.mjs`, registered in the bridge. TLS only (implicit TLS to `imap.gmail.com:993`, TLS ≥1.2, certificate checked; the host is the connector's whole egress allow-list). Read-only by construction: the reader can only send CAPABILITY, LOGIN, LIST, EXAMINE, UID SEARCH, UID FETCH and LOGOUT; the mailbox (Gmail's special-use `\All`, i.e. All Mail, else INBOX) is opened with EXAMINE and bodies are fetched with `BODY.PEEK[]<0.262144>`, so nothing is marked read and messages over 256 KB are shortened. UID-based incremental sync: cursor `{"v":1,"uv","last","p"}`; first sync takes the newest 500 (OpenJarvis's default), each sync fetches at most 50, the rest wait in the cursor; a new UIDVALIDITY starts again. Gmail's `X-GM-MSGID`/`X-GM-THRID` give the same message id as the Gmail API connector (hex) and a working web link; drafts are skipped by label. MIME to text in the new `mime.mjs` (encoded words, base64/quoted-printable, charsets, multipart, RFC 2231 file names; HTML reduced to text, now shared with the Gmail API connector); attachments listed by name and type, never decoded. App password and address go to the credential store only after a test login works; the Settings paste flow gained an optional account field (`setup.accountLabel`). Errors: refused login → `auth`, `[THROTTLED]` → `rate-limit` (retried after 2 s and 8 s), socket/TLS/timeouts → `offline`, `[UNAVAILABLE]`/BYE → `server`. Written fresh against RFC 3501 and Google's IMAP extension docs; not ported from OpenJarvis (option B, the sidecar, was not needed). Tests: a fake IMAP server on 127.0.0.1 (`imap-testserver.mjs`, reusable for C20/C21): card, connect via Settings (wrong password stores nothing), fixture sync with ids/timestamps/links, incremental through the document store, per-sync cap, UIDVALIDITY change, SINCE, expunged between search and fetch, partial fetch, drafts, wrong/revoked password, injection fixture, throttling, offline/dropped/silent/BYE, egress refusal, disconnect + erase, kill switches, read-only command audit. Left: live check with a real app password (C10); deleted/moved mail is not removed from the store yet (it ages out by retention; a UID-set comparison could add deletion markers like C96); generic IMAP hosts with the private-address (SSRF) block are C20.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
