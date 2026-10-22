# OpenJarvis as a connector source

**Repo:** [open-jarvis/OpenJarvis](https://github.com/open-jarvis/OpenJarvis) · Apache-2.0 · Python · "Personal AI, On Personal Devices" · ~11.7k stars · last push 2026-10-20 (checked 2026-10-21).
It is a different project from our JARVIS but solves overlapping problems, and its license lets us study, reuse patterns, or run it alongside ours (keep attribution and the NOTICE).

## How many connectors does it have?
Counted from the repository tree and source on 2026-10-21 (`src/openjarvis/...`):

| Group | Count | Where | What it is |
|---|---|---|---|
| **Data connectors** | **27** | `connectors/` | Read-only sync of personal data into a local knowledge store |
| **Messaging channels** | **30** | `channels/` | Two-way chat platforms (30 registered modules; some are variants of the same platform) |
| **Built-in skills** | **20** | `skills/data/*.toml` | Ready-made workflows (calendar-prep, daily-digest, email-draft, meeting-notes, pdf-summarize…) |
| **Skill importers** | **3** | `skills/sources/` | Hermes (~150 skills), OpenClaw (~13,700 community skills), any GitHub repo; follows the agentskills.io standard |
| **Tools** | ~40 | `tools/` | web_search, browser, shell, file read/write, git, http_request, knowledge search, TTS, weather… |
| **MCP** | client + server + loader | `mcp/` | Exposes connectors as MCP tools and consumes MCP servers |
| **Infrastructure in `connectors/`** | 14 files | — | oauth, sync_engine, pipeline, embeddings, hybrid_search, store, chunker, scheduler… (not connectors) |

So: **27 data connectors + 30 channels = 57 integrations**, plus 20 skills and an import path to thousands more.

Source files used for the counts: `connectors/__init__.py` auto-registers the data connectors; `channels/__init__.py` lists the 30 channel modules.

## Data connectors (27)
| Connector | Auth | Platform | Priority for JARVIS |
|---|---|---|---|
| [Gmail (API)](data-connectors/gmail/README.md) | oauth | Any | P1 |
| [Gmail (IMAP + app password)](data-connectors/gmail_imap/README.md) | oauth (app password stored like OAuth) | Any | P1 |
| [Google Drive](data-connectors/gdrive/README.md) | oauth | Any | P1 |
| [Google Calendar](data-connectors/gcalendar/README.md) | oauth | Any | P1 |
| [Google Contacts](data-connectors/gcontacts/README.md) | oauth | Any | P2 |
| [Google Tasks](data-connectors/google_tasks/README.md) | oauth | Any | P2 |
| [Outlook / Microsoft 365 mail (IMAP)](data-connectors/outlook/README.md) | app password | Any | P2 |
| [Generic IMAP mail](data-connectors/imap/README.md) | username + password / app password | Any | P2 |
| [Dropbox](data-connectors/dropbox/README.md) | oauth (access token) | Any | Later |
| [Notion](data-connectors/notion/README.md) | integration token | Any | P1 |
| [Obsidian vault](data-connectors/obsidian/README.md) | filesystem | Any (local) | P1 |
| [Granola meeting notes](data-connectors/granola/README.md) | api key | Any | Later |
| [Slack (data source)](data-connectors/slack/README.md) | oauth (bot token) | Any | P1 |
| [GitHub notifications](data-connectors/github_notifications/README.md) | personal access token | Any | P2 |
| [Weather (OpenWeatherMap)](data-connectors/weather/README.md) | api key | Any | P1 |
| [Hacker News](data-connectors/hackernews/README.md) | none | Any | Later |
| [News / RSS feeds](data-connectors/news_rss/README.md) | none (config list) | Any | P2 |
| [Spotify (recently played)](data-connectors/spotify/README.md) | oauth | Any | Later |
| [Strava](data-connectors/strava/README.md) | oauth (refresh token) | Any | Later |
| [Oura Ring](data-connectors/oura/README.md) | personal access token | Any | P2 |
| [Apple Health](data-connectors/apple_health/README.md) | local | macOS / export file | P2 |
| [Apple Calendar](data-connectors/apple_calendar/README.md) | local | macOS | P2 |
| [Apple Contacts](data-connectors/apple_contacts/README.md) | local | macOS | Later |
| [Apple Notes](data-connectors/apple_notes/README.md) | local | macOS | Later |
| [Apple Music (local)](data-connectors/apple_music/README.md) | local | macOS | Later |
| [iMessage (local database)](data-connectors/imessage/README.md) | local | macOS | Later |
| [WhatsApp chat export](data-connectors/whatsapp/README.md) | filesystem | Any | Later |

## Messaging channels (30)
| Channel | Inbound | Credentials | Priority for JARVIS |
|---|---|---|---|
| [Telegram](channels/telegram/README.md) | long-poll (no public URL) | 1 env vars | P1 |
| [Slack (DM your agent)](channels/slack/README.md) | Socket Mode (no public URL) | 2 env vars | P1 |
| [Discord](channels/discord/README.md) | gateway websocket (outbound) | 1 env vars | P2 |
| [Email (SMTP/IMAP)](channels/email/README.md) | IMAP polling | 2 env vars | P2 |
| [SMS via Twilio](channels/twilio_sms/README.md) | webhook (public URL needed) | 3 env vars | P1 |
| [WhatsApp (Cloud API)](channels/whatsapp/README.md) | webhook (public URL needed) | 1 env vars | P2 |
| [WhatsApp (Baileys, unofficial)](channels/whatsapp_baileys/README.md) | Node subprocess, QR login | — | Not planned |
| [Signal](channels/signal/README.md) | signal-cli REST API (local) | 1 env vars | P2 |
| [iMessage / SMS via SendBlue](channels/sendblue/README.md) | webhook (public URL needed) | 3 env vars | Later |
| [iMessage via BlueBubbles](channels/bluebubbles/README.md) | BlueBubbles server | 2 env vars | Later |
| [Google Chat](channels/google_chat/README.md) | incoming webhook (outbound only) | — | Later |
| [Microsoft Teams](channels/teams/README.md) | Bot Framework webhook | 2 env vars | Later |
| [Matrix](channels/matrix/README.md) | sync loop | 2 env vars | Later |
| [Mattermost](channels/mattermost/README.md) | REST/websocket | 2 env vars | Later |
| [Rocket.Chat](channels/rocketchat/README.md) | REST polling | 3 env vars | Later |
| [Zulip](channels/zulip/README.md) | event queue | 3 env vars | Later |
| [XMPP / Jabber](channels/xmpp/README.md) | XMPP session | 4 env vars | Not planned |
| [IRC](channels/irc/README.md) | IRC socket | 4 env vars | Not planned |
| [LINE](channels/line/README.md) | webhook | — | Later |
| [Viber](channels/viber/README.md) | webhook | 2 env vars | Later |
| [Facebook Messenger](channels/messenger/README.md) | webhook | — | Later |
| [Feishu / Lark](channels/feishu/README.md) | event subscription | 2 env vars | Later |
| [Reddit](channels/reddit/README.md) | API polling | 3 env vars | Not planned |
| [Mastodon](channels/mastodon/README.md) | API | 2 env vars | Not planned |
| [X / Twitter](channels/twitter/README.md) | API | 4 env vars | Not planned |
| [Twitch chat](channels/twitch/README.md) | IRC-over-websocket | 3 env vars | Not planned |
| [Nostr](channels/nostr/README.md) | relay websockets | 2 env vars | Not planned |
| [Gmail (as a channel)](channels/gmail/README.md) | Gmail API (OAuth) | — | Later |
| [Generic webhook (outbound)](channels/webhook/README.md) | none (outbound only) | — | P1 |
| [Web chat (in-memory)](channels/webchat/README.md) | in-memory queue | — | Not planned |

## How the OpenJarvis design works (useful to copy)
- **`BaseConnector`** with `connector_id`, `display_name`, `auth_type` (oauth | local | bridge | filesystem), `is_connected()`, `disconnect()`, `sync(since, cursor)` yielding a universal **`Document`** (doc_id, source, doc_type, content, title, author, participants, timestamp, thread_id, url, attachments, metadata, source_id, channel), `sync_status()`, `auth_url()/handle_callback()` for OAuth and optional `mcp_tools()`.
- **Registry + auto-registration:** modules import inside `try/except ImportError` so optional dependencies don't break startup.
- **Pipeline:** sync → chunk → embed → hybrid search (BM25 + dense) → retrieve with citations.
- **Credentials** in `~/.openjarvis/connectors/*.json`, mode 0600, local only.
- **Channels** share `BaseChannel`/`ChannelMessage`/`ChannelStatus` and register with a `ChannelRegistry` decorator; credentials via env vars or the UI.
- **Skills** follow the agentskills.io format and are exposed to agents as tools via a catalog.

## How JARVIS can use OpenJarvis
| Option | Idea | Pros | Cons |
|---|---|---|---|
| **A. Copy the patterns** | Re-implement the connector/channel interfaces in our Node bridge, using OpenJarvis code as a reference | Fits our stack and policy engine; no Python dependency | We write and maintain each adapter |
| **B. Run it as a sidecar** | Start OpenJarvis alongside; call its API (`/v1/channels`, connector sync) and/or its MCP server from our bridge | Fast access to 27 + 30 integrations | Second runtime (Python, optional Rust), second credential store, different safety model; needs wrapping in our policy engine |
| **C. Import skills only** | Use its importers to pull agentskills.io skills (Hermes, OpenClaw) | Large catalogue, standard format | Skills are untrusted code/instructions: needs vetting (plan 19) |

**Recommendation:** start with **A** for the handful of P1 connectors (Gmail/Calendar/Drive via Google, Notion, Obsidian, Weather, Telegram, Slack, Twilio SMS, webhook). Keep **B** as an experiment for long-tail connectors. Treat **C** under the skills plan with strict vetting.

## Caveats
- Counts are from source on 2026-10-21 and will change; re-run the count before relying on it.
- Setup steps below are taken from OpenJarvis's docs (`docs/user-guide/channels-and-connectors.md`) and source docstrings; anything marked "verify" should be re-checked against the provider's current docs.
- OpenJarvis connectors are **read-only data sync**; it does not by itself make actions safe. Our policy engine (plan 15) must wrap everything.

## Related
[Connector index](../README.md) · [n8n](../n8n/README.md) · [Claude skills and plugins](../claude-skills-and-plugins/README.md) · [Codex](../codex/README.md)
