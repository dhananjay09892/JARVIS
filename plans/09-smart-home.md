# 09 · The house that obeys (smart home)

**Status:** Pending · **Priority:** Later · **Effort:** 2–4 weeks · **Depends on:** 08/15 (gate, roles), 03 (rooms)

## End state
Natural commands ("it's cold in here", "movie night", "goodnight") control lights, climate,
blinds, media, locks and appliances through Home Assistant; scenes and routines are created
by voice; JARVIS reports the home state ("garage door has been open 20 minutes") and reacts
to events — with safety tiers so the dangerous things are never one misheard word away.

## Architecture
Home Assistant (mini PC) + Matter/Zigbee/Z-Wave devices ← MCP/REST/WebSocket ← JARVIS policy engine ← orchestrator.
HA's own local intents handle trivial commands even when AI/cloud is down.

## Phases
1. **Connect (2–3 d):** HA MCP server or direct WebSocket; entity allow-list UI (only exposed entities).
2. **Risk tiers in policy (2 d):**
   | Tier | Examples | Rule |
   |---|---|---|
   | 0 | lights, media, fans | free |
   | 1 | climate, blinds, covers | free for members, log |
   | 2 | locks, garage, alarm disarm, ovens | approval card + member identity + (optional) PIN |
   | 3 | anything unsafe/irreversible | never by voice alone |
3. **Room awareness (2 d):** "the lights" → current room (03); area/floor/group names learned.
4. **Scenes and routines by voice (3 d):** "create a movie scene", stored as HA scenes/automations after approval.
5. **State queries and summaries (2 d):** "is the house locked?", "what's using power?"
6. **Event reactions (with 12):** door left open, leak sensor, smoke → urgent proactive alert regardless of quiet hours (policy-defined).
7. **Energy & comfort intelligence (later):** schedule heating from calendar/presence; suggestions, not silent changes.
8. **Safety interlocks:** dry-run mode, rate limits, "undo that" for the last action, kill switch (15).

## Metrics
Command success ≥ 97 % on a fixed phrase set; zero tier-2 actions without approval in tests; median command-to-device latency ≤ 1.5 s total.

## Risks
Misheard commands with physical consequences → tiers + confirmations; vendor cloud dependence → prefer local protocols; entity naming chaos → onboarding wizard that tidies names/areas.
