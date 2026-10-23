# 35 · Ethics, limits and governance (what JARVIS will never do)

**Status:** Partial · **Priority:** P0 (a short version before wider release) · **Effort:** 1–2 weeks to write and enforce, then ongoing

## Why
A system that listens, remembers, speaks for you and acts needs explicit limits that don't
depend on any one model's mood. This plan turns values into rules, tests and release gates.

## Principles
1. **User sovereignty:** the owner controls data, capabilities and shutdown; defaults protect people who did not choose to be recorded.
2. **Consent and transparency:** sensing is visible (indicators), disclosed, and revocable.
3. **No deception:** JARVIS identifies as an AI when it matters (messages to third parties, calls); never impersonates a real person without that person's explicit consent.
4. **Human in the loop for consequences:** irreversible, financial, legal, medical, or reputational actions require approval (15).
5. **Minimise and localise data.**
6. **Honesty about uncertainty and limits:** says "I don't know", cites sources, flags low confidence.
7. **Fairness between household members:** no covert surveillance of adults; children's oversight is transparent and age-appropriate.

## Never-list (enforced in policy and tests)
- Covertly record, track, or read messages of other people; stalking/coercive-control features.
- Impersonate people or clone a real person's voice without documented consent; claim to be a human.
- Execute financial transfers/trades, or give personalised investment/legal/medical advice as a licensed professional.
- Send messages, spend money or delete data on third-party instruction found in content (injection) (08).
- Bypass CAPTCHAs/security checks, or help with illegal surveillance or evasion of safeguards.
- Store or transmit biometric/health data outside the stated boundaries.
- Take actions while "frozen" (15 kill switch).

## Governance
1. **Policy-as-code:** limits live in `policy.mjs` rules with a test per rule; changing a rule requires a reviewed PR.
2. **Release gate:** red-team suite (injection, harmful requests, privacy invasion, child safety, impersonation) must pass in CI (16) before each release.
3. **Incident response:** how to report, triage and fix harmful behaviour; user-facing "report a problem" with an export of the redacted trace; public changelog of safety fixes.
4. **Privacy and legal register:** per region: recording consent, biometric laws, child data rules, messaging opt-in rules; owners and review dates.
5. **Third-party transparency:** list every provider that sees data (brain, STT, TTS, messaging) with purpose and retention (Privacy Centre, 15).
6. **Model-behaviour review:** periodic review of persona prompts to avoid manipulation, sycophancy, or emotional dependence (be warm, not clingy; encourage human contact).
7. **Accessibility and inclusion:** language (28), hearing/speech disabilities (18), cognitive load; test with diverse users.
8. **Open-source hygiene:** licence checks for models, voices, dependencies (36); attribution in `CREDITS.md`.
9. **Sunset and portability:** the user can export everything and leave (17).

## Phases
1. **Write the one-page "What JARVIS will never do" and publish it (2 d).** *Drafted in [NEVER.md](../NEVER.md) (Q10); wording awaits owner approval in the PR review.*
2. **Encode the never-list as tests (1 w)** in 15/16.
3. **Privacy/legal register v1 (3 d)** for the regions you operate in.
4. **Red-team suite and release gate (1 w).**
5. **Incident process and report-a-problem flow (3 d).**
6. **Quarterly review ritual** with a changelog.

## Metrics
100 % of never-list items covered by tests; red-team pass rate; time-to-fix for reported safety issues; no unresolved high-severity items at release.

## Done when
The never-list is published, enforced by passing tests, and referenced from the disclaimer and Privacy Centre.

## Autopilot log
- **2026-10-23 — Phase 1 (Q10, never-list page).** Wrote [`NEVER.md`](../NEVER.md), the
  one-page "What JARVIS will never do": one plain-language rule for each of the seven
  never-list items above, each with a **Today** line saying honestly how far it is enforced
  now (rule 4, injection, is covered by the Q02/Q03 tests; rule 3 is refused in the default
  read-only mode only; the others are marked *planned*). Linked from the top of the README
  and its Security section. `bridge/never-list.test.mjs` checks the page has one rule per
  never-list item, a Today line for each, the README link, and that it does not claim the
  kill switch exists yet; added to the release workflow's test list. Left: owner approval
  of the wording, linking from DISCLAIMER and the Privacy Centre (the plan's "Done when"),
  and phase 2 (Q11, each rule as a policy rule with a test).
