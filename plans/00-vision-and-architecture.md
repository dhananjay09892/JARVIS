# 00 · Vision and target architecture

## The bar: a real-world JARVIS
Not a voice chatbot with tools. A **household/work chief of staff** that:

1. **Is always there, never creepy.** Hears you in any room, only when called; processes audio locally by default.
2. **Knows who is talking** and who is in the room, and behaves accordingly.
3. **Knows you.** Habits, people, projects, preferences, calendar, what is on your screen, learned over time and fully inspectable.
4. **Acts, not just answers.** Runs multi-step jobs in the background, reports back, asks only when it must.
5. **Speaks first, rarely and well.** Briefings, warnings, "you'll be late", "build failed" – filtered by urgency, place and time.
6. **Feels instant.** Under ~1 s to first sound for chat, with a spoken acknowledgement for long jobs.
7. **Is safe by construction.** One policy engine decides every action; risky ones need approval; everything is logged and reversible.
8. **Keeps working when things break.** Offline fallbacks, graceful degradation, self-healing service.

## Honest scope
Movie JARVIS is fiction. This plan targets the real parts that are achievable with today's tech and this codebase: voice, identity, memory, tools, proactivity, perception, autonomy. Nothing here is a claim of current capability: **status of each area is in `README.md`**.

## Target architecture

```
 EDGE (many)                      HUB (bridge, always-on)                      WORLD
 ┌──────────────┐   audio/events  ┌─────────────────────────────────────┐   ┌────────────────┐
 │ PC browser   │ ──────────────► │ Audio gateway                       │   │ Claude (brain) │
 │ Phone (PWA)  │                 │  wake (offline) → VAD → speaker ID  │   │ Local small LM │
 │ ESP32/HA sat │ ◄────────────── │  → STT (local|cloud) ; TTS router   │   │ MCP tools      │
 │ Cameras      │   TTS/cards     ├─────────────────────────────────────┤   │ Home Assistant │
 │ Sensors      │                 │ Orchestrator                        │◄─►│ Calendar/Mail  │
 └──────────────┘                 │  turn manager · model router        │   │ Phone/PC/Web   │
                                  │  planner · background agents (13)   │   └────────────────┘
                                  ├───────────────┬─────────────────────┤
                                  │ Policy engine │ Memory (07)         │
                                  │  (15): risk,  │  profile · episodic │
                                  │  roles, caps, │  · semantic · vault │
                                  │  audit, kill  │                     │
                                  ├───────────────┴─────────────────────┤
                                  │ Event bus + scheduler (12)          │
                                  │ Perception (11, 14)  Evals/obs (16) │
                                  └─────────────────────────────────────┘
```

Design rules:
- **Hub owns state; edges are dumb.** Any new room/device only streams audio/events and plays audio/cards.
- **Every action passes the policy engine.** No tool call, device command or message bypasses it.
- **Local first for raw sensor data** (audio, video, voiceprints). Only text/snapshots go to cloud models, and only when needed.
- **Everything has a degraded mode** (see 17). A broken network must not mean a silent house.
- **Everything is inspectable and deletable** by the user (memory, voiceprints, logs).

## Principles
1. **Trust before power.** Safety, privacy and honesty ship before new abilities (15, 35).
2. **Measure before claiming.** Every promise has a metric in 16.
3. **No single point of dependence.** Any brain, any speech vendor, any channel can be swapped or lost (21, 04, 20).
4. **Helpful, not clingy.** Proactive only when it earns the interruption (12).
5. **Everyone in the house counts.** Roles, languages, children, guests (01, 28, 30).
6. **Explain and undo.** Every action has a reason, a log entry and, where possible, an inverse (15).
7. **Ship thin vertical slices.** One working path end to end beats five half-built layers.

## Non-goals (for now)
- Replacing emergency services, medical, legal or financial professionals (31, 32, 35).
- Covert monitoring of any person (35).
- Cloning the film character's voice or any real person's voice (36).
- Running unreviewed third-party code with broad permissions (19).
- Cross-platform parity before the Windows experience is solid (10, 17).

## Roadmap
The authoritative schedule, dependency graph, 30/60/90-day plan, open decisions and risk
register are in [37-execution-roadmap-and-risks.md](37-execution-roadmap-and-risks.md).
Shared schemas that all plans use are in [38-shared-data-contracts.md](38-shared-data-contracts.md).

Summary of phases:

| Phase | Theme | Plans | Exit gate |
|---|---|---|---|
| 0 | **Trust and truth** | 08, 15, 02, 16, 35, 36 | Gate tested; no room-audio upload while asleep; latency measured; never-list published |
| 1 | **Identity and feel** | 01, 05, 06, 21, 25, 28, 29 | Two people recognised; median latency ≤ 1.2 s; provider interface live; wizard v2 |
| 2 | **Proactive and connected** | 12, 20, 14, 07, 22/23 | Briefing, quiet hours, Telegram with approvals, semantic memory |
| 3 | **Autonomy and work** | 13, 19, 33, 31 | Background missions with budgets; skill packs; meeting minutes and cited retrieval |
| 4 | **Home and the world** | 09, 03, 11, 30, 34, 32 | Rooms, safe device control, family roles, phone away from home |
| 5 | **Resilience and polish** | 17, 18, 04, 26, 24, 27 | Always-on service, backup/restore, offline basics, upgraded HUD |

## Cross-cutting definitions of done
- Unit tests for every policy decision and every new parser.
- A measurable metric in `16` for every user-visible promise (latency, wake accuracy, speaker accuracy, task success).
- Documented in `DISCLAIMER.txt`/README what data goes where.
- Setting to turn the feature off.
