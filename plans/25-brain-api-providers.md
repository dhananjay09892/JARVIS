# 25 · Brain: API-key providers (OpenAI, Anthropic, OpenRouter, Azure, compatible endpoints)

**Status:** Partial (Anthropic direct path exists in `src/lib/anthropic.ts`; browser-side only) · **Priority:** P1 (also the fallback for plans 22–24) · **Effort:** 1–2 weeks · **Depends on:** 21

## Goal
A generic **tool-loop brain** that works with any API key or OpenAI-compatible endpoint, so
users whose subscription routes are disallowed or unreliable still have a stable, officially
permitted way to use their preferred model. This is also the "plan B" for every subscription
brain and the base for the local-model plan.

## Why this matters
API keys are the route vendors explicitly document for apps and automation (OpenAI says API
keys are the recommended default for automation). It trades "free with my subscription" for
**predictable terms, higher limits and clear billing**.

## Scope
| Provider | Notes |
|---|---|
| **Anthropic API** | Official; also the fallback if subscription login is refused (`IMPROVEMENT_PLAN.md` #5 item 4) |
| **OpenAI API** (Responses/Chat) | Function calling, streaming, vision, realtime voice models possible later |
| **OpenRouter** | One key → many models; useful for experiments and fallback |
| **Azure OpenAI / Vertex / Bedrock** | Enterprise users with existing cloud contracts |
| **OpenAI-compatible endpoints** | Groq, Together, Fireworks, DeepSeek, Mistral, self-hosted vLLM, LM Studio |

## Design
- Adapter `bridge/brains/openai-compatible.mjs` + thin provider profiles (base URL, auth header, model list, capability flags: tools, vision, streaming, JSON mode).
- **JARVIS runs the agent loop:** model proposes tool calls → `policy.decide()` → bridge executes via MCP → result back to model. Max steps, timeouts and budgets (13/15).
- **Keys** stored in OS keychain; moved **server-side only** — the browser must never hold provider keys (the current `direct` path puts a key in the bundle; deprecate or restrict it to dev use).
- Prompt adapters per provider for persona, tool schema quirks, parallel tool calls.
- Cost tracking: tokens in/out per turn, daily/monthly caps with alerts and automatic downgrade to a cheaper model.
- Model catalogue with capabilities and price hints, user-overridable.

## Phases
1. **Generic adapter + OpenAI profile (4 d):** streaming, tool loop, cancellation, usage; conformance suite.
2. **Anthropic API profile (2 d):** reuse, with prompt caching; becomes the sanctioned fallback for the Claude brain.
3. **OpenRouter + compatible endpoints (2 d):** profile editor in Settings; "test connection" button.
4. **Secrets and the `direct` backend (2 d):** move keys behind the bridge; remove keys from the front-end bundle; migration note.
5. **Budgets and cost UI (2 d):** per-brain spend meter, hard caps, alert thresholds, spoken warning.
6. **Enterprise profiles (later):** Azure/Vertex/Bedrock auth schemes.
7. **Realtime/voice models (exploratory):** evaluate native speech-to-speech APIs (e.g. OpenAI realtime) as an optional low-latency path; they bypass local STT/TTS, so they need a separate privacy and policy review.

## Risks
- Tool-call fidelity varies across models/providers → capability flags, tool subsetting, retries on malformed calls.
- Cost surprises → caps by default (e.g. $5/month until the user raises it).
- Data policies differ per provider → show a data-use note at setup.

## Done when
A user can paste an OpenAI (or OpenRouter) key, choose it as the brain, hold a conversation, run a gated tool task, see spend, and no provider key exists in browser code.

## Related plans
[21](21-multi-brain-framework.md) · [36 cost caps](36-economics-and-licensing.md) · [15](15-policy-trust-and-privacy.md)
