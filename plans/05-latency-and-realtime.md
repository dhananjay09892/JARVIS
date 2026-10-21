# 05 · Instant feel: latency, turn-taking, interruption

**Status:** Mostly done structurally; unmeasured · **Priority:** P1 · **Effort:** 3–7 days

## End state
Speaking to JARVIS feels like speaking to a quick person: ≤ ~800 ms median from you finishing
to him starting; he acknowledges long jobs immediately; you can interrupt, correct or add to a
request mid-answer; he never talks over you, never cuts you off, never goes silent without
explanation.

## Today (verified)
Always-open recogniser with barge-in (`voice.ts`), echo filter (`isEcho`), self-guard window,
pause assembler, filler phrases (`fillers.ts`). Default model Opus at high effort. No latency
measurement exists.

## Latency budget (target, median, short question)
| Stage | Budget |
|---|---|
| Endpoint (silence + assembler) | 250–400 ms |
| STT final | 150–250 ms (streaming) |
| Model first token | 400–800 ms (fast model) |
| TTS first audio | 150–250 ms |
| **Total** | **≈ 1.0 s**, stretch 0.8 s |

## Phases
1. **Instrument (1 d):** timestamps through the whole turn; show rolling median/p95 in Diagnostics; log to the trace store (16).
2. **Cheap wins (1 d):** effort→medium default for chat; start TTS at first sentence; warm connections (keep-alive to bridge/ElevenLabs); prefetch the persona/system prompt (cache).
3. **Speculative start (2 d):** begin the model call on a stable STT prefix when the sentence is complete by punctuation/heuristic; cancel/restart if text changes.
4. **Acknowledgement policy:** quick answer → none; tool task → "On it." within 300 ms (filler) then real result; long task → hand off to background job (13) and say so.
5. **Full-duplex interaction:** "add X to that", "no, the other one", "stop" interpreted against the in-flight turn (turn manager owns an active-turn object).
6. **Transport:** WebSocket/streaming between page and bridge instead of request/response where still used.

## Metrics
Median ≤ 1.0 s, p95 ≤ 2.5 s on fast path; barge-in stop latency ≤ 250 ms; false barge-in (self-interrupt) < 1 per 100 answers.

## Risks
Speculative start wastes tokens; aggressive endpointing clips users → keep per-user tunable and test with the pause-heavy recordings already in the bug history.
