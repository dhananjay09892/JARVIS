# Google Tasks

**Kind:** data connector (read-first) · **Auth:** oauth · **Platform:** Any · **Risk tier:** R1 · **Priority:** P2
**Reference implementation:** [`src/openjarvis/connectors/google_tasks.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/google_tasks.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Tasks due today, overdue and recently completed, for briefings and reminders.

## How a user connects it
1. Enable the Google Tasks API in the same Cloud project.
2. Reuse the OAuth client.
3. In JARVIS: Settings → Connectors → Google Tasks → approve.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/google_tasks.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth with PKCE/loopback redirect and refresh-token handling; scopes requested per capability, read-only first.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Good first write capability later (add task) because it is reversible; still approval-gated at first.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect google_tasks`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## API facts (verified 2026-11-01)
- Scope `https://www.googleapis.com/auth/tasks.readonly` is enough for both [tasklists.list](https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists/list) (`GET /tasks/v1/users/@me/lists`, up to 1000 a page) and [tasks.list](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list) (`GET /tasks/v1/lists/{tasklist}/tasks`, `maxResults` default 20, max 100).
- No sync token: incremental sync uses `updatedMin` with `showDeleted=true`. `showHidden=true` is required to see tasks completed in Google's own apps.
- `due` is a date only; the time of day is discarded ([Task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)).

## Build log
- **2026-11-01 · C19** — Read-only adapter `bridge/connectors/google_tasks.mjs` on the shared Google OAuth module (scope `tasks.readonly`), registered in `bridge/server.mjs`. Full sync of every list (open tasks plus completions from the last 90 days), incremental by `updatedMin` watermark with a 2-minute overlap; deleted tasks become deletion markers (C96); page budget resumes from the cursor. Read tool `list_tasks` with views due_today / overdue / upcoming / open / recently_completed in the owner's time zone. Tests: shared pack + 14 own tests, all against a fake Google. Left: real sign-in is C05 (enable the Tasks API in the same Cloud project); tasks of a whole list deleted in Google stay stored until "erase synced data"; "add task" write capability is a separate, approval-gated task if wanted.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
