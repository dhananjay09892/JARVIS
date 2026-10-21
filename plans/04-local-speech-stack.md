# 04 · The voice: speech in, speech out, local or cloud

**Status:** Partial · **Priority:** P2 (TTS polish), Later (offline) · **Effort:** 1–3 weeks

## End state
Human-grade, expressive voice that starts speaking within a few hundred ms, handles accents,
noise and many languages, can whisper at night and project in a big room, and **keeps working
offline** (degraded but alive). One original signature voice with a clear licence.

## Today (verified)
STT: Scribe via `/stt` or browser SpeechRecognition. TTS: ElevenLabs via `/tts`, Kokoro local
(`kokoro.ts`), browser voices. VAD + assembler for turn detection. Language option exists (`language.ts`).

## Speech-to-text roadmap
1. **Streaming STT** (partials while you speak) so the model can start on stable prefixes → big latency win; evaluate Deepgram/Scribe realtime and local streaming Whisper variants.
2. **Local engine** (faster-whisper / whisper.cpp, small/int8 on CPU, GPU if present) behind the same `/stt` contract; auto-select by hardware probe.
3. **Vocabulary biasing:** feed names from memory/contacts/projects as hotwords so "Priya", project names and "Jarvis" transcribe right.
4. **Noise robustness:** RNNoise/DeepFilter pre-filter before STT.
5. **Smarter endpointing:** semantic end-of-turn model (already heuristic in `makeAssembler`); learn per-user pause length.
6. **Multilingual & code-switching** per speaker (01).

## Text-to-speech roadmap
1. **Sentence-streamed TTS** with pre-buffer; start on the first clause.
2. **Voice router:** pick engine by context: ElevenLabs (premium) → Kokoro (local) → Piper (tiny) → browser (last resort).
3. **Expressiveness:** short markup for pace/emphasis; whisper mode at night (quiet hours from 12); louder/slower when asked.
4. **Signature voice:** design an original voice; record its licence in `public/audio/CREDITS.md`. Do not clone the film actor or any real person without consent.
5. **Non-speech audio:** earcons, thinking sounds, acknowledgement chimes tuned (`sfx.ts`) so silence never feels like failure.
6. **Pronunciation dictionary** (names, brand terms) editable by the user.

## Offline mode (degraded but alive)
Local wake (02) + local STT + local TTS + small local model (06) for basics: timers, notes,
home control through Home Assistant local API, reading the calendar cache. Cloud-only features
say so out loud ("I can't reach my main brain right now, but I can do that when we're back online").

## Metrics (in 16)
WER on a recorded set (home noise, accents); time-to-first-audio; MOS-style listener rating of voices; offline success rate of the basic command set.

## Risks
Model licences (some "open" TTS forbids commercial use), CPU load on laptops, voice-clone ethics/legal.

## Related plans
[02](02-offline-wake-word.md) · [28 multilingual](28-multilingual.md) · [26 offline brain](26-brain-local-models.md) · [17 degraded modes](17-deployment-and-resilience.md) · [36 voice licences](36-economics-and-licensing.md)
