# Codex · Plugins and marketplaces

**Kind:** tool-provider bundle · **Auth:** per plugin · **Platform:** Any · **Risk tier:** R2 · **Priority:** Later
**Status of facts:** OpenAI's skills page says plugins are the way to distribute reusable skills and connectors through a directory shared by ChatGPT and Codex, and that a plugin can bundle two or more skills and ship a skill with a connector. The **manifest layout and marketplace commands below come from third-party blog posts** (`.codex-plugin/plugin.json`, optional `.mcp.json`, marketplace entries pointing to a Git repo or local directory containing `.agents/plugins/marketplace.json`; launch reported 2026-03-27). **Verify against OpenAI's plugin build docs (developers.openai.com/plugins/build/plugins) before implementing.**

## What it gives JARVIS
A distribution unit equivalent to a Claude plugin: skills + MCP server config + app connectors, installable from a marketplace.

## How a user connects it
1. Add a marketplace source in Codex (`marketplaces.<name>.source` in `config.toml`, or the Codex marketplace add command; exact command *verify*).
2. Install a plugin from it in Codex.
3. In JARVIS: **Settings → Skills & Plugins → Import → From Codex** and pick the installed plugin, or add the same marketplace repo as a JARVIS source ([marketplaces](../../claude-skills-and-plugins/marketplaces/README.md)).
4. Review components; enable skills and MCP servers selectively.

## How we implement it in JARVIS
1. A second manifest reader beside the Claude one: map `.codex-plugin/plugin.json` components to the same internal model (skills, MCP servers, connectors).
2. App connectors (ChatGPT-side) are **not** executable by JARVIS; list them as "not supported" with an explanation.
3. Same vetting, pinning, diff and trust tiers as Claude plugins.
4. Keep one internal "bundle" representation so Claude, Codex and JARVIS-native bundles all go through one review screen.

## Acceptance tests
Sample Codex plugin imports its skills and MCP config; unsupported components are listed, not silently dropped; manifest changes upstream fail validation with a clear message.

## Risks
Format still evolving; marketplace details unverified; ChatGPT-only connectors cannot be reused.

## Related
[Codex overview](../README.md) · [Claude plugins](../../claude-skills-and-plugins/plugins/README.md) · [plan 19](../../../19-skills-ecosystem.md)
