# Google Calendar

**Kind:** data connector (read-first) · **Auth:** oauth · **Platform:** Any · **Risk tier:** R1 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/gcalendar.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/gcalendar.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Events, meetings and free/busy for briefings, travel alerts and scheduling.

## How a user connects it
1. Enable the Google Calendar API in the same Cloud project.
2. Reuse the same OAuth client.
3. In JARVIS: Settings → Connectors → Google Calendar → approve.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/gcalendar.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth with PKCE/loopback redirect and refresh-token handling; scopes requested per capability, read-only first.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- OpenJarvis reads all calendars the user can access.
- Event creation is a separate scope and always approval-gated.
- Feeds proactive alerts (plan 12) and pre-meeting briefs (plan 33).

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect gcalendar`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## API facts (checked 2026-10-25)
- Scopes: `calendar.events.readonly` ("read events on all calendars") and `calendar.calendarlist.readonly` ("read the list of subscribed calendars") both exist and are the smallest pair that lets JARVIS find and read the owner's calendars ([Choose scopes](https://developers.google.com/calendar/api/auth)). Free/busy is computed from the events, so no `calendar.freebusy` scope is needed.
- Sync: full sync = `events.list` (optionally filtered); `nextSyncToken` arrives on the last page. Incremental sync = `events.list?syncToken=…`, which must not be combined with `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`, `sharedExtendedProperty`, `timeMin`, `timeMax` or `updatedMin`; deleted events are always included. An expired or invalidated token returns **410 Gone** and the client must full-sync ([Synchronize resources efficiently](https://developers.google.com/workspace/calendar/api/guides/sync), [Events: list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)).
- Paging: `maxResults` defaults to 250 and caps at 2500; `nextPageToken` until the last page.
- `calendarList.list` takes `minAccessRole`, `showHidden`, `pageToken` (and a `syncToken` that cannot be combined with `minAccessRole`); entries carry `selected`, `hidden`, `primary`, `accessRole`, `summaryOverride`.

## Build log
- **2026-10-25 · C07.** `bridge/connectors/gcalendar.mjs`, registered in the bridge. Read-only (the two read-only scopes above, via the shared Google OAuth module C04); `write` and `subscribe` are false. Reads the primary calendar and the ones the owner shows in Google Calendar (hidden, deleted and free/busy-only calendars are left out; at most 25). Full sync per calendar from 90 days back, then incremental by sync token with nothing Google forbids beside it; 410 restarts just that calendar; at most 8 pages (≤2,000 events) per run, the rest kept in the cursor (`{"v":1,"c":{calendarId:{s:syncToken,p:pageToken}}}`), checkpoint after every page; calendars the owner stops showing drop out. Each event → a `personal`-class document `"<calendarId>/<eventId>"` (when, where, organizer, attendees and replies, https video link, RRULE, tentative/free, attachment titles never opened, HTML description reduced to text, link back to Google Calendar). Cancelled/deleted events become a short "Cancelled" document so the stored copy is overwritten. Two read tools: `list_events` (window ≤92 days, default next 24 h, occurrences expanded, optional keyword) and `check_free_busy` (merged busy blocks; free, declined and all-day events listed apart), results wrapped as untrusted. Tests: the shared test pack plus calendar selection, full/incremental sync, forbidden-parameter check, 410, page budget and resume, cancelled events, bad cursors, event mapping, both tools, Test and disconnect-revokes. Left: deleting a cancelled event from the store outright needs a "tombstone" in the C02 store (follow-up C96); "Sync now" arrives with C06; scheduled sync (plan 12), semantic index (plans 07/33); real sign-in is C05; event creation would be its own task, scope and approval-gated write.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
