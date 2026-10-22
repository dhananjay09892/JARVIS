# 01 · Speaker identification and presence ("who is talking, who is here")

**Status:** Pending · **Priority:** P1 · **Effort:** 1–2 weeks for full scope · **Depends on:** 15 (roles)

## End state
JARVIS recognises each household member by voice within a sentence, greets them by name,
loads *their* memory and preferences, applies *their* permissions, and knows who is currently
present. A stranger is a "guest" with chat-only access. Kids/guests cannot approve spending
or unlock doors. Multi-speaker overlap is handled gracefully ("one at a time, please") instead
of producing garbage.

## Today (verified)
`vad.ts` yields one blob per utterance → `voice.ts transcribe()` → bridge `/stt` → text only.
No identity anywhere.

## Architecture
```
VAD segment ─┬─► STT (text)
             └─► Speaker service (bridge): resample 16 kHz → embed → cosine vs. voiceprints
                       → { speaker | guest, score, confidence band }
Fusion: voice score + recent-speaker carry-over + (optional) face/room presence → final identity
Identity → turn context, memory scope, policy role
```
- Model: ECAPA-TDNN / WeSpeaker ONNX in bridge via `onnxruntime-node` (voiceprints never leave the machine).
- Voiceprint = several embeddings per person (different mic distances, moods), not one average.
- Store in the encrypted local DB beside memory; delete = hard delete.

## Phases
1. **MVP (3–4 d):** `/speaker/enroll`, `/speaker/identify`, spoken enrollment ("learn my voice"), `speaker` field on utterances, name in system prompt, owner/guest split.
2. **Robustness (3–4 d):** short-utterance carry-over (<1.5 s reuse previous within 20 s), confidence bands (confident / unsure / unknown) — unsure → JARVIS asks "is that you, Priya?" for risky actions only, running adaptive enrollment (add embeddings from confirmed turns, capped and reversible).
3. **Presence (3 d):** maintain "who is here" from recent speech + (later) satellites/cameras; expire after N minutes; expose to policy and proactive alerts (don't read private mail aloud when a guest is present).
4. **Overlap and diarization (optional):** use Scribe diarization or an overlap detector to refuse mixed speech; per-speaker barge-in rules (only the active speaker can interrupt).
5. **Per-speaker personality:** address style, language, verbosity, wake-word acceptance.

## Policy hooks (see 15)
- Roles: `owner`, `member`, `child`, `guest`.
- Risky actions require `owner`/`member` identity **and** an approval click; identity alone never authorises.
- "Privacy mode": when an unknown/guest voice is present, suppress private readouts.

## Metrics (to track in 16)
- Equal error rate on an enrolled test set ≤ 5 % for sentences ≥ 3 s, quiet room.
- Guest false-accept rate on risky actions: 0 by policy design (approval click always required).
- Added latency ≤ 150 ms per utterance (run in parallel with STT).

## Risks
- Spoofing by recording/impersonation → never sole authentication.
- Biometric data law (GDPR/BIPA-style): explicit consent at enrollment, in-app delete, disclosed in `DISCLAIMER.txt`.
- Mic variance across rooms → adaptive enrollment and per-device calibration.
- Children's voices change → allow re-enroll prompts.

## Acceptance tests
- Enroll A and B; alternate 40 sentences; ≥ 95 % correct identification.
- Guest voice asks to run a command → denied with a spoken explanation.
- Delete voiceprint → rows and embeddings gone; verified by test.

## Related plans
[15 roles](15-policy-trust-and-privacy.md) · [03 rooms](03-multi-room-satellites.md) · [28 per-person language](28-multilingual.md) · [30 family](30-household-and-family.md) · [38 Identity contract](38-shared-data-contracts.md)
