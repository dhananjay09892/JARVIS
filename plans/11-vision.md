# 11 · Eyes (vision)

**Status:** Partial · **Priority:** Later · **Effort:** 3–5 days

## Today
`src/lib/camera.ts`, `hands.ts` (gesture control), `bridge/vision.mjs`. These were not audited
in depth for this plan; confirm what `vision.mjs` does before starting.

## Steps
1. **Audit** current camera/vision flow and write down what is sent where.
2. **Local detection, snapshots to the model.** Detect person/package/etc. locally (Frigate or
   an in-browser detector); send only a snapshot to Claude when an event fires, never
   continuous video.
3. **Who is it:** optional face recognition for the owner's household only. Check local law
   before using it on visitors; off by default; embeddings stay local and are deletable.
   Complements voice ID ([01](01-speaker-identification.md)).
4. Feed events into [12](12-proactive-alerts.md) ("package at the door").

## Done when
An event produces one snapshot and one spoken/visual alert, with no continuous upload.
