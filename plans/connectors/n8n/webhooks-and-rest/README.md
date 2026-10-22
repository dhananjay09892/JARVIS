# n8n · Webhooks and REST (works on any version)

**Kind:** channel / tool-provider · **Auth:** secret header or signed request · **Platform:** Any · **Risk tier:** R2 · **Priority:** P1 (as the generic webhook connector)

## What it gives JARVIS
The simplest and most portable link: JARVIS calls an n8n **Webhook** URL to start a workflow, and n8n calls a JARVIS callback URL (via the relay) with results or events. It works on old n8n versions, with Zapier/Make-style tools, and with Home Assistant and Discord, so it doubles as the generic **webhook channel** (see [OpenJarvis channels/webhook](../../openjarvis/channels/webhook/README.md)).

## How a user connects it
1. In n8n add a **Webhook** trigger node, set method POST and **Header Auth** with a secret; copy the **production URL**.
2. In JARVIS: **Settings → Connectors → Webhooks → Add** → name it ("Create invoice"), paste the URL, paste the secret header, and describe in one line what it does and what inputs it takes (JSON schema or a short list).
3. Choose the risk tier (default: approval each run).
4. Optional callbacks: JARVIS shows a callback URL and secret; in n8n add an **HTTP Request** node at the end of the workflow that posts the result there.
5. Test with a harmless workflow.

## How we implement it in JARVIS
1. `bridge/connectors/webhook.mjs`: registry of named webhooks → tool manifests (name, description, input schema, tier).
2. Outbound: POST JSON with the secret header, timeout, retries with idempotency key, response size cap.
3. Inbound callbacks: relay endpoint (plan 41) verifies an HMAC signature and timestamp, then delivers to the hub as a notification or tool result (untrusted).
4. SSRF protection: only user-registered hosts; block private/loopback targets unless explicitly allowed for local n8n (OpenJarvis applies the same rule to feeds and IMAP).
5. Audit log entry per call; spend and rate limits per webhook.

## Acceptance tests
Run a webhook with valid input; reject missing secret; timeout handled; callback with bad signature rejected; replayed callback rejected.

## Related
[n8n overview](../README.md) · [plan 20](../../../20-messaging-channels.md) · [plan 41](../../../41-backend-relay-service.md)
