# Obsidian vault

**Kind:** data connector (read-first) · **Auth:** filesystem · **Platform:** Any (local) · **Risk tier:** R0 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/obsidian.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/obsidian.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Index Markdown notes from a local vault (.md, .markdown, .txt).

## How a user connects it
1. Find your vault folder (the one containing .obsidian).
2. In JARVIS: Settings → Connectors → Obsidian → choose the folder.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/obsidian.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** No network credential; needs OS file/permission access, requested with a plain-language explanation.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R0); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Purely local; best privacy; watch the folder for changes instead of polling.
- Writing notes back (daily notes, capture) is a natural first write capability, approval-gated.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect obsidian`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-10-27 · C13.** `bridge/connectors/obsidian.mjs`, registered in the bridge, plus `bridge/connectors/watch.mjs` (background sync for connectors that can watch their source). Grant-local-access pattern: the owner types the vault's full path (`~` allowed) and ticks the consent box; the folder is resolved to its real path and kept in the connector's credential slot, so Disconnect forgets it. A whole drive or the home folder itself is refused; a folder without `.obsidian` is accepted with a note. Reads only `.md`, `.markdown` and `.txt` inside that folder: never a symlink (file or folder), never a dot entry (`.obsidian`, `.trash`, `.git`), at most 2 MB per note and 20,000 notes. Every tool path is checked (no `..`, no absolute or drive paths, real path must equal the vault path, `O_NOFOLLOW` where the OS has it). Read-only: nothing in the vault is ever written, moved or deleted. Mapping: id = path inside the vault, title = frontmatter `title` or file name, text = tags/aliases/simple frontmatter lines then the body with wikilinks made readable (`[[Note|shown]]` → shown, `[[Note#Part]]` → Note › Part, `![[x.png]]` → `[embedded: x.png]`), meta = folder, tags (frontmatter and inline `#tags`, not in code), aliases, links; url = `obsidian://open?vault=…&file=…` (checked 2026-10-27 at obsidian.md/help/uri: values URI-encoded, `.md` may be left out). Sync compares modified time and size with the cursor `{"v":1,"r":<vault hash>,"f":{path:[mtime,size]}}`, reads only what changed (newest first, at most 200 a run), and reports removed or renamed notes as deletions (C96); a cursor from another vault deletes that vault's notes. Change watching: recursive `fs.watch`, debounced, ignoring dot entries and attachments; it runs only while the vault is connected and the owner has "Sync in the background" (subscribe grant, off by default) on, and never while the connector is off or frozen; each change runs the same sync as "Sync now", never two at once. Tools (read): `search_notes` (title, path and text, max 10, short excerpts) and `read_note` (one note by vault path). New error code `folder-missing` for a vault that moved or vanished. Written fresh, not ported from OpenJarvis. Tests: fixture vaults in a temp folder: connect checks, fixture sync (ids, titles, times, links, tags, url), incremental sync and deletions through the document store, batches, `since`, vault switch, size and binary limits, folder missing or replaced by a link, 14 path-escape attempts, symlinked file and folder, search bounds, injection fixture, disconnect + erase, no writes, kill switches, watcher gating and debounce, and one real `fs.watch`. Left: writing notes back (daily notes, capture) is a separate approval-gated write task; Obsidian's Bases and Canvas files are not read; a folder picker on the card (today the path is typed).

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
