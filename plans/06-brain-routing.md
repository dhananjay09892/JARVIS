# 06 · Brain: routing and personality

**Status:** Partial · **Priority:** P2 · **Effort:** 1–2 days (routing), 1–2 weeks (local model)

## Today
- Claude through the Agent SDK on the user's own subscription (decision recorded; do not
  change the default).
- Persona lives in `SYSTEM_PROMPT` (`bridge/server.mjs` ~386): spoken, short, impersonal
  success lines. Model and effort are Settings options.

## Steps
1. **Fast/slow routing.** Small model (Haiku-class) for quick chat and simple commands, the
   big model for tool-heavy or multi-step requests. Start with a rule: no tools needed and
   short question → fast model. Log which path each turn took.
2. **Personality pass.** Review `SYSTEM_PROMPT` for dry humour and brevity; add a few
   few-shot examples; keep it testable (a fixed prompt set, outputs eyeballed).
3. **Per-speaker address** once [01](01-speaker-identification.md) lands ("Good evening, Priya").
4. **Local model (optional, last).** Ollama for offline basics. Only with plan 04, and
   labelled as a different, weaker mode.

## Done when
Quick questions answer on the fast model, complex ones on the big model, the choice is
shown in diagnostics, and an override exists in Settings.
