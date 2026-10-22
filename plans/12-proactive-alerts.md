# 12 · Proactive JARVIS: briefings, alerts, anticipation

**Status:** Pending · **Priority:** P1 (highest-value "Later" item) · **Effort:** 2–4 weeks

## End state
JARVIS speaks first when it matters, in the right place, at the right time, in the right tone:
"Good morning. Rain by nine, your first meeting moved to ten, and the build from last night
passed." He knows when to stay quiet, batches low-value news, interrupts for urgent things,
and learns what you actually care about.

## Today (verified)
Daily scheduled workflows (`workflows.mjs`, checked every 30 s while the bridge runs). No
spoken/pushed announcement step, no event bus, no quiet hours.

## Building blocks
1. **Event bus (3 d):** sources (scheduler, task completion, builds, calendar, mail, sensors, camera) publish typed events.
2. **Notification policy engine (3 d):** each candidate alert gets `urgency` (info/normal/important/urgent), `audience` (who), `place` (room), `privacy` (private/public). Decision = f(urgency, quiet hours, presence, current activity, speaker present, focus mode).
3. **Delivery channels:** speak in room, HUD card, phone push, queue-for-next-wake ("while you were away…").
4. **"announce" workflow step** and event-triggered workflows.
5. **Briefings (3 d):** morning/evening/weekly templates (calendar, travel time, weather, tasks, mail highlights, overnight jobs, home status); length adapts; skippable by voice.
6. **Anticipation (1–2 w):** travel-time alerts from calendar + location, "you usually call Mum on Sundays", package/arrival reminders, bill due — each from a rule or approved learned routine (07).
7. **Do-not-disturb intelligence:** meetings (from calendar), calls, sleep schedule, focus sessions, guests present; urgent override list (smoke, leak, family).
8. **Feedback loop:** "not now / don't tell me this again / more like this" adjusts a per-source score; weekly digest of what was suppressed.
9. **Escalation:** unacknowledged urgent alerts repeat → other room → phone push.

## Metrics
Alert usefulness rating ≥ 80 % kept; interruptions during focus/sleep = 0 non-urgent; briefing delivered on time ≥ 99 %; suppression transparency (user can ask "what did you hold back?").

## Risks
Annoyance is the failure mode → conservative defaults, explicit opt-in per source, a one-word mute ("quiet"), and every alert shows *why* it fired.

## Related plans
[20 channels](20-messaging-channels.md) · [14](14-ambient-context.md) · [34 push](34-wearables-and-mobility.md) · [32 health nudges](32-health-and-wellbeing.md) · [38 Notification](38-shared-data-contracts.md)
