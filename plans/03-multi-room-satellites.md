# 03 · Mics and speakers in every room

**Status:** Pending · **Priority:** Later · **Effort:** 3–5 days (phone), more for hardware

## Goal
Talk to JARVIS from another room. Same brain, answers play in the room you spoke from.

## Today
One microphone and one speaker: the PC running the browser tab. Mobile or second-screen use
is `IMPROVEMENT_PLAN.md` item 11.

## Options (cheapest first)
1. **Phone as a satellite.** Open JARVIS on the phone over the LAN. Browsers only allow the
   mic on HTTPS or localhost, so the bridge needs a local certificate (mkcert-style) and a
   pairing code so strangers on the network cannot connect.
2. **ESP32 push-to-talk satellite** (e.g. M5Stack Atom Echo) streaming audio to the bridge.
   Needs a small audio ingest endpoint and a return stream for TTS.
3. **Home Assistant Voice PE** as a Wyoming-protocol satellite. Most work, best hardware
   (echo cancellation). Only worth it together with plan 09.

## Steps
1. Add bridge HTTPS + pairing code; list paired devices in Settings with revoke.
2. Tag each utterance with `deviceId` / room.
3. Route TTS back to the device that asked.
4. Decide what happens with two devices hearing one wake word (pick the loudest).

## Risks
- Echo and double-wake between rooms; security of an open LAN endpoint.

## Done when
A paired phone can wake, ask and hear the answer; unpaired devices are refused.
