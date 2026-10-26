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
1. Reflex layer + routing rules (3 d). **Done (Q25):** stop, time, date, repeat, volume, timers; Hindi/Gujarati phrasings and telling the model about reflex turns are Q75.
2. Fast/deep routing + metrics (3 d). **Done (Q26):** rules router on the bridge, per-turn model switch, path in traces and Diagnostics; "upgrade mid-turn" is not built (a short reply after a tool turn goes deep instead). 3. Persona v2 + modes (2 d). 4. Context assembler with budgets (3 d). 5. Local fallback (1–2 w).

## Metrics
% turns answered on fast path ≥ 60 %; cost per turn; user "feel" score on the rubric; zero regression in tool-use success.

## Risks
Misrouting a hard question to the fast model → escalate on uncertainty; subscription rate limits → routing also reduces load.

## Related plans
[21 multi-brain](21-multi-brain-framework.md) · [07 memory](07-memory-upgrade.md) · [14 context](14-ambient-context.md) · [28 per-language persona](28-multilingual.md) · [38 TurnContext](38-shared-data-contracts.md)

## Autopilot log

- **2026-10-26 · Q25 · Reflex layer (phase 1).**
  - **Where it runs:** on the page, before anything is sent to the brain (`App.respond` → `src/lib/reflex.ts`), so it needs no bridge, no model and no network. Like the existing "start a new conversation" shortcut.
  - **Covered:** stop / never mind / that's all (go quiet, back to standby, silence a ringing timer); the time; the date; "say that again"; louder / quieter / mute / unmute / "volume 40 percent" (voice and interface sounds, kept per browser); timers: set (with an optional name), ask what's left, cancel one or all. Timers live on the page (`src/lib/timers.ts`), survive a reload, chime until stopped (a minute at most) and say which one finished when he is free.
  - **Routing rule:** a pattern must match the whole utterance after polite words are trimmed. Anything else (for example "stop my subscription", "what time is it in Tokyo", "turn the lights down") goes to the model. Tests pin 49 phrasings that must match and 25 that must not.
  - **Measured in traces:** reflex turns are traced on route `reflex` with their family (never the words). `/traces/stats` now reports `routes` and `reflex { turns, modelCalls, latency }`, and keeps them out of the headline latency so the model's number stays honest. Diagnostics shows "quick commands (no AI)" and flags any reflex turn that reached a model.
  - **Setting:** Settings → Listening → Quick commands (`JARVIS_REFLEXES`, on by default, applies live).
  - **Left:** Hindi and Gujarati phrasings (plan 28), and telling the model what reflexes did (running timers, a changed volume) so a follow-up question makes sense; both are Q75. Real latency numbers need a session on your machine (the autopilot has no microphone). Music/ambient volume is not touched by "louder"/"quieter".

- **2026-10-26 · Q26 · Fast/deep routing (phase 2).**
  - **Where it runs:** on the bridge, between turns (`bridge/routing.mjs`, wired in `server.mjs` `handOver`). Each turn is routed on the owner's own words only, never the memory context riding along, with plain rules and no model call.
  - **Rules:** small talk, thanks, greetings and short plain questions go **fast**; anything with a tool word (open, email, calendar, search, weather, remind, screen, file, today…), a link or path, a why/how/explain/compare, arithmetic, or more than 24 words goes **deep**. A short reply straight after a turn that used a tool ("yes", "the second one") stays deep. Unclear medium-length turns take the safe deep path. Tests pin 23 fast phrasings and 26 deep ones.
  - **What changes on the fast path:** the model only (`Query.setModel` on the Claude session, a per-turn model on the OpenAI-compatible brain, passed through the registry). Tools, the policy engine, the taint guard and the persona are identical on both paths. A failed switch is answered by the main model and traced as deep, so a trace never claims a path it did not take.
  - **Measured in traces:** the bridge sends a `route` frame per turn (`path`, `reason`, `model`); the page puts it in the turn's trace. `/traces/stats` reports `paths { routed, fastShare, fast, deep, reasons }` with each path's latency and how many fast turns used a tool (a hint the router guessed low). Diagnostics shows "fast path: N% of M turns" (flagged under the 60 % target) and "deep path". `npm run latency` prints the split and each path's median.
  - **Settings:** Settings → Brain → Fast/deep routing (`JARVIS_ROUTING`, on by default, live) and Fast model (`JARVIS_FAST_MODEL`, default `claude-sonnet-5`, live). Claude only for now; on another brain every turn stays deep (reason `off`).
  - **Left:** real fast-share and latency numbers need a session on your machine (fold into Q74's day of use). Upgrading a fast turn to the deep model mid-turn when it reaches for tools is not built; the fast model keeps the same tools, and `fast.toolTurns` shows how often that happens. Effort stays the same on both paths (the SDK session takes effort at start). A fast-model setting for the OpenAI brain. Hindi/Gujarati small-talk words for the router belong with Q75.
