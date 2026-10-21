# 23 · Brain: GitHub Copilot subscription

**Status:** Pending · **Priority:** P1 (best-documented subscription route) · **Effort:** 1–2 weeks · **Depends on:** 21

## Goal
Let a user with GitHub Copilot (including the free tier) power JARVIS's brain through the
official **Copilot SDK**, with BYOK as an alternative.

## What is known (October 2026)
- The [Copilot SDK](https://github.blog/changelog/2026-04-02-copilot-sdk-in-public-preview/) embeds Copilot's agent runtime in apps. It talks to the **Copilot CLI** over JSON-RPC and manages its lifecycle. SDKs: Node/TypeScript, Python, Go, .NET, (Java).
- Auth: signed-in GitHub user via CLI login, OAuth GitHub App token, environment tokens (`GH_TOKEN`), or **BYOK** (own key for OpenAI/Azure/Anthropic).
- Usage: each prompt counts toward the user's **premium request quota**; Copilot Free has limited usage.
- Sources disagree on status (preview vs. GA on 2026-06-02) → verify before shipping.
- Unlike the other subscription routes this is an **official, documented SDK for embedding**, so terms risk is lower; still confirm the Copilot terms for redistribution and for apps that serve other people.

## Open questions (week 0)
1. Which models are available to the user's plan, and can the user choose (including Claude/GPT models served by Copilot)?
2. SDK hooks: permission requests per tool, custom tool registration (to expose JARVIS tools), MCP support, streaming deltas, cancellation, session resume.
3. Quota exposure: can JARVIS read remaining premium requests to warn the user?
4. Windows support and how the Copilot CLI is installed/bundled.
5. Latency of the JSON-RPC path for voice turns.

## Design
- Adapter `bridge/brains/copilot.mjs` using the Node SDK; one long-lived client, a session per conversation.
- Register JARVIS tools as SDK custom tools (or MCP) and route every call through `policy.decide()`; map SDK permission events to approvals.
- Model picker: list models from the SDK; choose fast model for chat and a stronger one for tasks (links to 06 routing).
- Auth UX: Settings → Brains → Copilot → "Sign in with GitHub" (device flow); BYOK field as the alternative; clear label of which billing applies.
- Quota awareness: show premium-request usage if available; auto-fallback to another brain when exhausted.

## Phases
1. **Research gate (2 d):** read SDK docs, license and terms; answer open questions; record in terms register.
2. **Prototype (3 d):** streaming text + one custom tool; measure first-token latency.
3. **Policy and sandbox (2 d):** permission hook wiring; deny-by-default tests.
4. **Conformance suite (2 d):** run 21's scenarios; document gaps.
5. **UX and packaging (2 d):** sign-in flow, status, model picker, bundling vs. detecting the CLI.
6. **Quota and fallback (1–2 d):** warn at 80 %, switch brain at limit with a spoken notice.

## Risks
- Premium request quotas can be consumed fast by chatty voice use → routing sends only complex turns here, or uses the free/base model for chat.
- SDK still evolving → pin versions, wrap behind the interface.
- Coding-centric defaults; persona needs testing.

## Done when
A Copilot-signed-in user can hold a voice conversation and run a policy-gated tool task on Copilot, quota is visible, and fallback to another brain works.

## Related plans
[21](21-multi-brain-framework.md) · [25](25-brain-api-providers.md) · [36](36-economics-and-licensing.md)
