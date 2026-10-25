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
1. **Generic adapter + OpenAI profile (4 d):** streaming, tool loop, cancellation, usage; conformance suite. **Done (Q21):** `bridge/brains/openai-compatible.mjs`, passes the conformance suite against a mock server; not yet registered in the bridge or selectable in Settings.
2. **Anthropic API profile (2 d):** reuse, with prompt caching; becomes the sanctioned fallback for the Claude brain.
3. **OpenRouter + compatible endpoints (2 d):** profile editor in Settings; "test connection" button.
4. **Secrets and the `direct` backend (2 d):** move keys behind the bridge; remove keys from the front-end bundle; migration note. **Done (Q22):** `vite build` refuses any `VITE_` key, token or secret MCP URL and the build scans `dist/` for keys; a built front end always uses the bridge (`direct` is `npm run dev` only); migration note in the README.
5. **Budgets and cost UI (2 d):** per-brain spend meter, hard caps, alert thresholds, spoken warning.
6. **Enterprise profiles (later):** Azure/Vertex/Bedrock auth schemes.
7. **Realtime/voice models (exploratory):** evaluate native speech-to-speech APIs (e.g. OpenAI realtime) as an optional low-latency path; they bypass local STT/TTS, so they need a separate privacy and policy review.

## Risks
- Tool-call fidelity varies across models/providers → capability flags, tool subsetting, retries on malformed calls.
- Cost surprises → caps by default (e.g. $5/month until the user raises it).
- Data policies differ per provider → show a data-use note at setup.

## Done when
A user can paste an OpenAI (or OpenRouter) key, choose it as the brain, hold a conversation, run a gated tool task, see spend, and no provider key exists in browser code.

## Autopilot log
- **2026-10-24 · Q21 · Phase 1: generic adapter and OpenAI profile.**
  Added `bridge/brains/openai-compatible.mjs`: a tool-loop brain (`toolGate: 'loop'`) over the
  Chat Completions streaming API, with an OpenAI profile (`PROFILES.openai`). It streams text,
  assembles streamed (and parallel) tool calls, runs every call through the registry's
  policy-gated tool bridge, feeds results back to the model, sums usage over the turn's requests
  (one `usage` per turn), cancels by aborting the request in flight, and stops at a step limit
  (8 voice / 24 worker) and on a silent-provider timeout. HTTP failures map to `auth`,
  `rate_limit`, `provider`, `request`; keys come from `getKey()` at request time, are scrubbed
  from provider messages, and a non-loopback base URL must be https. Calls with non-JSON
  arguments are never run; missing or repeated provider call ids are replaced. The tool bridge
  now also hands the brain the whole tool output as a non-enumerable `content`, so the model sees
  more than the 2000-character `detail` while events, traces and the HUD do not.
  `openai-compatible.test.mjs` runs the whole conformance suite against a local mock
  OpenAI-compatible HTTP server (no paid key) plus 19 adapter tests.
  Left: register the brain in `server.mjs` behind a Settings switch (off by default) and store
  its key through the keychain (Q22); untrusted-content labelling of tool results in tool-loop
  mode (Claude gets it from its PostToolUse hook); a cost figure (`costUsd`) from a price table
  (phase 5); phases 2–7.
- **2026-10-25 · Q22 · Phase 4: keys behind the bridge.**
  `scripts/bundle-secrets.mjs` lists the eleven `VITE_` variables that are credentials
  (Anthropic and ElevenLabs keys, the MCP tokens, and the Zapier, Pipedream and Home Assistant
  URLs). `vite.config.ts` refuses to run `vite build` while any is set in the shell or a `.env`
  file, naming the variables (never the values) and how to move each behind the bridge. The
  `build` script then runs `scripts/check-bundle-secrets.mjs`, which scans every text file in
  `dist/` for the literal values from the env files and shell (with and without the `VITE_`
  prefix) and for nine well-known key shapes, and fails the build on a match. In `src/config.ts`
  every credential goes through `devSecret()` (read only when `import.meta.env.DEV`), and a
  production build forces `BACKEND` to `bridge` with a warning if `direct` was asked for; the
  ElevenLabs voice already came from the bridge's `/tts`. The Windows installer runs
  `npm run build`, so it is covered. README: "Keys behind the bridge" with an upgrade note;
  `.env.example` updated. `scripts/bundle-secrets.test.mjs`: 8 tests (key shapes found, benign
  bundle text not flagged, env values found, the refusal message never contains a key,
  `src/config.ts` reads every credential through `devSecret` and no other file reads one, and a
  scan of a fake `dist/`).
  Left: removing the direct path entirely once the OpenAI and Anthropic API profiles run in the
  bridge (Q54 and phase 2); a real `npm run build` was not run in this session (npm registry
  unreachable), so the first build on a machine with dependencies is the end-to-end check.

## Related plans
[21](21-multi-brain-framework.md) · [36 cost caps](36-economics-and-licensing.md) · [15](15-policy-trust-and-privacy.md)
