# Wake-model recipe: "Hey Tamelo", "Hey Buddy", "Hey Friend"

A reproducible way to train our own openWakeWord-style wake models, using **only inputs whose
licences allow commercial use**, so the assistant can ship without the non-commercial
`hey_jarvis` model (licence risk **B4** in [`plans/LICENCES.md`](../../plans/LICENCES.md)).
Written by the plan autopilot (task Q47, plan [02](../../plans/02-offline-wake-word.md));
running it is task Q48, on a machine with a GPU.

Each phrase is its own small classifier on a shared front end (mel spectrogram → 96-number
embedding), exactly like the engine in `src/lib/wake/`, so all three can run at once for very
little CPU (plan 02, "Multiple and custom wake words").

> **Status.** The front-end check (`test_frontend.py`) and the config tests run in CI-like
> conditions. The download, generation and training scripts have **not** been run end to end:
> the autopilot has no GPU and could not install the Python packages. Expect to fix small
> things on the first run; start with the 1 % smoke run in step 3.

## What is in this folder

| File | What it does |
|---|---|
| `sources.json` | Every input the recipe may use, with licence, attribution and where it was checked. Excluded inputs are listed too, with the reason |
| `phrases.json` | Each phrase: spellings for the TTS voices, English near-misses, Hindi and Gujarati negatives |
| `make-configs.mjs` | Builds `configs/<model>.json` (openWakeWord training configs) from the two files above |
| `configs/` | Generated; `node scripts/wake/make-configs.mjs --check` fails if they are stale |
| `frontend_mel.py`, `onnx_weights.py` | Rebuild the mel front end from MIT/ISC formulas and compare it with openWakeWord's file |
| `prepare_frontend.py` | Step 2: write our front end and check it against the published one with onnxruntime |
| `download.py` | Step 1: fetch only what `sources.json` clears for commercial use |
| `generate_clips.py` | Step 3: synthesise positives and negatives with Kokoro and Piper |
| `build_features.py` | Step 4: negative features from real speech, music and noise (once, shared) |
| `train.py` | Steps 5–6: openWakeWord's augmentation and trainer on our front end, plus a model card |
| `recipe.test.mjs`, `test_frontend.py` | Checks that run without a GPU |

## Training inputs (all commercial use OK)

| Input | Used for | Licence |
|---|---|---|
| Kokoro-82M (28 English voices, 4 Hindi voices) | Positives and spoken negatives; Indian-accent English; Hindi/Gujarati negatives | Apache-2.0 |
| Piper `en_US-libritts_r-medium` (904 speakers) | Most positives and spoken negatives | MIT; trained on LibriTTS-R (CC BY 4.0) |
| LibriTTS-R | English speech negatives and validation | CC BY 4.0 |
| Google FLEURS `en_us`, `hi_in`, `gu_in` | Real English, Hindi and Gujarati speech negatives and validation | CC BY 4.0 |
| AI4Bharat Kathbath (Hindi, Gujarati; optional, gated) | More Hindi and Gujarati negatives | CC BY 4.0 (assumed; see `sources.json`) |
| MUSAN | Background noise and music; speech and music negatives | CC BY 4.0 |
| OpenSLR 28 room impulse responses and noises | Reverb and point-source noise | Apache-2.0 |
| Mel front end, rebuilt here | Feature front end | Ours, from torchlibrosa (MIT) / librosa (ISC) formulas |
| Google `speech_embedding` | Feature front end | Apache-2.0 (step 2) |

**Not used** (listed in `sources.json` so the tests can block them): openWakeWord's ACAV100M
negative features and validation features, AudioSet, the Free Music Archive, the MIT impulse
response survey, openWakeWord's pre-trained models, and (until its current terms are checked)
Common Voice. These are what openWakeWord's standard notebook uses and why its models are
non-commercial.

**Main risk: fewer negatives.** openWakeWord's own models were trained on about 30,000 h of negative audio
(its notebook uses a 2,000 h feature file); the commercial-only set here is roughly 250 h (LibriTTS-R train-clean-100 ~54 h,
MUSAN ~100 h, FLEURS ~30 h, plus the synthetic near-misses), more with Kathbath. That may mean
more false wakes, especially for "Hey Friend". If Q48 shows that, add LibriTTS-R
`train_clean_360` and `train_other_500` (same CC BY 4.0 licence, ~30 GB more) to
`sources.json` before reaching for anything with an unclear licence.

Build-time tools (`openwakeword` code, `piper-sample-generator`, `kokoro`, eSpeak NG inside the
phonemisers) are not shipped; only the audio they produce is used for training.

## Machine and time (estimates)

| Need | Estimate |
|---|---|
| GPU | One NVIDIA card with 8–12 GB (an RTX 3060 is enough); CPU-only works but generation and features take several times longer |
| RAM / disk | 32 GB RAM; about 150 GB free disk for `work/` |
| Python | 3.10 or 3.11, PyTorch with CUDA, then `pip install -r scripts/wake/requirements.txt` |
| Downloads | About 30 GB (MUSAN 11 GB, LibriTTS-R ~9 GB, FLEURS ~6 GB, OpenSLR 28 1.3 GB, voices) |
| Step 4 (shared, once) | 1–3 h on a GPU for the ~250 h of audio (more with Kathbath) |
| Steps 3, 5, 6 per phrase | ~1 h generation + ~1 h augmentation + ~1 h training on a GPU |
| Total | Roughly one day of machine time for all three phrases |

## Steps

Run from `scripts/wake/`. Everything large goes to `scripts/wake/work/` (git-ignored), or to
the folder in `WAKE_WORK`.

0. **Tools.** `git clone https://github.com/rhasspy/piper-sample-generator work/tools/piper-sample-generator`
   and check out tag `v3.1.0`; read its `LICENSE.md` and note it in `plans/LICENCES.md`. Install
   the Python requirements.
1. **Download.** `python download.py` (add `kathbath` with `HF_TOKEN` set after accepting the
   dataset's conditions). It refuses anything not cleared in `sources.json` and makes flat
   16 kHz folders for the background and RIR audio. Set `WAKE_RIRS=simulated` to use only the
   simulated impulse responses if the legal review prefers.
2. **Front end.** `python prepare_frontend.py --embedding <file>` (see "Closing B4" below for
   which file). It exports our mel model and stops unless it matches openWakeWord's within 1e-3
   on noise, a tone and a streaming frame.
3. **Clips.** Smoke run first: `python generate_clips.py hey_tamelo --scale 0.01`, then the full
   run for each of `hey_tamelo`, `hey_buddy`, `hey_friend`.
4. **Negative features.** `python build_features.py` (once for all three).
5. **Train.** `python train.py hey_tamelo` (and the other two). Writes
   `work/release/<model>.onnx` and `<model>.MODEL_CARD.md`.
6. **Test with real voices** (Q48): copy the three models and our two front-end files to
   `public/models/wake/`, run the Q45 checks per phrase, including Hindi and Gujarati talk with
   "tame lo" and everyday "buddy"/"friend", and record the numbers in plan 02.

Changing phrases or negatives: edit `phrases.json`, run `node scripts/wake/make-configs.mjs`,
commit both. Adding an input: add it to `sources.json` **and** a row to `plans/LICENCES.md`
(the test checks both).

## Closing B4

B4 is closed for the wake word when all of these are true:

1. **Recipe merged** (Q47): every training input has a commercial-use licence entry. ✅ with this PR.
2. **Mel front end is ours**: rebuilt from MIT/ISC formulas, matching openWakeWord's weights to
   within 4e-9 (`test_frontend.py`). ✅ code; the exported file is produced in step 2.
3. **Embedding front end cleared** (Q53): either re-export Google's `speech_embedding`
   (Apache-2.0) and show the parity check passes, or get written confirmation that
   openWakeWord's `embedding_model.onnx` is Apache-2.0 (its README says the backbone is
   Google's Apache-2.0 TFHub model), and record which in `plans/LICENCES.md`.
4. **Models trained and tested** (Q48) on the step-2 front end, committed with their model cards.
5. **`hey_jarvis` removed** (Q49), together with openWakeWord's front-end files if Q53 replaced them.

Not legal advice: CC BY 4.0 training data is credited in `CREDITS.md` and the model cards to be
safe, and the outside legal review (Q13) should confirm the approach.
