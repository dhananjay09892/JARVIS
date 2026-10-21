# 03 · The whole house: satellites, rooms, handoff

**Status:** Pending · **Priority:** Later · **Effort:** 2–4 weeks · **Depends on:** 02, 01, 15

## End state
Speak anywhere; the nearest device hears you; the answer plays in the room you are in and
follows you if you walk; "Jarvis, announce dinner to all rooms" works; each room has its own
context ("turn off the lights" means *this* room).

## Today
One PC mic/speaker. Phone/second-screen concept in `IMPROVEMENT_PLAN.md` #11.

## Tiers of hardware
| Tier | Device | Effort | Notes |
|---|---|---|---|
| A | Phone/tablet PWA | low | Needs local HTTPS (mkcert/self-signed trusted) + pairing code |
| B | Spare laptop/mini-PC running the same page | low | Great for desk/kitchen |
| C | ESP32 satellite (Atom Echo, ESP32-S3-BOX) | medium | Audio stream to hub, TTS back; open firmware (ESPHome/Wyoming) |
| D | Purpose-built mic array (HA Voice PE, ReSpeaker) | medium | Best echo cancel and far-field |

## Protocol (hub side)
- `WS /satellite` with device id, room, capabilities; authenticated by pairing token (revocable).
- Edge → hub: wake events + audio after wake (or continuous low-rate stream for hub-side wake), level meters.
- Hub → edge: TTS audio stream, cards, LED/state, volume duck commands.
- Adopt Wyoming protocol where cheap so HA satellites work unmodified.

## Behaviours
1. **Arbitration:** several devices hear one wake → pick best SNR; others mute for 2 s.
2. **Room context:** every turn carries `room`; policy and device commands default to it.
3. **Handoff/follow-me:** continue speaking on the nearest device as presence moves (needs 01/11).
4. **Intercom/announce:** speak to rooms; broadcast with quiet-hours and presence checks.
5. **Ducking:** lower TV/music (HA media_player or system volume) while JARVIS speaks.
6. **Per-room volume and voice** settings.

## Security
Pairing code with expiry, device allow-list, per-device revoke, LAN-only by default, TLS everywhere,
no unauthenticated audio endpoint, rate limits.

## Metrics
Arbitration correct ≥ 95 %; added network latency ≤ 150 ms; satellite uptime visible in diagnostics.

## Risks
Echo and feedback loops, double answers, Wi-Fi drops, firmware maintenance burden → start with Tier A/B, ship C only once the protocol is stable.

## Related plans
[01](01-speaker-identification.md) · [02](02-offline-wake-word.md) · [09](09-smart-home.md) · [34 mobility](34-wearables-and-mobility.md) · [38 DeviceEvent](38-shared-data-contracts.md)
