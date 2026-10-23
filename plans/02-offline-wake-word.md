# 02 · Wake word and always-on listening, done privately

**Status:** Partial · **Priority:** P0 (trust) · **Effort:** 30 min disclosure, 2–4 days full

## End state
A tiny on-device model listens continuously and **nothing leaves the machine until it hears
"Jarvis"**. Wake is reliable across rooms and TV noise, adapts to your voice (optionally only
wakes for recognised speakers), supports a conversational window (no need to repeat the name
for follow-ups), and has non-voice wake options (clap, gesture, hotkey, phone button).

## Today (verified)
- Wake = regex over transcripts (`WAKE` in `voice.ts`); asleep audio is transcribed by Scribe/Google.
- `WAKE_ENGINE` in `config.ts` unused; Porcupine is installed.
- Clap trigger exists (`clap.ts`).

## Phases
1. **Disclose (30 min):** fix DISCLAIMER, site, Settings wording. ✅ Done (Q07, 2026-10-23).
2. **Engine (1–2 d):** Porcupine ("Jarvis" built in) *or* openWakeWord ("hey jarvis"), run in
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
| Engine + key present | Offline wake, cloud only after wake |
| No key | openWakeWord (free) |
| Neither works | Today's transcript matching, UI shows a "cloud listening" badge |

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
