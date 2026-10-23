# 02 · Wake word and always-on listening, done privately

**Status:** Partial · **Priority:** P0 (trust) · **Effort:** 30 min disclosure, 2–4 days full

## End state
A tiny on-device model listens continuously and **nothing leaves the machine until it hears
"Jarvis"**. Wake is reliable across rooms and TV noise, adapts to your voice (optionally only
wakes for recognised speakers), supports a conversational window (no need to repeat the name
for follow-ups), and has non-voice wake options (clap, gesture, hotkey, phone button).

## Today (verified)
- Wake = openWakeWord "hey jarvis" in the page (`src/lib/wake/`), on by default (Q09). Asleep
  VAD segments are kept or dropped locally by `src/lib/wake/router.ts`; the browser recogniser
  is stopped while asleep. Off or failed → the old transcript regex, with a CLOUD LISTENING badge.
- Porcupine and `WAKE_ENGINE` removed (ADR 002).
- Clap trigger exists (`clap.ts`).

## Phases
1. **Disclose (30 min):** fix DISCLAIMER, site, Settings wording. ✅ Done (Q07, 2026-10-23).
2. **Engine (1–2 d):** ✅ Done (Q09, 2026-10-23) with openWakeWord in the page ([ADR 002](adr/002-wake-engine.md)); live voice check is Q45. Porcupine ("Jarvis" built in) *or* openWakeWord ("hey jarvis"), run in
   the page (WASM) or bridge. Keep a 2–3 s ring buffer so the words after the name are not lost.
   In `wake` mode the VAD blobs are **dropped locally**; only a wake event starts STT.
3. **Tuning (1 d):** sensitivity slider; false-wake log; a "TV mode" (raise threshold when media
   is playing, see `music.ts`/system audio level).
4. **Conversation window:** after an answer, stay in `command` for N seconds (default 8, learns
   from user behaviour) so follow-ups need no name; shorten if a different/unknown voice speaks.
5. **Verified wake (with 01):** optional "only wake for enrolled voices" to reduce TV/guest wakes.
6. **Alternate wakes:** hotkey, tray click, phone push-to-talk, gesture (already have hands.ts).
7. **Custom phrase:** let users pick their own name/phrase (Porcupine custom keyword or openWakeWord training).

## Fallback matrix
| Situation | Behaviour |
|---|---|
| Offline wake word on (default) and it starts | openWakeWord in the page; cloud only after a wake |
| Turned off in Settings, or the models/runtime fail to load | Transcript matching, HUD shows a CLOUD LISTENING badge, Diagnostics says why |

(Updated in Q09: Picovoice keys are no longer free, so there is no "engine + key" row.)

## Metrics
- Wake recall ≥ 95 % at 3 m in a quiet room; ≥ 85 % with TV at conversational level.
- False wakes ≤ 1 per 8 h of ambient TV/speech.
- Network audit: zero upload bytes while idle (automated test in 16).

## Risks
Licence/keys (Picovoice free tier limits), model size on low-end laptops, mic permissions in iframes/panes.

## Related plans
[04 speech stack](04-local-speech-stack.md) · [16 network audit test](16-evals-and-observability.md) · [29 calibration](29-onboarding-and-first-run.md) · [35 consent](35-ethics-limits-and-governance.md)

## Autopilot log
- **2026-10-23 · Q07 · Phase 1 (disclosure) done.** DISCLAIMER.txt, the README (disclaimer
  footer and the voice-loop "Detection is local" bullet) and a new "Listening" note in Settings
  and the welcome wizard now say plainly that the wake word is not detected on-device yet: with
  an ElevenLabs key, VAD-gated sound is sent to Scribe via the bridge; without one, the browser
  streams the mic continuously to its speech service (Google in Chrome, Microsoft in Edge).
  `WAKE_ENGINE` in `config.ts` is documented as not wired up. `bridge/disclosure.test.mjs`
  fails if user-facing text claims on-device/offline wake detection and checks the disclosure
  is present; it is added to the CI test list. Left: there is no separate website in the repo,
  so "site" was covered by the README; phase 2 (offline engine) waits on ADR 002 (Q08/Q09).
  When phase 2 ships, update the disclosure and the test together.
- **2026-10-23 — Q08 (wake engine decision record).** Wrote [ADR 002](adr/002-wake-engine.md)
  comparing Porcupine and openWakeWord (licence and cost, accuracy, CPU, custom phrases, Windows,
  page vs bridge), with sherpa-onnx keyword spotting as a third path. Key finding: Picovoice
  disabled Free Tier AccessKeys on 30 June 2026 and offers no personal plan, so the "Engine + key"
  row of the fallback matrix above no longer has a free path. Recommendation: openWakeWord in
  the page via onnxruntime-web (already a transitive dependency). `Decision:` is left for the
  owner; Q09 (phase 2) waits on it.
- **2026-10-23 · Q09 · Phase 2 (offline engine) done.** Following ADR 002's steps 1–5:
  `src/lib/wake/` adds a `WakeDetector` interface, a TypeScript port of openWakeWord's streaming
  pipeline (mel → embedding → `hey_jarvis` classifier, 80 ms frames), a score gate with
  low/medium/high sensitivity, a 48/44.1 → 16 kHz resampler, and the engine that taps the mic
  through an AudioWorklet and runs the three ONNX models with onnxruntime-web, loaded lazily
  and served from our own origin (`public/models/wake/`, committed with a LICENSE note;
  `public/ort/`, vendored by `scripts/start.mjs` and `scripts/package.mjs`). `router.ts`
  enforces "a segment that ends while asleep never leaves the machine": held in memory for
  1.2 s in case the wake phrase was in it, otherwise dropped; segments that span a wake are
  sent marked `afterWake` and the leading "hey jarvis" is stripped. The browser
  SpeechRecognition path is stopped while asleep and started by a wake. Settings: "Offline
  wake word" (on by default) and "Wake sensitivity" in the registry and the Settings dialog.
  Diagnostics: a WAKE WORD section (engine, score/peak/bar, ms per frame, false wakes,
  segments kept here, bytes sent while asleep); the HUD shows CLOUD LISTENING when the
  engine is off or failed. `@picovoice/*`, `VITE_PICOVOICE_ACCESS_KEY` and `WAKE_ENGINE`
  removed; model licences in `plans/LICENCES.md` (B3 resolved, B4 shipped) and CREDITS.md.
  DISCLAIMER, README and Settings wording updated with `bridge/disclosure.test.mjs`, which now
  also checks the claim is backed by the shipped code and models. Tests:
  `src/lib/wake/router.test.ts` (an hour of asleep speech uploads 0 bytes; wake releases only
  the wake segment; cloud fallback counts what it sends; false wakes) and
  `openwakeword.test.ts` (model shapes, buffering, gate, resampler). The port was also run
  once against the real ONNX files (via Python onnxruntime): shapes accepted, max score 0.00
  on silence, 0.04 on noise, 0.003 on a tone. Left: a live check with a real voice (Q45);
  the "hey jarvis" greeting still plays when the command follows in one breath; inference
  runs on the main thread (move to a Worker if Q45 shows a cost); phase 3 tuning (TV mode).
