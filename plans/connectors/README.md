# JARVIS connectors: index and framework

Connectors are how JARVIS reaches the world: your mail, calendar, files, chats, home, health, tools and other agents. This folder holds **one README per connector source**, each with (1) what it gives JARVIS, (2) **how a user connects it**, and (3) **how we implement it**.

Written 2026-10-21 against `release/0.1.5`. Draft status: nothing here is built. Facts from vendor docs are marked; items marked *verify* need re-checking before work starts. Public/private status of this folder: **not yet labelled by the owner**; it contains no secrets or private-infrastructure details, and stays uncommitted until labelled.

## Sources researched so far

| # | Source | What it is | Count / size | Folder |
|---|---|---|---|---|
| 1 | **OpenJarvis** (open-jarvis/OpenJarvis, Apache-2.0) | Open-source local-first personal AI with its own connectors and channels | **27 data connectors + 30 messaging channels + 20 built-in skills**, importers for ~150 Hermes and ~13,700 OpenClaw skills | [openjarvis/](openjarvis/README.md) |
| 2 | **n8n** | Workflow-automation platform; exposes workflows to AI clients over MCP | **400+ built-in nodes**, ~1,000+ counting community packages (third-party figures); 4 integration modes below | [n8n/](n8n/README.md) |
| 3 | **Claude skills and plugins** | Agent Skills (SKILL.md) and Claude Code plugins that bundle skills, agents, hooks and MCP servers | Open standard; official and community marketplaces (counts change fast; see folder) | [claude-skills-and-plugins/](claude-skills-and-plugins/README.md) |
| 4 | **Codex** (OpenAI) | MCP servers in `config.toml`, skills in `.agents/skills`, plugins, AGENTS.md | Skills and MCP documented; plugin manifest partly unverified | [codex/](codex/README.md) |

Still to research and add (later): Google/Microsoft official MCP servers, Home Assistant, Zapier/Pipedream/Composio aggregators, finance, health, travel, media. See the earlier survey in plan discussions: the MCP registry lists ~43,000 servers and Claude's directory ~993 connectors (third-party counts; treat as ranges).

### Everything under OpenJarvis
- Data connectors (27): Gmail, Gmail IMAP, Google Drive, Calendar, Contacts, Tasks, Outlook, IMAP, Dropbox, Notion, Obsidian, Granola, Slack, GitHub notifications, Weather, Hacker News, RSS, Spotify, Strava, Oura, Apple Health/Calendar/Contacts/Notes/Music, iMessage, WhatsApp export → [list](openjarvis/README.md#data-connectors-27)
- Channels (30): Telegram, Slack, Discord, Email, Twilio SMS, WhatsApp (Cloud API and Baileys), Signal, SendBlue, BlueBubbles, Google Chat, Teams, Matrix, Mattermost, Rocket.Chat, Zulip, XMPP, IRC, LINE, Viber, Messenger, Feishu, Reddit, Mastodon, X, Twitch, Nostr, Gmail, webhook, webchat → [list](openjarvis/README.md#messaging-channels-30)

## Priority backlog (what to build first)
**P1 (Phase 2 of the roadmap):** Google (Gmail, Calendar, Drive via one OAuth module), Notion, Obsidian, Weather, Telegram, Slack, Twilio SMS, generic webhook, n8n instance MCP, Claude/Agent Skills loader.
**P2:** Outlook/IMAP, Google Tasks/Contacts, Discord, Email channel, WhatsApp Cloud API, Signal, Oura/Apple Health, GitHub notifications, RSS, Codex MCP/skills interop.
**Later:** the rest of the OpenJarvis list (mostly regional chats, macOS-only sources, fitness/music).
**Not planned:** unofficial WhatsApp (Baileys), Reddit/X/Mastodon/Twitch/Nostr/IRC/XMPP/webchat as assistant surfaces.

## The JARVIS connector interface
One interface for all sources, so adding a connector is mostly configuration and one adapter file. Types follow [plan 38](../38-shared-data-contracts.md).

```ts
interface Connector {
  id: string; name: string
  kind: 'data' | 'channel' | 'tool-provider'     // data = sync/search; channel = two-way chat; tool-provider = MCP/n8n/skills
  auth: 'oauth' | 'token' | 'local' | 'filesystem' | 'none'
  platforms: ('win'|'mac'|'linux')[]
  risk: 'R0'|'R1'|'R2'|'R3'                      // see tiers below
  capabilities: { read: boolean; write: boolean; subscribe: boolean }
  connect(opts): Promise<ConnectResult>          // runs the user's setup flow
  disconnect(opts?: { eraseData: boolean }): Promise<void>
  status(): { state: 'ok'|'attention'|'error'|'disconnected'; detail: string; lastSync?: number }
  sync?(o: { since?: Date; cursor?: string }): AsyncIterable<Document>
  tools?(): ToolManifest[]                       // exposed to brains, policy-gated
  receive?(): AsyncIterable<ChannelMessage>      // channels
  send?(msg: OutboundMessage): Promise<void>     // channels, approval-gated
}
```
- **Registry:** connectors register at startup inside try/catch (optional dependencies must not break the app).
- **Policy:** every tool a connector exposes passes the policy engine (plan 15); writes are separate capabilities.
- **Storage:** credentials in the OS keychain (plan 39); synced data in the local knowledge store (plans 07, 33), erasable per connector.
- **Settings:** each connector gets a card (Settings → Connectors / Channels): status, scopes, last sync, test, disconnect, erase.

## Risk tiers for connectors
| Tier | Meaning | Examples | Default |
|---|---|---|---|
| **R0** | Public or purely local, no personal data leaves | RSS, Hacker News, Obsidian, weather | On when enabled |
| **R1** | Reads private data from an account | Gmail, Calendar, Drive, Notion, Slack | Read-only, owner only |
| **R2** | Writes or sensitive categories (health, messages of others) | Send mail, create events, Oura, iMessage | Approval per action; health in the vault |
| **R3** | Irreversible / external / money / physical | Send to third parties, payments, locks | Approval + PIN/biometrics (plans 15, 40) |

## How a user connects a connector (the three patterns)
1. **Guided sign-in (OAuth):** Settings → Connectors → pick → "Connect" → browser consent screen → done. For providers that need your own Cloud project (Google today), the card shows a short numbered guide with deep links and a "test" button.
2. **Paste a token or key:** create a token at the provider (Notion integration secret, Telegram bot token, weather API key), paste it once; JARVIS validates it with a test call and stores it in the keychain.
3. **Grant local access:** for macOS databases or folders (Full Disk Access, Obsidian vault, WhatsApp exports) JARVIS explains exactly why and what it will read, then opens the OS settings.

Every flow ends with: a **test question** ("What's on my calendar tomorrow?"), a status dot, and a visible "what this connector can see" list.

## Vetting rules before any connector ships (apply to MCP servers, n8n workflows, skills, plugins)
Prompted by 2026 MCP security research (tool poisoning, "rug pulls" after approval, exposed unauthenticated servers; academic scans found a few percent of servers with vulnerabilities; see plans 08 and 15).
1. **Provenance:** official vendor server > open-source with active maintainers > anonymous. Record the source URL and licence.
2. **Pin versions** and **snapshot the tool list** at approval; alert and re-approve on any change.
3. **Least privilege:** smallest OAuth scopes, read-only first, per-capability grants.
4. **Treat all returned content as untrusted** (never instructions).
5. **No ambient secrets:** the connector gets only its own credentials.
6. **Sandbox** local code (no network/file access beyond its declared needs).
7. **Egress allow-list** per connector; outbound calls to unnamed hosts need approval after private reads.
8. **Test pack:** auth failure, revoked token, injection fixture, rate limit, offline.
9. **Kill switch:** disable one connector or all instantly ("freeze").
10. **Disclosure:** the Privacy Centre lists which providers see which data (plans 15, 35).

## Folder map
```
connectors/
  README.md                         this index and framework
  TEMPLATE.md                       copy for new connector READMEs
  openjarvis/                       overview + counts + reuse options
    data-connectors/<id>/README.md  27 data connectors
    channels/<id>/README.md         30 messaging channels
  n8n/                              overview + 4 integration modes
    instance-mcp/  mcp-server-trigger/  mcp-client-tool/  webhooks-and-rest/
  claude-skills-and-plugins/        overview + 5 parts
    skills/  plugins/  marketplaces/  mcp-in-plugins/  agent-sdk-loading/
  codex/                            overview + 5 parts
    mcp/  skills/  plugins/  agents-md/  codex-as-connector/
```

## Suggested build order
1. Connector framework and registry, Settings cards, keychain (plans 38, 39).
2. Generic webhook channel and n8n instance MCP (unlocks many services quickly).
3. Telegram channel (plan 20) and Google OAuth module (Gmail, Calendar, Drive).
4. Notion, Obsidian, Weather.
5. Skills loader (Agent Skills format) with vetting (plan 19).
6. Codex and Claude-plugin interop.
7. Long tail by demand.

## Build log
- **2026-10-23 · C01 (connector framework).** Built `bridge/connectors/`: `interface.mjs` (the interface above as runtime checks, plus the synced `Document` shape and sensitivity classes), `registry.mjs` (try/catch registration, tool-list snapshot at registration, scoped credentials per adapter, untrusted wrapping of every document and tool result, `policyRule` for the policy engine), `grants.mjs` (read / write / subscribe grants, writes and subscriptions off by default; per-connector and global kill switch), `credentials.mjs` (one store interface: OS keychain once Q20 lands; until then nothing is stored unless a developer sets `JARVIS_DEV_CREDENTIALS=1`, which enables a DEV-ONLY 0600 file outside the repo), `http.mjs` (egress allow-list per adapter, no redirects, Retry-After backoff, readable error codes) and `testpack.mjs` (auth failure, revoked token, injection fixture, rate limit, offline, erase, writes denied, kill switches). `fake.mjs` passes the whole pack. The policy engine routes `mcp__jarvis_connectors__<id>__<capability>__<tool>` to the registry and fails closed; a connector write needs the write grant, general writes and an approval per call. Left: no connector is registered yet, there is no `jarvis_connectors` MCP server exposing tools to the brain (the first real data connector adds it), grants are not persisted (C03), and the keychain backend waits on Q20.

## Related plans
[08](../08-data-access-and-safety.md) · [15](../15-policy-trust-and-privacy.md) · [19](../19-skills-ecosystem.md) · [20](../20-messaging-channels.md) · [21](../21-multi-brain-framework.md) · [38](../38-shared-data-contracts.md) · [39](../39-settings-and-control-center.md) · [41](../41-backend-relay-service.md)
