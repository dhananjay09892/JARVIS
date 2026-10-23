# JARVIS plans

Written October 2026 against `release/0.1.5`. Start with
[00-vision-and-architecture.md](00-vision-and-architecture.md): the end state, target
architecture, roadmap phases and exit gates. Each numbered plan then has: end state, what
exists today (verified in the repo), phased steps, metrics, and risks.

Status key: **Done** · **Partial** · **Pending**. "Today" statements were checked against code;
anything marked *unaudited* was not read in depth.

## Plan index and gap check

| # | Plan | Status | Priority | Today → missing |
|---|---|---|---|---|
| 00 | [Vision and architecture](00-vision-and-architecture.md) | – | – | Master roadmap |
| 01 | [Speaker identification and presence](01-speaker-identification.md) | Pending | P1 | STT returns text only → voiceprints, roles, presence |
| 02 | [Offline wake word](02-offline-wake-word.md) | Partial | **P0** | Transcript-regex wake sends room audio to cloud; Porcupine unused → on-device engine |
| 03 | [Whole-house satellites](03-multi-room-satellites.md) | Pending | Later | One PC mic → phone/ESP32/HA satellites, rooms, handoff |
| 04 | [Voice stack, local and cloud](04-local-speech-stack.md) | Partial | P2/Later | Scribe + ElevenLabs/Kokoro/browser → streaming STT, voice router, offline |
| 05 | [Latency and real-time](05-latency-and-realtime.md) | Partial | P1 | Loop with barge-in exists, unmeasured → budget, instrumentation, speculative start |
| 06 | [Brain: orchestration and personality](06-brain-routing.md) | Partial | P1/P2 | Single persona + model → reflex/fast/deep routing, persona modes |
| 07 | [Memory](07-memory-upgrade.md) | Done (basic) | P2 | Keyword SQLite memory → semantic, entity graph, proposals |
| 08 | [Data access and injection defence](08-data-access-and-safety.md) | Partial | **P0/P1** | Gate heuristic bug, URL exfiltration → fixed gate, taint tracking, connectors |
| 09 | [Smart home](09-smart-home.md) | Pending | Later | Nothing → Home Assistant with risk tiers |
| 10 | [Computer and phone control](10-computer-and-phone-control.md) | Partial | P1/Later | Windows-only launching, Android MCP → execution ladder, skills, cross-platform |
| 11 | [Vision and presence](11-vision.md) | Partial (*unaudited*) | Later | Camera + hands → audit, local detection, events |
| 12 | [Proactive alerts](12-proactive-alerts.md) | Pending | P1 | Daily workflows only → event bus, notification policy, briefings |
| 13 | [Autonomy and background agents](13-autonomy-and-background-agents.md) | Partial | P1 | Mission board exists → planner/verifier, budgets, parallel agents |
| 14 | [Ambient context](14-ambient-context.md) | Pending | P2 | Nothing → context broker, screen/calendar awareness |
| 15 | [Policy, trust, privacy](15-policy-trust-and-privacy.md) | Partial | **P0** | Approvals + `decideTool` → policy engine, roles, audit, kill switch |
| 16 | [Evals and observability](16-evals-and-observability.md) | Partial | **P0/P1** | Turn traces + latency number → corpus, evals, CI metrics |
| 17 | [Deployment and resilience](17-deployment-and-resilience.md) | Partial | P1/P2 | Unsigned Windows installer → service, signing, backup, degraded modes |
| 18 | [HUD and multi-surface UI](18-hud-and-presence-ui.md) | Partial | P2 | HUD exists → state language, phone app, accessibility |
| 19 | [Skills ecosystem](19-skills-ecosystem.md) | Pending | Later | Workflows only → signed, sandboxed skill packs |
| 20 | [Messaging channels (own number, WhatsApp, Telegram)](20-messaging-channels.md) | Pending | P1 | Voice/browser only → channel adapters, sender allow-list, approvals over chat |
| 21 | [Multi-brain framework](21-multi-brain-framework.md) | Pending | P1 | Claude-only (`brain.ts`, Agent SDK in `server.mjs`) → provider interface, conformance suite, fallback |
| 22 | [Brain: OpenAI Codex / ChatGPT plan](22-brain-openai-codex.md) | Pending | P1 | Subscription login documented; third-party use terms unconfirmed |
| 23 | [Brain: GitHub Copilot](23-brain-github-copilot.md) | Pending | P1 | Official embeddable SDK; verify GA status and quota |
| 24 | [Brain: Google Gemini](24-brain-google-gemini.md) | Pending | P2 | API key first; free Google-login path reportedly ended (unverified) |
| 25 | [Brain: API-key providers](25-brain-api-providers.md) | Partial | P1 | Anthropic direct path only, key in browser → server-side tool-loop adapter, OpenAI/OpenRouter/compatible |
| 26 | [Brain: local models](26-brain-local-models.md) | Pending | P2 | Nothing → Ollama/LM Studio, offline basics |
| 27 | [Brain: other agent CLIs (evaluation)](27-brain-other-agent-clis.md) | Pending | Later | Research rubric for Cursor, Amp, OpenCode, Qwen, Grok, Mistral |
| 28 | [Multilingual (English, Gujarati, Hindi, mixed)](28-multilingual.md) | Partial | P1 | Language option, English-only replies → per-person profile, detection, code-switching STT, native TTS |
| 29 | [Onboarding and first run](29-onboarding-and-first-run.md) | Partial | P1 | Welcome wizard → hardware/echo test, wake calibration, guided connectors, first success |
| 30 | [Household and family](30-household-and-family.md) | Pending | P2 | Single user → profiles, child mode, shared lists, routines, guest mode, elder care |
| 31 | [Money and life admin](31-finance-and-admin.md) | Pending | Later | Nothing → bills, receipts, subscriptions, scam shield (read-only; no payments) |
| 32 | [Health and wellbeing](32-health-and-wellbeing.md) | Pending | Later | Nothing → reminders, sleep, routines, vault; supportive, not medical |
| 33 | [Knowledge work and meetings](33-knowledge-work-and-meetings.md) | Pending | P1/P2 | Keyword memory → cited RAG, meeting minutes, briefs, drafting, research |
| 34 | [Wearables and mobility](34-wearables-and-mobility.md) | Pending | Later | Home PC only → phone, earbuds, watch, car, secure remote access |
| 35 | [Ethics, limits and governance](35-ethics-limits-and-governance.md) | Partial | **P0** | Disclaimer only → published never-list, red-team gate, incident process |
| 36 | [Economics and licensing](36-economics-and-licensing.md) | Pending | P1 | Unknown costs/licences → cost table, caps, licence register, IP review |
| 37 | [Execution roadmap and risks](37-execution-roadmap-and-risks.md) | – | – | Dependency graph, 30/60/90 days, ADR list, risk register |
| 38 | [Shared data contracts](38-shared-data-contracts.md) | Pending | P0/P1 | Ad-hoc shapes → typed, validated schemas and event topics |
| 39 | [Settings and control center](39-settings-and-control-center.md) | Partial | P1 | Six flat settings, restart to apply → settings registry, 15 sections, live apply, keychain secrets, per-person scope |
| 40 | [Name and brand](40-name-and-brand.md) | Proposal | P1 | Codename "JARVIS" (Marvel IP, unownable) → own coined name **Tamelo**, multilingual full forms, trademark + domain plan |
| – | [Connectors folder](connectors/README.md) | Draft | P1 | Index and framework plus per-connector READMEs: OpenJarvis (27 data connectors, 30 channels), n8n (4 modes), Claude skills/plugins, Codex |

## Mapping from the 12-step "movie Jarvis" list

1 → 03 · 2 → 02 · 3 → 04 · 4 → 04 · 5 → 05 · 6 → 06 · 7 → 07 · 8 → 08 · 9 → 09 · 10 → 10 · 11 → 11 · 12 → 12.
Added because a real assistant needs them: 01, 13–39.

## What to build first

The authoritative order, dependency graph and 30/60/90-day plan are in [37](37-execution-roadmap-and-risks.md). The task-by-task order the autopilot follows is in [QUEUE.md](QUEUE.md). In short:

1. **Phase 0, trust and truth:** 08, 15, 02, 16, 35, 36.
2. **Phase 1, identity and feel:** 01, 05, 06, 21 + 25, 28, 29.
3. **Phase 2, proactive and connected:** 12, 20 (Telegram first), 14, 07, then 22 or 23 once their terms are confirmed.
4. **Phase 3, autonomy and work:** 13, 19, 33, 31.
5. **Phase 4, home and the world:** 09, 03, 11, 30, 34, 32.
6. **Phase 5, resilience and polish:** 17, 18, offline 04 + 26, 24, 27.

Use [38](38-shared-data-contracts.md) as the shared vocabulary so plans built in parallel still fit together.

## Standing constraints

- The default brain stays Claude on the user's own subscription (recorded decision). Other brains (21–27) are optional, sit behind the provider interface, and none may loosen the policy engine.
- Effectful actions are off by default and always pass the policy engine (15).
- Raw audio, video and voiceprints stay local; only text/snapshots go to cloud models when needed.
- Windows installer is the main product; Node 22.13+ for source users.
- Voice and likeness: original voice only; no cloning the film actor or anyone without consent.
- Every feature ships with a setting to turn it off, tests, and a metric in 16.
