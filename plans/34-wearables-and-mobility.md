# 34 · Beyond the room: phone, earbuds, watch, car

**Status:** Pending · **Priority:** Later · **Effort:** 4–8 weeks · **Depends on:** 03 (satellites), 17 (hub), 20 (channels), 15, 18 (PWA)

## End state
JARVIS is with you, not just at home: a phone app/PWA with push-to-talk and push alerts, an
earbud mode (hands-free, private), a watch glance/reply, and a car mode (voice-only, safe).
The hub at home stays the brain; devices are secure edges.

## Surfaces
| Surface | Role | Approach |
|---|---|---|
| **Phone (PWA first, native later)** | Mic, speaker, notifications, location, camera | HTTPS + pairing (03); push notifications; background limits mean push-to-talk first |
| **Earbuds / headset** | Private hands-free | Bluetooth headset as the mic/speaker of the phone edge; whisper-quiet TTS; privacy by default |
| **Watch** | Glance and reply | Notification actions (approve/deny, snooze), dictation reply, health data source (32) |
| **Car** | Voice-only, short | Android Auto / CarPlay constraints; read-only and safe commands; no visual interaction |
| **Laptop away from home** | Same as desktop edge | Remote connection to hub, or run local |

## Remote access to the hub (security first)
- Outbound tunnel or relay (no open ports); mutual auth with device keys; per-device revoke (03, 15).
- Option for **fully self-hosted** path (WireGuard/Tailscale-style VPN) vs. a managed relay; document trade-offs.
- Offline behaviour: when the hub is unreachable, the phone edge says so and queues notes/reminders.

## Features
1. Push-to-talk and wake-by-button; quick actions (add to list, remind me, call/message draft).
2. Location context: leaving/arriving triggers (12), "remind me when I get to the shop", travel-time alerts.
3. Notification triage: summarise and read selected notifications aloud when driving or wearing earbuds.
4. Approvals on the go: approve/deny risky actions with biometrics (phone) instead of voice alone (15).
5. Camera: "what is this?" using the phone camera (11).
6. Health data bridge (32): sleep, steps, heart rate, with per-signal consent.
7. Car mode: driving detected → shorter replies, no screen, only low-risk actions.
8. Trip mode: itinerary, documents, currency, translation (28) offline packs.

## Phases
1. **PWA edge + pairing + push (2 w)** (shares work with 03/18).
2. **Remote hub access (1–2 w)** with security review.
3. **Location and notification features (1 w).**
4. **Earbud/private mode and whisper TTS (3 d).**
5. **Watch actions (1 w)** via notification actions or companion app.
6. **Car mode (1 w)** with safety rules.
7. **Native apps (later)** only if PWA limits block key features (background mic, wake word).

## Risks
Mobile OS background restrictions (wake word on-device is hard); battery; privacy of location data; car-safety liability → conservative defaults, read-only in motion.

## Done when
From outside the home network, the phone can ask a question, receive a push alert, and approve a pending action with biometrics, all over an authenticated, revocable connection.
