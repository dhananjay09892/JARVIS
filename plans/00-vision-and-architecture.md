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

## Roadmap (phases with exit gates)

| Phase | Theme | Plans | Exit gate |
|---|---|---|---|
| 0 | **Trust** | 02 (disclose + engine), 08, 15 (core), 16 (baseline metrics) | Permission gate tested; no room-audio upload while asleep; latency measured |
| 1 | **Identity and feel** | 01, 05, 06, 04 (TTS polish) | Two people recognised; median latency < 1.5 s; fast/slow routing live |
| 2 | **Proactive and context** | 12, 14, 07 | Morning briefing, quiet hours, screen/calendar awareness, semantic recall |
| 3 | **Autonomy** | 13, 19 | Multi-step background jobs with progress and approvals; first skill packs |
| 4 | **Home and perception** | 09, 03, 11 | Rooms, lights/locks with risk levels, camera events |
| 5 | **Resilience and polish** | 17, 18, 04 (offline) | Always-on service, backup/restore, offline degraded mode, upgraded HUD |

## Cross-cutting definitions of done
- Unit tests for every policy decision and every new parser.
- A measurable metric in `16` for every user-visible promise (latency, wake accuracy, speaker accuracy, task success).
- Documented in `DISCLAIMER.txt`/README what data goes where.
- Setting to turn the feature off.
