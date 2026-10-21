# 05 · Latency and the real-time loop

**Status:** Mostly done · **Priority:** P2 · **Effort:** hours to 2 days

## Today
The loop in `src/lib/voice.ts` is already the hard part: one always-open recogniser,
barge-in, echo filtering, pause-aware assembly, filler phrases (`fillers.ts`). No framework
(Pipecat/LiveKit) is needed; replacing it would be a rewrite for little gain.

## Gap
Nobody can say how fast it is. Target from the movie-feel list: under ~1 s from end of
speech to first sound. Opus at high effort is the default and is likely slower than that.

## Steps
1. **Measure first.** Add one number to the diagnostics panel (`window.__voice` / `Diagnostics.tsx`):
   time from last speech energy → transcript → first model token → first audio byte.
2. Show it in the panel as a rolling median of the last 20 turns.
3. Default effort to *medium* (README and code disagree today; settle it).
4. Stream TTS from the first sentence rather than the whole reply, if not already.
5. Tune `SILENCE_MS`, `SETTLE_MS` against the measured numbers, not by feel.
6. Model routing is in [06](06-brain-routing.md).

## Done when
The latency number is visible, documented here with a before/after, and the median is under
the target for short questions on a normal connection.
