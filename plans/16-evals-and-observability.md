# 16 · Evals and observability (so "feels better" becomes a number)

**Status:** Pending (a diagnostics panel and `window.__voice` exist) · **Priority:** P0/P1 · **Effort:** 2–3 weeks

## End state
Every promise in these plans has a measured metric, a regression test and a dashboard. A
change that makes wake worse, speaker ID less accurate, replies slower or the gate leakier
fails CI. Real-world failures are captured (with consent) and become test cases.

## Today (verified)
Diagnostics panel and `diag` object (`voice.ts`), unit tests in `bridge/*.test.mjs`. No audio
test corpus, no latency traces, no end-to-end evals.

## Components
1. **Trace store (3 d):** one trace per turn: timestamps for wake→STT→route→first token→first audio, model/route chosen, tools used, policy decisions, errors. Local SQLite, retention-limited, redacted.
2. **Metrics panel:** rolling medians/p95, wake count and false-wake log, speaker confidence histogram, fast-path %, alert acceptance.
3. **Audio test corpus (1 w):** recorded/synthesised sets: wake phrases at distances, TV-noise mixes, accents, pause-heavy sentences, barge-in, multi-speaker; with ground-truth labels.
4. **Offline harness:** replays corpus through VAD→wake→STT→speaker-ID and outputs WER, wake recall/FAR, EER, endpointing errors. Runs in CI nightly.
5. **Behaviour evals:** scripted conversations (persona rubric, tool success, memory recall, injection red-team, risky-action refusals) judged by assertions + LLM-judge with fixed rubric.
6. **Performance budgets in CI:** fail if p50 latency or CPU exceeds thresholds on a reference machine.
7. **Field feedback loop:** "that was wrong" voice command saves the last turn trace (with permission) to a review queue → becomes a test.
8. **Health & alerts:** bridge self-check, mic alive, STT/TTS reachable, disk, memory DB integrity, with a one-line status in the HUD.

## Initial KPI table (targets referenced by other plans)
| KPI | Target |
|---|---|
| Median end-of-speech→first audio | ≤ 1.0 s |
| Wake recall / false wakes | ≥ 95 % / ≤ 1 per 8 h |
| Speaker EER | ≤ 5 % |
| Tool-task success | ≥ 90 % |
| Policy bypasses | 0 |
| Proactive alert keep-rate | ≥ 80 % |

## Risks
Collecting audio is itself a privacy risk → synthetic corpus first, explicit opt-in for real captures, local only.

## Related plans
[35 red-team gate](35-ethics-limits-and-governance.md) · [37 roadmap gates](37-execution-roadmap-and-risks.md) · [38 contract tests](38-shared-data-contracts.md) · [36 cost metrics](36-economics-and-licensing.md)
