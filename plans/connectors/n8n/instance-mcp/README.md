# n8n · Instance-level MCP (JARVIS → n8n)

**Kind:** tool-provider · **Auth:** OAuth (recommended) or personal access token · **Platform:** Any · **Risk tier:** R2 (workflows can act) · **Priority:** P1
**Reference:** n8n docs, "Set up and use n8n MCP server" (docs.n8n.io/advanced-ai/mcp/accessing-n8n-mcp-server).

## What it gives JARVIS
A single endpoint, `https://<your-n8n-host>/mcp-server/http`, through which JARVIS can search the workflows you exposed, read their descriptions and inputs, and **run** them. Workflow building through MCP is possible on newer versions (2.13.0+).

## How a user connects it
1. In n8n go to **Settings → Instance-level MCP** and select **Enable MCP access** (owner or admin only; n8n 2.33.0+ for the guided dialog).
2. Select **Connect**, copy the **Server URL** (ends in `/mcp-server/http`).
3. Expose workflows one by one: workflow menu → Settings → **Available in MCP**, or the **Workflows enabled** page. Keep **Auto-expose new workflows** off.
4. In JARVIS: **Settings → Connectors → n8n** → paste the Server URL → choose **OAuth** and approve in n8n (or paste the API-key token from the **API key** tab).
5. JARVIS lists the exposed workflows; tick the ones JARVIS may use and confirm the risk tier for each.
6. Test: say "Jarvis, what n8n workflows can you run?" and then run a harmless one.

If n8n is at home and JARVIS is remote (or you use Claude/ChatGPT cloud clients), n8n must be reachable; use the JARVIS relay or a private network instead of exposing the instance.

## How we implement it in JARVIS
1. MCP client (streamable HTTP) with the n8n URL and credential from the keychain; reuse the same MCP client code as other tool-providers.
2. Discovery job: call the workflow search tool, store `{id, name, description, inputs}` with a content hash; show diffs.
3. Policy: each workflow = a tool named `n8n.<slug>`; default tier R2 (approval each time); owner can raise to "allowed" per workflow with spend/rate caps.
4. Execution: pass inputs as JSON; use the *published* version by default; never use the unpublished `manual` mode unless the owner enables a "developer" setting.
5. Results: size-capped, redacted, tagged untrusted.
6. Settings card: URL, auth mode, version, exposed count, last discovery, test, disconnect.
7. Health: n8n version ≥ 2.13, token validity, reachable, required proxy headers present.

## Acceptance tests
- Enable → discover → run a workflow with inputs → result displayed.
- A workflow whose description changes triggers re-approval.
- A workflow not ticked in JARVIS is not callable even though n8n exposes it.
- Revoking the OAuth client in n8n gives a clear reconnect message.
- Injection text in a workflow result causes no action.

## Risks
Preview features may change; per-workflow (not per-client) exposure; public reachability; costly or destructive workflows. See the [n8n overview](../README.md).

## Related plans
[08](../../../08-data-access-and-safety.md) · [15](../../../15-policy-trust-and-privacy.md) · [41](../../../41-backend-relay-service.md) · [39](../../../39-settings-and-control-center.md)
