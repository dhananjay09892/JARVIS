# 27 · Brain: other agent CLIs and subscriptions (evaluation plan)

**Status:** Pending (research) · **Priority:** Later · **Effort:** 1 week research, then 3–5 days per adopted provider · **Depends on:** 21

## Goal
Decide, with evidence, which other subscription-backed or open agent runtimes deserve an
adapter. This plan is a **structured evaluation**, not a commitment to build. Findings were
thin in search; nothing below should be treated as fact until checked in the vendor's docs.

## Candidates (unverified)
| Candidate | Why interesting | Unknowns |
|---|---|---|
| **Cursor CLI / agent** | Large user base with subscriptions | Headless mode? Login/terms for third-party apps? MCP? |
| **Amp** | Reported as a launch partner for ChatGPT-plan sign-in; agent-first | Does it expose a programmatic API/SDK? Pricing? |
| **OpenCode** | Open source, provider-agnostic, popular | It is a harness, not a model source; its own auth to providers; known friction with Anthropic about subscription login |
| **Qwen Code** | Open fork of Gemini CLI, works with open-weight models | Model hosting needed; quality for tool use |
| **Cline / Continue CLI** | Headless modes exist | Same: harness without model; users bring a key |
| **Grok (xAI)** | API and apps | Subscription programmatic access? API terms |
| **Mistral (Le Chat / Vibe)** | EU option, API | Subscription programmatic access? |
| **Devin and similar hosted agents** | Autonomous task agents | Only suitable as *mission* backends (13), not conversational brains |
| **Perplexity / search-native assistants** | Strong web research | API only; best as a *tool*, not the brain |

> **Update 2026-10-23 (Q15):** a first terms pass on Cursor, xAI and Mistral is in [ADR 001](adr/001-subscription-brain-terms.md); none documents third-party subscription use, so criterion 1 is a red flag for all three today.

## Evaluation rubric (score 0–2 each; adopt only if ≥ 12/16 and no red flags)
1. **Terms:** third-party app use of the user's subscription explicitly allowed (red flag if prohibited or unclear).
2. **Headless/SDK:** programmatic, non-interactive, streaming events.
3. **Tool integration:** MCP or custom tools.
4. **Permission hook:** per-tool approval callback we can route to policy.
5. **Cancellation and sessions.**
6. **Windows support and installability** (bundle or detect).
7. **Latency** suitable for voice (first token ≤ ~1.5 s warm).
8. **Stability:** documented, versioned, not in flux.

## Phases
1. **Desk research (3 d):** for each candidate gather docs links, auth modes, terms, headless/SDK status; fill the rubric; update the terms register.
2. **Spike on the top two (3 d each):** run the conformance suite from 21 against them, record results.
3. **Decision record (1 d):** adopt / defer / reject with reasons; open a dedicated plan file only for adopted ones.
4. **Mission-backend track (optional):** evaluate hosted agents as pluggable executors for background missions (13), with strict budgets and policy mediation.
5. **Tool-vs-brain split:** keep research/search providers (Perplexity-like) as MCP *tools* any brain can call.

## Risks
Chasing every new CLI creates maintenance debt → require the rubric, keep adapters small, remove providers that fail conformance for two releases.

## Done when
A decision record exists for each candidate and no provider is shipped without a passing rubric and conformance run.

## Related plans
[21](21-multi-brain-framework.md) · [36](36-economics-and-licensing.md) · [37 ADRs](37-execution-roadmap-and-risks.md)
