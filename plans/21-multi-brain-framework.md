# 21 · Multi-brain framework: one JARVIS, many models

**Status:** Pending · **Priority:** P1 · **Effort:** 2–3 weeks · **Depends on:** 15 (policy engine above every brain), 06 (routing)
**Provider plans:** [22 Codex](22-brain-openai-codex.md) · [23 Copilot](23-brain-github-copilot.md) · [24 Gemini](24-brain-google-gemini.md) · [25 API-key providers](25-brain-api-providers.md) · [26 Local models](26-brain-local-models.md) · [27 Other agent CLIs](27-brain-other-agent-clis.md)

## End state
The user picks (or JARVIS picks) the brain per task: Claude, OpenAI Codex/ChatGPT, GitHub
Copilot, Gemini, any API provider or a local model. Switching brain never changes JARVIS's
permissions, persona, memory or tools. If one brain is down, rate-limited or too slow, he
falls back to another and says so.

## Today (verified in the repo)
- `src/lib/brain.ts` chooses between two backends via `BACKEND`: `bridge` and `direct`.
- `bridge` = local Node bridge driving the **Claude Agent SDK** `query()` (`bridge/server.mjs` ~1383, ~1593) on the user's Claude login, with MCP servers, `canUseTool` → `decideTool`, `disallowedTools` when writes are off, persona in `SYSTEM_PROMPT`.
- `direct` = browser calls the Claude API (`src/lib/anthropic.ts`); remote HTTP MCP only.
- `bridge/claude-cli.mjs` locates/drives the bundled Claude binary and reports login status.
- Everything provider-specific (tool gating, streaming events, session resume) is wired to Anthropic's shapes.

## The hard part: what a "brain" must provide
JARVIS does not just need text. A brain must supply:
1. **Streaming text** (so TTS can start early).
2. **Tool use** against JARVIS's MCP servers and bridge tools (UI control, memory, workflows, tasks).
3. **A permission hook** before each tool runs (to call the policy engine).
4. **Sessions/resume** (conversation continuity) or let JARVIS own history.
5. **Cancellation** (barge-in must stop the turn).
6. **Structured events** (thinking, tool start/end, errors, usage).
7. **A way to inject the persona and per-turn context** (speaker, room, memories).

Providers differ on every point, so the framework defines the interface and a conformance suite.

## Provider interface (proposal)
```
interface Brain {
  id; label; capabilities: { tools, streaming, resume, vision, maxContext, offline }
  status(): { installed, authenticated, authMode: 'subscription'|'apikey'|'local', quota? }
  startTurn(input, ctx): AsyncIterable<BrainEvent>      // text | tool_call | tool_result | usage | error | done
  cancel(turnId)
  toolBridge: policy-gated executor shared by all brains   // brains ask; policy decides; bridge executes
}
```
Key design: **the bridge executes tools, not the brain.** Where a provider's own agent loop
runs tools itself (Claude Agent SDK, Codex, Copilot), JARVIS exposes its tools through MCP
and intercepts calls via the provider's approval/permission hook. Where a provider can't
hook permissions, that brain is restricted to **read-only mode** or **API-tool-loop mode**
(JARVIS runs the loop, the model only proposes calls).

Two integration modes:
| Mode | Who runs the agent loop | Used for |
|---|---|---|
| **Agent-CLI mode** | Vendor CLI/SDK (Claude, Codex, Copilot) | Subscription logins, rich built-in tools |
| **Tool-loop mode** | JARVIS | Any chat-completions/responses API, OpenRouter, local models |

## Phases
1. ✅ **Refactor behind an interface (4–5 d):** extract the current Claude code from `server.mjs` into `bridge/brains/claude.mjs` with no behaviour change; add a registry; add tests that pin current behaviour.
2. ✅ **Event schema and conformance suite (3 d):** *(events, adapter and suite done in Q17; the bridge moves onto the events in Q46)* normalise events; scripted scenarios every brain must pass (plain answer, one tool call, denied tool, cancel mid-stream, long answer, tool error, resume).
3. **Policy contract (2 d):** all tool calls flow through `policy.decide()` (15); brains without a pre-execution hook are forced to read-only or tool-loop mode; test that `disallowedTools`-equivalents hold on every brain.
4. **Brain settings UI (2 d):** pick default brain, per-person brain (01), per-task rules (06), connection status, "test this brain" button, clear subscription-vs-API-key labels and a cost/limit meter.
5. **Router and fallback (3 d):** extend plan 06 routing with brain choice (reflex → fast → deep) and failover on outage/429/timeouts, with a spoken notice; sticky per conversation so tool state isn't lost.
6. **Provider terms register (1 d):** *(research done: [ADR 001](adr/001-subscription-brain-terms.md) has the per-provider findings and a summary table to build the register from; waiting for the owner's decision)* `plans/brain-terms.md` or a doc listing per provider: auth mode, ToS stance for third-party apps, last verified date, risk level; surfaced in Settings before enabling a subscription login for that brain.
7. **Observability (1 d):** per-brain latency, failure and cost metrics in 16; A/B scoring on the behaviour eval set.
8. **Memory and persona portability (2 d):** persona/context assembly (06/07) is brain-agnostic with per-provider prompt adapters; memory stays in JARVIS, never in a vendor thread.

## Safety rules
- Policy engine, taint tracking and audit log are **outside** every brain and identical for all.
- Credentials per provider in OS keychain; never mixed between providers; subscription tokens never logged.
- Data-flow disclosure per brain in the Privacy Centre (what leaves the machine, who sees it).
- A new brain defaults to **read-only** until it passes the conformance suite and the user enables writes.
- Local models never get write tools by default (weaker instruction following).

## Metrics
Conformance suite pass rate per brain; policy-bypass tests = 0 on all brains; failover time < 3 s; behaviour eval score per brain; cost/turn.

## Risks
- Terms of service for subscription logins (see each provider plan); a provider can change rules or break its CLI at any time → adapters isolated, brain can be disabled remotely via config.
- Divergent tool-calling quality → per-brain capability flags and routing rules.
- Maintenance burden → limit first release to Claude + one more brain; add others behind the conformance suite.

## Related plans
[06](06-brain-routing.md) · [15](15-policy-trust-and-privacy.md) · [16](16-evals-and-observability.md) · [25](25-brain-api-providers.md) · [37 ADRs](37-execution-roadmap-and-risks.md) · [38 BrainEvent](38-shared-data-contracts.md)

## Autopilot log
- **2026-10-23 · Q15 · Subscription terms research done (phase 6 input, roadmap decision 1).**
  Wrote [ADR 001](adr/001-subscription-brain-terms.md): current vendor terms for using a user's own
  subscription login from a third-party local app, with sources and dates. Anthropic: allowed for now
  (stock binary, Anthropic's own sign-in) but provisional, Medium risk. OpenAI: Sign in with ChatGPT
  is open to open-source local apps, Low. GitHub Copilot SDK: documented, Low. Google: prohibited
  and enforced, High (API key only). Cursor/xAI/Mistral: not shown, API key only. Recommendation:
  keep Claude subscription as default, add a Claude API-key fallback, ask Anthropic for written
  confirmation. `Decision:` left empty for the owner. Left: the owner's decision, then the terms
  register and Settings warning (phase 6 build).
- **2026-10-23 · Q16 · Phase 1 done.** New `bridge/brains/claude.mjs` (`createClaudeBrain`,
  `claudeOptions`) holds everything Claude-specific: the Agent SDK session options with their
  reasons, status and sign-in through the bundled binary. New `bridge/brains/registry.mjs`
  registers brains and picks the default (Claude). `server.mjs` now starts the voice session and
  task workers with `brain.startSession(...)` and no longer calls the SDK's `query()` or the
  Claude CLI helpers directly. No behaviour change: `brains/claude.test.mjs` pins every option
  (turn limits, `settingSources: []`, `permissionMode: 'default'`, hooks, `canUseTool`) and runs
  the real policy engine through them; the `policy.test.mjs` structure check now follows the
  options into the brain. `status()` also reports `authMode` (`apikey` when `ANTHROPIC_API_KEY` is
  set, else `subscription`) for the later Settings work. Left: normalised `BrainEvent`s and the
  conformance suite (Q17); the stream pump in `server.mjs` still reads SDK message shapes.
- **2026-10-23 · Q17 · Phase 2 done (events and suite); bridge adoption left.** New
  `bridge/brains/events.mjs`: the `BrainEvent` shapes from `shared/contracts.ts` as a plain-JS
  checker (no zod or TypeScript step in the bridge), cross-checked against the zod contract on the
  same samples and the plan 38 fixture. `claude.mjs` gains `claudeEventMapper` (SDK messages →
  text, tool_call, tool_result, usage, error, done; one `done` per turn always, including when the
  stream ends or throws; text in flight after a cancel is dropped) and `brain.converse()` →
  `{ events, cancel, close }`; the registry now requires `converse`. New
  `bridge/brains/conformance.mjs`: seven scripted scenarios (plain answer, one tool call, denied
  tool, cancel mid-stream, long answer, tool error, second turn) plus stream rules, run with the
  real policy engine with writes off; `runConformance()` reports per scenario for a later pass-rate
  metric and "test this brain" button. The Claude brain passes all seven against a stand-in SDK
  that asks the policy through the brain's own `disallowedTools`, PreToolUse hook and `canUseTool`;
  the denied tool is checked on the audit trail. The suite is shown to fail broken brains (runs a
  refused tool, reports it as ok, speaks a cancelled tail, loses a turn boundary, invalid event,
  no streaming, never finishes). Left: `server.mjs` and `tasks.mjs` still read SDK message shapes
  (`startSession`); moving them onto `converse()` is Q46. `resume` is tested as "a second turn in
  the same session keeps to its own turn", because JARVIS owns history (`capabilities.resume:
  false`); a brain with vendor-side resume will need its own scenario.
