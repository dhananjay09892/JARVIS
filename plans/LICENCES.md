# Licence register

Plan [36](36-economics-and-licensing.md) §3. One row per thing JARVIS depends on, ships or calls:
npm packages, models, voices, fonts, audio, bundled binaries and cloud services. Attributions that
must reach users are in [`CREDITS.md`](../CREDITS.md).

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
| B2 | **Claude Code binary** inside `@anthropic-ai/claude-agent-sdk` platform packages | Proprietary, "SEE LICENSE IN LICENSE.md". Anthropic allows running Claude Code in your product **only** under the Commercial Terms and these conditions: the binary must be unmodified; each end user signs in with their **own** API key, subscription or cloud-provider credential; the product must not pay for, resell or intermediate usage. Anthropic also says third-party developers may not offer Claude.ai login in their own apps or route requests through Free/Pro/Max credentials on users' behalf, while an end user signing in to the **unmodified** Claude Code binary with their own subscription is allowed. JARVIS's design (user's own login, stock binary) appears to fit, but this is exactly the subscription-terms question. | **Needs a decision** | Covered by **Q15**: findings and options in [ADR 001](adr/001-subscription-brain-terms.md), waiting for the owner's decision. Keep the binary unmodified and never store or proxy Claude.ai credentials. Product wording: "Powered by Claude" is allowed; never "Claude Code" as part of the product name. |
| B3 | **Picovoice Porcupine** (`@picovoice/porcupine-web`, `@picovoice/web-voice-processor`) | The SDK code is Apache-2.0 but will not run without a Picovoice AccessKey. Picovoice reportedly ended its Free Tier on **30 June 2026** with no non-commercial tier planned (see ADR 002). The packages are in `dependencies` but **no source file imports them**, so nothing ships today. | Risk (no current exposure) | Decide in ADR 002 (Q09). If openWakeWord is chosen, remove both packages from `package.json`. |
| B4 | **openWakeWord pre-trained models** (planned, Q09) | CC BY-NC-SA 4.0: **non-commercial only**, share-alike. | Risk (not shipped yet) | Fine for a free MIT project. Before any commercial distribution, train a custom model on data with known licences (ADR 002). |
| B5 | **ElevenLabs** voice and Scribe STT (optional, user's own key) | A cloud service under ElevenLabs' terms, not a licence we redistribute. On the ElevenLabs **free plan, output may not be used commercially and must credit ElevenLabs**. The default voice ID `JBFqnCBsd6RMkjVDRZzb` is a stock ElevenLabs library voice, not a clone of anyone. | Note for users | Say in Settings / README that the user's own ElevenLabs plan decides whether they may use the audio commercially. Never ship an ElevenLabs key. |
| B6 | **Inno Setup** (builds the installer) | Not redistributed (the installer runtime is covered by Inno's permissive licence), but jrsoftware **asks commercial users** (for-profit organisations or individuals with more than USD 5,000 annual revenue) to buy a commercial licence. Donations for open-source/freeware count towards that threshold. | Note | No action while JARVIS is free and unfunded. Revisit with the sustainability decision (plan 36 phase 6). |
| B7 | **Node.js runtime** (`node.exe` in the installer) | MIT plus the third-party licences bundled into Node (OpenSSL, ICU, V8 and others), which must travel with the binary. `scripts/package.mjs` copies `node.exe` but **not Node's LICENSE file**. | Fix (small) | Copy Node's `LICENSE` next to `node.exe` in the installer stage (follow-up; needs a Windows build to verify). |
| B8 | **`webgl-constants` 1.1.1** (via `@react-three/drei` → `detect-gpu`) | No licence field in `package-lock.json`. Bundled into `dist/`. | Check | Confirm the licence from the package's repository; if none, ask upstream or check whether `detect-gpu` can be avoided. |
| B9 | **Name and look ("JARVIS", Iron Man style)** | Trademark/IP risk; not a software licence. | Risk | Q13 (legal review) and plan 40 (name and brand). The audio deliberately avoids the film score (see `public/audio/CREDITS.md`). |

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
| `@picovoice/porcupine-web` | 4.0.1 | Apache-2.0 (needs paid AccessKey) | Only with a Picovoice plan (B3) | no (not imported) | — | 2026-10-23 |
| `@picovoice/web-voice-processor` | 4.0.10 | Apache-2.0 | Yes | no (not imported) | — | 2026-10-23 |
| `@react-three/drei` | 10.7.7 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `@react-three/fiber` | 9.7.0 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `@react-three/postprocessing` | 3.0.4 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 | Yes (we take Apache-2.0) | dist | Keep licence notice | 2026-10-23 |
| `dotenv` | 18.0.7 | BSD-2-Clause | Yes | no (setup scripts only) | — | 2026-10-23 |
| `framer-motion` | 12.43.0 | MIT | Yes | dist | Keep licence notice | 2026-10-23 |
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
| openWakeWord `hey_jarvis` (planned, Q09) | Offline wake word | CC BY-NC-SA 4.0 | **No** (B4) | Not shipped yet | — | 2026-10-23 |
| Porcupine built-in "Jarvis" keyword (option in ADR 002) | Offline wake word | Picovoice terms; needs a paid AccessKey | Only with a plan (B3) | Not shipped | — | 2026-10-23 |
| Speaker embedding (planned, Q27/Q28) | Speaker ID | To be recorded with ADR 003 | — | — | — | — |

## Voices and likeness

| Voice | Source | Licence / terms | Notes | Last reviewed |
|---|---|---|---|---|
| System voice (default) | The OS / browser `speechSynthesis` | The OS vendor's terms; nothing redistributed | Runs on-device | 2026-10-23 |
| Kokoro `bm_george`, `bm_fable`, `bm_lewis`, `bm_daniel` | Kokoro-82M voice packs | Apache-2.0 (with the model) | Generic British male voices; not clones of the film actor | 2026-10-23 |
| ElevenLabs voice `JBFqnCBsd6RMkjVDRZzb` (default ID, user's own key) | ElevenLabs voice library | ElevenLabs terms; free plan output non-commercial and must credit ElevenLabs (B5) | Stock library voice, not a clone | 2026-10-23 |

Standing rule (plans/README.md): original or properly licensed voices only; no cloning of the film
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
| Browser speech recognition (Google in Chrome, Microsoft in Edge) | STT and wake word without an ElevenLabs key | The browser vendor's terms; audio leaves the machine (see DISCLAIMER and plan 02) | 2026-10-23 |
| Hugging Face, Google storage, Google Fonts | Model and font downloads | Public CDNs; no account | 2026-10-23 |
| MCP connectors in `src/config.ts` (Zapier, Notion, Linear, GitHub, Stripe, Sentry) | Optional tools | Each vendor's terms, with the user's own account | 2026-10-23 |

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
- openWakeWord model licence: see sources in [ADR 002](adr/002-wake-engine.md).

Not verified in this run: the MediaPipe hand model's licence on its model card (the guide page does not state one), the `webgl-constants` repository licence (B8), the exact files inside the
`phonemizer` package (npm was unreachable from the autopilot's sandbox, so `node_modules` could not
be inspected), and ElevenLabs' own terms page (a third-party summary was used).
