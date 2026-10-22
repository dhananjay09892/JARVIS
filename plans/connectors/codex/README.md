# Codex (OpenAI) as a connector source

**What it is:** OpenAI's coding/agent runtime (CLI, desktop app, IDE extension, cloud). For connectors it matters in four ways: it **consumes MCP servers** from `config.toml`, it uses **Agent Skills** (`SKILL.md`) from `.agents/skills`, it has a **plugin** system that bundles skills, app connectors and MCP configs, and it reads **`AGENTS.md`** instructions. It can also be used as a **brain** (plan 22) or as a **tool executor** behind JARVIS.

Documentation read 2026-10-21 (OpenAI docs now redirect to learn.chatgpt.com): MCP configuration and Skills pages. Plugin manifest and marketplace details come from third-party write-ups and are marked *verify*.

## Parts
| # | Part | README |
|---|---|---|
| 1 | MCP servers in `config.toml` | [mcp/](mcp/README.md) |
| 2 | Skills (`SKILL.md`, `.agents/skills`) | [skills/](skills/README.md) |
| 3 | Plugins and marketplaces | [plugins/](plugins/README.md) |
| 4 | `AGENTS.md` instructions | [agents-md/](agents-md/README.md) |
| 5 | Codex as a connector (tool executor / brain) | [codex-as-connector/](codex-as-connector/README.md) |

## What this gives JARVIS
1. **Interop in both directions:** MCP servers and skills written for Codex work in JARVIS and vice versa, so one library serves every brain (plan 21).
2. **A second brain / executor:** run Codex headless for coding or long tasks (plan 22), with JARVIS's policy engine in front.
3. **Shared vetting:** the same rules as Claude plugins apply (see the [connector index](../README.md#vetting-rules-before-any-connector-ships-apply-to-mcp-servers-n8n-workflows-skills-plugins)).

## Terms and auth caveat
OpenAI documents "Sign in with ChatGPT" (subscription) and API key sign-in for Codex, and recommends API keys for automation. Whether a third-party app may drive Codex with a user's ChatGPT login is **unconfirmed** (see [plan 22](../../22-brain-openai-codex.md)). Connector interop (MCP, skills) does not depend on that question; running Codex as a brain does.

## Related
[Connector index](../README.md) · [Claude skills and plugins](../claude-skills-and-plugins/README.md) · [n8n](../n8n/README.md) · [plans 21](../../21-multi-brain-framework.md), [22](../../22-brain-openai-codex.md), [19](../../19-skills-ecosystem.md)
