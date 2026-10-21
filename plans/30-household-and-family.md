# 30 · Household and family

**Status:** Pending · **Priority:** P2 · **Effort:** 3–5 weeks · **Depends on:** 01 (identity), 15 (roles), 07 (memory), 12 (alerts), 20 (channels)

## End state
JARVIS is useful to the whole home, not just the owner: shared shopping and chores lists,
family calendar, school and appointment reminders, kid-safe mode, elder-care check-ins,
house rules ("no screens after 9"), and guest handling, with each person's privacy respected.

## Features
1. **Family profiles:** adults, teens, children, grandparents, guests; each with language, voice, permissions, bedtime and quiet hours.
2. **Shared lists and calendar:** shopping, chores, packing; "add milk" from any room or message; family calendar merge with conflict detection ("both of you have a pickup at 3").
3. **Child mode:** age-appropriate answers and content filter, no purchases, no messages out, no device control beyond allowed list, time limits, parent-visible activity summary (age-appropriate transparency, not covert surveillance), homework helper that explains rather than just answers.
4. **Routines:** morning (wake kids, weather, school items), bedtime (lights, story, alarm), leaving/arriving home; triggered by time, presence (01, 03, 11), or voice.
5. **Elder care (opt-in, consent from the person):** daily check-in ("Good morning, how are you?"), medication reminders (reminders only, no medical advice), inactivity alert to family, one-phrase emergency ("Jarvis, help") → call/message chosen contacts.
6. **Guest mode:** welcome message, Wi-Fi info, limited controls, no private data, auto-expire.
7. **Fairness and privacy between members:** private notes and messages remain private; a parent cannot silently read an adult's data; shared vs. personal memory layers (07).
8. **Family digest:** weekly summary to adults (events, chores done, upcoming bills if enabled, with permissions).
9. **Pets (small but loved):** feeding reminders, vet appointments, camera-based "has the dog been out?" (11).

## Phases
1. **Roles and profiles (4 d)** on top of 01/15.
2. **Shared lists/calendar (4 d)** via connectors (08).
3. **Child mode (1 w)** incl. content policy, time limits, parent dashboard.
4. **Routines engine (1 w)** on the event bus (12) and workflows (19).
5. **Guest mode and emergency phrase (3 d).**
6. **Elder-care pack (1 w)** after safety and consent review.
7. **Family digest and pets (3 d).**

## Safety, ethics and law
- Children's data: strictest defaults; parental consent; no voiceprints for under-13 without explicit guardian consent and local-only storage; check regional rules (COPPA/GDPR-K style).
- Elder care: consent from the person, visible indicators, easy opt-out; never a covert monitor.
- Emergency features are **assistive, not guaranteed**; say so; do not replace emergency services.
- Domestic situations: avoid features enabling coercive control (tracking adults, reading others' messages) — see 35.

## Metrics
Lists/calendar adoption by non-owners; child-mode incident reports = 0 in testing; routine success rate; opt-out rates; satisfaction survey per role.

## Done when
Two adults and a child use distinct profiles with correct permissions, shared lists work from voice and chat, and child mode passes a content and permission test suite.
