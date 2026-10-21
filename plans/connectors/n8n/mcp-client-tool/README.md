# n8n · MCP Client Tool (n8n agent → JARVIS tools)

**Kind:** tool-provider (reverse direction) · **Auth:** bearer token issued by JARVIS · **Platform:** Any · **Risk tier:** R2 · **Priority:** Later
**Reference:** n8n "MCP Client Tool" node (lets an n8n AI Agent call tools on an external MCP server).

## What it gives JARVIS
The other direction: an **n8n AI agent** can call JARVIS as an MCP server, for example to read the user's calendar summary, add a note to memory, or send a notification through JARVIS, inside an n8n automation.

## How a user connects it
1. In JARVIS: **Settings → Connectors → n8n → "Let n8n call JARVIS"** → create an access token and choose exactly which JARVIS tools n8n may use (start with read-only: calendar summary, notes search).
2. In n8n add an **AI Agent** node, attach an **MCP Client Tool** node, and set the endpoint (the JARVIS MCP URL, reachable from n8n; via the relay if n8n is outside the home network) and the bearer token.
3. Test with a read-only tool.

## How we implement it in JARVIS
1. The bridge exposes a small **MCP server** (streamable HTTP) with an explicit allow-list of tools (never the full tool set).
2. Tokens are per client, scoped, revocable, short-lived; every call is logged in the audit log with the client name (plan 15).
3. All calls pass the policy engine as an *external agent* actor with no owner identity; risky tools require an approval card on the owner's phone/HUD.
4. Rate limits, payload size caps, and no access to vault/health data by default.
5. Settings card: token list, last used, allowed tools, revoke.

## Acceptance tests
Allowed read tool works; disallowed tool is invisible; revoked token fails; risky tool pauses for approval; injection in the agent's prompt cannot widen its scope.

## Risks
Exposing an MCP server expands the attack surface; keep it off by default, bind to localhost or the relay, and require authentication.

## Related
[n8n overview](../README.md) · [plans 15](../../../15-policy-trust-and-privacy.md), [41](../../../41-backend-relay-service.md)
