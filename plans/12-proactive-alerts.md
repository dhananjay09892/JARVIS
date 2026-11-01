# 12 · Proactive JARVIS: briefings, alerts, anticipation

**Status:** Pending · **Priority:** P1 (highest-value "Later" item) · **Effort:** 2–4 weeks

## End state
JARVIS speaks first when it matters, in the right place, at the right time, in the right tone:
"Good morning. Rain by nine, your first meeting moved to ten, and the build from last night
passed." He knows when to stay quiet, batches low-value news, interrupts for urgent things,
and learns what you actually care about.

## Today (verified)
Daily scheduled workflows (`workflows.mjs`, checked every 30 s while the bridge runs). An
in-process event bus (`bridge/bus.mjs`, Q32) that the scheduler and background tasks publish
to. A notification policy engine (`bridge/notify-policy.mjs`, Q33) listens for
`notification.created` and decides deliver / hold / suppress, with quiet hours in Settings; no
source raises alerts yet and no channel speaks or shows them.

## Building blocks
1. ✅ **Event bus (3 d):** sources (scheduler, task completion, builds, calendar, mail, sensors, camera) publish typed events. *First slice done (Q32): `bridge/bus.mjs`; the scheduler and task completion publish. Builds, calendar, mail, sensors and camera join as their plans add them.*
2. ✅ **Notification policy engine (3 d):** each candidate alert gets `urgency` (info/normal/important/urgent), `audience` (who), `place` (room), `privacy` (private/public). Decision = f(urgency, quiet hours, presence, current activity, speaker present, focus mode). *First slice done (Q33): `bridge/notify-policy.mjs`, quiet hours and the alerts switch in Settings. Presence and activity rules are built and tested but get real signals only when speaker ID (01) and context (14) report them; `place` waits for rooms (03).*
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

## Autopilot log
- **2026-10-27 — Building block 1 (Q32).** `bridge/bus.mjs`: an in-process, in-memory bus.
  Every event is the plan 38 `BusEvent` envelope (`v`, `id`, `ts`, `topic`, optional
  `traceId`, `payload`), checked by a plain-JS copy of the contract (no zod, loads on Node
  22.13); `bus.test.mjs` runs the copy and `shared/contracts.ts` over the same valid and invalid
  samples. Only topics with a payload check can be published, unknown payload fields are
  dropped, listeners get a frozen copy after `publish` returns, a throwing listener is counted
  and does not affect the others or the publisher, and rejections are logged by field, never by
  value. Subscribe by exact topic, `prefix.*` or `*`; a misspelt pattern throws. New topics in
  the contract: `workflow.started` / `workflow.finished` (payload `WorkflowRun`: names, trigger
  and step counts, never a command or output), published by the workflow engine for scheduled
  and manual runs; and `task.finished` (payload `TaskOutcome`: status, title, a summary clipped
  to 300 characters, `private` by default), published when a background task ends, including
  tasks marked interrupted by a restart. Metric (16): `GET /bus/stats` gives counts per topic,
  rejections, listener errors and listener count since start, never payloads. Off switch:
  `JARVIS_EVENT_BUS=off` builds no bus, so nothing publishes. **Left:** no listener yet (the
  notification policy engine, Q33, is the first); other topics get bridge payload checks as
  their publishers arrive; Diagnostics does not show `/bus/stats` yet (like `/brains/stats`);
  persistence/replay ("what did you hold back?") belongs with Q33's suppression log.
- **2026-11-01 — Building block 2 (Q33).** `bridge/notify-policy.mjs`: a pure `decide()` and a
  notifier that listens for `notification.created` on the bus. Rules, first match wins: alerts
  off → suppress; past `expiresAt` → suppress; `urgent` → speak + HUD at once, even in quiet
  hours (redacted when a private alert may be overheard, or nobody knows who is there); quiet
  hours or someone asleep → hold until they end; presence known and nobody in the audience here
  → hold ("while you were away"); private with someone outside the audience here → hold; meeting,
  call or focus → `important` as a silent HUD card, the rest held; mid-conversation → HUD card,
  never spoken over you; otherwise `important` speaks, `normal` is a HUD card, `info` waits for
  the next briefing. Every decision carries a rule name and a one-sentence reason. Held alerts
  stay in memory (at most 100; the least urgent, oldest goes first) and `tick()` (every minute)
  looks at them again, so a held alert goes out when quiet hours end and is dropped if it
  expired meanwhile. Settings → Alerts: **Let JARVIS bring things up on his own**
  (`JARVIS_ALERTS`, on) and **Quiet hours** (`JARVIS_QUIET_HOURS`, `22:00-07:00` local time or
  `off`, per person), both live. The bus now checks `Notification` payloads (plain-JS copy of the
  contract, parity samples in `bus.test.mjs`). Metric (16): `GET /notifications/stats` gives
  counts per verdict and rule, delivered, held and channel errors, never a title or body.
  Tests: `notify-policy.test.mjs` (quiet hours across midnight, urgent override, expiry while
  held, presence, privacy, activity, off switch, live settings, cap). **Left:** the bridge passes
  presence `undefined` and activity `'unknown'` until speaker ID (Q28) and the context broker
  (Q39) exist; no delivery channel (block 3: speak, HUD card, push) is attached, so alerts the
  policy would deliver are kept with rule `no-channel`; no source raises alerts yet (briefings,
  Q34, and task completion are the obvious first); `place`/room routing waits for plan 03;
  Diagnostics does not show `/notifications/stats` or the held list yet ("what did you hold
  back?" needs `held()` behind a who-may-hear check); the urgent-override list and DND from the
  calendar are block 7.
