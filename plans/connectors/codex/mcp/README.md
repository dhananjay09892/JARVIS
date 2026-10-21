# Codex · MCP servers (`config.toml`)

**Kind:** tool-provider interop · **Auth:** OAuth, bearer token env var, headers · **Platform:** Any · **Risk tier:** per tool · **Priority:** P2
**Reference:** OpenAI Codex MCP docs (learn.chatgpt.com/docs/extend/mcp), read 2026-10-21. Settings are shared by the CLI, desktop app and IDE extension.

## What it gives JARVIS
Two things: (1) a **config format JARVIS can read and write**, so a user's existing Codex MCP servers can be imported into JARVIS (and vice versa); (2) the exact knobs (approval modes, tool allow/deny, timeouts) worth copying into our own MCP client.

## Config reference (from the docs)
```toml
# ~/.codex/config.toml  (or .codex/config.toml in a trusted project)
[mcp_servers.context7]                 # stdio server
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["LOCAL_TOKEN"]
[mcp_servers.context7.env]
MY_ENV_VAR = "MY_ENV_VALUE"

[mcp_servers.figma]                    # streamable HTTP server
url = "https://mcp.figma.com/mcp"
auth = "oauth"                         # or "chatgpt"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
env_http_headers = { "X-Api-Key" = "FIGMA_API_KEY" }

[mcp_servers.example.oauth]
client_id = "my-client"
callback_url = "http://127.0.0.1/callback"

[mcp_servers.chrome_devtools]
url = "http://localhost:3000/mcp"
enabled = true                         # false disables without deleting
required = false                       # true: startup fails if it can't initialise
enabled_tools = ["open", "screenshot"] # allow list
disabled_tools = ["screenshot"]        # deny list, applied after enabled_tools
default_tools_approval_mode = "prompt" # auto | prompt | writes | approve
startup_timeout_sec = 20               # default 10
tool_timeout_sec = 45                  # default 60
[mcp_servers.chrome_devtools.tools.open]
approval_mode = "approve"
output_token_limit = 30000
```
CLI: `codex mcp add <name> --env K=V -- <command…>`, `codex mcp add <name> --url <https-url> --oauth-client-id <id>`, `codex mcp list`, `codex mcp login <name>`. Project-scoped servers require a **trusted** project.

## How a user connects it
**To use a server with JARVIS (import from Codex):**
1. In JARVIS: **Settings → Connectors → Tool servers → Import from Codex**.
2. JARVIS reads `~/.codex/config.toml` (read-only), lists each server with command/URL, and marks which secrets it expects.
3. The user ticks servers to import; secrets are re-entered or copied into the keychain after confirmation (never read from environment silently).
4. Each server starts disabled; the owner approves tools.

**To use a JARVIS tool set inside Codex (export):**
1. In JARVIS: **Settings → Connectors → n8n/Codex → "Let Codex call JARVIS"** (see [n8n MCP client](../../n8n/mcp-client-tool/README.md) for the same pattern).
2. Copy the generated `codex mcp add jarvis --url … ` command with a scoped token.

## How we implement it in JARVIS
1. TOML parser and a mapper: `mcp_servers.*` → JARVIS tool-server records (`transport`, `command/args/env`, `url`, `auth`, allow/deny lists, approval mode, timeouts).
2. Approval-mode mapping: `auto|prompt|writes|approve` → JARVIS tiers (never map "auto" to "allowed without policy"; JARVIS policy always wins).
3. Reuse the shared MCP client layer ([mcp-in-plugins](../../claude-skills-and-plugins/mcp-in-plugins/README.md)) with snapshot-and-diff.
4. Export: generate a Codex-style snippet; never include secrets.

## Acceptance tests
Import skips unknown keys safely; secrets are not copied silently; disabled servers stay disabled; allow/deny lists respected; project-scoped config is ignored unless the project is trusted.

## Risks
Config format changes; secret handling in env vars; the same vetting risks as any MCP server.

## Related
[Codex overview](../README.md) · [plans 08](../../../08-data-access-and-safety.md), [15](../../../15-policy-trust-and-privacy.md)
