# 09 · Smart home

**Status:** Pending · **Priority:** Later · **Effort:** 2–3 days · **Needs:** plan 08 (gate) first

## Goal
"Turn off the lights", "lock the door" through Home Assistant, safely.

## Steps
1. Connect the **Home Assistant MCP server** (documented setup in README, no code needed to try).
2. **Risk levels** in `decideTool`: lights/media free; climate with a confirm; locks, garage,
   alarm always need an approval card (and, after plan 01, the owner's voice).
3. Expose only an allow-list of entities to JARVIS, not the whole house.
4. Keep Home Assistant's own local command handling for basics so they work if the AI is down.
5. Test with a dry-run mode that logs intended calls instead of sending them.

## Done when
Lights respond by voice; a lock command shows an approval and does nothing until approved.
