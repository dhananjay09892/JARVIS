# 22 · Brain: OpenAI Codex / ChatGPT subscription

**Status:** Partial · **Priority:** P1 (most-requested alternative) · **Effort:** 1–2 weeks · **Depends on:** 21

## Goal
Let a user with a ChatGPT Plus/Pro/Business plan run JARVIS's brain on Codex using "Sign in
with ChatGPT", with the same tools, persona, permissions and memory as the Claude brain.

## What is known (from OpenAI's docs, checked October 2026)
- Codex supports **Sign in with ChatGPT (subscription)** or **API key (usage-based)** in the CLI, desktop app and IDE extension ([auth docs](https://learn.chatgpt.com/docs/auth)).
- Login is cached in `~/.codex/auth.json` or the OS credential store.
- For headless machines: device-code login (beta) or copying `auth.json` ("treat like a password").
- For automation/CI OpenAI says **API keys are the recommended default**; enterprise admins can issue access tokens for scripts.
- The docs reference a non-interactive mode and a Codex SDK; this plan must read those pages first.
- A news report says OpenAI is letting ChatGPT subscribers use plan allowance in participating third-party tools with per-partner caps; **official partner terms were not found** → treat third-party use of a subscription login as **unconfirmed**.

> **Update 2026-10-23 (Q15):** OpenAI now offers **Sign in with ChatGPT** plan usage to open-source local apps (self-serve, Responses API). Third-party reuse of the Codex CLI login is not documented. See [ADR 001](adr/001-subscription-brain-terms.md); question 1 is answered there.

## Open questions to resolve first (week 0)
1. Does OpenAI permit a third-party app (JARVIS) to drive the Codex CLI/SDK with the user's own ChatGPT login? Ask OpenAI / read the Services Agreement and any partner program. Record the answer.
2. Does Codex expose a **permission/approval hook** per tool call (needed for policy), and can it consume **MCP servers** (JARVIS tools)? If not, Codex runs in read-only or tool-loop mode.
3. Streaming events format, session resume, cancellation, vision input support.
4. Rate limits and what happens at the plan cap (clear error mapping).

## Design
- Adapter `bridge/brains/codex.mjs` implementing the interface from 21.
- **Mode A (preferred if allowed): agent-CLI mode.** Spawn `codex` in non-interactive/SDK mode with: JARVIS persona injected, JARVIS MCP tools attached, approval policy set so every tool request is routed to `policy.decide()`; sandbox set to read-only unless writes are enabled; working directory = the dedicated workspace only.
- **Mode B: API-key tool-loop** via plan 25 (OpenAI API), same model family, no subscription involved.
- Login UX: Settings → Brains → OpenAI Codex → "Sign in with ChatGPT" opens the Codex login flow (device code on headless hubs); show account/plan and remaining allowance if exposed.
- Status probe like `claudeStatus()`: installed, version, logged in, auth mode.

## Phases
1. **Research and terms (2–3 d):** answer the open questions above; update the terms register; decision gate: proceed with subscription mode, API-key only, or defer.
2. **Prototype (3 d):** headless run with persona + one MCP tool; capture event stream; map to `BrainEvent`.
3. **Permission wiring (2 d):** approval callbacks → policy engine; deny-by-default tests; read-only sandbox tests.
4. **Conformance suite (2 d):** pass the scenarios in 21; document any capability gaps (vision, resume).
5. **Settings and onboarding (2 d):** installer bundling decision (bundle Codex CLI like the Claude binary, or detect on PATH), sign-in wizard, status panel, clear note that billing/limits are the user's ChatGPT plan's.
6. **Latency tuning (1–2 d):** keep process warm; measure vs Claude in 16.

## Risks
- **Terms of service** for third-party subscription use (biggest). Fallback: API-key mode only.
- Codex is tuned for coding; conversational/voice persona and short spoken answers may need stronger prompting.
- Tool-call format differences and sandbox behaviour on Windows.
- CLI changes break the adapter → pin versions, adapter tests in CI.

## Done when
JARVIS answers voice turns and runs a read-only tool task on Codex, a denied tool stays denied, cancel works, status shows the plan, and the conformance suite passes (or documented gaps are accepted).

## Progress
- **SIWC route (ADR 001):** auth module and Responses API wire format done (Q43); bridge
  routes and Settings screen next (Q55, after Q54 wires the OpenAI brain into the bridge).
- The Codex CLI route (Mode A above) is not being built: ADR 001 chose SIWC on the Responses
  API instead.

## Autopilot log
- **2026-10-25 · Q43 · Sign in with ChatGPT for the OpenAI profile.**
  Added `bridge/brains/siwc.mjs`, following OpenAI's SIWC docs for open-source local apps
  (checked 2026-10-25): a stable `urn:uuid` host id; first sign-in registers through
  `dynamic_agent_client` + `agent_name_hint: JARVIS` and keeps the issued `client_id` (no
  client secret); PKCE S256, fresh state and nonce, loopback callback on
  `127.0.0.1:<port>/auth/callback` (listener up before the browser opens, Host and state
  checked); code exchange with `resource=https://api.openai.com/v1`; ID token verified against
  OpenAI's JWKS (RS256, issuer, audience = issued client, expiry, nonce); plan usage only when
  `chatgpt.tokens.use.direct` is granted; refresh early, serialized (rotating refresh token);
  `invalid_grant`-family errors mean sign in again while temporary failures keep credentials;
  sign-out revokes at the OpenID `revocation_endpoint` and says so when OpenAI did not confirm.
  Every auth URL must be on auth.openai.com. SIWC terms: tokens only in the store the bridge
  passes in (the OS keychain), never in a log, URL or error; background (worker) turns need
  express consent, forgotten on sign-out; `PRIVACY_NOTICE` and `MANAGE_USAGE_URL` for Settings.
  The OpenAI profile in `openai-compatible.mjs` now takes `auth: 'chatgpt'` with that client: it
  speaks the Responses API (`POST /v1/responses`, `store: false`, streamed, persona as
  `instructions`, function calls and outputs as items, tools non-strict), refreshes and retries
  once on a 401, needs `response.completed` to count a reply as finished, and maps the SIWC
  plan-usage errors (`usage_limit` with the Manage usage link, `not_eligible`, …) to their own
  codes without ever falling back to an API key. `status().authMode` is `chatgpt`. Tests:
  `siwc.test.mjs` (21, mock auth server with real RSA-signed ID tokens) and
  `openai-chatgpt.test.mjs` (25, including the whole conformance suite against a Responses mock).
  Left (Q55): bridge routes, the Settings screen (auth choice, privacy notice, Manage usage link,
  background consent switch, model picker from `/v1/models`), and checking the Manage usage deep
  link against OpenAI's UI guidelines page, which could not be read in this run.

## Related plans
[21](21-multi-brain-framework.md) · [25 API fallback](25-brain-api-providers.md) · [36 CLI redistribution licence](36-economics-and-licensing.md)
