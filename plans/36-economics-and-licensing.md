# 36 · Economics, licensing and sustainability

**Status:** Partial · **Priority:** P1 (before promoting widely) · **Effort:** 1–2 weeks research, then ongoing

## Why
Every capability here has a running cost (models, voice, messaging, hardware) and a licence
(models, voices, code, data). Ignoring them produces surprise bills, takedowns or abandoned
projects. This plan makes cost and licence visible.

## 1. Cost model per user per month (fill with real numbers in Phase 1)
| Line | Driver | Notes |
|---|---|---|
| Brain | subscription (user's own) or API tokens | Subscription = zero marginal cost to the project, but terms risk (21–27); API = pay per token with caps (25) |
| Speech-to-text | minutes of audio | Wake gating (02) cuts this massively; local STT (04) = hardware cost only |
| Text-to-speech | characters | ElevenLabs is the priciest line; local Kokoro/Piper free; cache frequent phrases |
| Messaging | per message / number rental | Telegram free; Twilio SMS/WhatsApp priced per message (20) |
| Vision | per image | Local detection first; snapshots only (11) |
| Hosting/relay | optional managed relay (34) | Self-hosted VPN = free |
| Hardware | mini-PC, mic arrays, satellites | One-time (03, 09, 17) |

Deliverable: a spreadsheet-style table in this file with light / typical / heavy usage
profiles and a recommended budget cap per profile, surfaced in Settings as default caps.

## 2. Cost controls (built into product)
- Per-brain and per-service **monthly caps** with spoken warnings at 80 %, hard stop at 100 % (25, 15).
- **Cheap-first routing** (06): reflex → local → fast model → deep model.
- **Caching:** repeated TTS phrases, prompt caching, memory-based answers.
- **Idle discipline:** no cloud calls while asleep (02).
- Cost shown per turn in diagnostics (16) and a monthly summary by voice.

## 3. Licence register ([`plans/LICENCES.md`](LICENCES.md))
For each dependency: name, licence, commercial-use allowed?, redistribution in the installer allowed?, attribution needed?, obligations, link, last reviewed.
Focus areas:
- **Models:** TTS (Kokoro, Piper, others), STT (Whisper variants), wake-word (Porcupine key terms, openWakeWord models), speaker-embedding models, local LLMs. Some "open" models forbid commercial use.
- **Voices and likeness:** only original or properly licensed voices; no cloning of the film actor or any person without documented consent; no trademark use implying endorsement (see disclaimer / branding items in `IMPROVEMENT_PLAN.md` #5).
- **Vendor SDKs and CLIs:** redistribution of Claude/Codex/Copilot binaries in the installer needs licence confirmation.
- **Assets:** music/SFX credited in `public/audio/CREDITS.md`.
- **JARVIS name/Iron Man IP:** assess trademark/IP risk of the name and visual style for any public or commercial distribution; consider a distinct product name or clear non-affiliation language (existing DISCLAIMER covers part of this; get legal review before monetising).

## 4. Sustainability options for the project (decide later, record in ADRs)
- Fully free and local-first, community-funded.
- Free core + optional paid managed relay / hosted services.
- Paid support or business edition (policy packs, SSO, audit export).
- Marketplace revenue share for skills (19) — only after a security review process exists.

## Phases
1. **Measure real usage (1 w)** with the metrics in 16 on a test household.
2. **Fill the cost table and set default caps (3 d).**
3. **Licence register v1 (1 w)** and fix any blockers (swap models, add attributions). **Register v1 and `CREDITS.md` done (autopilot, 2026-10-23, Q12, awaiting review); fixing the blockers is Q41, which needs your choice on B1 first.**
4. **Legal review of name/branding/IP (external, 1–2 w).**
5. **Cost UI and monthly summary (3 d).**
6. **Sustainability decision record (1 d)** once real numbers exist.

## Risks
Vendor price changes → provider-agnostic design (21); licence changes → pin versions and keep alternatives; IP complaints → proactive legal review.

## Done when
A user can see what JARVIS costs them this month; defaults cap spend; every bundled model, voice and binary has a recorded, compatible licence.

## Autopilot log
- **2026-10-23 — Phase 3, first half (Q12, licence register v1).** Created
  [`plans/LICENCES.md`](LICENCES.md): how JARVIS is distributed (what the Windows installer actually
  redistributes, from `scripts/package.mjs`), then one row per direct npm dependency, the notable
  transitive ones, models, voices, fonts, audio, bundled binaries and cloud services, each with
  licence, commercial use, whether it ships in the installer, obligations and review date, plus
  sources. Added a root [`CREDITS.md`](../CREDITS.md) with the attributions that must travel with
  JARVIS (CC BY 4.0 music, Kokoro, MediaPipe, Node, fonts, Anthropic), linked it from the README,
  and made `scripts/package.mjs` copy it into the installer. Blockers found: **B1** `phonemizer`
  (via `kokoro-js`) is a build of GPL-3.0 eSpeak NG and is bundled into `dist/` even though Kokoro
  is off by default; **B2** the Claude Code binary is shipped under Anthropic's Commercial Terms
  with conditions (ties to Q15); plus smaller items (Node `LICENSE` not shipped, `webgl-constants`
  has no licence field, unused Picovoice packages, Inno Setup's commercial-user licence request).
  **Left:** fixing the blockers (new task Q41, `needs-you` for the B1 choice); the cost table
  (phases 1–2) and legal review (Q13).
