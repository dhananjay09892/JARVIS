# Slack (data source)

**Kind:** data connector (read-first) · **Auth:** oauth (bot token) · **Platform:** Any · **Risk tier:** R1 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/slack_connector.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/slack_connector.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Search and read channel messages and DMs the bot can see.

## How a user connects it
1. Create a Slack app in your own workspace (api.slack.com/apps → Create New App → From scratch, name it "JARVIS").
2. OAuth & Permissions → Bot Token Scopes: add only `channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read`.
3. Install it to your workspace and copy the Bot User OAuth Token (xoxb-…).
4. Invite the bot to each channel you want indexed (/invite @JARVIS).
5. In JARVIS: Settings → Connectors → Slack → paste the bot token.

Credentials stay on the user's machine. In JARVIS they go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/slack.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** OAuth with PKCE/loopback redirect and refresh-token handling; scopes requested per capability, read-only first.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R1); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- A Slack-hosted MCP server also exists; evaluate it first.
- One app can serve both reading and the Slack channel (see channels/slack); keep scopes minimal and separate by capability.
- Reinstall the app after any scope change.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect slack`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-10-27 · C14.** `bridge/connectors/slack.mjs`, registered in the bridge. Paste pattern: a Bot User OAuth Token (`xoxb-…`; user `xoxp-` and app-level `xapp-` tokens are refused) is checked with `auth.test` and stored only if that works; the card shows the workspace name. Read-only by construction: only `auth.test`, `users.conversations`, `conversations.history`, `conversations.replies` and `users.info`, all GET on `slack.com` (its whole egress allow-list), token in the `Authorization` header. Scopes: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read` — no `chat:write`, no DMs (`im:*`) or group DMs (`mpim:*`). Only channels the bot was invited to (users.conversations lists the bot's own memberships), archived ones skipped. Sync: one document per message (`<channel>-<ts>`, title `#channel · author`, archive link, sensitivity `messages`); per-channel ts watermark; a burst bigger than one sync's page budget keeps Slack's cursor and the newest ts seen so the next sync carries on without a gap; first sync reads 30 days back (or from `since`), newest 500 per channel; 10 channels per sync, in turns. Threads: parents seen in the history and up to 200 recently active threads (parent younger than 14 days) are polled with `conversations.replies` for new replies, 20 per sync. Markup: `<@U…>` → `@name` (users.info, cached, ≤ 50 lookups per sync), `<#C…|name>`, `<url|label>`, `<!here>`, dates and user groups made readable, `&lt;`/`&gt;`/`&amp;` unescaped (the untrusted wrapper then neutralises any markup); files named, never downloaded; attachment text included; join/leave/topic and other channel events left out. Errors: Slack's HTTP 200 `{ ok: false }` codes are mapped (`token_revoked`/`account_inactive`/`token_expired` → reconnect; `invalid_auth`/`missing_scope` → check the token; `ratelimited` → rate limit); `not_in_channel`/`channel_not_found` skip that channel only. Rate limits: paced to one call every 1.2 s (Tier 3, 50+/min); 429 + Retry-After honoured by http.mjs. Two read tools: `list_channels` and `read_recent_messages` (one channel, ≤ 20 messages, wrapped as untrusted). Facts checked 2026-10-27 on docs.slack.dev: conversations.history args and Tier 3; the 2025-05-29 change (non-Marketplace *commercially distributed* apps drop to 1 request/min and 15 objects for history/replies) exempts internal customer-built apps, which is what this setup creates; users.conversations scopes, types and error codes; 429 with Retry-After in seconds. Written fresh against Slack's docs; not ported from OpenJarvis. Alternatives: Slack's hosted MCP server answers live through a Slack OAuth sign-in and keeps no local copy; this connector is the local-first route with a bot token and one egress host. Left: live check with a real workspace (C15); edits to older messages and deletions are not seen by an incremental read (retention ages those copies out); DMs to the bot are not read (would need `im:history`, deliberately left out); search across Slack (`search.messages`) needs a user token and is not offered.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
