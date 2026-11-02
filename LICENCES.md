# Licence register

Plan 36 §3. One row per thing JARVIS depends on, ships or calls:
npm packages, models, voices, fonts, audio, bundled binaries and cloud services. Attributions that
must reach users are in [`CREDITS.md`](CREDITS.md).

- **v1 written by:** the plan autopilot, task Q12, **2026-10-23**. Licences come from
  `package-lock.json` (npm `license` fields) and from the vendor pages linked below, checked that day.
- **Not legal advice.** This is an engineering inventory to find problems early. The outside legal
  review is Q13.
- **How to update:** when a dependency, model, voice or service is added or upgraded, add or edit its
  row and the "Last reviewed" date in the same PR.

## How JARVIS is distributed (decides which rows matter)

| Channel | What is redistributed | Source |
|---|---|---|
| **Windows installer** (main product) | `node.exe` (the Node runtime), the bridge, the built UI in `dist/` (which bundles every browser dependency, including lazily loaded chunks such as Kokoro), MediaPipe WASM in `public/mediapipe/`, the audio in `public/audio/`, and a production `node_modules` with **only** `@anthropic-ai/claude-agent-sdk`, `ws` and `zod` (and the Agent SDK's platform packages, which contain the **Claude Code binary**). Built with Inno Setup. | `scripts/package.mjs`, `installer/jarvis.iss`, `.github/workflows/release.yml` |
| **Source** (`git clone`, `npm install`) | Only JARVIS's own MIT code. Users fetch dependencies from npm themselves. | `package.json` |
| **Downloaded at run time** (never in the installer) | Kokoro model and voices (Hugging Face), MediaPipe hand model (Google storage), Google Fonts. | `src/lib/kokoro.ts`, `src/lib/hands.ts`, `src/index.css` |

## Blockers and risks

| # | Item | Problem | Severity | Suggested fix |
|---|---|---|---|---|
| B1 | **`phonemizer` 1.2.1** (pulled in by `kokoro-js`) | Its npm licence says Apache-2.0, but it is a WebAssembly build of **eSpeak NG**, which is **GPL-3.0-or-later**. Vite bundles it into `dist/` as part of the lazy Kokoro chunk even though Kokoro is off by default (`VITE_TTS_ENGINE=system`), so the **installer redistributes GPL code inside an MIT product** without GPL notices or a source offer. | **Blocker for the installer** (until checked) | Pick one (owner decision, **Q41**): (a) exclude the Kokoro chunk from installer builds while it stays off by default; (b) swap the G2P step for a permissively licensed one (a dictionary-based English G2P, or plan 04's local speech stack choice); (c) accept GPL-3.0 for that component: ship the eSpeak NG licence and a source link, and have the legal review (Q13) confirm the combination is acceptable. |
| B2 | **Claude Code binary** inside `@anthropic-ai/claude-agent-sdk` platform packages | Proprietary, "SEE LICENSE IN LICENSE.md". Anthropic allows running Claude Code in your product **only** under the Commercial Terms and these conditions: the binary must be unmodified; each end user signs in with their **own** API key, subscription or cloud-provider credential; the product must not pay for, resell or intermediate usage. Anthropic also says third-party developers may not offer Claude.ai login in their own apps or route requests through Free/Pro/Max credentials on users' behalf, while an end user signing in to the **unmodified** Claude Code binary with their own subscription is allowed. JARVIS's design (user's own login, stock binary) appears to fit, but this is exactly the subscription-terms question. | **Decided** (2026-10-23) | ADR 001 accepted: the user's own subscription login stays the default, with an API-key fallback (Q42), and Anthropic is asked for written confirmation (Q44). Keep the binary unmodified and never store or proxy Claude.ai credentials. Product wording: "Powered by Claude" is allowed; never "Claude Code" as part of the product name. |
| B3 | **Picovoice Porcupine** (`@picovoice/porcupine-web`, `@picovoice/web-voice-processor`) | The SDK code is Apache-2.0 but will not run without a Picovoice AccessKey, and Picovoice ended its Free Tier on 30 June 2026 (ADR 002). | **Resolved** (Q09, 2026-10-23) | ADR 002 chose openWakeWord. Both packages, their lockfile entries and the `VITE_PICOVOICE_ACCESS_KEY` / `WAKE_ENGINE` code were removed in Q09. |
| B4 | **openWakeWord pre-trained models** (shipped in Q09, `public/models/wake/`) | CC BY-NC-SA 4.0: **non-commercial only**, share-alike. Shipped unmodified with attribution in `public/models/wake/LICENSE.md` and CREDITS.md. | Risk (non-commercial) | Fine for a free MIT project. Before any commercial distribution, train our own models on data with known licences (ADR 002). **Path to closed** (Q47, [`scripts/wake/README.md`](scripts/wake/README.md#closing-b4)): (1) the commercial-only training recipe and its input register below ✅ Q47; (2) the mel front end rebuilt from MIT/ISC formulas, weights matching openWakeWord's to within 4e-9 ✅ Q47 (code; the file is exported when the recipe runs); (3) the embedding front end cleared: re-export Google's Apache-2.0 `speech_embedding` or get written confirmation (Q53: re-export script `export_embedding.py` and parity check `embedding_parity.py` ready; the run on Google's module is pending because the autopilot could not download it or install TensorFlow); (4) `hey_tamelo`, `hey_buddy`, `hey_friend` trained and tested (Q48); (5) `hey_jarvis` removed (Q49). |
| B5 | **ElevenLabs** voice and Scribe STT (optional, user's own key) | A cloud service under ElevenLabs' terms, not a licence we redistribute. On the ElevenLabs **free plan, output may not be used commercially and must credit ElevenLabs**. The default voice ID `JBFqnCBsd6RMkjVDRZzb` is a stock ElevenLabs library voice, not a clone of anyone. | Note for users | Say in Settings / README that the user's own ElevenLabs plan decides whether they may use the audio commercially. Never ship an ElevenLabs key. |
| B6 | **Inno Setup** (builds the installer) | Not redistributed (the installer runtime is covered by Inno's permissive licence), but jrsoftware **asks commercial users** (for-profit organisations or individuals with more than USD 5,000 annual revenue) to buy a commercial licence. Donations for open-source/freeware count towards that threshold. | Note | No action while JARVIS is free and unfunded. Revisit with the sustainability decision (plan 36 phase 6). |
| B7 | **Node.js runtime** (`node.exe` in the installer) | MIT plus the third-party licences bundled into Node (OpenSSL, ICU, V8 and others), which must travel with the binary. `scripts/package.mjs` copies `node.exe` but **not Node's LICENSE file**. | Fix (small) | Copy Node's `LICENSE` next to `node.exe` in the installer stage (follow-up; needs a Windows build to verify). |
| B8 | **`webgl-constants` 1.1.1** (via `@react-three/drei` → `detect-gpu`) | No licence field in `package-lock.json`. Bundled into `dist/`. | Check | Confirm the licence from the package's repository; if none, ask upstream or check whether `detect-gpu` can be avoided. |
| B9 | **Name and look ("JARVIS", Iron Man style)** | Trademark/IP risk; not a software licence. | Risk | Q13 (legal review) and plan 40 (name and brand). The audio deliberately avoids the film score (see `public/audio/CREDITS.md`). |
| B10 | **LinkedIn publishing** (Q68) | LinkedIn's API Terms of Use §3.1(26) forbid using "the Content or the APIs to automate posting on the LinkedIn Services". The terms do not define it, and the text was last revised in December 2022. Sending one post the owner approved may be fine; a queue that posts later is the risky reading. | Open question, **blocks Q68's LinkedIn half** | Do not build LinkedIn scheduling until **Q81** has an answer. Manual packages (Q63) are unaffected. |
| B11 | **X for agency work** | X's Pay-Per-Use agreement bars providing the API "on a service bureau, rental or managed services basis" (§III(A)(e)) and says self-serve plans are for prototyping, early integrations and "a limited number of end-users" (§III(L)). Running clients' accounts for a fee may need an Enterprise plan. | Risk for Agency mode | X stays Personal mode only until **Q81** has an answer. Plan 41 already lists X as "later". |
| B12 | **YouTube consent for later uploads** | YouTube Developer Policies §III.I(02) allow automated uploads only with "the user's prior specific and express consent", and §III.E.3(d) wants consent "prior to their actual execution". One approval per item for one upload may meet this, but it needs checking. | Input to ADR 005 | Q57 must weigh this. Each approval names the item, channel and time, never a standing permission. Q68 re-checks it. |
| B13 | **Higgsfield trains on what you upload** | Unless you have an Enterprise agreement, Higgsfield may train its models on inputs and outputs (§4.4). Deleting stops future use, but content already used stays in trained models (§16.5(c)). | Risk for client work | Agency mode: no client material, faces or unreleased work in Higgsfield without the client's written consent, or use an Enterprise agreement. Record it in Q70. |

Everything else in the tables below is permissive and compatible with shipping inside an MIT
installer, provided the attributions in `CREDITS.md` and the licence texts in `node_modules` travel
with it.

## npm dependencies (direct)

Versions are the ones locked in `package-lock.json`. "Installer" says whether the package ends up in
the Windows installer (`dist` = bundled into the built UI; `node_modules` = shipped as a package;
no = build-time only).

| Package | Version | Licence | Commercial use | Installer | Attribution / obligations | Last reviewed |
|---|---|---|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.220 | Proprietary: Anthropic Commercial Terms | Under Commercial Terms with conditions (B2) | node_modules (with Claude Code binary) | Binary unmodified; users bring their own credentials; branding rules (B2) | 2026-10-23 |
| `@anthropic-ai/sdk` | 0.115.0 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `@mediapipe/tasks-vision` | 1.0.1 | Apache-2.0 | Yes | dist + WASM in `public/mediapipe` | Keep licence and NOTICE | 2026-10-23 |
| `@react-three/drei` | 10.7.7 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `@react-three/fiber` | 9.7.0 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `@react-three/postprocessing` | 3.0.4 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 | Yes (we take Apache-2.0) | dist | Keep licence notice | 2026-10-23 |
| `dotenv` | 18.0.7 | BSD-2-Clause | Yes | no (setup scripts only) | — | 2026-10-23 |
| `framer-motion` | 12.43.0 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `onnxruntime-web` | 1.22.0-dev.20250409-89f8206ba4 | MIT | Yes | dist (lazy chunk) + WASM in `public/ort` | Keep licence notice. Was already a transitive dependency of `kokoro-js`; made direct in Q09 for the offline wake word | 2026-10-23 |
| `kokoro-js` | 1.2.1 | Apache-2.0 | Yes | dist (lazy chunk) | Keep licence; **see B1 for its `phonemizer` dependency** | 2026-10-23 |
| `react`, `react-dom` | 19.2.8 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `three` | 0.185.1 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `ws` | 8.21.1 | MIT | Yes | node_modules | Keep licence notice | 2026-10-23 |
| `zod` | 4.4.3 | MIT | Yes | node_modules + dist | Keep licence notice | 2026-10-23 |
| `zustand` | 5.0.14 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |

Dev dependencies (`typescript` Apache-2.0; `vite`, `@vitejs/plugin-react`, `oxlint`, `tsx` and the
`@types/*` packages MIT) are build tools and are not redistributed.

## npm dependencies (notable transitive)

| Package | Version | Licence | Pulled in by | Installer | Note |
|---|---|---|---|---|---|
| `phonemizer` | 1.2.1 | Apache-2.0 on npm; contains **eSpeak NG (GPL-3.0-or-later)** | `kokoro-js` | dist | **B1** |
| `@huggingface/transformers` | 3.8.1 | Apache-2.0 | `kokoro-js` | dist | — |
| `onnxruntime-web` | 1.22.0-dev | MIT | `@huggingface/transformers` | dist (JS + WASM) | Ships Microsoft third-party notices in the package |
| `sharp` + `@img/sharp-libvips-*` | 0.34.5 / 1.2.4 | Apache-2.0; libvips **LGPL-3.0-or-later** | `@huggingface/transformers` | no (Node-only, not in the browser build or the installer's runtime set) | Fine for source installs (dynamically loaded); never bundle into the installer without LGPL notices |
| `onnxruntime-node` | 1.21.0 | MIT | `@huggingface/transformers` | no | — |
| `postprocessing` | 6.39.4 | Zlib | `@react-three/postprocessing` | dist | — |
| `webgl-constants` | 1.1.1 | **unspecified** | `detect-gpu` | dist | **B8** |
| `type-fest` | 0.13.1 | MIT OR CC0-1.0 | `serialize-error` | — | — |

Licence counts for the whole production tree (262 packages in `package-lock.json`): MIT 171,
Apache-2.0 27, BSD-3-Clause 16, ISC 13, BlueOak-1.0.0 4, BSD-2-Clause 2, Zlib 1, 0BSD 1,
Unlicense 1, MIT/CC0 dual 1, MPL/Apache dual 1, LGPL-3.0 (sharp/libvips, platform-specific,
optional) 14, Anthropic proprietary 9 (Agent SDK and its platform packages), unspecified 1.

## Models

| Model | Used for | Licence | Commercial use | How it reaches the user | Attribution | Last reviewed |
|---|---|---|---|---|---|---|
| Kokoro-82M v1.0 (`onnx-community/Kokoro-82M-v1.0-ONNX`, q8), by hexgrad | Optional local TTS (`VITE_TTS_ENGINE=kokoro`) | Apache-2.0 | Yes. Trained on public-domain, Apache/MIT-licensed and synthetic audio per its model card | Downloaded from Hugging Face on first use, cached by the browser | Credit Kokoro / hexgrad (CREDITS.md) | 2026-10-23 |
| MediaPipe Hand Landmarker (`hand_landmarker.task`, float16 v1) | Hand-gesture control | Apache-2.0 like the rest of MediaPipe (to confirm against Google's model card) | Yes, assuming Apache-2.0 | Downloaded from `storage.googleapis.com` at run time | Keep licence notice | 2026-10-23 |
| openWakeWord `hey_jarvis_v0.1.onnx` (release v0.5.1) | Offline wake word (Q09) | CC BY-NC-SA 4.0 | **No** (B4) | Committed in `public/models/wake/`, bundled into the UI build | Credit openWakeWord / David Scripka (CREDITS.md, `public/models/wake/LICENSE.md`) | 2026-10-23 |
| openWakeWord `melspectrogram.onnx` and `embedding_model.onnx` (release v0.5.1) | Wake-word feature front end | Distributed by openWakeWord with its CC BY-NC-SA 4.0 models. Q47 found the mel file is a PyTorch 1.11 export of torchlibrosa (MIT) with librosa's Slaney filters (ISC), and rebuilt it (`scripts/wake/frontend_mel.py`); the embedding file is a tf2onnx export of a Keras re-implementation of Google's `speech_embedding` (Apache-2.0). Treated as CC BY-NC-SA 4.0 until replaced (mel: Q48/Q49) or confirmed (embedding: Q53, run `scripts/wake/export_embedding.py` then `embedding_parity.py`; a "match" verdict confirms it) | Treat as **No** (B4) | Same as above | Same as above | 2026-10-23 |
| Speaker embedding (planned, Q28) | Speaker ID | Candidates compared in ADR 006 (recommended: WeSpeaker CAM++ on VoxCeleb, CC BY 4.0; VoxCeleb is published "for research purposes"). Recorded here once the owner decides and Q28 bundles it | Pending decision | — | — | 2026-10-26 |

## Wake-model training inputs (Q47 recipe)

Everything the recipe in [`scripts/wake/`](scripts/wake/README.md) may use to train our own
wake models ("Hey Tamelo", "Hey Buddy", "Hey Friend"). The machine-readable list is
`scripts/wake/sources.json`; `scripts/wake/recipe.test.mjs` fails if an input there has no row
here, or if the recipe uses anything not cleared for commercial use. Nothing below is shipped
except the trained models and the front end, which carry our licence and a model card crediting
these inputs.

| Recipe id | Input | Used for | Licence | Commercial use | Attribution | Last reviewed |
|---|---|---|---|---|---|---|
| `kokoro-82m` | Kokoro-82M, 28 English + 4 Hindi voices | Synthetic positives and negatives (Japanese/French voices not used) | Apache-2.0 | Yes | Kokoro-82M by hexgrad | 2026-10-23 |
| `piper-libritts-r` | Piper voice `en_US-libritts_r-medium` | Synthetic positives and negatives, 904 speakers | MIT (rhasspy/piper-voices); trained on LibriTTS-R (CC BY 4.0) | Yes | Piper / Rhasspy; LibriTTS-R | 2026-10-23 |
| `libritts-r` | LibriTTS-R train-clean-100, test-clean | English speech negatives and validation | CC BY 4.0 | Yes, with attribution | Koizumi et al., 2023 | 2026-10-23 |
| `fleurs` | Google FLEURS `en_us`, `hi_in`, `gu_in` | Real English, Hindi, Gujarati speech negatives and validation | CC BY 4.0 | Yes, with attribution | Conneau et al., 2022 (Google) | 2026-10-23 |
| `kathbath` | AI4Bharat Kathbath, Hindi and Gujarati (optional, gated) | More Hindi/Gujarati negatives | CC BY 4.0 per the card metadata (the card text says CC0 packaging; the stricter one is assumed) | Yes, with attribution | AI4Bharat | 2026-10-23 |
| `musan` | MUSAN | Background noise and music; speech/music negatives | CC BY 4.0 | Yes, with attribution | Snyder, Chen and Povey, 2015 | 2026-10-23 |
| `rirs-noises` | OpenSLR 28 Room Impulse Response and Noise Database | Reverb and point-source noise | Apache-2.0 for the package (real RIRs come from RWCP, REVERB, AIR; `WAKE_RIRS=simulated` uses only the simulated ones) | Yes | Ko et al., 2017 | 2026-10-23 |
| `frontend-mel` | Mel front end rebuilt by `scripts/wake/frontend_mel.py` | Feature front end | Our own export of torchlibrosa (MIT) / librosa (ISC) formulas | Yes | torchlibrosa, librosa | 2026-10-23 |
| `frontend-embedding` | Google `speech_embedding` | Feature front end | Apache-2.0 (as stated by openWakeWord); Q53 confirms or re-exports | Yes, once Q53 is done | Google; openWakeWord re-implementation | 2026-10-23 |

**Excluded** (listed so the test can block them):

| Recipe id | Input | Why not | Last reviewed |
|---|---|---|---|
| `acav100m-features` | openWakeWord's ACAV100M negative features | YouTube-derived audio with no licence | 2026-10-23 |
| `openwakeword-validation-features` | openWakeWord `validation_set_features.npy` | Unknown licence | 2026-10-23 |
| `audioset` | AudioSet | Labels CC BY 4.0, audio is YouTube content | 2026-10-23 |
| `fma` | Free Music Archive | Mixed per-track licences, including NC and ND | 2026-10-23 |
| `mit-ir-survey` | MIT impulse response survey | No licence stated | 2026-10-23 |
| `openwakeword-pretrained` | openWakeWord pre-trained models | CC BY-NC-SA 4.0 | 2026-10-23 |
| `common-voice` | Mozilla Common Voice | CC0 historically, but its current access terms (Mozilla Data Collective) could not be read; add after checking | 2026-10-23 |

**Build-time tools** (not shipped; only the audio they produce is used):

| Recipe id | Tool | Licence | Note |
|---|---|---|---|
| `openwakeword` | openWakeWord 0.6.0 training code | Apache-2.0 | Its bundled models are not used |
| `piper-sample-generator` | piper-sample-generator v3.1.0 | Not read in this run: check its `LICENSE.md` at recipe step 0 | Phonemises with eSpeak NG (GPL-3.0) via piper-phonemize |
| `kokoro` | `kokoro` Python package | Apache-2.0 | Its G2P may fall back to eSpeak NG (GPL-3.0) |
| `tensorflow` | TensorFlow 2.15.1 and tensorflow-hub 0.16.1 | Apache-2.0 | Q53 embedding re-export only (`scripts/wake/export_embedding.py`) |
| `tf2onnx` | tf2onnx 1.16.1 | Apache-2.0 | Q53 embedding re-export only |

## Voices and likeness

| Voice | Source | Licence / terms | Notes | Last reviewed |
|---|---|---|---|---|
| System voice (default) | The OS / browser `speechSynthesis` | The OS vendor's terms; nothing redistributed | Runs on-device | 2026-10-23 |
| Kokoro `bm_george`, `bm_fable`, `bm_lewis`, `bm_daniel` | Kokoro-82M voice packs | Apache-2.0 (with the model) | Generic British male voices; not clones of the film actor | 2026-10-23 |
| ElevenLabs voice `JBFqnCBsd6RMkjVDRZzb` (default ID, user's own key) | ElevenLabs voice library | ElevenLabs terms; free plan output non-commercial and must credit ElevenLabs (B5) | Stock library voice, not a clone | 2026-10-23 |

Standing rule: original or properly licensed voices only; no cloning of the film
actor or any person without documented consent.

## Fonts, audio and other assets

| Asset | Licence | Commercial use | Shipped? | Attribution | Last reviewed |
|---|---|---|---|---|---|
| Music: *Impact Prelude*, *Ossuary 6 – Air*, *Mechanolith* by Kevin MacLeod (incompetech.com) | CC BY 4.0 | Yes, with attribution | Yes (`public/audio/`) | **Required**: see `public/audio/CREDITS.md` and `CREDITS.md` | 2026-10-23 |
| Interface sounds (wake pips, ticks, chime) | Synthesised in `src/lib/sfx.ts`: JARVIS's own MIT code | Yes | Yes (code) | — | 2026-10-23 |
| Fonts: Chakra Petch, JetBrains Mono | SIL Open Font License 1.1 | Yes | No: loaded from Google Fonts at run time | Not required while loaded from Google Fonts; required if ever bundled | 2026-10-23 |
| `public/favicon.svg`, `src/assets/*` | JARVIS's own (MIT) unless noted | Yes | Yes | — | 2026-10-23 |

## Bundled binaries and build tools

| Item | Licence | Redistributed? | Obligations | Last reviewed |
|---|---|---|---|---|
| Node.js runtime (`node.exe`, Node 22.13+) | MIT plus bundled third-party licences | Yes (installer) | Ship Node's `LICENSE` with it (**B7**) | 2026-10-23 |
| Claude Code binary (via Agent SDK) | Anthropic Commercial Terms | Yes (installer) | **B2** | 2026-10-23 |
| Inno Setup 6 | Inno Setup licence (permissive; commercial users asked to buy a licence) | Its installer stub, yes | **B6** | 2026-10-23 |

## Cloud services (not redistributed; the user's own account)

| Service | Used for | Terms that matter | Last reviewed |
|---|---|---|---|
| Anthropic (Claude subscription or API key) | The brain | Consumer or Commercial Terms, Usage Policy; credential rules in B2 / Q15 | 2026-10-23 |
| ElevenLabs (optional key) | TTS and Scribe STT | B5 | 2026-10-23 |
| Browser speech recognition (Google in Chrome, Microsoft in Edge) | STT without an ElevenLabs key; the wake word too only when cloud listening is on (offline wake word off or failed) | The browser vendor's terms; audio leaves the machine (see DISCLAIMER and plan 02) | 2026-10-23 |
| Hugging Face, Google storage, Google Fonts | Model and font downloads | Public CDNs; no account | 2026-10-23 |
| MCP connectors in `src/config.ts` (Zapier, Notion, Linear, GitHub, Stripe, Sentry) | Optional tools | Each vendor's terms, with the user's own account | 2026-10-23 |

## Content Studio services (plan 41; the user's or client's own account)

Added by Q71 for the plan 41 commercial checklist.
These are services, not redistributed code: each one's terms bind whoever holds the account. "Agency"
means paid work for clients. Not legal advice; Q13 still applies. Plan 41 only uses the platform APIs
from Q66 onward, and each connector re-checks its row in its own PR.

| Service | Used for | Commercial use | Agency work | Terms that matter | Last reviewed |
|---|---|---|---|---|---|
| **Higgsfield** (optional `higgsfield` MCP server, user's own account) | Art Director images and video | **Yes.** "Company does not claim ownership" of inputs or outputs and does not restrict their commercial use (Terms §4.4, updated 2026-10-23). The help centre says rights are not tied to a plan, but only paid plans give watermark-free downloads | Output rights may pass to clients (§4.4). Do not resell the service or give clients standalone access (§1.6, §5.2(i)), and no pass-through of developer access (§11.5) | Training: B13. You need consent for any person's name, likeness or voice (§4.2(b), §5.3), must add legally required AI disclosure (§5.5), and must never present output as human-made (§5.2(xi)). No training other models on output (§5.2(iv)). Keep API keys out of client-side code (§11.3); actions by agents on your credentials are yours (§11.12). Clearing rights before publishing is on you (§13.2). Output may match other users' (§4.4) | 2026-11-02 |
| **Instagram** (Instagram Platform, Q66) | Publishing, insights | **Yes, for the account holder's own posts**; the terms set no fee. Meta bars selling or licensing Platform Data and selling or sublicensing the Platform (Platform Terms, updated 2026-02-03) | Allowed as a Tech Provider: process data "on behalf of and at the direction of your Client" and keep each client's data separate (§5). Each client connects their own account | Developer Policies §1.7: "Obtain consent from people before publishing content or taking any other action on their behalf." Professional account and the app access levels in plan 41 | 2026-11-02 |
| **Facebook Pages** (Pages API, later) | Publishing | As Instagram (same Meta terms) | As Instagram. Needs `pages_manage_posts` and related permissions, and a Page role that can create content | Meta's Access Verification page says that check "is no longer required" and is kept for reference; confirm App Review needs before building | 2026-11-02 |
| **Threads** (Threads API, later) | Publishing | **Unconfirmed.** The API overview sets no fee, but neither it nor the Developer Policies say which terms apply; assumed to be the Meta terms above | As Instagram, once confirmed | 250 API posts, 1,000 replies and 100 deletions per 24 h per profile; `threads_basic` + `threads_content_publish`. Confirm terms before building | 2026-11-02 |
| **YouTube** (Data API `videos.insert`, Q68) | Upload | **Yes.** Developer Policies list "Selling an API Client" and ad-enabled clients as allowed; selling or sublicensing the API services is not | Allowed with authority to bind the client (ToS §3.3). Every request must name the channel. One API project per client application, not per customer | B12. Users keep "final control" of what is published (§III.C). Clients must link YouTube's Terms and Google's Privacy Policy and require a privacy policy. YouTube may audit at any time (ToS §6). Default quota 100 `videos.insert` calls a day; more needs a compliance audit. The `videos.insert` page (2026-10-15) now says unverified projects' uploads "are not restricted to private viewing mode", which differs from older Google pages: test it in Q68 | 2026-11-02 |
| **LinkedIn** (Share on LinkedIn / Posts API, Q68) | Publishing | **Limited.** No API fee today, but no charging users extra for API access or Content. Self-serve is only for apps that do not use Content for advertising (§1) | **Unclear.** Credentials and Content may not go to anyone beyond your employees (§3.1(02)); enterprise apps need customer agreements (§5.1). Company Pages need the reviewed Community Management API (third-party source) and its Marketing API Terms, not yet read | B10. No impersonating a member (§3.1); store Content only as long as needed and delete on request. Terms last revised 2022-12-13 | 2026-11-02 |
| **X** (X API v2, later) | Publishing | **Limited.** Pay-per-use is for prototyping, early integrations and apps with few end users; beyond that needs Enterprise (§III(L)) | **Probably not on self-serve**: B11 | No selling or redistributing API material, no training a foundation or frontier model on it (§III(A)(k)). Automation Rules: no identical posts across accounts, label bots, explicit consent before automated replies or DMs. The agreement page shows no calendar date | 2026-11-02 |

## Sources (checked 2026-10-23)

- `package-lock.json` in this repo (npm licence fields for all 262 production packages).
- Claude Agent SDK overview, "License and terms" and "Branding guidelines": https://code.claude.com/docs/en/agent-sdk/overview
- Claude Code legal and compliance ("Can customers offer Claude Code in their products?", "Authentication and credential use"): https://code.claude.com/docs/en/legal-and-compliance
- `phonemizer` on jsDelivr (Apache-2.0, "text to phones converter using eSpeak NG"): https://www.jsdelivr.com/package/npm/phonemizer
- eSpeak NG licence (GPL-3.0-or-later), e.g. Arch Linux ARM package: https://archlinuxarm.org/packages/aarch64/espeak-ng
- Kokoro-82M licence and training data: https://huggingface.co/hexgrad/Kokoro-82M (summarised at https://featherless.ai/models/hexgrad/Kokoro-82M)
- MediaPipe Hand Landmarker guide and model card: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker
- Picovoice Free Tier ending 30 June 2026 (second-hand, quoting Picovoice): https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744
- ElevenLabs free-plan output rights (summary of the ElevenLabs terms): https://terms.law/ai-output-rights/elevenlabs/
- Inno Setup licence text (permits commercial use): https://feed.nuget.org/packages/Tools.InnoSetup/6.7.0/License and commercial licence request: https://jrsoftware.org/isorder.php
- openWakeWord model licence: see sources in ADR 002.

- Wake-model training inputs (Q47): openWakeWord licences and training summary https://pypi.org/project/openwakeword ; piper-sample-generator https://github.com/dscripka/piper-sample-generator and releases https://github.com/rhasspy/piper-sample-generator/releases ; Piper LibriTTS-R voice https://huggingface.co/rhasspy/piper-voices/tree/9df7583dc899c8f5ecaaebf1120a9fd1911e8009/en/en_US/libritts_r ; LibriTTS-R https://www.openslr.org/141/ and LibriTTS https://www.openslr.org/60 ; FLEURS https://huggingface.co/datasets/google/fleurs ; Kathbath https://huggingface.co/datasets/ai4bharat/Kathbath ; MUSAN https://openslr.org/17/ ; OpenSLR 28 https://openslr.org/28/ ; MIT IR survey (no licence stated) https://mcdermottlab.mit.edu/Reverb/IR_Survey.html ; Kokoro voices https://replicate.com/alphanumericuser/kokoro-82m/readme ; what openWakeWord's notebook downloads https://github.com/alfiedennen/openwakeword-colab-2026

Not verified in this run: the MediaPipe hand model's licence on its model card (the guide page does not state one), the `webgl-constants` repository licence (B8), the exact files inside the
`phonemizer` package (npm was unreachable from the autopilot's sandbox, so `node_modules` could not
be inspected), and ElevenLabs' own terms page (a third-party summary was used).

- Content Studio services (Q71, checked 2026-11-02). Higgsfield: Terms of Use https://higgsfield.ai/terms-of-use-agreement ; who owns generations https://higgsfield.ai/creator-hub/help-center/account/who-owns-my-generations-and-can-i-use-them-commercially ; summary of the update effective 2026-08-27 https://higgsfield.ai/blog/terms-of-use-privacy-policy-update . Older press about an "irrevocable, perpetual" licence quotes the 2025 terms and does not match the current text: https://startupfortune.com/higgsfield-ai-tells-creators-they-own-their-videos-but-quietly-claims-a-perpetual-worldwide-license-to-train-on-them/ . Meta: https://developers.facebook.com/terms , https://developers.facebook.com/devpolicy , https://developers.facebook.com/documentation/development/release/access-verification.md , https://developers.facebook.com/documentation/pages-api/getting-started.md , https://developers.facebook.com/docs/threads/overview . YouTube: https://developers.google.com/youtube/terms/api-services-terms-of-service , https://developers.google.com/youtube/terms/developer-policies , https://developers.google.com/youtube/data/guides/quota_and_compliance_audits , https://developers.google.com/youtube/v3/docs/videos/insert . LinkedIn: https://developer.linkedin.com/legal/api-terms-of-use ; Company Page access (third party) https://opentweet.io/answers/can-i-post-to-linkedin-without-partner-approval . X: https://docs.x.com/developer-terms/ppu-agreement , https://developer.x.com/en/developer-terms/policy/platform-usage-guidelines .

Not verified in Q71: Higgsfield's separate API and MCP pages; LinkedIn's Marketing API Terms; Meta's App Review needs for each permission; which terms govern the Threads API. Terms were read through a page summariser, so check quotes against the live page before relying on one.
