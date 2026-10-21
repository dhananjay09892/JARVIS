# 12 · Proactive alerts (JARVIS speaks first)

**Status:** Pending · **Priority:** Later, but the most valuable of that group · **Effort:** 2–4 days

## Today
The bridge scheduler runs daily workflows at a local time (`bridge/workflows.mjs`, checked
every 30 s, only while the bridge runs). Workflows have no way to *speak* or show a card on
their own.

## Steps
1. **"announce" workflow step:** speaks text and/or pushes a panel to the open UI; queued if
   the UI is closed and delivered on next open.
2. **Morning briefing workflow** (calendar, mail count, weather) as a shipped template.
3. **Quiet hours + urgency:** each alert has a level; at night only `urgent` interrupts;
   others wait until morning. Settings for the window.
4. **Event triggers:** build finished/failed (development workspace), mission-board task
   done, later camera/sensor events ([11](11-vision.md), [09](09-smart-home.md)).
5. Never interrupt mid-conversation; wait for idle (`wake` mode).

## Done when
A scheduled briefing speaks at the set time, a night-time non-urgent alert is held until
morning, and an urgent one speaks immediately.
