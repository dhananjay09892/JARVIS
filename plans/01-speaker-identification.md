# 01 · Speaker identification ("who is talking?")

**Status:** Pending · **Priority:** P1 · **Effort:** 3–5 days

## Goal
When more than one person talks to JARVIS, he knows who each utterance came from, greets
them by name, uses their memory and applies their permissions. Unknown voices are "guest".

## Today
- `src/lib/vad.ts` cuts the mic into one audio blob per utterance.
- `src/lib/voice.ts` `transcribe()` posts the blob to bridge `/stt` and gets text back.
- No identity is attached anywhere. Scribe diarization only labels speakers inside one file
  ("speaker 0/1"), not across turns, and is poor on 2–3 s clips, so it is not enough.

## Approach: voice enrollment + speaker verification
1. **Embedding model.** Small speaker-embedding model as ONNX (ECAPA-TDNN or WeSpeaker).
   Run it in the **bridge** with `onnxruntime-node` so voiceprints never leave the machine
   and the browser bundle stays small. (Alternative: `onnxruntime-web` in the page.)
2. **Enrollment.** "Jarvis, learn my voice": prompt for 3–4 sentences, average the
   embeddings, store `{ id, name, role, embedding[] }` in a new local SQLite table beside
   the memory database (`%LOCALAPPDATA%\JARVIS`).
3. **Identify.** In `transcribe()`, send the same blob to bridge `POST /speaker`. Return
   `{ speaker, score }` by cosine similarity against enrolled voiceprints; below threshold
   means `guest`.
4. **Short utterances** ("stop", "yes") are unreliable. Below ~1.5 s of speech, reuse the
   speaker from the previous turn within a time window instead of re-scoring.
5. **Use the result.** Pass `speaker` with the utterance to the conversation, inject
   `Speaker: <name>` into the turn context, and scope memory per speaker.
6. **Permissions.** Roles `owner` / `member` / `guest`. Only `owner` can approve effectful
   tools, run commands or change settings. Guests get chat only.
7. **Fallback.** Spoken declaration ("it's Priya") sets the speaker for the session.

## Privacy and safety
- Voiceprints are biometric data: local only, never sent to any API, deletable in Settings
  ("Forget my voice"), and stated in `DISCLAIMER.txt`.
- Voice ID is **not authentication**. Recordings and impersonation can fool it. Never let it
  alone unlock anything destructive; approvals still need a click.

## Done when
- Enroll two people; each is recognised ≥ 95 % of the time on normal sentences in a quiet room.
- A guest voice cannot approve an effectful tool.
- Deleting a voiceprint removes the row and the embedding.
- Unit tests for enrollment, scoring threshold and the previous-speaker carry-over.

## Open questions
- Threshold tuning per mic/room (needs a small calibration step).
- Whether to also gate the wake word on the owner's voice (stricter, more misses).
