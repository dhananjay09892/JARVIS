# 04 · Local speech-to-text and text-to-speech (offline mode)

**Status:** Partial · **Priority:** Later (last) · **Effort:** 1–2 weeks

## Today
- **STT:** ElevenLabs Scribe through bridge `/stt`; browser `SpeechRecognition` as keyless
  fallback. Turn detection is good: energy VAD (`vad.ts`) plus a sentence-aware assembler
  (`makeAssembler` in `voice.ts`).
- **TTS:** ElevenLabs via bridge `/tts`, local **Kokoro** (`kokoro.ts`), browser voices.
- The brain (Claude) is cloud-only, so "fully offline" would also need plan 06's local model.

## Steps
1. **Local STT:** add `faster-whisper` (or whisper.cpp) as a bridge sidecar behind the same
   `/stt` contract, so `voice.ts` does not change. Choose model size by hardware
   (small/int8 on CPU).
2. **Engine choice in Settings:** ElevenLabs / local / browser, with the current
   capability probe (`/health` in `server.mjs`) extended to report `localStt`.
3. **TTS:** keep Kokoro; evaluate **Piper** for low-end CPUs.
4. **Voice licence review:** record the licence of every bundled voice in
   `public/audio/CREDITS.md`. Use an original voice; do not clone the film actor or anyone
   without permission. Some "open" voice models forbid commercial use.
5. **Measure** word error rate and latency vs. Scribe on a small recorded set.

## Done when
With no keys and no internet for speech, wake → listen → speak still works (the brain call
excepted), and the choice is visible and switchable in Settings.
