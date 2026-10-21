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
| 16 | [Evals and observability](16-evals-and-observability.md) | Pending | **P0/P1** | Diagnostics panel → traces, corpus, CI metrics |
| 17 | [Deployment and resilience](17-deployment-and-resilience.md) | Partial | P1/P2 | Unsigned Windows installer → service, signing, backup, degraded modes |
| 18 | [HUD and multi-surface UI](18-hud-and-presence-ui.md) | Partial | P2 | HUD exists → state language, phone app, accessibility |
| 19 | [Skills ecosystem](19-skills-ecosystem.md) | Pending | Later | Workflows only → signed, sandboxed skill packs |

## Mapping from the 12-step "movie Jarvis" list

1 → 03 · 2 → 02 · 3 → 04 · 4 → 04 · 5 → 05 · 6 → 06 · 7 → 07 · 8 → 08 · 9 → 09 · 10 → 10 · 11 → 11 · 12 → 12.
Added because a real assistant needs them: 01, 13–19.

## What to build first

1. **Phase 0, trust:** 08 (gate and injection), 02 (private wake), 15 (policy extraction), 16 (baseline metrics).
2. **Phase 1, identity and feel:** 01, 05, 06.
3. **Phase 2, proactive and context:** 12, 14, 07.
4. **Phase 3, autonomy:** 13, 19.
5. **Phase 4, home and perception:** 09, 03, 11.
6. **Phase 5, resilience and polish:** 17, 18, offline half of 04.

## Standing constraints

- JARVIS stays on the user's own Claude subscription (recorded decision; API key only as fallback).
- Effectful actions are off by default and always pass the policy engine (15).
- Raw audio, video and voiceprints stay local; only text/snapshots go to cloud models when needed.
- Windows installer is the main product; Node 22.13+ for source users.
- Voice and likeness: original voice only; no cloning the film actor or anyone without consent.
- Every feature ships with a setting to turn it off, tests, and a metric in 16.
