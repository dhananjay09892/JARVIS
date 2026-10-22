# Claude Code plugins

**Kind:** tool-provider bundle · **Auth:** per plugin (`userConfig` prompts) · **Platform:** Any · **Risk tier:** R2 (plugins can include code) · **Priority:** P2
**Reference:** Claude Code docs, "Plugin manifest reference" (code.claude.com/docs/en/plugins-reference), read 2026-10-21.

## What it gives JARVIS
A single installable unit that can add skills, slash commands, subagents, hooks, MCP servers, LSP servers, output styles, monitors, workflows and executables. For JARVIS the valuable parts are **skills** and **MCP servers**; the rest are developer-oriented.

## Structure (from the docs)
```
my-plugin/
├── .claude-plugin/plugin.json    manifest (optional; only `name` required)
├── skills/<name>/SKILL.md        recommended component type
├── commands/*.md                 older flat command format
├── agents/*.md                   subagents
├── hooks/hooks.json              lifecycle hooks
├── .mcp.json                     MCP server definitions
├── .lsp.json  monitors/  output-styles/  themes/  workflows/
├── bin/                          executables put on PATH while enabled
└── settings.json                 default settings (agent, subagentStatusLine)
```
Manifest highlights: `name` (kebab-case, namespaces every component as `plugin:component`), `version`, `description`, `author`, `license`, `dependencies`, `skills`/`commands`/`agents`/`hooks`/`mcpServers` path or inline forms, and **`userConfig`**, which prompts the user for values (types string/number/boolean/directory/file; `sensitive: true` stores in secure storage; referenced as `${user_config.KEY}`). Paths must start with `./`, stay inside the plugin root and exist. `claude plugin validate ./my-plugin` checks a manifest. Names that imitate Anthropic (`claude-…`, `anthropic-…`, `official-claude-…`) are rejected by the validator.

## How a user connects it
1. Add a marketplace: `/plugin marketplace add <owner/repo>` (Claude Code; commands per the marketplace docs, *verify*).
2. Install: `/plugin install <name>@<marketplace>`.
3. Review before enabling: hooks, MCP config, executables.
4. Fill the prompted `userConfig` (tokens are stored securely).
5. In **JARVIS**: Settings → Skills & Plugins → Import → choose the installed plugin folder or its git URL; JARVIS shows its components and requested permissions.

## How we implement it in JARVIS
1. **Importer** reads `.claude-plugin/plugin.json` (or the standard layout) and lists components.
2. **Mapping:**
   | Component | JARVIS v1 behaviour |
   |---|---|
   | skills | imported as JARVIS skills (see [skills](../skills/README.md)) |
   | `.mcp.json` / `mcpServers` | registered as tool-provider connectors, disabled until approved (see [mcp-in-plugins](../mcp-in-plugins/README.md)) |
   | commands, agents | optional; commands become voice shortcuts later |
   | hooks, monitors, bin/, workflows | **not executed** in v1 (arbitrary code); shown as "requires review" |
   | userConfig | rendered as a settings form; sensitive values to the keychain |
3. **Variables:** support `${CLAUDE_PLUGIN_ROOT}` style substitution only for paths inside the plugin.
4. **Policy:** all imported tools run under the policy engine with a plugin-specific actor id and an allow-list; plugin cannot raise its own tier.
5. **Dependencies:** resolve `dependencies`; refuse circular or unknown ones.
6. **Updates:** version pinning, diff, re-approval.

## Acceptance tests
Import a sample plugin with a skill + MCP server; hooks are listed but not run; userConfig secret stored in keychain; manifest with path escape is rejected; version bump triggers diff.

## Risks
Plugins run code with the user's privileges in Claude Code; JARVIS must not inherit that trust. Marketplace sprawl. Manifest format may change (*verify per release*).

## Related
[Part overview](../README.md) · [marketplaces](../marketplaces/README.md) · [plans 19](../../../19-skills-ecosystem.md), [15](../../../15-policy-trust-and-privacy.md)
