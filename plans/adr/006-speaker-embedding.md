# ADR 006 · Speaker embedding: which model, and where it runs

- **Status:** Proposed (waiting for the owner)
- **Plan:** [01 Speaker identification](../01-speaker-identification.md) · roadmap open decision 3 in [37](../37-execution-roadmap-and-risks.md) · licences in [36](../36-economics-and-licensing.md) and [LICENCES.md](../LICENCES.md)
- **Queue:** written by Q27; Q28 (speaker ID MVP) only starts once the line below is filled
- **Date checked:** 2026-10-26
- **Decision:**

> Numbering note: the queue asked for `003-speaker-embedding.md`, but 003 is the custom wake word
> record (Q50), 004 is reserved for the vector store (Q37) and 005 for scheduled publishing
> (Q57). This record takes the next free number, **006**. Q28's "Needs you" line still says
> "ADR 003"; it means this file.

## Context

Plan 01 wants JARVIS to know **who** is speaking, within a sentence, so it can load that person's
memory and preferences and pass a real `Identity` (`shared/contracts.ts`, plan 38) to the policy
engine. Identity never authorises on its own: risky actions still need an approval click (plan 15).
The building block is a **speaker-embedding model**: it turns a few seconds of speech into a
fixed-length vector (typically 192–512 numbers); two vectors from the same person have a high
cosine similarity. A voiceprint is a handful of such vectors per person.

What the code has today (checked on `main`, 2026-10-26):

- **Audio path.** `src/lib/vad.ts` records each utterance as a compressed Opus/WebM blob with
  `MediaRecorder`; `src/lib/voice.ts` posts it to the bridge's `POST /stt`, which forwards it to
  ElevenLabs Scribe. So the bridge already receives every utterance, but **compressed**: Node has
  no built-in Opus decoder, so the bridge cannot get PCM from it without adding ffmpeg or a
  decoder package.
- **The page already has 16 kHz PCM.** The offline wake engine (`src/lib/wake/engine.ts`, Q09)
  taps the microphone in an AudioWorklet, resamples to 16 kHz (`src/lib/wake/resample.ts`) and
  runs ONNX models with `onnxruntime-web` (WebAssembly, one thread).
- **ONNX runtimes are already in the tree.** `onnxruntime-web` is a direct dependency;
  `onnxruntime-node` 1.21.0 (MIT, prebuilt Windows x64 binaries) arrives through
  `kokoro-js` → `@huggingface/transformers`. Nothing in the bridge uses it yet.
- **No identity anywhere.** Utterances carry text only.

Constraints that shape the choice (plans/README.md "Standing constraints"): raw audio and
voiceprints stay local; Windows installer first; every feature has an off switch, tests and a
metric; and plans 36/41 keep a commercial path open, so model licences matter.

## What the model has to do

| Need | Why |
|---|---|
| Run offline on a laptop CPU | Voiceprints never leave the machine (plan 01, standing constraints) |
| ≤ 150 ms added per utterance, in parallel with STT | Plan 01 metric |
| Good on 2–5 s far-field clips, Indian English, Hindi and Gujarati | The household (plan 28); short commands are the common case |
| Licence that allows redistribution, ideally commercial use | Plan 36 licence register; a model we cannot ship is a dead end |
| ONNX file available | Same runtime as the wake engine; no Python on the user's machine |

Accuracy on the standard benchmark (VoxCeleb1-O, equal error rate) is a useful **ranking**, not a
prediction for this house: it is clean-ish celebrity interview audio. Every model below is in the
0.6–0.9 % range there, which is far better than plan 01's 5 % target for ≥ 3 s sentences. The
real risks are short clips, room echo and accents, so the decision should favour licence, size and
ease of swapping, and Q28 should measure on the owner's own voices.

## Options: the model

All of these take 16 kHz mono audio and 80-dim log-mel filterbank (Kaldi "fbank") features, so the
feature front end is the same whichever is picked. Ready-made ONNX exports of the first four
families are published by the sherpa-onnx project (`csukuangfj/speaker-embedding-models`).

### A. WeSpeaker CAM++ or ResNet34, trained on VoxCeleb

| Criterion | Assessment |
|---|---|
| Licence | Code Apache-2.0. WeSpeaker says its pretrained models "follow the license of the corresponding dataset", and the VoxCeleb models are **CC BY 4.0** (attribution). VoxCeleb itself is offered under CC BY 4.0 "for research purposes", and "the copyright remains with the original owners of the video". Fine for a free MIT project; for commercial use the training-data question is a grey area to record in the licence register (it is the norm for nearly all open speaker models). |
| Accuracy | VoxCeleb1-O EER: CAM++ **0.654 %**, ResNet34 **0.723 %** (WeSpeaker VoxSRC 2023 baselines). |
| Size / CPU | ONNX ≈ 29 MB (CAM++) or 26.5 MB (ResNet34). CAM++ was designed to be lighter to compute than ResNet34 at similar accuracy. |
| Languages | Trained on VoxCeleb 1+2 (many nationalities and accents, mostly English speech). No Hindi/Gujarati-specific data. |
| Fit | Official ONNX runtime exports; the `_LM` variants (large-margin fine-tuned) are also available at the same size. pyannote's diarization uses the ResNet34-LM model, so it is widely exercised. |

### B. 3D-Speaker CAM++ / ERes2Net (Alibaba / ModelScope)

| Criterion | Assessment |
|---|---|
| Licence | Repository Apache-2.0; the ModelScope model releases are mirrored as Apache-2.0 (the model pages themselves should be re-checked before bundling). Clearer model licence than A, but the training data (a "Mandarin dataset with 200k labelled speakers") is not named. |
| Accuracy | VoxCeleb1-O EER: CAM++ 0.65 %, ERes2NetV2 0.61 %; CN-Celeb 6.1–6.8 %. |
| Size / CPU | CAM++ ≈ 28–30 MB; ERes2Net 26–221 MB depending on variant. |
| Languages | Mostly Mandarin training data; an English VoxCeleb CAM++ and a Chinese+English "advanced" CAM++ exist. Transfer to Indian voices is untested. |
| Fit | ONNX exports available (sherpa-onnx); same fbank front end as A. |

### C. NVIDIA NeMo TitaNet (small / large)

| Criterion | Assessment |
|---|---|
| Licence | **CC BY 4.0** model card. Trained on VoxCeleb 1+2, Fisher, Switchboard, LibriSpeech and NIST SRE 2004–2010; Fisher, Switchboard and SRE are LDC corpora with their own licences, which adds to the commercial grey area. |
| Accuracy | TitaNet-L VoxCeleb1 EER **0.66 %**; strong diarization results on telephone and meeting audio (AMI, CH109). |
| Size / CPU | Large ≈ 23 M parameters, ONNX 101 MB; small ONNX 40 MB. The heaviest option here. |
| Languages | English training data, broader channel variety (telephone, meetings) than VoxCeleb alone. |
| Fit | ONNX exports available (sherpa-onnx). |

### D. SpeechBrain ECAPA-TDNN (`spkrec-ecapa-voxceleb`)

| Criterion | Assessment |
|---|---|
| Licence | Model card says **Apache-2.0**, though it is trained on VoxCeleb 1+2 (same data question as A). |
| Accuracy | VoxCeleb1-test EER **0.69 %**. |
| Fit | PyTorch checkpoint only; no maintained ONNX export, so we would own an export and its parity test. The most familiar name in plan 01, but more work than A–C for no accuracy gain. |

### Also considered

- **Picovoice Eagle:** a polished commercial speaker-recognition SDK, but it needs a Picovoice
  AccessKey, and ADR 002 found that Picovoice no longer offers free or personal keys. Rejected for
  the same reason as Porcupine.
- **Models trained on VoxBlink2** (WeSpeaker SimAMResNet, multilingual): attractive for accents,
  but the VoxBlink2 dataset is **CC BY-NC-SA 4.0** (non-commercial, share-alike). Not a default;
  could be an opt-in "better for my accent" model for personal use only.
- **WavLM / w2v-BERT based embedders:** best research numbers, but hundreds of MB and too slow for
  a per-utterance CPU budget. Not now.

## Options: where it runs

| | Page (onnxruntime-web, WebAssembly) | Bridge (onnxruntime-node, native) |
|---|---|---|
| Getting PCM | Already there: the wake engine's 16 kHz tap, or `decodeAudioData` on the VAD blob | Page must send 16 kHz PCM (a WAV) to the bridge over localhost; the existing Opus blob cannot be decoded without adding ffmpeg |
| Speed | One WASM thread, sharing the tab with the Three.js HUD and the wake models; a 30 MB model also has to be loaded into every tab | Native, multi-threaded, unaffected by HUD frame rate; one copy in memory |
| Where voiceprints and matching live | Embeddings would have to be sent to the bridge anyway: voiceprints belong in the encrypted local store, next to memory and policy | Embedding, matching and storage all in one process, next to the policy engine that consumes the `Identity` |
| Trust | The page decides who is speaking; anything that can script the page can claim to be the owner | The bridge decides; the page only supplies audio |
| Satellites (plan 03) | One model per browser | One service for every room's audio |
| Privacy | Audio never leaves the tab | Audio crosses localhost only (as it already does for `/stt`); never leaves the machine |

## Recommendation

**Model: WeSpeaker CAM++ trained on VoxCeleb (`wespeaker_en_voxceleb_CAM++.onnx`), with the
ResNet34-LM model as the pre-agreed fallback. Run it in the bridge with `onnxruntime-node`.**

Concretely, for Q28:

1. Add a `SpeakerEmbedder` interface in the bridge (`embed(pcm16k) → Float32Array`, plus a
   `modelId`). Store `modelId` with every voiceprint embedding, so changing model later means
   "re-enrol", never silently mixing vectors.
2. The page sends the utterance as 16 kHz mono PCM to a new `POST /speaker/identify` **in
   parallel** with `/stt` (it already has the samples from the wake tap or `decodeAudioData`).
   Raw audio is not stored; only embeddings are kept, and only after enrolment.
3. Port the Kaldi fbank front end (80 mel bins, 25 ms window, 10 ms shift, mean normalisation) to
   JavaScript with a parity test against reference features, the same way Q09 ported
   openWakeWord's front end. (Alternative: the `sherpa-onnx-node` package, Apache-2.0, does the
   front end and embedding for all models above, but adds a second native runtime; only if the
   port proves hard.)
4. Bundle the ONNX file in the installer (no download at run time), add its row to the licence
   register with attribution to WeSpeaker and VoxCeleb (CC BY 4.0), and confirm
   `onnxruntime-node`'s Windows binary actually lands in the installer stage.
5. Measure on the owner's voices before trusting the numbers: enrol two people, 40 alternating
   sentences (plan 01 acceptance test), report accuracy, false accepts and added latency in the
   turn trace (plan 16). If CAM++ misses the targets, try ResNet34-LM and 3D-Speaker's
   Chinese+English CAM++ with the same front end before anything bigger.

Why: all the candidates are close on the benchmark, so the deciding factors are licence, size
and fit. WeSpeaker CAM++ is the most accurate of the small models, is ~29 MB, has an official ONNX
export, and its licence (CC BY 4.0) allows redistribution with attribution. Running in the bridge
keeps voiceprints and the identity decision in the same process as the policy engine, avoids
loading another 30 MB model into a tab already running the HUD and the wake models, and works
unchanged for satellites later. The cost is sending PCM over localhost, which the page already
does in compressed form for `/stt`.

## Consequences and questions for the owner

- **Commercial use:** every good open speaker model is trained on VoxCeleb or similar web/LDC
  data. The model licence (CC BY 4.0 or Apache-2.0) allows commercial use, but VoxCeleb is
  published "for research purposes". Treat this like the openWakeWord question: fine for the free
  project; get the plan 36 legal review to look at it before any paid release, or prefer option B
  if a clean model licence matters more than named training data.
- **Biometric consent:** enrolment stores biometric data. Q28 must add explicit consent at
  enrolment, in-app delete (hard delete), and a line in `DISCLAIMER.txt` (plan 01 risks).
- **Hindi and Gujarati:** no candidate is trained on these languages specifically. Speaker
  embeddings are mostly language-independent, but Q28's test should include each person speaking
  each of their languages, and enrolment should collect a sentence in each.
- **Never sole authentication:** a recording can fool any of these models. This does not change
  the plan 15 rule: identity selects memory and role; risky actions still need the approval click.

## Sources (checked 2026-10-26)

- WeSpeaker pretrained models and licence note: https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md
- WeSpeaker baselines for VoxSRC 2023 (VoxCeleb1-O EERs for CAM++, ECAPA-TDNN, ResNet34): https://arxiv.org/pdf/2306.15161
- pyannote's packaging of WeSpeaker ResNet34-LM (CC BY 4.0): https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM
- VoxCeleb dataset page (CC BY 4.0, research purposes, copyright with video owners): https://mm.kaist.ac.kr/datasets/voxceleb/
- 3D-Speaker (Apache-2.0, CAM++/ERes2Net results): https://github.com/modelscope/3D-Speaker
- CAM++ mirror stating Apache-2.0 for `iic/speech_campplus_sv_zh-cn_16k-common`: https://huggingface.co/jingyaogong/campplus
- NVIDIA TitaNet-Large model card (CC BY 4.0, 0.66 % EER, training data): https://huggingface.co/nvidia/speakerverification_en_titanet_large
- SpeechBrain ECAPA-TDNN model card (Apache-2.0, 0.69 % EER): https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb
- sherpa-onnx ONNX exports of speaker-embedding models (file sizes): https://huggingface.co/csukuangfj/speaker-embedding-models/tree/main
- sherpa-onnx (Apache-2.0; speaker identification; Node.js, Windows, WebAssembly): https://pkg.go.dev/github.com/k2-fsa/sherpa-onnx
- VoxBlink2 (CC BY-NC-SA 4.0): https://raw.githubusercontent.com/VoxBlink2/ScriptsForVoxBlink2/main/README.md
- Picovoice key situation: see ADR 002 sources.

Not verified in this run: the licence text on the ModelScope model pages themselves (only a
mirror), CAM++ and ResNet34 CPU latency on a low-end Windows laptop (Q28 measures it), and the
embedding dimension of each ONNX export (read it from the file in Q28).
