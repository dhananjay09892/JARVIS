# 06 · The brain: orchestration, model routing, personality

**Status:** Partial · **Priority:** P1/P2 · **Effort:** 1–3 weeks

## End state
A turn manager that decides, per request, *how* to answer: instant local reply, fast model,
deep model, or hand-off to a background agent; with a consistent, charming, dry-witted
personality that adapts to the person, time of day and situation, and never rambles.

## Today (verified)
Claude via Agent SDK on the user's own subscription (decision recorded — keep). One persona
`SYSTEM_PROMPT` in `bridge/server.mjs`. Model/effort are Settings options.

## Orchestrator design
```
utterance + speaker + room + context
   │
   ▼  intent router (rules → tiny classifier → fast model)
 ┌─────────────┬──────────────┬──────────────┬─────────────────┐
 │ Reflex      │ Quick chat   │ Tool task    │ Long job        │
 │ timers,vol, │ fast model,  │ deep model + │ background agent│
 │ stop, time  │ no tools     │ MCP, approv. │ (plan 13)       │
 └─────────────┴──────────────┴──────────────┴─────────────────┘
```
- **Reflex layer** (no LLM): stop, volume, timers, "what time is it", repeat that → ~instant and works offline.
- **Fast model** for chat/clarifications; **deep model** for reasoning/tool use; upgrade mid-turn if the fast model signals "needs tools".
- **Prompt assembly:** persona + speaker profile + time/room + relevant memories (07) + ambient context (14), with a token budget and caching.
- **Self-consistency guard:** short, speakable output; no markdown; numbers/dates formatted for speech.

## Personality system
- Core traits (calm, dry humour, precise, loyal, never sycophantic) in a versioned persona file.
- Modes: normal / focus (terse) / night (quiet, minimal) / guest (formal) / sarcasm-level slider.
- Per-person overrides (01). Humour budget so it stays charming.
- Regression set of 30 prompts + expected "feel" rubric in 16.

## Local model (optional, later)
Small local LLM (Ollama) for reflex+basic chat when offline; clearly labelled weaker mode.
Home-control-tuned small models only after 09 is in place.

## Phases
1. Reflex layer + routing rules (3 d). 2. Fast/deep routing + metrics (3 d). 3. Persona v2 + modes (2 d). 4. Context assembler with budgets (3 d). 5. Local fallback (1–2 w).

## Metrics
% turns answered on fast path ≥ 60 %; cost per turn; user "feel" score on the rubric; zero regression in tool-use success.

## Risks
Misrouting a hard question to the fast model → escalate on uncertainty; subscription rate limits → routing also reduces load.
