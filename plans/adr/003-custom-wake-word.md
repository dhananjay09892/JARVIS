# ADR 003 · Custom wake word: an engine for a name the user types

- **Status:** Proposed (waiting for the owner)
- **Plan:** [02 Offline wake word](../02-offline-wake-word.md), section "Multiple and custom wake words" · settings in [39](../39-settings-and-control-center.md) · per-person names in [30](../30-household-and-family.md)
- **Queue:** written by Q50; Q51 (wake words in Settings, including a custom name) only starts once the line below is filled
- **Date checked:** 2026-10-23
- **Decision:**

> Numbering note: the queue also reserves "ADR 003" for the speaker-embedding record (Q27) and
> `plans/LICENCES.md` mentions it. This file was written first under the number Q50 asked for;
> Q27 should take the next free number (004 is reserved for the vector store by Q37, so 005).

## Context

ADR 002 put openWakeWord in the page: a mel-spectrogram model and a shared 96-number speech
embedding run once per 80 ms frame, and each wake phrase is a tiny classifier on top
(`src/lib/wake/`). Q47/Q48 train fixed phrases ("Hey Tamelo", "Hey Buddy", "Hey Friend") on a
GPU with commercially licensed data. Plan 02 also wants **a name the user types in Settings**
("Hey Max", "Hey Didi", "Hey Dost") that works offline alongside the built-in phrases, and Q51
builds it. That needs an engine that can learn a phrase **on the user's own machine**, with no
cloud, no vendor account and no GPU, in a household that may speak English, Hindi and Gujarati.

What already exists and shapes the choice:

- The front end (mel + embedding) runs in the page on onnxruntime-web, behind the
  `WakeDetector` interface (`detector.ts`), with the score gate (`gate.ts`) and the router that
  drops asleep audio locally (`router.ts`). A new engine only has to implement `WakeDetector`.
- Q47's recipe (merged, `scripts/wake/`) rebuilds the mel front end from MIT/ISC formulas and lists commercially
  usable training inputs in `scripts/wake/sources.json` (Kokoro-82M, Piper LibriTTS-R, FLEURS
  en/hi/gu, MUSAN, OpenSLR 28). Q53 (queued) clears the embedding model (Google
  `speech_embedding`, Apache-2.0).
- Kokoro-82M is already an optional local TTS (`kokoro-js`), but its `phonemizer` bundles
  GPL-3.0 eSpeak NG (licence blocker **B1**, owner decision **Q41**).
- Targets from plan 02: recall ≥ 95 % at 3 m in a quiet room, ≥ 85 % with TV; **false wakes
  ≤ 1 per 8 h** of ambient TV and speech; zero upload bytes while asleep.

The hard part is not detecting the name once; it is **not firing on TV and normal talk for
8 hours** with only a few examples of a phrase nobody trained for.

## Options

### A. Few-shot enrolment on the openWakeWord embeddings

The user says "Hey <name>" 5–10 times. We keep the embedding sequences (16 frames × 96 numbers
per 1.28 s window, the classifier's normal input) and train a tiny classifier **in the page in
seconds**: positives are the user's clips with on-the-fly augmentation (gain, noise, reverb,
small speed change); negatives are a bundled pack of pre-computed embeddings from the Q47
commercial-OK sources plus ~10–30 s of the user's own normal talk and room noise recorded at
enrolment. The classifier plugs in next to the built-in ones on the shared front end.

openWakeWord's own "custom verifier" does something close (a logistic-regression filter trained
from as few as 3 clips per speaker plus ~10 s of their other speech), but **only on top of a base
model for the same phrase**, which a custom name does not have. Its docs warn the result is
tuned to the enrolled speakers and acoustics and must be retrained per user. So option A is our
own small extension of that idea, not an upstream feature.

| Criterion | Assessment |
|---|---|
| Accuracy | Good for the enrolled voice(s), weak for others. Research on 5-shot keyword spotting with a pre-trained embedding reports ~87 % accuracy with a 4.3 % false-accept rate per test utterance (Mazumder et al., 2021): far from "1 false wake per 8 h". Expect it to need a high threshold and a confirmation step (below). |
| False wakes | The main risk. Few positives and a small negative pack mean similar-sounding words and TV will fire it. Mitigations: per-phrase sensitivity, the user's own room negatives, a "Test my wake word" run, require two consecutive frames over threshold, and log false wakes (Q51 Diagnostics counter). |
| CPU (low-end laptop) | Almost none extra: the mel and embedding already run for the built-in phrases; one more classifier is a few thousand multiply-adds per frame. |
| Time until it works | About a minute: 5–10 utterances, then training in a Worker in seconds. |
| Privacy | Fully local. Enrolment clips are raw audio of the user's voice, so they are treated like voiceprints (plan 01, standing constraint): kept on the machine, deletable, never synced; only the embeddings need keeping after training. |
| Licences | No new runtime or model. The negative pack must be built only from Q47's commercial-OK inputs (CC BY 4.0 attributions in CREDITS.md). Depends on Q53 clearing the embedding model, like the built-in phrases. |
| Windows | Same as today: runs in the page on onnxruntime-web; nothing OS-specific. |
| Hindi / Gujarati names | Works on sound, not words, so "Hey Didi" or "Hey Dost" works as well as an English name. But it only knows the enrolled speakers' pronunciation. |
| Size | Negative pack: a few hours of embeddings at int8/fp16 is in the tens of MB (estimate; to be measured). Downloaded on first use of the feature, not in the installer. |

### B. Local keyword spotter (Vosk grammar mode, or sherpa-onnx keyword spotting)

A small offline speech recogniser runs **only on VAD speech segments while asleep** (audio stays
in the page) and checks for "hey <name>". Two candidates:

- **Vosk** (Kaldi): small models are ~40 MB (`en-us`, `en-in`, `hi`) and ~100 MB (`gu`), all
  listed as Apache-2.0, and most small models allow runtime vocabulary changes, so the grammar
  can be `["hey max", "[unk]"]`. `vosk-browser` (Apache-2.0) compiles Vosk to WebAssembly for a
  Web Worker. Limits: a grammar can only contain words already in the model's lexicon, so an
  unusual name ("Tamelo", many family names) is **out of vocabulary** and cannot be spotted
  without rebuilding the model's graph; the training data behind the small models is not
  published; `vosk-browser` is a small project (pinned 0.0.x versions, no tests listed).
- **sherpa-onnx keyword spotting**: an open-vocabulary streaming Zipformer transducer (~3 M
  parameters) that takes keywords as BPE or phone tokens, so **any name works with no training**,
  with per-keyword score and threshold. Runs in WebAssembly, Node.js and on Windows. But the
  English model (`kws-zipformer-gigaspeech-3.3M`) is trained on **GigaSpeech, whose terms allow
  only non-commercial research and education**, so it carries the same commercial problem as
  `hey_jarvis` (B4) whatever the Apache-2.0 tag on the weights says. The zh-en model publishes no
  training-data licence. One third-party test of a similar English model reports 88 % recall and
  0.27 false positives per negative utterance on LibriSpeech, far too many for always-on use.
  There is no Hindi or Gujarati KWS model.

| Criterion | Assessment |
|---|---|
| Accuracy | Speaker-independent: works for guests and children at once. Constrained-grammar recognisers tend to force speech onto the allowed phrase, so the `[unk]` garbage path and a confidence threshold are essential. Unmeasured on our audio. |
| False wakes | Likely higher than a trained wake model, especially on TV, because the recogniser is general-purpose. Running only on VAD segments helps CPU, not false wakes. |
| CPU (low-end laptop) | Highest of the three while asleep: a full acoustic model plus decoding on every speech segment. Fine on a modern laptop; a concern on a low-end one next to the HUD (measure; would need a Worker). |
| Time until it works | Instant once the model is downloaded (40–100 MB per language). |
| Privacy | Fully local (in-page WebAssembly). It is a speech recogniser, so the code must make sure **no transcript of asleep speech is kept or logged**, only the yes/no. |
| Licences | Vosk small models: Apache-2.0 as listed (training data unknown; legal review Q13 should look). sherpa-onnx English KWS: **blocked for commercial use** (GigaSpeech). |
| Windows | Both run in the page (WASM) or in the bridge (native/Node). |
| Hindi / Gujarati names | Vosk has `hi` and `gu` small models, but only for names in their lexicons, and one model per language means running two or three recognisers for a mixed household. |

### C. On-device training with synthetic speech

Do what Q47's recipe does, but on the user's machine for one phrase: synthesise "Hey <name>" in
many voices with a commercially licensed TTS, augment it, and train a real openWakeWord-style
classifier against the same bundled negative pack, in the background in the bridge (CPU), then
hot-swap it in. The user's own enrolment clips (option A) can be added as extra positives.

| Criterion | Assessment |
|---|---|
| Accuracy | Best of the three and speaker-independent, because it sees hundreds to thousands of voices. openWakeWord's quick notebook gets a usable model in under an hour on a GPU; a Google study found a keyword model trained only on synthetic speech over a pre-trained embedding matched one trained on 500+ real examples (Lin et al., 2020). |
| False wakes | Lower than A, but limited by the negative pack: openWakeWord's own models used ~30,000 h of negatives; a commercial-only pack is far smaller (Q47 estimates ~250 h for the full GPU recipe, and an on-device pack would be smaller still). Near-miss negatives can be synthesised per name ("hey" + similar names). |
| CPU (low-end laptop) | Heavy but one-off and in the background: generating a few thousand clips with Kokoro (82 M parameters) plus training is roughly **tens of minutes to a few hours on CPU** (estimate; Q47's GPU figure is ~3 h per phrase at full scale, so the on-device version must be cut down hard). Must pause on battery and yield to the assistant. |
| Time until it works | Minutes to hours. Needs A or B as the engine in the meantime. |
| Privacy | Fully local; nothing leaves the machine. |
| Licences | TTS must allow commercial use: Kokoro-82M is Apache-2.0, **but `kokoro-js` pulls in GPL-3.0 eSpeak NG (B1)**, so the Q41 decision applies here too (a bridge-side Kokoro with a permissive G2P, or Piper voices, MIT, trained on CC BY 4.0 LibriTTS-R). Same negative-pack and Q53 dependencies as A. Each generated model is our user's own; no new third-party model ships. |
| Windows | The bridge runs on Windows (Node 22 + onnxruntime-node). Training needs a small trainer: either port the classifier training to JavaScript (it is a tiny dense network) or ship Python, which the installer avoids today. JavaScript is the realistic path. |
| Hindi / Gujarati names | Kokoro has 4 Hindi voices and no Gujarati; Piper's commercial-OK voice set used by Q47 is English. Indic Parler-TTS (AI4Bharat, listed as Apache-2.0, covers Gujarati and Hindi) could say Gujarati names but is far larger and slower on CPU. Practical answer: synthesise Gujarati names with Hindi and Indian-English voices, and lean on the user's own clips. |
| Size | Adds the TTS voices (Kokoro ~80–330 MB depending on quantisation; already downloaded if the user uses Kokoro for speech) and the negative pack. |

## Comparison

| | A. Few-shot enrolment | B. Keyword spotter | C. On-device training |
|---|---|---|---|
| Works for guests / kids | Weak (only enrolled voices) | Yes | Yes |
| Unusual names (out of vocabulary) | Yes | Vosk: no · sherpa-onnx: yes | Yes |
| False wakes on TV | Highest risk | High risk | Lowest of the three |
| Extra CPU while asleep | ~0 | Highest | ~0 (after training) |
| Ready after | ~1 min | Download | Minutes to hours |
| New download | Negative pack (tens of MB) | 40–100 MB per language | TTS voices + negative pack |
| Commercial licence | OK (with Q47 inputs, Q53) | Vosk OK as listed · sherpa-onnx English **blocked** | OK if B1/Q41 resolved or Piper used |
| Hindi / Gujarati | Yes (sound-based) | Only names in the lexicon | Approximate (Hindi voices) |
| Fits today's code | Plugs into `WakeDetector` and the shared front end | New runtime + models | Same detector; new trainer in the bridge |

## Recommendation

**Option A now, with option C as an optional "Improve accuracy" upgrade; not option B.**

1. **Q51 builds A.** "Add your own name" records 5–10 "Hey <name>" clips and ~20 s of normal
   talk in the room, trains a classifier in a Worker on the shared embeddings, and runs it next
   to the built-in phrases. Ship it with: its own sensitivity defaulting **higher** than the
   built-ins; a two-frame confirmation; the plan 02 name checks; the "Test my wake word" hit
   rate; the per-phrase false-wake counter; and the honest label "Learns your voice; others may
   need to add theirs" (each household member can enrol, plan 30).
2. **A follow-up task builds C** in the bridge: a background, battery-aware job that synthesises
   the name with commercially licensed voices and retrains that same classifier, then swaps it
   in; Settings shows "Improving… / Improved". Blocked on Q41 (B1) for Kokoro, or uses Piper.
3. **Build the negative pack once** from Q47's commercial-OK inputs (it serves A and C), as a
   first-use download with its licence and attributions, measured against the 8-hour false-wake
   target before Q51 ships.
4. **Do not adopt B.** Vosk cannot spot out-of-vocabulary names, which is most custom names, and
   costs the most CPU while asleep; sherpa-onnx's English model is non-commercial (GigaSpeech).
   Revisit sherpa-onnx only if a commercially trained open-vocabulary model appears, and record
   it in `plans/LICENCES.md` first.

Why: A is the only option that works within a minute, offline, for any name in any of the
household's languages, at almost no CPU, with no new runtime or licence question. Its weakness
(speaker dependence and false wakes) is exactly what C fixes, and C reuses A's classifier slot,
negative pack and Settings flow, so nothing built for A is thrown away.

## Consequences and questions for the owner

- **Expectation setting:** a custom name will be less reliable than the trained built-in phrases,
  especially for guests and with TV on. Is that acceptable for the first release of Q51, with C
  as the fix later?
- **Enrolment audio counts as biometric data:** keep it local, deletable, and covered by the
  never-list (plan 35) and the plan 01 voiceprint rules; drop the raw clips after training
  unless the user opts to keep them for retraining.
- **Q41 (B1) now also blocks option C with Kokoro.** Choosing (b) "swap the phonemizer" would
  unblock both local TTS and on-device wake training.
- **Q53 (embedding licence)** blocks A and C as well as the built-in models.
- **Performance check:** the false-wake target should be measured on a few hours of TV and
  Hindi/Gujarati talk before Q51 is called done (same method as Q45/Q48).

## Sources (checked 2026-10-23)

- openWakeWord, "Custom verifier models" (logistic regression on shared features, ≥ 3 positive
  clips and ~10 s of other speech per speaker, needs a base model, retrain per user):
  https://github.com/dscripka/openWakeWord/blob/main/docs/custom_verifier_models.md
- openWakeWord on PyPI (training with synthetic clips, quick notebook under 1 hour, ~30,000 h of
  negatives, English only, Apache-2.0 code, CC BY-NC-SA 4.0 pre-trained models, embedding from
  Google's Apache-2.0 TFHub module): https://pypi.org/project/openwakeword
- Mazumder et al., "Few-Shot Keyword Spotting in Any Language", Interspeech 2021 (5-shot,
  87.4 % accuracy, 4.3 % false-accept rate, 22 languages): https://arxiv.org/abs/2104.01454v3
- Lin et al., "Training Keyword Spotters with Limited and Synthesized Speech Data", ICASSP 2020
  (synthetic-only training on a speech embedding matches 500+ real examples):
  https://arxiv.org/abs/2002.01322v1
- Vosk models list (small `en-us` 40 MB, `en-in` 36 MB, `hi` 42 MB, `gu` 100 MB, Apache-2.0;
  dynamic vocabulary on most small models): https://alphacephei.com/vosk/models
- vosk-browser (Apache-2.0, WebAssembly in a Web Worker): https://github.com/ccoreilly/vosk-browser
- sherpa-onnx English KWS model trained on GigaSpeech:
  https://modulellm-tutorial.readthedocs.io/en/latest/model_pages/kws.html
- sherpa-onnx zh-en KWS model card (custom keywords via `text2token`, per-keyword score and
  threshold; no training-data licence published): https://huggingface.co/openEuler/sherpa-kws
- GigaSpeech terms ("only for non-commercial research and educational purposes"), as quoted on
  a Hugging Face mirror's access form:
  https://huggingface.co/datasets/distil-whisper/gigaspeech-l-token-ids/blob/main/README.md
- Third-party open-vocabulary KWS figures (3.49 M parameters, 88 % recall, 0.27 false positives
  per negative utterance on LibriSpeech test-clean): https://soniqo.audio/guides/wake-word
- Indic Parler-TTS (AI4Bharat, Apache-2.0, Hindi and Gujarati), third-party listing:
  https://tts.ai/voices/indic-parler/?lang=gu
- Q47 recipe inputs and licences: `scripts/wake/sources.json` and `scripts/wake/README.md` on
  `main` (merged in PR #39).

Not verified in this run: the Indic Parler-TTS model card on Hugging Face (fetch not permitted;
re-check licence and size before using it), the training data behind Vosk's small models, and
CPU numbers on a low-end laptop for any option (all CPU and time figures above are estimates to
be measured in Q51).
