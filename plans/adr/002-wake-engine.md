# ADR 002 · Wake engine: Porcupine vs openWakeWord

- **Status:** Proposed (waiting for the owner)
- **Plan:** [02 Offline wake word](../02-offline-wake-word.md) · roadmap open decision 2 in [37](../37-execution-roadmap-and-risks.md)
- **Queue:** written by Q08; unblocks Q09 (offline wake engine)
- **Date checked:** 2026-10-23
- **Decision:** <!-- owner: write the chosen option here, then set Q09 to `todo` in plans/QUEUE.md -->

## Context

Today the wake word is a regex over transcripts (`WAKE` in `src/lib/voice.ts`). While JARVIS is
"asleep", every speech segment the VAD (`src/lib/vad.ts`) captures is sent off the machine to be
transcribed (ElevenLabs Scribe through the bridge, or the browser's SpeechRecognition, which is
Google). Plan 02 wants a small on-device detector so **no room audio leaves the machine until the
wake word is heard**. This is the P0 trust item in plan 02 and risk R3 in plan 37.

What the code already has:

- `@picovoice/porcupine-web` and `@picovoice/web-voice-processor` are dependencies, and
  `src/config.ts` defines `WAKE_ENGINE = 'porcupine'` when `VITE_PICOVOICE_ACCESS_KEY` is set.
  Nothing reads `WAKE_ENGINE`, so Porcupine is installed but never runs.
- `onnxruntime-web` and `onnxruntime-node` are already in `package-lock.json` as transitive
  dependencies of `kokoro-js` (via `@huggingface/transformers`). An ONNX-based detector would
  add model files, not a new runtime.
- The microphone is captured in the page (`src/lib/audio.ts`), so the page is where the audio
  already is.

Two things changed since plan 02 was written, and both bear on this decision:

1. **Picovoice ended its Free Tier.** Free Tier AccessKeys were disabled on **30 June 2026**, and
   Picovoice told users "the SDK does not run without a valid key" and "there is no
   non-commercial tier planned" (Home Assistant community post, 4 June 2026, quoting Picovoice
   email). Picovoice's own FAQ now describes only a one-time Free Trial "for enterprise
   developers" and says "there are no dedicated free or paid plans for personal or
   non-commercial use"; continued use means contacting sales. One third-party pricing tracker
   lists paid plans from about $6,000/month (unofficial; Picovoice publishes no prices).
2. **The project may be renamed** (open PR "Plan 40: Name and brand (Tamelo)"). If the
   assistant's name changes, the wake phrase changes with it, so **custom phrases** are no longer
   a phase-7 nice-to-have: the engine must support a phrase that no vendor ships.

## Options

### A. Porcupine (Picovoice)

| Criterion | Assessment |
|---|---|
| Licence and cost | SDK is Apache-2.0 on GitHub, but it **will not run without a valid AccessKey**, and keys are now enterprise-only (trial, then sales). No personal or non-commercial plan. Each user of an open-source app would need their own key, which they can no longer get for free. |
| Accuracy | The best published numbers of the options here, but from Picovoice's own benchmark. Widely regarded as the most accurate low-power engine. |
| CPU / size | Very low CPU and a small model, built for microcontrollers. Not a concern on a PC. |
| Custom phrases | "Jarvis" is a built-in keyword. Custom phrases are trained in the Picovoice Console (seconds, no data needed), but the console and the resulting `.ppn` file are tied to an account and AccessKey. |
| Windows support | Yes (web SDK in the page; native SDKs incl. Node.js). |
| Fit with the bridge | Already installed for the page (`porcupine-web` + `web-voice-processor`, 16 kHz frames). Smallest code change. The AccessKey requirement puts a vendor account in front of the one component that is meant to work offline. |
| Risk | Vendor lock-in already materialised: the free path was withdrawn mid-project. Licence and terms can change again. |

### B. openWakeWord

| Criterion | Assessment |
|---|---|
| Licence and cost | Free. Code is **Apache-2.0**. The bundled pre-trained models (including `hey_jarvis`) are **CC BY-NC-SA 4.0** because some training data has unknown or restrictive licences. Fine for a free, non-commercial MIT project; **not** fine if JARVIS is ever sold or bundled commercially (see plan 36). Models the owner trains are a separate licensing question (depends on the training data used; record in the licence register, Q12). |
| Accuracy | Project target for its models: under 5 % false rejects and under 0.5 false accepts per hour, tuned on ~5.5 h of far-field party audio (Dinner Party Corpus). Good but generally a step behind Porcupine; it improves with a per-household threshold and the plan-02 "TV mode". |
| CPU / size | Three small ONNX models in a chain (mel-spectrogram → shared speech embedding → per-phrase classifier), a few MB in total. One Raspberry Pi 3 core runs 15–20 models in real time, so a laptop cost is small; measure it in Q09. |
| Custom phrases | Yes, without any account: generate several thousand synthetic clips with an open TTS (Piper), mix with negative audio, train the small classifier head; a Colab notebook does a basic model in under an hour. English phrases only for the documented pipeline. |
| Windows support | Python package supports Windows via onnxruntime. For JARVIS the relevant path is ONNX in JavaScript, which runs on any OS: `onnxruntime-web` in the page or `onnxruntime-node` (Windows x64 binaries) in the bridge. |
| Fit with the bridge | No official JavaScript port, so Q09 must port the small feature pipeline (16 kHz PCM, 80 ms frames → mel → embedding → classifier score 0..1). Runtime already in the dependency tree. |
| Risk | Upstream is quiet (last PyPI release 0.6.0, Feb 2024), so we own the JS port. The models are plain ONNX files, so this does not block us. |

### C. (For comparison) open-vocabulary keyword spotting, e.g. sherpa-onnx KWS

Apache-2.0, runs on Windows, Node.js and WebAssembly, and spots **any typed phrase with no
training** (a small streaming ASR model constrained to a keyword list). That makes it attractive
for the rename and for plan 02 phase 7. It is heavier than a dedicated wake model and its
false-accept rate on always-on TV audio is unproven for us. Model licences vary per model and
must be checked before shipping. Listed so the owner knows a third path exists; not
recommended as the first engine.

### Also considered

- **microWakeWord** (ESPHome): Apache-2.0, ships a `hey_jarvis` model, designed for ESP32-S3 and
  the Home Assistant Android app. TFLite-Micro, not a natural fit for a browser or Node process
  today; relevant later for plan 03 satellites.
- **Keep the transcript regex**: fails the plan-02 goal; stays as the last fallback with a visible
  "cloud listening" badge.

## Where it runs: page or bridge

| | Page (WASM / onnxruntime-web) | Bridge (onnxruntime-node) |
|---|---|---|
| Audio path | Mic is already in the page; nothing new crosses a socket | Page must stream raw PCM to the bridge over the local WebSocket |
| Privacy | Audio never leaves the tab | Audio stays on the machine (localhost), but adds a raw-audio channel to secure and test |
| CPU | Shares the tab with the Three.js HUD; worker/AudioWorklet needed | Separate process, unaffected by HUD frame rate |
| Satellites (plan 03) | One detector per browser | One place for many rooms' streams |

## Recommendation

**Option B, openWakeWord, running in the page** (onnxruntime-web in an AudioWorklet or Worker),
behind a small `WakeDetector` interface so the same models can later run in the bridge for
satellites. Concretely for Q09:

1. Port the openWakeWord feature pipeline to TypeScript and load the `hey_jarvis` model;
   keep a 2–3 s ring buffer so words after the name are kept (plan 02 phase 2).
2. In `wake` mode, drop VAD blobs locally; only a wake event starts STT. Add the network-audit
   test from plan 16 (zero upload bytes while asleep).
3. Add the Settings toggle and a sensitivity threshold, a false-wake counter in Diagnostics, and
   keep the regex path as the visible "cloud listening" fallback.
4. Remove the unused `@picovoice/*` dependencies and the `VITE_PICOVOICE_ACCESS_KEY` /
   `WAKE_ENGINE` code, since keys can no longer be obtained for free. (Or keep Porcupine as an
   opt-in for users who already hold an enterprise key; the owner's call.)
5. Record the model licences (CC BY-NC-SA 4.0 for the pre-trained models) in the licence
   register (Q12).

Why: Porcupine is now unavailable to an open-source personal project without an enterprise
contract, and its key requirement puts a vendor account in front of the one component that must work
offline. openWakeWord is free, needs no account, runs on the ONNX runtime already in the tree,
ships a "hey jarvis" model, and lets the owner train a new phrase if the product is renamed.
The cost is a JS port of a small pipeline and somewhat lower accuracy, which plan 02's tuning
phase is designed to recover.

If the rename to a new name goes ahead, revisit option C before training a custom openWakeWord
model: it may give a working wake phrase on day one while a dedicated model is trained.

## Consequences and questions for the owner

- **Commercial use:** the pre-trained openWakeWord models are non-commercial. If JARVIS might be
  sold or bundled commercially (plan 36 sustainability decision), plan to train our own model
  on data with known licences before that happens.
- **Plan 02 fallback matrix** ("Engine + key present → Porcupine; no key → openWakeWord") should
  be updated once this is decided: there is no longer a free-key path.
- **Phrase:** "hey jarvis" (two words) is what the open model expects, while today's regex also
  accepts bare "Jarvis". Bare-name detection would need a custom model.

## Sources (checked 2026-10-23)

- Home Assistant Community, "FYI, Picovoice confirmed Free Tier AccessKeys will stop working after
  June 30, 2026" (4 June 2026, quoting Picovoice email):
  https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744
- Picovoice FAQ (Free Trial, no personal or non-commercial plans): https://picovoice.ai/docs/faq/general/
- sannabot issue "Picovoice changed to enterprise only model": https://github.com/sannabotdev/sannabotapp/issues/4
- Third-party pricing tracker (unofficial, ~$6,000/month entry): https://www.xpay.sh/saas-pricing/picovoice-ai/
- openWakeWord on PyPI (licences, accuracy targets, CPU, audio format, training): https://pypi.org/project/openwakeword
- Home Assistant, "The Home Assistant approach to wake words" (openWakeWord vs microWakeWord, hey_jarvis, training with Piper): https://home-assistant.io/voice_control/about_wake_word
- ESPHome micro-wake-word models (Apache-2.0, `.tflite`): https://github.com/esphome/micro-wake-word-models
- sherpa-onnx (Apache-2.0, keyword spotting, Windows/WebAssembly/Node.js): https://pkg.go.dev/github.com/k2-fsa/sherpa-onnx

Not verified in this run: Picovoice's official pricing page (no public prices) and the openWakeWord
GitHub README (fetch was not permitted); Q09 should re-check the `hey_jarvis` model file and its
licence notice before bundling.
