# 11 · Eyes: perception and presence

**Status:** Partial (camera + hands exist; scope unaudited) · **Priority:** Later · **Effort:** 3–6 weeks

## End state
JARVIS can look when asked ("what's this?", "read this label", "is the stove on?") and notice
what matters unprompted (person at door, package delivered, pet in the garden, someone fell)
— using **local detection and snapshots**, never a continuous video feed to the cloud.

## Today
`camera.ts`, `hands.ts` (gesture control with smoothing), `bridge/vision.mjs`. Audit first:
document exactly what frames go where.

## Architecture
Cameras (RTSP/ONVIF/USB) → local detector (Frigate / YOLO / MediaPipe) → events → event bus →
policy → (optional) single snapshot → vision model for description → proactive alert (12).

## Phases
1. **Audit & consent (2 d):** list every capture path; visible camera indicator in the HUD; global off switch; DISCLAIMER update.
2. **On-demand vision (3–4 d):** "look at this" uses current camera/screen; OCR and object description; results spoken + shown on a panel.
3. **Local detector (1 w):** person/vehicle/package/animal events with zones and schedules; Frigate if cameras exist, in-browser MediaPipe otherwise.
4. **Event→action rules (3 d):** "if a person at the front door after 9pm, tell me with a snapshot".
5. **Recognition (optional, careful):** household face recognition on-device only; visitors unknown by default; jurisdiction check; opt-in.
6. **Presence fusion (with 01/03):** combine voice, face, device location to answer "who is home / which room".
7. **Gesture upgrades:** more reliable air-gestures, calibrated per camera.
8. **Activity understanding (later):** fall/inactivity detection for family safety with explicit consent and local processing.

## Metrics
Event precision ≥ 90 %, miss rate ≤ 5 % in tested zones, false alerts ≤ 2/day, snapshot→alert latency ≤ 3 s, zero continuous cloud video.

## Risks
Privacy law on recording/recognition, bystanders (neighbours, visitors), storage of snapshots → local retention limits, encryption, auto-delete, clear signage/indicators.

## Related plans
[14](14-ambient-context.md) · [12](12-proactive-alerts.md) · [09](09-smart-home.md) · [35 consent and law](35-ethics-limits-and-governance.md) · [01 presence](01-speaker-identification.md)
