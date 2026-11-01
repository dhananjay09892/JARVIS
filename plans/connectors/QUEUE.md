# JARVIS connector work queue

The ordered list of connector tasks the **JARVIS connector autopilot** (a Claude scheduled task)
works through. It turns the [connector index](README.md) and the per-connector READMEs into tasks
small enough for one run and one reviewable pull request. The READMEs stay the source of truth
for *what* to build; this file decides *in what order*. The main roadmap queue is
[plans/QUEUE.md](../QUEUE.md); this file never changes its tasks.

## How it works

- Each run takes the **first** task (top to bottom) whose status is `todo`, whose `Depends on`
  tasks are all `done` on `main`, and that has no open or rejected `connector/` pull request.
  `C` tasks are in this file; `Q` tasks are in [plans/QUEUE.md](../QUEUE.md).
- The autopilot opens one PR per task, on a branch named `connector/Cnn-short-name`. In that PR
  it changes the task's status line to `done`, so the status becomes true when you merge.
- A task is only `done` once its PR is **merged**. Tasks that depend on an unmerged PR wait,
  so reviewing and merging PRs is what keeps the queue moving. At most two connector PRs are
  open at a time.
- Everything is built and tested against fixtures and mocks; no run uses a real account. The
  step that needs your real account, key, paid service or device is a separate `needs-you` task
  right after the build task (optional Later items share one block per group).
- Order inside each group follows the README priority: P1, then P2, then Later. Items marked
  "Not planned" are listed as `skip`.
- When nothing else is `todo`, the autopilot runs **C99** (discovery) instead of building.

## Status values

| Status | Meaning |
|---|---|
| `todo` | Ready for the autopilot once its dependencies are done |
| `done` | Merged to `main` |
| `needs-you` | Waiting on the owner: an account, a key, a device, a decision. The autopilot skips it |
| `skip` | Deferred, dropped, or covered elsewhere. The autopilot ignores it |

## What you control

- **Change priorities:** move a task block up or down. Order is the only priority signal.
- **Unblock a `needs-you` task:** do what its *Needs you* line says, then change the status to
  `done` (live checks) or `todo` (approvals of new connectors from discovery).
- **Stop a task:** set it to `skip`, or close its PR without merging (the autopilot won't retry it).
- **Add work:** add a block anywhere, with the next free `C` number below 99.

---

## Framework

### C01 · connectors · Connector framework
- **Status:** done
- **Depends on:** Q02, Q04, Q14
- **Scope:** Connector index "The JARVIS connector interface" and vetting rules 2–5, 8–9. `bridge/connectors/`: the `Connector` interface (plan 38 types), a registry that registers each adapter inside try/catch, a credential-store interface that uses the OS keychain once Q20 is `done` (until then a clearly marked dev-only store behind the same interface: outside the repo, file mode 0600, never plain secrets in git or logs), policy-engine registration per capability (read / write / subscribe as separate grants, writes off by default), untrusted-content wrapping for everything a connector returns (reuse Q02), per-connector and global kill switch, and a test-pack helper (auth failure, revoked token, injection fixture, rate limit, offline) every adapter reuses. One fake connector proves it end to end.
- **Done when:** a fake connector registers, syncs fixture data as untrusted content, has its write capability denied by default, and passes the shared test pack; a throwing adapter does not break startup.

### C02 · connectors · Local connector document store
- **Status:** done
- **Depends on:** C01
- **Scope:** Where synced `Document`s live until plans 07/33 bring semantic search: a local SQLite table keyed by connector, with keyword search, a sensitivity class per document (e.g. `health`, `messages`), retention, and erase-per-connector. Exposed to brains as a read tool through the policy engine; results wrapped as untrusted.
- **Done when:** fixture documents can be stored, searched and erased per connector, with tests.

### C03 · connectors · Settings → Connectors card
- **Status:** done
- **Depends on:** C01, Q19
- **Scope:** Plan 39 section 6 (no Q task covers it yet). A Connectors section on the settings registry: one card per registered connector with status dot, scopes / "what this connector can see", last sync, Test, Disconnect, Erase data and the kill switch; the three connect patterns (guided OAuth, paste a token, grant local access) as reusable UI flows. Tokens are written only through the credential store, never into settings.
- **Done when:** the fake connector from the framework task can be connected, tested, disconnected and erased from Settings, with tests.

### C95 · connectors · Connectors card: vault and retention controls
- **Status:** done
- **Depends on:** C03
- **Scope:** Follow-up from C03. On the Settings → Connectors card: the documents connector's "show health and finance documents to the brain" switch (`allowVault`, off by default, confirmation to turn on) and per-class / per-connector retention from the C02 store, saved beside the grants (no secrets), plus a per-connector document count. Also write a plan 16 metric for connector health (cards in `attention`/`error`).
- **Done when:** the vault switch and a retention change survive a restart and take effect in the store and the documents tools, with tests.

## Data connectors (OpenJarvis list)

Each task builds the adapter at `bridge/connectors/<id>.mjs` against fixtures/mocks, read-only, following the connector's README.

### C04 · openjarvis/data-connectors (shared) · Shared Google OAuth module
- **Status:** done
- **Depends on:** C02, C03
- **Scope:** One Google OAuth module for Gmail, Calendar, Drive, Contacts and Tasks: installed-app flow with PKCE and loopback redirect, incremental per-connector scopes (smallest read-only scopes), token refresh and revocation, tokens in the credential store. Tested against a mock token endpoint.
- **Done when:** a mocked consent → token → refresh → revoke round trip passes, with readable errors for denied consent and revoked tokens.

### C05 · openjarvis/data-connectors (shared) · Create the Google OAuth client
- **Status:** needs-you
- **Needs you:** create a Google Cloud project and an OAuth client (Desktop app), enable the Gmail, Calendar, Drive, People and Tasks APIs as you want them, add yourself as a test user, and paste the client ID in Settings → Connectors → Google. Then try "What's on my calendar tomorrow?" once each Google connector is merged, and set this to `done`.
- **Depends on:** C04
- **Scope:** Real-account step for every Google connector; nothing in the repo needs a real client to pass tests.
- **Done when:** a real Google sign-in works on your machine.

### C06 · openjarvis/data-connectors/gmail · Gmail (API)
- **Status:** done
- **Depends on:** C02, C03, C04
- **Scope:** README "How we implement it" and acceptance tests, read-only scopes through the shared Google OAuth module; incremental sync with cursor, rate-limit backoff.
- **Done when:** fixture sync, revoked token, injection fixture and erase tests pass.

### C07 · openjarvis/data-connectors/gcalendar · Google Calendar
- **Status:** done
- **Depends on:** C02, C03, C04
- **Scope:** README "How we implement it" and acceptance tests, read-only scopes through the shared Google OAuth module; incremental sync with cursor, rate-limit backoff.
- **Done when:** fixture sync, revoked token, injection fixture and erase tests pass.

### C96 · connectors · Deleted items leave the document store
- **Status:** done
- **Depends on:** C07
- **Scope:** Follow-up from C07. Let an adapter's `sync()` yield a deletion marker (e.g. `{ deleted: '<doc id>' }`) that the registry validates and passes through, and that the C02 store applies by removing that document (no tombstone text kept). Use it in Google Calendar for cancelled/deleted events instead of the short "Cancelled" document, and in Gmail if C06 is merged by then.
- **Done when:** a cancelled event synced incrementally removes the stored event, with tests; a marker for another connector's document is ignored.

### C08 · openjarvis/data-connectors/gdrive · Google Drive
- **Status:** done
- **Depends on:** C02, C03, C04
- **Scope:** README "How we implement it" and acceptance tests, read-only scopes through the shared Google OAuth module; incremental sync with cursor, rate-limit backoff. Text extraction for Docs/Sheets exports only; binary files listed, not read.
- **Done when:** fixture sync, revoked token, injection fixture and erase tests pass.

### C97 · openjarvis/data-connectors/gdrive · Google Drive: folder allow-list and shared drives
- **Status:** done
- **Depends on:** C08
- **Scope:** Follow-up from C08. A folder allow-list on the Google Drive card (only files under the chosen folders are synced and searchable; empty = everything, as now), applied to full sync, changes and both tools, with files moved out of an allowed folder leaving the store. Optional shared-drive support behind its own switch (`includeItemsFromAllDrives`/`supportsAllDrives` on files.list and changes.list), off by default.
- **Done when:** fixture tests show files outside the allow-list are neither stored nor returned by the tools, a file moved out is deleted from the store, and shared-drive files appear only when the switch is on.

### C98 · openjarvis/data-connectors/gdrive · Google Drive: folders moved in or out of the allow-list
- **Status:** done
- **Depends on:** C97
- **Scope:** Follow-up from C97. When the changes feed reports a *folder* (not a file) that moved across the allow-list boundary, its files must follow: a folder now outside yields deletion markers for the stored files under it (store lookup by a `meta.parents` field or a files.list of its descendants, bounded per run), and a folder now inside has its files listed and synced. Keep the per-run API budget.
- **Done when:** fixture tests show a folder moved out of an allowed folder removes its files (and its subfolders' files) from the store, and a folder moved in brings its files in, within the page budget.

### C09 · openjarvis/data-connectors/gmail_imap · Gmail over IMAP (shared IMAP reader)
- **Status:** done
- **Depends on:** C02, C03
- **Scope:** Build a shared read-only IMAP reader (TLS only, app password from the credential store, UID-based incremental sync, MIME to text, attachments listed not opened) and the Gmail IMAP adapter on top of it. Tested against a fake IMAP server.
- **Done when:** fixture mailbox sync, wrong password, injection fixture and erase tests pass.

### C10 · openjarvis/data-connectors/gmail_imap · Live check: Gmail over IMAP
- **Status:** needs-you
- **Needs you:** turn on 2-Step Verification, create a Google app password, paste it in Settings → Connectors → Gmail (IMAP), ask "Any new mail from the bank?", then set this to `done`.
- **Depends on:** C09
- **Scope:** Real-account check for the IMAP reader.
- **Done when:** a real mailbox syncs read-only.

### C11 · openjarvis/data-connectors/notion · Notion
- **Status:** done
- **Depends on:** C02, C03
- **Scope:** Paste-a-token pattern; read pages/databases shared with the integration; block-to-text mapping; rate-limit backoff (Notion's documented limit, *verify*).
- **Done when:** fixture workspace sync, bad token, injection fixture and erase tests pass.

### C12 · openjarvis/data-connectors/notion · Live check: Notion
- **Status:** needs-you
- **Needs you:** create an internal Notion integration, share only the pages you want JARVIS to read with it, paste the secret in Settings → Connectors → Notion, ask a question about one page, then set this to `done`.
- **Depends on:** C11
- **Scope:** Real-account check.
- **Done when:** a real workspace syncs read-only.

### C13 · openjarvis/data-connectors/obsidian · Obsidian vault
- **Status:** done
- **Depends on:** C02, C03
- **Scope:** Grant-local-access pattern: read Markdown in a chosen vault folder only (no path escape, symlinks not followed), frontmatter and wikilinks mapped, file watcher for changes. No credentials needed.
- **Done when:** fixture vault sync, path-escape attempt, injection fixture and erase tests pass.

### C14 · openjarvis/data-connectors/slack · Slack (data source)
- **Status:** done
- **Depends on:** C02, C03
- **Scope:** Read-only sync of channels the bot is a member of, bot token in the credential store, smallest scopes, cursor pagination and Retry-After handling.
- **Done when:** fixture workspace sync, revoked token, rate limit, injection fixture and erase tests pass.

### C15 · openjarvis/data-connectors/slack · Live check: Slack data
- **Status:** needs-you
- **Needs you:** create a Slack app in your workspace with the read scopes listed in the PR, install it, invite it to the channels JARVIS may read, paste the bot token in Settings → Connectors → Slack, then set this to `done`.
- **Depends on:** C14
- **Scope:** Real-account check.
- **Done when:** a real workspace syncs read-only.

### C16 · openjarvis/data-connectors/weather · Weather
- **Status:** done
- **Depends on:** C02, C03
- **Scope:** Compare a keyless provider (e.g. Open-Meteo, *verify* terms) with OpenWeatherMap as the README names; R0, location from Settings only. Current conditions and forecast as a read tool.
- **Done when:** fixture forecast, bad key, offline and injection tests pass.

### C17 · openjarvis/data-connectors/weather · Live check: Weather
- **Status:** needs-you
- **Needs you:** if the PR chose a keyed provider, create the API key and paste it in Settings → Connectors → Weather; set your location; ask "Will it rain tomorrow?"; then set this to `done`.
- **Depends on:** C16
- **Scope:** Real-service check.
- **Done when:** a real forecast is answered.

### C18 · openjarvis/data-connectors/gcontacts · Google Contacts
- **Status:** done
- **Depends on:** C02, C03, C04
- **Scope:** README "How we implement it" and acceptance tests, read-only scope through the shared Google OAuth module. Writes (create task, edit contact) stay out of scope.
- **Done when:** fixture sync, revoked token, injection fixture and erase tests pass.

### C19 · openjarvis/data-connectors/google_tasks · Google Tasks
- **Status:** done
- **Depends on:** C02, C03, C04
- **Scope:** README "How we implement it" and acceptance tests, read-only scope through the shared Google OAuth module. Writes (create task, edit contact) stay out of scope.
- **Done when:** fixture sync, revoked token, injection fixture and erase tests pass.

### C20 · openjarvis/data-connectors/imap · Generic IMAP mail
- **Status:** todo
- **Depends on:** C02, C03, C09
- **Scope:** Generic adapter on the shared IMAP reader: host/port/TLS settings, app-password guidance per provider.
- **Done when:** fixture mailbox, bad host, wrong password, injection fixture and erase tests pass.

### C21 · openjarvis/data-connectors/outlook · Outlook / Microsoft 365 mail
- **Status:** todo
- **Depends on:** C02, C03, C09
- **Scope:** Check first whether Microsoft still allows app-password IMAP for the account types we target (*verify*; basic auth was retired for many Exchange Online tenants) and, if not, compare Microsoft Graph OAuth or Microsoft's official MCP server; record the choice in the README. Read-only.
- **Done when:** fixture mailbox sync, auth failure, injection fixture and erase tests pass.

### C22 · openjarvis/data-connectors/outlook · Live check: IMAP and Outlook mail
- **Status:** needs-you
- **Needs you:** connect one IMAP account and one Outlook account as the PRs describe (app password, or the OAuth app the Outlook PR chose), ask about a recent email in each, then set this to `done`.
- **Depends on:** C20, C21
- **Scope:** Real-account checks for the two P2 mail connectors.
- **Done when:** both real mailboxes sync read-only.

### C23 · openjarvis/data-connectors/github_notifications · GitHub notifications
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** Fine-grained personal access token with notifications read only; polling with the `X-Poll-Interval` and `Last-Modified` headers; mark-as-read stays out of scope.
- **Done when:** fixture notifications, bad token, rate limit, injection fixture and erase tests pass.

### C24 · openjarvis/data-connectors/github_notifications · Live check: GitHub notifications
- **Status:** needs-you
- **Needs you:** create a GitHub token with the read-only permission listed in the PR, paste it in Settings → Connectors → GitHub, ask "Anything new on GitHub?", then set this to `done`.
- **Depends on:** C23
- **Scope:** Real-account check.
- **Done when:** real notifications are read.

### C25 · openjarvis/data-connectors/news_rss · News / RSS feeds
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** R0; feed list in Settings; RSS/Atom parsing with size and redirect limits; ETag/Last-Modified caching; feed text is untrusted.
- **Done when:** fixture feeds, malformed feed, offline and injection tests pass.

### C26 · openjarvis/data-connectors/oura · Oura Ring
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** R2-sensitive: documents stored with sensitivity class `health`, never sent to a cloud model without per-turn approval (plan 32 vault when it exists). Personal access token or OAuth as the README says (*verify* Oura's current auth options).
- **Done when:** fixture sleep/readiness sync, bad token, sensitivity enforcement and erase tests pass.

### C27 · openjarvis/data-connectors/oura · Live check: Oura
- **Status:** needs-you
- **Needs you:** create the Oura token or app the PR describes, paste it in Settings → Connectors → Oura, ask "How did I sleep?", then set this to `done`.
- **Depends on:** C26
- **Scope:** Real-account check.
- **Done when:** real sleep data is read and kept local.

### C28 · openjarvis/data-connectors/apple_health · Apple Health (export file)
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** R2-sensitive. Import from the Health app's `export.zip` (works on any OS): streaming XML parse, size limits, `health` sensitivity class as for Oura.
- **Done when:** a fixture export imports, a malformed/oversized file fails cleanly, and sensitivity and erase tests pass.

### C29 · openjarvis/data-connectors/apple_calendar · Apple Calendar (shared macOS local access)
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** Build a shared macOS local-access helper (permission check, clear explanation of what is read, read-only DB/EventKit access as the README decides) and the Apple Calendar adapter. Disabled on Windows/Linux. Tested with fixture databases.
- **Done when:** fixture sync, missing-permission, injection fixture and erase tests pass; the connector reports itself unavailable off macOS.

### C30 · openjarvis/data-connectors/apple_calendar · Live check: Apple Health and Calendar on a Mac
- **Status:** needs-you
- **Needs you:** on a Mac, grant the permission the Apple Calendar PR describes and ask about tomorrow; import a Health export and ask about last week's steps; then set this to `done`.
- **Depends on:** C28, C29
- **Scope:** Real-device checks for the P2 Apple connectors.
- **Done when:** both work on a real Mac.

### C31 · openjarvis/data-connectors/dropbox · Dropbox
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** README "How we implement it" and acceptance tests. OAuth with PKCE, read-only scope, cursor-based listing; text files only.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C32 · openjarvis/data-connectors/granola · Granola meeting notes
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** README "How we implement it" and acceptance tests. API key, read-only notes sync (*verify* the current Granola API).
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C33 · openjarvis/data-connectors/hackernews · Hacker News
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** README "How we implement it" and acceptance tests. R0, public API, top/best stories and comments as untrusted text.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C34 · openjarvis/data-connectors/spotify · Spotify (recently played)
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** README "How we implement it" and acceptance tests. OAuth with PKCE, read-only recently-played scope; playback control out of scope.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C35 · openjarvis/data-connectors/strava · Strava
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** README "How we implement it" and acceptance tests. OAuth with refresh token, read-only activities; `health` sensitivity class for heart-rate data.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C36 · openjarvis/data-connectors/apple_contacts · Apple Contacts
- **Status:** todo
- **Depends on:** C02, C03, C29
- **Scope:** README "How we implement it" and acceptance tests. On the shared macOS local-access helper; read-only.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C37 · openjarvis/data-connectors/apple_notes · Apple Notes
- **Status:** todo
- **Depends on:** C02, C03, C29
- **Scope:** README "How we implement it" and acceptance tests. On the shared macOS local-access helper; read-only; locked notes skipped.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C38 · openjarvis/data-connectors/apple_music · Apple Music (local)
- **Status:** todo
- **Depends on:** C02, C03, C29
- **Scope:** README "How we implement it" and acceptance tests. On the shared macOS local-access helper; R0 library/play history.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C39 · openjarvis/data-connectors/imessage · iMessage (local database)
- **Status:** todo
- **Depends on:** C02, C03, C29
- **Scope:** README "How we implement it" and acceptance tests. R2-sensitive, `messages` class; read-only copy of chat.db via the shared macOS helper; never sends.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C40 · openjarvis/data-connectors/whatsapp · WhatsApp chat export
- **Status:** todo
- **Depends on:** C02, C03
- **Scope:** README "How we implement it" and acceptance tests. Filesystem import of exported chat .txt/.zip; `messages` class; no account access.
- **Done when:** fixture sync, auth/permission failure where relevant, injection fixture and erase tests pass.

### C41 · openjarvis/data-connectors · Live checks: Later data connectors
- **Status:** needs-you
- **Needs you:** for each Later data connector you want, create the account token/app or grant the Mac permission its PR describes, try its test question, and tick it in the README's build log; set this to `done` when you are finished (or `skip`).
- **Depends on:** C31, C32, C33, C34, C35, C36, C37, C38, C39, C40
- **Scope:** Real-account checks for the Later data connectors, grouped in one block because they are optional.
- **Done when:** each connector you use works on a real account.

## Channels (OpenJarvis list)

Every channel depends on main task Q35 (messaging spec and threat model) and follows its channel interface and sender allow-list. Inbound messages are untrusted; every send is a separate capability, off by default and approval-gated. Channels that need a public webhook URL use the relay from plan 41 (not written yet) or a tunnel the owner chooses; they are built against mocks first.

### C42 · openjarvis/channels/telegram · Telegram
- **Status:** skip
- **Depends on:** Q35
- **Scope:** Covered by main task Q36 (plan 20 Telegram adapter). Not built here.
- **Done when:** Q36 is done.

### C43 · openjarvis/channels/slack · Slack (DM your agent)
- **Status:** todo
- **Depends on:** Q35, C03, C14
- **Scope:** Socket Mode (no public URL), DMs from allow-listed users only, reuse the Slack client from the data connector; replies approval-gated per the Q35 spec.
- **Done when:** mock Socket Mode round trip, non-allow-listed sender ignored, injection fixture and revoked token tests pass.

### C44 · openjarvis/channels/slack · Live check: Slack channel
- **Status:** needs-you
- **Needs you:** enable Socket Mode on your Slack app, create the app-level token, paste it in Settings → Channels → Slack, DM JARVIS, then set this to `done`.
- **Depends on:** C43
- **Scope:** Real-account check.
- **Done when:** a real DM gets an approved reply.

### C45 · openjarvis/channels/twilio_sms · SMS via Twilio
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** Inbound webhook with Twilio signature validation, allow-listed numbers only, outbound SMS approval-gated with a spend cap. Built against a mock Twilio API; public URL handled through the relay/tunnel choice.
- **Done when:** mock inbound/outbound round trip, bad signature rejected, non-allow-listed number ignored, spend cap and injection tests pass.

### C46 · openjarvis/channels/twilio_sms · Live check: Twilio SMS
- **Status:** needs-you
- **Needs you:** create a Twilio account and number (paid), decide how the webhook reaches your PC (relay or tunnel), paste the SID/token/number in Settings → Channels → SMS, text JARVIS, then set this to `done`.
- **Depends on:** C45
- **Scope:** Real-account and paid-service step.
- **Done when:** a real SMS gets an approved reply.

### C47 · openjarvis/channels/webhook · Generic webhook (outbound)
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** Outbound-only webhook channel: owner-configured URLs (egress allow-list), HMAC-signed payloads, retries with backoff, approval per send unless the owner pre-approves a target. No credentials needed beyond the generated signing secret.
- **Done when:** mock receiver gets signed payloads, unlisted URL blocked, retry/offline and injection tests pass.

### C48 · openjarvis/channels/discord · Discord
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests. Gateway websocket (outbound connection), DMs/allow-listed users only, intents kept minimal.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure, rate limit and injection tests pass.

### C49 · openjarvis/channels/discord · Live check: Discord
- **Status:** needs-you
- **Needs you:** create a Discord application and bot, invite it to your server with the permissions in the PR, paste the bot token in Settings → Channels → Discord, message it, then set this to `done`.
- **Depends on:** C48
- **Scope:** Real-account check.
- **Done when:** a real message gets an approved reply.

### C50 · openjarvis/channels/email · Email (SMTP/IMAP)
- **Status:** todo
- **Depends on:** Q35, C03, C09
- **Scope:** README "How we implement it" and acceptance tests. Reuse the shared IMAP reader for inbound; SMTP send approval-gated; allow-listed senders only; SPF/DKIM results shown, not trusted blindly.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure, rate limit and injection tests pass.

### C51 · openjarvis/channels/email · Live check: Email (SMTP/IMAP)
- **Status:** needs-you
- **Needs you:** connect a dedicated mailbox for JARVIS (app password), email it from an allow-listed address, then set this to `done`.
- **Depends on:** C50
- **Scope:** Real-account check.
- **Done when:** a real message gets an approved reply.

### C52 · openjarvis/channels/whatsapp · WhatsApp (Cloud API)
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests. Meta Cloud API webhook with signature validation, 24-hour window and template rules (*verify*), allow-listed numbers; built against a mock Graph API.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure, rate limit and injection tests pass.

### C53 · openjarvis/channels/whatsapp · Live check: WhatsApp (Cloud API)
- **Status:** needs-you
- **Needs you:** create a Meta developer app with WhatsApp, a business number and a permanent token, decide how the webhook reaches your PC, paste the credentials in Settings → Channels → WhatsApp, message JARVIS, then set this to `done`.
- **Depends on:** C52
- **Scope:** Real-account check.
- **Done when:** a real message gets an approved reply.

### C54 · openjarvis/channels/signal · Signal
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests. Via a local signal-cli REST API container the owner runs; allow-listed numbers; JARVIS never registers a number by itself.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure, rate limit and injection tests pass.

### C55 · openjarvis/channels/signal · Live check: Signal
- **Status:** needs-you
- **Needs you:** run signal-cli REST API with a number you control (a second number is recommended), paste its URL in Settings → Channels → Signal, message JARVIS, then set this to `done`.
- **Depends on:** C54
- **Scope:** Real-account check.
- **Done when:** a real message gets an approved reply.

### C56 · openjarvis/channels/bluebubbles · iMessage via BlueBubbles
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C57 · openjarvis/channels/feishu · Feishu / Lark
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C58 · openjarvis/channels/gmail · Gmail (as a channel)
- **Status:** todo
- **Depends on:** Q35, C03, C06
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C59 · openjarvis/channels/google_chat · Google Chat
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C60 · openjarvis/channels/line · LINE
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C61 · openjarvis/channels/matrix · Matrix
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C62 · openjarvis/channels/mattermost · Mattermost
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C63 · openjarvis/channels/messenger · Facebook Messenger
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C64 · openjarvis/channels/rocketchat · Rocket.Chat
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C65 · openjarvis/channels/sendblue · iMessage / SMS via SendBlue
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C66 · openjarvis/channels/teams · Microsoft Teams
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C67 · openjarvis/channels/viber · Viber
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C68 · openjarvis/channels/zulip · Zulip
- **Status:** todo
- **Depends on:** Q35, C03
- **Scope:** README "How we implement it" and acceptance tests, built against a mock of the platform API; allow-listed senders, sends approval-gated.
- **Done when:** mock round trip, non-allow-listed sender ignored, auth failure and injection tests pass.

### C69 · openjarvis/channels · Live checks: Later channels
- **Status:** needs-you
- **Needs you:** for each Later channel you want, create the account/bot and credentials its PR lists (and the webhook route if it needs one), message JARVIS, and tick it in the README's build log; set this to `done` when finished (or `skip`).
- **Depends on:** C56, C57, C58, C59, C60, C61, C62, C63, C64, C65, C66, C67, C68
- **Scope:** Real-account checks for the Later channels, grouped in one block because they are optional.
- **Done when:** each channel you use works on a real account.

### C70 · openjarvis/channels/irc · IRC
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C71 · openjarvis/channels/mastodon · Mastodon
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C72 · openjarvis/channels/nostr · Nostr
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C73 · openjarvis/channels/reddit · Reddit
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C74 · openjarvis/channels/twitch · Twitch chat
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C75 · openjarvis/channels/twitter · X / Twitter
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C76 · openjarvis/channels/webchat · Web chat (in-memory)
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C77 · openjarvis/channels/whatsapp_baileys · WhatsApp (Baileys, unofficial)
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

### C78 · openjarvis/channels/xmpp · XMPP / Jabber
- **Status:** skip
- **Depends on:** none
- **Scope:** Not planned in the connector index. Change to `todo` only if you decide otherwise.
- **Done when:** –

## n8n

One task per integration mode folder.

### C79 · n8n/instance-mcp · Instance-level MCP
- **Status:** todo
- **Depends on:** C03
- **Scope:** Tool-provider connector `bridge/connectors/n8n.mjs` with a shared MCP client module (streamable HTTP) other MCP connectors reuse; owner ticks allowed workflows in Settings and assigns risk tiers (default R2, approval); tool-list snapshot with re-approval on change; results untrusted; version/health checks. Tested against a fake MCP server.
- **Done when:** fake n8n MCP server: discovery, allow-list, approval-gated run, changed-tool-list re-approval, injection and offline tests pass.

### C80 · n8n/webhooks-and-rest · Webhooks and REST
- **Status:** todo
- **Depends on:** C79, C47
- **Scope:** Trigger n8n workflows through the generic webhook channel (signed, allow-listed) and accept signed callbacks into JARVIS; inbound callbacks are untrusted and rate-limited.
- **Done when:** mock n8n webhook round trip, bad signature, replay and injection tests pass.

### C81 · n8n · Live check: n8n
- **Status:** needs-you
- **Needs you:** run n8n (2.13+), enable instance MCP as owner/admin with "Auto-expose new workflows" off, mark one harmless workflow available, connect it in Settings → Connectors → n8n, ask JARVIS to run it, then set this to `done`.
- **Depends on:** C79, C80
- **Scope:** Real-instance check for both P1 n8n modes.
- **Done when:** a real workflow runs after approval.

### C82 · n8n/mcp-server-trigger · MCP Server Trigger (per workflow)
- **Status:** todo
- **Depends on:** C79
- **Scope:** Register a single workflow's MCP Server Trigger endpoint as its own tool provider with its own auth, on the shared MCP client.
- **Done when:** fake trigger endpoint: auth, approval, re-approval and injection tests pass.

### C83 · n8n/mcp-client-tool · MCP Client Tool (n8n calls JARVIS)
- **Status:** todo
- **Depends on:** C79, Q18
- **Scope:** Expose a small, read-only JARVIS MCP server for n8n agents with a bearer token issued by JARVIS, per-token tool allow-list, everything through the policy engine; not reachable from outside the machine unless the owner routes it.
- **Done when:** a mock n8n client can call allowed read tools only; bad token, write attempt and injection tests pass.

## Claude skills and plugins

Plan 19 owns JARVIS's own skill packs; it has no tasks in plans/QUEUE.md yet. These tasks build the SKILL.md interop layer and reference plan 19 phase 1 (spec and loader) rather than duplicating it: when the plan autopilot adds plan 19 tasks, they should build on these.

### C84 · claude-skills-and-plugins/skills · Skills loader (SKILL.md)
- **Status:** todo
- **Depends on:** C03, Q18
- **Scope:** Read SKILL.md folders from the JARVIS skills folder; validate frontmatter; inject only name + description (progressive loading); every skill disabled until the owner enables it after seeing its full text; scripts not run in v1; version pin and re-approval on change. Malicious-skill fixtures.
- **Done when:** fixture skills load progressively; a malicious skill (exfiltration, hidden text) cannot widen tools; changed skill needs re-approval.

### C85 · claude-skills-and-plugins/agent-sdk-loading · Load skills through the Claude Agent SDK
- **Status:** todo
- **Depends on:** C84
- **Scope:** Pass only owner-enabled skills (and their allowed tools) to the Agent SDK `query()` path in the bridge, as the README describes (*verify* current SDK options); policy engine still decides every tool call.
- **Done when:** a mocked SDK call receives only enabled skills; tests pass.

### C86 · claude-skills-and-plugins/mcp-in-plugins · MCP servers as tool providers
- **Status:** todo
- **Depends on:** C84, C79
- **Scope:** Register plain MCP servers (from Settings, and later from plugins) as tool-provider connectors on the shared MCP client: provenance and pinned version recorded, tool-list snapshot and re-approval, per-server egress allow-list, results untrusted.
- **Done when:** fake MCP server: registration, rug-pull detection, approval and injection tests pass.

### C87 · claude-skills-and-plugins/plugins · Claude Code plugin importer
- **Status:** todo
- **Depends on:** C85, C86
- **Scope:** Read `.claude-plugin/plugin.json`, show components and requested permissions, map skills and MCP servers only (hooks, executables, agents and commands unsupported in v1), trust tiers, name-spoofing rule.
- **Done when:** fixture plugins import skills/MCP only; a plugin with hooks is refused or partially imported with a clear message; tests pass.

### C88 · claude-skills-and-plugins/marketplaces · Marketplaces
- **Status:** todo
- **Depends on:** C87
- **Scope:** Add a marketplace by git URL (owner action), list plugins, install with pinned commit, update shows a diff and needs re-approval; community tier off by default.
- **Done when:** fixture marketplace repo: list, install, update-with-diff and rollback tests pass.

## Codex

Running Codex as a brain belongs to plan 22 (Q43 in plans/QUEUE.md); these tasks cover interop and Codex as a tool executor.

### C89 · codex/codex-as-connector · Codex as a tool executor: research and design
- **Status:** todo
- **Depends on:** Q15, Q43
- **Scope:** README "How we implement it", research slice: compare `codex exec` / app-server / MCP-server modes (*verify* current docs), sandbox and approval mapping to the policy engine, terms per the Q15 record; build a mocked executor wrapper behind a disabled-by-default capability.
- **Done when:** the design is in the README and a mocked Codex run is policy-gated in tests.

### C90 · codex/codex-as-connector · Live check: Codex executor
- **Status:** needs-you
- **Needs you:** install Codex, sign in the way the PR recommends (API key unless the terms record allows ChatGPT sign-in), run the PR's test task, then set this to `done`.
- **Depends on:** C89
- **Scope:** Real-account check.
- **Done when:** a real Codex run is approved and recorded.

### C91 · codex/mcp · Read MCP servers from Codex config.toml
- **Status:** todo
- **Depends on:** C86
- **Scope:** Import MCP server entries from `~/.codex/config.toml` into the MCP tool-provider registry (owner picks which); bearer tokens referenced by env var names only, never copied into JARVIS settings.
- **Done when:** fixture config imports selected servers; secrets never copied; tests pass.

### C92 · codex/skills · Codex skills interop
- **Status:** todo
- **Depends on:** C84
- **Scope:** Discover `.agents/skills` SKILL.md folders as an extra skills source on the same loader and vetting rules.
- **Done when:** fixture `.agents/skills` folders load through the same approval flow; tests pass.

### C93 · codex/agents-md · AGENTS.md instructions
- **Status:** todo
- **Depends on:** C84
- **Scope:** Decide whether and how JARVIS reads AGENTS.md (treat as owner-scoped instructions only from approved folders); implement read-only with injection fixtures.
- **Done when:** decision recorded in the README; fixture tests pass.

### C94 · codex/plugins · Codex plugins
- **Status:** todo
- **Depends on:** C87, C91, C92
- **Scope:** Verify the Codex plugin manifest against current docs, then map its skills and MCP configs through the same importer and trust tiers as Claude plugins.
- **Done when:** fixture Codex plugin imports skills/MCP only; tests pass.

## Discovery

### C99 · discovery · Discover new connectors
- **Status:** todo
- **Depends on:** none
- **Scope:** Run only when no other task above is `todo`. Research new connector sources (official vendor MCP servers, the MCP registry, Claude connector directory, Home Assistant, aggregators, finance, health, travel, media, what other assistants added). Write up to 5 READMEs from TEMPLATE.md and append them as `needs-you` tasks. This task stays `todo`.
- **Done when:** never; it repeats while the rest of the queue is idle.
