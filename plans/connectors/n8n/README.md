# n8n as a connector hub

**What it is:** an open-source workflow-automation platform (self-hostable or cloud). In 2026 it can act as an **MCP server** (so AI clients can find and run your workflows) and as an **MCP client** (so n8n agents can call other MCP servers).
**Why it matters for JARVIS:** one n8n connection gives access to its whole node library without writing an adapter per service. That library is **400+ built-in nodes**, and about **1,000+ counting community packages** (third-party estimates; n8n's own page is the authority, and sources disagree on how to count).

## Four ways to connect JARVIS and n8n
| # | Mode | Direction | Best for | README |
|---|---|---|---|---|
| 1 | **Instance-level MCP** | JARVIS → n8n | Let JARVIS discover and run the workflows you mark "available in MCP" | [instance-mcp/](instance-mcp/README.md) |
| 2 | **MCP Server Trigger** (per workflow) | JARVIS → one workflow as its own tool server | A single focused tool with custom auth | [mcp-server-trigger/](mcp-server-trigger/README.md) |
| 3 | **MCP Client Tool** | n8n agent → JARVIS tools | n8n AI agents that call JARVIS's MCP tools (memory, notes, calendar) | [mcp-client-tool/](mcp-client-tool/README.md) |
| 4 | **Webhooks and REST** | JARVIS ⇄ n8n | Simple triggers and callbacks, works on any n8n version; also the generic webhook channel | [webhooks-and-rest/](webhooks-and-rest/README.md) |

## Recommendation
Start with **mode 1** (instance MCP) for "JARVIS, run my invoice workflow" style use and **mode 4** as the fallback. Use mode 2 only when a workflow needs its own endpoint; use mode 3 when n8n should drive JARVIS.

## Requirements and limits (from n8n's documentation, checked 2026-10-21)
- Only an instance **owner or admin** can enable instance-level MCP.
- Workflow building through MCP needs **n8n 2.13.0+**; the per-client setup dialog needs **2.33.0+**; older versions use manual client configs.
- For cloud MCP clients the n8n instance must be **publicly reachable**. For a home n8n, route through the relay (plan 41) or a private network, not an open port.
- MCP access is **per workflow, not per client**: every connected client sees every workflow you enable.
- `execute_workflow` runs the *published* version by default; `search_workflows` returns previews only.
- Behind a reverse proxy or WAF, allow the headers `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`.
- OAuth clients can be reviewed and revoked in **Connected clients**; API-key clients do not appear there, so rotate their tokens to cut access; admins can restrict **Allowed callback URLs** (default allows any).
- Agent management through MCP is **Preview**.

## How the user prepares n8n (once)
1. Run n8n (cloud or self-hosted) on a recent version.
2. Build workflows for the jobs you care about (send invoice, summarise a sheet, post to Slack).
3. Enable MCP and mark only the workflows you want JARVIS to run; leave "Auto-expose new workflows" **off**.
4. Follow the mode-specific README to connect.

## Safety design for JARVIS
- **Workflows are tools with side effects.** Each one is registered with a risk tier (default R2: needs approval) and a plain-language description JARVIS can read back before running.
- **Name and parameter allow-list:** JARVIS only sees workflows the owner approved in JARVIS Settings, even if n8n exposes more.
- **Snapshot and diff:** store the tool list at approval; re-approve if a workflow's description, inputs or nodes change (rug-pull protection).
- **Untrusted results:** data returned from workflows is treated as untrusted content (plan 08).
- **Spend and rate limits** per workflow; n8n executions can cost money or send real emails.
- **Credentials** for n8n (OAuth grant or API token) live in the OS keychain.
- **Kill switch:** disabling the connector in JARVIS stops calls; disabling MCP in n8n disconnects every client.

## Implementation outline
1. `bridge/connectors/n8n.mjs` as a *tool-provider* connector wrapping an MCP client (streamable HTTP) to `<n8n-host>/mcp-server/http`.
2. Discovery: list workflows → show them in Settings → owner ticks the ones JARVIS may use and assigns risk tiers.
3. Tool manifests are generated from the workflow input schemas; calls go through the policy engine.
4. Health: version check (≥ 2.13), reachability, token expiry, count of exposed workflows.
5. Tests: fake MCP server fixture, changed-tool-list detection, injection in results, offline n8n.

## Open questions
- Home n8n reachability: relay (plan 41) vs. VPN.
- Whether to ship starter n8n workflows (briefing, expense capture) as importable templates under the skills plan (19).
- Licence terms for embedding or redistributing n8n (it is "fair-code"; confirm before bundling anything).

## Related
[Connector index](../README.md) · [Claude plugins](../claude-skills-and-plugins/README.md) · [Codex](../codex/README.md) · [plans 08](../../08-data-access-and-safety.md), [15](../../15-policy-trust-and-privacy.md), [19](../../19-skills-ecosystem.md), [41](../../41-backend-relay-service.md)
