# Loading skills and plugins through the Claude Agent SDK

**Kind:** integration design · **Platform:** Any · **Priority:** P1 · **Status:** the SDK-level details are *unverified*; this README lists what to confirm before building.

## Context (verified in this repo)
`bridge/server.mjs` calls the Claude Agent SDK `query()` (imported from `@anthropic-ai/claude-agent-sdk`) with: a `systemPrompt`, `mcpServers` (JARVIS's own tools plus the user's configured servers), `disallowedTools` when writes are off, and a `canUseTool` callback that routes to `decideTool`. The Claude binary is bundled with the installer (`bridge/claude-cli.mjs`).

## What to confirm in the SDK documentation (week 0)
1. Which **setting sources** the SDK loads (user, project, local) and whether that picks up `~/.claude/skills`, project skills and installed plugins automatically.
2. Whether `query()` accepts an explicit **plugins** option (local path) and a **skills** allow-list, and how skill invocation is exposed to the permission callback.
3. Whether loading skills/plugins also loads **hooks**, and how to disable hooks, commands and agents we do not want.
4. How plugin-provided MCP servers appear in `mcpServers` and whether they pass through `canUseTool`.
5. Behaviour on Windows, and whether `settingSources: []` isolates JARVIS from the developer's own Claude Code configuration (important: a user's personal skills/plugins must not silently change JARVIS's behaviour or leak into it).

## Design options
| Option | How | Pros | Cons |
|---|---|---|---|
| **A. SDK-native** | Pass plugin/skill paths through SDK options; let Claude's runtime load them | Least code; matches Claude's behaviour | Less control over vetting; hooks/commands may come along; Claude-only |
| **B. JARVIS-native loader** | JARVIS parses `SKILL.md` and plugin manifests itself, injects a catalog into the system prompt, registers MCP servers itself | Works for every brain (Codex, API providers); full policy control; same vetting for all | We re-implement progressive loading and file access |
| **C. Hybrid** | JARVIS-native catalog and vetting, but for the Claude brain hand approved skill folders to the SDK | Best of both | More moving parts |

**Recommendation:** B first (brain-agnostic, matches plan 21), then C for Claude if the SDK path gives better skill-following.

## Implementation outline (option B)
1. `bridge/skills/registry.mjs`: scan directories, parse frontmatter, validate, build the catalog.
2. Prompt assembly (plan 06): include catalog entries within a token budget; add a `read_skill(name)` tool so the brain fetches the body when needed.
3. `bridge/skills/files.mjs`: read-only access to a skill's `references/` and `assets/`, path-contained.
4. `bridge/skills/run-script.mjs`: sandboxed script execution, approval for R2+ scripts.
5. MCP servers from plugins registered through the shared client layer ([mcp-in-plugins](../mcp-in-plugins/README.md)).
6. Isolation: pass an empty `settingSources` (or equivalent) to the SDK so only JARVIS-approved components load.

## Acceptance tests
A personal Claude Code skill on the machine is **not** visible to JARVIS unless imported; an approved skill is selected for a matching request; disabling a skill removes it from the catalog on the next turn; skills work identically on a non-Claude brain.

## Related
[Part overview](../README.md) · [plan 21](../../../21-multi-brain-framework.md) · [plan 19](../../../19-skills-ecosystem.md) · [plan 06](../../../06-brain-routing.md)
