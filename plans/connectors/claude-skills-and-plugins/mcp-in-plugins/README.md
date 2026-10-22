# MCP servers bundled in plugins

**Kind:** tool-provider · **Auth:** per server (OAuth / token via `userConfig`) · **Platform:** Any · **Risk tier:** R1–R3 by tool · **Priority:** P1 (as plain MCP) / P2 (via plugins)
**Reference:** Claude Code plugin docs (`.mcp.json`, `mcpServers`).

## What it gives JARVIS
Access to any MCP server a plugin declares: stdio servers (run a local command) or remote servers (`http`, `sse`, `ws` URLs), including `.mcpb`/`.dxt` bundles. Variables such as `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` resolve in `command`, `args`, `env`, `url` and `headers`.

## How a user connects it
1. Install or import the plugin (see [plugins](../plugins/README.md)).
2. In JARVIS: **Settings → Connectors → Tool servers** shows each MCP server from the plugin, **disabled**, with its command or URL, its declared tools and the secrets it wants.
3. Fill required values (for example an API token; stored in the keychain).
4. Tick the tools to allow and set the risk tier; **Enable**.
5. Test with a read-only tool.

## How we implement it in JARVIS
1. **Single MCP client layer** shared by all tool-providers: stdio and streamable-HTTP transports, timeouts, size caps, reconnection.
2. **Stdio servers = running third-party code.** Run them in a restricted process: scrubbed environment (only declared secrets), working dir under JARVIS's data folder, no network unless declared, resource limits; on Windows use job objects/low-integrity where practical.
3. **Remote servers:** require HTTPS; refuse `http://` to non-loopback hosts and literal credentials in headers (the Claude validator warns on both); OAuth where the server supports it.
4. **Snapshot-and-diff** of the tool list and descriptions on every connect (rug-pull protection); tool descriptions are shown to the user and treated as untrusted text.
5. **Per-tool policy:** deny by default, owner allow-list, read vs write classification (plan 08's word-based classifier, not prefix guessing).
6. **Name collisions:** namespace tools as `server.tool`.
7. **Health:** startup timeout, crash loops, last error.

## Acceptance tests
Server starts with only declared secrets; undeclared env vars are absent; changed tool list requires re-approval; remote HTTP to a public host is refused; tool with action verbs in its name is not treated as read-only.

## Risks
Arbitrary code execution; secret leakage via environment; confusing tool descriptions that inject instructions; servers exposed to the internet without auth.

## Related
[Part overview](../README.md) · [plugins](../plugins/README.md) · [Codex MCP](../../codex/mcp/README.md) · [plans 08](../../../08-data-access-and-safety.md), [15](../../../15-policy-trust-and-privacy.md)
