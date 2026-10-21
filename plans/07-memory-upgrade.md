# 07 · Memory that knows you

**Status:** Done (basic) · **Priority:** P2 · **Effort:** 2–4 weeks

## End state
JARVIS remembers like a good assistant: people (who is Sam, birthday, how you relate), projects,
routines, preferences, past decisions, "what did we decide about the roof last week?". It
learns passively but **proposes before saving**, forgets on request, can explain *why* it knows
something, and keeps each person's memory separate with shared household facts.

## Today (verified)
Local SQLite (`memory.mjs`, `memory-tools.mjs`, `journal.mjs`, `conversation.mjs`), keyword
recall, view/edit/forget, retention option, memory cannot grant permission (tested).

## Memory layers
| Layer | What | Store |
|---|---|---|
| Profile | stable facts, preferences, people, routines | structured rows + provenance |
| Episodic | conversations, events, journal | text + timestamps |
| Semantic | embeddings for fuzzy recall | vector index (SQLite-vec or similar) |
| Working | current task/session context | in-memory, per turn |
| Vault | secrets/sensitive items | never auto-recalled; explicit unlock |

## Phases
1. **Semantic recall (3–4 d):** local embedding model in bridge, hybrid keyword+vector, relevance threshold, recall shown in diagnostics ("used memories: …").
2. **Proposed memories (2–3 d):** after-turn extractor suggests facts as cards; user taps keep/skip; auto-decline lists.
3. **Entity graph (1 w):** people/places/projects with relations ("Sam = spouse"), resolves "my wife's birthday".
4. **Provenance and explain:** every memory stores source turn/date and confidence; "why do you think that?" works.
5. **Consolidation:** nightly job summarises old conversations, merges duplicates, flags conflicts for confirmation.
6. **Per-speaker scopes** with shared household layer (01, 15).
7. **Routines learning:** detect patterns (leaves at 8:10, coffee at 6:30) → offer automations (12, 13). Only suggested, never silent.
8. **Export/import and backup** (17).

## Privacy
Local-only embeddings, never send vault items, retention controls, "forget everything about X" cascades through all layers, exportable.

## Metrics
Recall@5 on a paraphrase test set ≥ 90 %; user-approved suggestion rate; stale/incorrect fact rate; prompt token overhead from memory ≤ 800.

## Risks
Wrong or creepy memories → approval + provenance; prompt injection through remembered content → memory is data, never instructions (08/15).
