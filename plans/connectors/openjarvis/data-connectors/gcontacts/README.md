# Google Contacts

**Kind:** data connector (read-first) · **Auth:** oauth · **Platform:** Any · **Risk tier:** R1 · **Priority:** P2
**Reference implementation:** [`src/openjarvis/connectors/gcontacts.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/gcontacts.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
People, phone numbers and emails, to resolve names ("call Sam") and identify senders.

## How a user connects it
1. Enable the People API in the same Cloud project.
2. Reuse the OAuth client.
3. In JARVIS: Settings → Connectors → Google Contacts → approve.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/gcontacts.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth with PKCE/loopback redirect and refresh-token handling; scopes requested per capability, read-only first.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Contacts feed the entity graph in memory (plan 07) and the sender allow-list for channels (plan 20); keep them local and minimal.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect gcontacts`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-11-01 · C18.** `bridge/connectors/gcontacts.mjs`, registered in the bridge. Read-only: only `contacts.readonly`, via the shared Google OAuth module (C04); `write` and `subscribe` are false. Written fresh against the People API v1 reference (checked 2026-11-01), not ported from OpenJarvis; the OpenJarvis sidecar (option B) was not needed. Reads saved contacts only (no "Other contacts", no directory) with the minimal field mask `names,nicknames,emailAddresses,phoneNumbers,organizations,metadata` (no addresses, birthdays, photos, notes or relations). Full sync `people/me/connections` with `requestSyncToken=true`, 1,000 per page, then incremental by `syncToken`; every page repeats the first call's parameters as Google requires; deleted contacts (`metadata.deleted`) become deletion markers (C96); an expired token (7 days; `EXPIRED_SYNC_TOKEN`, seen as 400 `FAILED_PRECONDITION` or 410) restarts one full sync; at most 10 pages per run, rest kept in the cursor `{"v":1,"s":syncToken,"p":pageToken}`. Each person → a `personal` document id `c…` (the resource name without `people/`) with name, nicknames, checked emails and phones (E.164 when Google has it), work, link back to contacts.google.com. One read tool, `find_contact` (people:searchContacts prefix match, ≤30 results, one empty warm-up query per session as Google asks), results wrapped as untrusted. Tests: the shared test pack plus card/scope, field mask, full and incremental sync, deletion through the store, expired token, page budget and resume, incremental paging, bad cursors, mapping and junk filtering, the tool, policy, Test and disconnect-revokes. Left: real sign-in is C05 (enable the People API); feeding contacts into the memory entity graph (plan 07) and the channel sender allow-list (plan 20) belongs to those plans; scheduled sync (plan 12); "Other contacts" would be its own opt-in scope; contact edits would be a separate approval-gated write task.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
