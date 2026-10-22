# 32 · Health and wellbeing (supportive, not medical)

**Status:** Pending · **Priority:** Later · **Effort:** 2–4 weeks · **Depends on:** 15 (vault, consent), 12, 14, 34

## End state
JARVIS supports healthy habits and notices when you need a nudge: sleep, hydration,
medication reminders, workouts, breaks, focus and stress, using data you choose to share
(watch, phone, calendar). He is warm, private and honest about limits. He does not diagnose
or give medical advice.

## Hard boundaries
- Not a medical device; no diagnosis, no dosage changes, no emergency triage. For symptoms he suggests contacting a professional and, for urgent signs, emergency services.
- Health data is the most sensitive class: local-only by default, stored in the encrypted vault, never sent to a cloud model in raw form; summaries only with explicit consent.
- Mental health: supportive tone, no therapy claims; detect crisis language and respond with safe-messaging guidance and local helpline resources; escalate to chosen trusted contact **only with prior consent**.
- Never share health data over SMS/WhatsApp (20) unless explicitly enabled.

## Features
1. **Medication and appointment reminders** with confirmation and snooze; missed-dose notice to the person (and caregiver if consented).
2. **Sleep and routine coach:** wind-down at set time, smart alarm, adjust lights/noise (09), morning summary.
3. **Activity and breaks:** posture/eye-break nudges at the desk (14), step goals from watch (34), workout logging by voice.
4. **Nutrition lightweight:** log meals by voice/photo, hydration reminders, recipes from what's in the fridge/shopping list (30). No calorie dogma.
5. **Focus and stress:** Pomodoro, "do not disturb" integration (12), breathing exercises on request, notice patterns (late nights, back-to-back meetings) and suggest changes, not lecture.
6. **Health records binder:** store reports, prescriptions, vaccination dates; search by voice; doctor-visit prep ("questions to ask").
7. **Caregiver mode (with 30):** opt-in sharing of selected signals (took medication, inactivity) with a named caregiver.
8. **Environment:** air quality, temperature, noise alerts from sensors (09).

## Phases
1. **Vault and consent model (4 d):** categories, per-item sharing, audit (15).
2. **Reminders and routines (1 w).**
3. **Wearable/phone data ingestion (1 w)** (34), local aggregation.
4. **Coaching rules and tone (1 w):** small rule engine + persona guidelines, red-team for harmful advice.
5. **Crisis-safety behaviour (3 d):** tested scripts and resources per region; human review before shipping.
6. **Records binder and visit prep (4 d).**

## Metrics
Reminder adherence; opt-out rate; harmful-advice red-team failures = 0; user-rated helpfulness; zero health data in logs/telemetry.

## Risks
Liability and regulation (health claims) → strict wording, disclaimers, region review; creepiness → opt-in per signal, transparent "why I'm saying this"; data leakage → vault + tainted-content rules.

## Done when
A user can enable medication reminders and a sleep routine, see exactly what data is used and where it lives, and a red-team set of harmful-advice prompts produces safe refusals.
