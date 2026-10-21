# 02 · Offline wake word

**Status:** Partial · **Priority:** P0 (trust) · **Effort:** 30 min disclosure now, ~1 day engine

## Problem
While asleep, every phrase the mic hears is transcribed by ElevenLabs Scribe (or Google, in
browser mode) just to look for "Jarvis" (`WAKE` regex in `src/lib/voice.ts`). Room audio is
sent to the cloud before anyone says the wake word. `WAKE_ENGINE` in `src/config.ts` is
defined and unused; Porcupine is already a dependency.

## Steps
1. **Now (wording only):** correct `DISCLAIMER.txt`, the download page and the Settings text
   to say room audio is transcribed while asleep.
2. **Engine:** run an offline detector while in `wake` mode. Options:
   - Picovoice **Porcupine** (built-in "Jarvis", needs a free access key), or
   - **openWakeWord** (free, has a "Hey Jarvis" model; runs via ONNX/WASM or a bridge sidecar).
3. **Gate the cloud:** in `wake` mode, VAD segments are *not* sent to `/stt`. Only after the
   engine fires does `h.onWake()` run and transcription start (keep any trailing words by
   buffering ~2 s of pre-roll audio).
4. **Fallback:** no key / no model → today's transcript matching, clearly labelled in the UI.
5. **Sensitivity setting** in Settings (TV and music cause false wakes).
6. Keep the clap trigger (`clap.ts`) as is.

## Done when
- With the engine on, a network trace during a minute of room talk shows no audio uploads.
- Wake rate and false-wake rate measured over a recorded test set, numbers in this file.
- Falls back cleanly when the key is missing.
