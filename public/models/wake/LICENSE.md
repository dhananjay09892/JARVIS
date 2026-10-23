# Offline wake-word models

These three ONNX files are the [openWakeWord](https://github.com/dscripka/openWakeWord)
models used by `src/lib/wake/` (plan 02, ADR 002). They are shipped unmodified, exactly as
published in openWakeWord release **v0.5.1**
(`https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/<file>`), so JARVIS
never fetches them at run time.

| File | SHA-256 | What it is | Licence |
|---|---|---|---|
| `melspectrogram.onnx` | `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f` | ONNX port of a Torch mel-spectrogram function (feature front end) | Distributed by openWakeWord with its models; treated as CC BY-NC-SA 4.0 below until confirmed otherwise |
| `embedding_model.onnx` | `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f` | openWakeWord's re-implementation of Google's `speech_embedding` model (TFHub, Apache-2.0) | Upstream Google model: Apache-2.0. Treated as CC BY-NC-SA 4.0 below until confirmed otherwise |
| `hey_jarvis_v0.1.onnx` | `94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb` | Pre-trained "hey jarvis" classifier | **CC BY-NC-SA 4.0** |

openWakeWord states: "All of the included pre-trained models are licensed under the
Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International license", because
some training data has unknown or restrictive licences. Its code is Apache-2.0.

Attribution: openWakeWord by David Scripka, https://github.com/dscripka/openWakeWord.
Licence text: https://creativecommons.org/licenses/by-nc-sa/4.0/

**Non-commercial.** These models may not be used in a commercial product. Before any
commercial release of JARVIS, train our own wake model on data with known licences
(ADR 002, plan 36, `plans/LICENCES.md`).
