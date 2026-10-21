# <Connector name>

**Kind:** data connector | channel | tool-provider · **Auth:** oauth | token | local | filesystem | none · **Platform:** Any | Windows | macOS · **Risk tier:** R0–R3 · **Priority:** P1 | P2 | Later | Not planned
**Reference:** link to the official docs and, if any, an open-source implementation (note its licence)

## What it gives JARVIS
One or two sentences: what can JARVIS read, do or receive.

## How a user connects it
Numbered steps a non-technical person can follow, with provider links. End with the test question that proves it works.

## How we implement it in JARVIS
1. Adapter file and interface (`bridge/connectors/<id>.mjs`)
2. Auth and credential storage (keychain)
3. Data mapping (plan 38 types) or tool manifest
4. Sync / receive path, rate limits, backoff
5. Policy: risk tier, read vs write capabilities, approvals
6. Privacy: what may reach a cloud model, sensitivity class
7. Settings card (plan 39)
8. Health checks and error messages

### Alternatives to compare first
Official hosted MCP server? Existing aggregator (n8n, Zapier)? Reuse from OpenJarvis?

## Acceptance tests
- Connect / disconnect / revoke
- Fixture sync or message round trip
- Injection fixture does nothing
- Errors are readable
- Data erase works

## Risks and open questions
Terms of service, cost, rate limits, regional availability, unverified claims.

## Related plans
Links to the plans this depends on.
