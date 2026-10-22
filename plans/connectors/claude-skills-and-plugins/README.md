# Claude skills and plugins as connectors

**What they are**
- **Agent Skills:** a folder with a `SKILL.md` (YAML frontmatter `name` + `description`, then Markdown instructions) plus optional `scripts/`, `references/`, `assets/`. Anthropic published the format as an open standard on 2025-12-18 (agentskills.io); other tools (Codex, Cursor, OpenJarvis, many more) read the same format, so a skill written once can be reused across brains. Loading is progressive: only name and description load at startup, the body loads when the skill triggers, reference files load on demand.
- **Claude Code plugins:** an installable bundle (`.claude-plugin/plugin.json` plus components at the plugin root) that can contain **skills, slash commands, agents (subagents), hooks, MCP servers (`.mcp.json`), LSP servers, output styles, monitors, workflows and executables (`bin/`)**. Plugins are shared through **marketplaces** and are namespaced (`plugin-name:component`).

**Why they matter for JARVIS:** they are the lowest-effort way to give JARVIS new abilities (procedures, tools, connectors) from a large shared ecosystem, but they are also **code and instructions from strangers**. Every one needs vetting (see [connector index](../README.md#vetting-rules-before-any-connector-ships-apply-to-mcp-servers-n8n-workflows-skills-plugins)).

## Parts
| # | Part | README |
|---|---|---|
| 1 | Skills (`SKILL.md`) | [skills/](skills/README.md) |
| 2 | Plugins (`plugin.json`, components, `userConfig`) | [plugins/](plugins/README.md) |
| 3 | Marketplaces (official, community, private) | [marketplaces/](marketplaces/README.md) |
| 4 | MCP servers bundled in plugins | [mcp-in-plugins/](mcp-in-plugins/README.md) |
| 5 | Loading skills/plugins through the Claude Agent SDK in the JARVIS bridge | [agent-sdk-loading/](agent-sdk-loading/README.md) |

## How this relates to what JARVIS already does
- The JARVIS bridge runs Claude through the **Claude Agent SDK** (`query()` in `bridge/server.mjs`) and already reuses the user's MCP servers from their Claude configuration. Skills and plugins extend that path rather than replace it.
- JARVIS's own skills/workflows plan is [plan 19](../../19-skills-ecosystem.md). The `SKILL.md` format is the proposed on-disk format for JARVIS skills, so they interoperate with Claude, Codex and OpenJarvis.
- OpenJarvis can already import from Hermes (~150) and OpenClaw (~13,700) catalogues; see [openjarvis/](../openjarvis/README.md).

## Safety stance
1. **Skills are instructions that steer an agent with tools.** A malicious skill can try to exfiltrate data or run commands. Review before enabling; disable by default; show the full text.
2. **Plugins can run code** (hooks, MCP servers, executables, monitors). Read hooks, MCP config and executables before install; the UI details pane shows that a hook exists, not what it runs.
3. **Pin versions;** snapshot component lists; re-approve on update (rug-pull defence).
4. **Tools from a plugin still go through JARVIS's policy engine** (plan 15); a plugin cannot widen permissions.
5. **Trust tiers:** (a) first-party, (b) signed and reviewed, (c) community/unreviewed (off by default, read-only tools only, no hooks/executables).
6. **Namespace and name rules:** plugin names that imitate vendor names (`claude-…`, `anthropic-…`) are rejected by Claude's own validator; keep the same rule for JARVIS marketplaces (plan 36 branding).

## Implementation outline
1. A **skills registry** reading `SKILL.md` folders from `~/.jarvis/skills`, project folders, and enabled plugins; catalog of `name + description` injected into the brain's prompt (progressive loading).
2. A **plugin importer** that reads `.claude-plugin/plugin.json`, validates it (run `claude plugin validate` when available), shows components and requested permissions, and maps: skills → JARVIS skills, MCP servers → connector registry (tool-provider), hooks → *not supported by default*, commands/agents → optional.
3. **Settings cards:** installed skills/plugins, source, version, trust tier, enable/disable, "what can this do" view, update-with-diff.
4. **Tests:** malicious-skill fixtures (exfiltration, overbroad hooks), version-bump rug pull, name spoofing, large catalogs.

## Open questions
- Which components do we support in v1 (recommend: skills + MCP servers only; defer hooks/agents/commands).
- Whether to support the Claude Code plugin format directly or convert to a JARVIS-native bundle.
- Licence and attribution rules when redistributing community skills.

## Related
[Connector index](../README.md) · [Codex](../codex/README.md) · [n8n](../n8n/README.md) · [plans 19](../../19-skills-ecosystem.md), [08](../../08-data-access-and-safety.md), [15](../../15-policy-trust-and-privacy.md)
