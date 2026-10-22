# 18 · HUD, presence and multi-surface UI

**Status:** Partial (holographic HUD, panels, gestures) · **Priority:** P2 · **Effort:** 3–6 weeks

## End state
The interface communicates JARVIS's *state and intent* at a glance — listening, thinking,
working on missions, blocked, privacy mode, who he thinks is speaking — and is available on
whatever surface is nearest: main display, secondary monitor, phone, wall tablet, watch
glance. It is beautiful but never in the way, accessible, and honest about what it is doing.

## Today (verified)
Three.js/GLSL reactor and orbits (`src/scene/`), panels (`Panels.tsx`), mission board
(`Missions.tsx`), approvals UI, suggestions, gesture guide, diagnostics, settings.

## Phases
1. **State language (1 w):** a defined vocabulary of visual/audio states: asleep, listening, hearing-you, thinking, using-tools, speaking, waiting-for-approval, degraded, privacy/frozen, camera-active, mic-muted — each distinct and consistent across surfaces.
2. **Presence widgets:** compact always-on-top overlay mode; ambient "glance" mode for a second monitor/wall tablet (time, next event, alerts, mission progress, home state).
3. **Identity UI:** show recognised speaker name/avatar and confidence; unrecognised → guest badge (01).
4. **Approvals and audit UX:** single approvals inbox, undo buttons, "what did you do?" timeline from the audit log (15).
5. **Transparency panels:** context in use (14), memories used (07), model route and latency (05, 16), data leaving the machine.
6. **Phone/tablet app (PWA) (2 w):** same hub, push notifications for alerts (12), approve/deny on the go, push-to-talk, camera/mic as satellite (03).
7. **Accessibility:** captions always available, keyboard-only operation, high-contrast and reduced-motion themes, screen-reader labels, text input equivalent of every voice action, hard-of-hearing mode (visual alerts).
8. **Theming/personas:** HUD themes and optional voice/persona skins; user-built panels via skills (19).
9. **Spatial/AR (exploratory):** WebXR or glasses companion for hands-free overlays.
10. **Performance:** adaptive quality for low-end GPUs; frame-rate budget; power-saving idle scene.

## Metrics
Task completion without voice (accessibility) 100 %; idle GPU/CPU budgets; comprehension test: 5 users identify state correctly ≥ 90 %.

## Risks
Visual flair costing battery/CPU → adaptive quality; clutter → default minimal, progressive disclosure.

## Related plans
[29](29-onboarding-and-first-run.md) · [12](12-proactive-alerts.md) · [15 privacy centre](15-policy-trust-and-privacy.md) · [34 PWA](34-wearables-and-mobility.md) · [28 scripts/Unicode](28-multilingual.md)
