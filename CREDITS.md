# Credits

JARVIS is MIT-licensed (see [LICENSE](LICENSE)). It stands on other people's work. This page
holds the attributions that must travel with JARVIS; the full inventory, with licences and open
issues, is the licence register in [LICENCES.md](LICENCES.md).

## Music (attribution required)

Music by Kevin MacLeod (incompetech.com)
- "Impact Prelude" (`public/audio/boot-music.mp3`)
- "Ossuary 6 - Air" (`public/audio/ambient.mp3`)
- "Mechanolith" (`public/audio/work.mp3`)

Licensed under Creative Commons: By Attribution 4.0 — http://creativecommons.org/licenses/by/4.0/

More detail, and a ready-to-paste block for video descriptions: [public/audio/CREDITS.md](public/audio/CREDITS.md).

## Models and voices

- **Kokoro-82M** by hexgrad (Apache-2.0), run in the browser with **kokoro-js** and
  **Transformers.js** by Hugging Face (Apache-2.0) on **ONNX Runtime Web** by Microsoft (MIT).
  Used only when the Kokoro voice is turned on; the model is downloaded on first use.
- **openWakeWord** by David Scripka (code Apache-2.0; pre-trained models CC BY-NC-SA 4.0,
  https://creativecommons.org/licenses/by-nc-sa/4.0/): the "hey jarvis", mel-spectrogram and
  speech-embedding models in `public/models/wake/`, shipped unmodified, run on **ONNX Runtime
  Web** for the offline wake word. Non-commercial; see `public/models/wake/LICENSE.md`.
  https://github.com/dscripka/openWakeWord
- **MediaPipe** Tasks Vision and the Hand Landmarker model by Google (Apache-2.0), for hand gestures.
- Text-to-phoneme conversion for Kokoro uses **eSpeak NG** (GPL-3.0-or-later) through the
  `phonemizer` 1.2.1 package, which is a WebAssembly build of eSpeak NG. We accept the GPL for
  that component and ship its notices: the licence text is in
  [installer/licences/GPL-3.0.txt](installer/licences/GPL-3.0.txt) (installed under `licences\`),
  with the source links in [installer/licences/ESPEAK-NG-NOTICE.txt](installer/licences/ESPEAK-NG-NOTICE.txt).
  Source: https://github.com/xenova/phonemizer.js (phonemizer 1.2.1) and
  https://github.com/espeak-ng/espeak-ng (eSpeak NG). JARVIS's own code stays MIT.

## Software

- **Claude Agent SDK** and **Claude Code** by Anthropic, used under Anthropic's Commercial Terms of
  Service. JARVIS is powered by Claude; it is not made or endorsed by Anthropic.
- **Node.js** (MIT, with bundled third-party licences), shipped inside the Windows installer with its
  `LICENSE` file next to `node.exe`.
- **React**, **three.js**, **react-three-fiber** and **drei** (pmndrs), **postprocessing** (Zlib),
  **Framer Motion**, **Zustand**, **DOMPurify** (Apache-2.0 option of MPL-2.0 OR Apache-2.0),
  **ws**, **zod**, and the other open-source packages listed in `package-lock.json`. Their licence
  texts ship in `node_modules` and, for the built UI, in the bundled code's licence comments.
- The Windows installer is built with **Inno Setup** by Jordan Russell and Martijn Laan.

## Fonts

**Chakra Petch** (Cadson Demak) and **JetBrains Mono** (JetBrains), both under the SIL Open Font
License 1.1, loaded from Google Fonts.

## Speaker recognition

The optional speaker-recognition feature uses the **WeSpeaker CAM++** model trained on VoxCeleb
(WeSpeaker, Apache-2.0 code; model under CC BY 4.0), as exported to ONNX by the
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project, run with `onnxruntime-node` (MIT).
The model is downloaded on first use, not bundled. Test clips are made with the CMU Flite voices.

## Services

Optional, with your own account: **ElevenLabs** (voice and transcription; on the ElevenLabs free
plan, audio must credit ElevenLabs and may not be used commercially), and your browser's speech
service (Google in Chrome, Microsoft in Edge).

## Not affiliated

JARVIS is a fan-inspired project. It is not affiliated with or endorsed by Marvel, Disney or
Anthropic. See [DISCLAIMER.txt](DISCLAIMER.txt).
