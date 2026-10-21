# n8n · MCP Server Trigger node (one workflow = one tool server)

**Kind:** tool-provider · **Auth:** set on the trigger node (none / bearer / header) · **Platform:** Any · **Risk tier:** R2 · **Priority:** Later
**Reference:** n8n "MCP Server Trigger" node (see the n8n docs; details below beyond the instance-MCP page are *verify*).

## What it gives JARVIS
A dedicated MCP endpoint produced by one workflow: attach tool nodes (HTTP request, Google Sheets, database…) to the **MCP Server Trigger** and n8n publishes them as that server's tools. Good when you want a small, purpose-built tool set with its own URL and authentication, separate from the instance-wide server.

## How a user connects it
1. In n8n create a workflow that starts with **MCP Server Trigger**.
2. Add tool nodes to it (each becomes an MCP tool); give each a clear name and description.
3. Set authentication on the trigger (use a bearer token; do not leave it open) and **activate** the workflow.
4. Copy the production URL the trigger shows.
5. In JARVIS: **Settings → Connectors → MCP servers → Add** → paste the URL and the bearer token → choose which tools to allow.
6. Test with a read-only tool first.

## How we implement it in JARVIS
- Treated like any generic remote MCP server (HTTP transport): the same client, discovery, snapshot-and-diff, policy and settings card as other MCP servers.
- Per-tool allow-list and risk tier; default deny until the owner ticks tools.
- Requires the endpoint to be reachable from the hub; if n8n is cloud-hosted this works directly, if it is at home use the relay or a private network.

## Acceptance tests
Add server → list tools → call a read tool; token rotation requires re-entry; changed tool list triggers re-approval; unauthenticated endpoints are refused by JARVIS.

## Risks
Open triggers without auth are a common mistake; refuse to connect to servers without authentication. Version differences between n8n releases (*verify*).

## Related
[n8n overview](../README.md) · [Instance MCP](../instance-mcp/README.md) · [plan 08](../../../08-data-access-and-safety.md)
