# 15 · Policy engine, trust and privacy (the safety spine)

**Status:** Partial (approvals + `decideTool`) · **Priority:** P0 · **Effort:** 2–4 weeks

## End state
A single, testable policy engine decides **every** action: tool calls, device commands, file
writes, messages, spending, data egress. It knows who is asking (01), where (03), what the
action touches, what the model just read (taint, 08) and what the user pre-authorised.
Everything is logged, explainable and reversible where possible. A kill switch stops everything.

## Today (verified)
`decideTool` (default-deny for effectful MCP tools; heuristic read detection) and
`approvals.mjs`. No roles, no audit log UI, no spend caps, no central egress control.

## Policy model
`decide(action, actor, context) → allow | ask(approval) | deny` with a human-readable reason.
Inputs: action risk tier, capability annotations, actor role, room, presence, taint state,
time/quiet hours, budgets, standing grants.

Risk tiers: **R0** read local · **R1** read private/remote · **R2** reversible write · **R3** irreversible/external (send, spend, delete, unlock) · **R4** forbidden.

## Phases
1. ✅ **Extract and test (P0) — done (autopilot, 2026-10-23, awaiting review):** move gating into `bridge/policy.mjs`; table-driven tests; no behaviour change except fixing known defects (08).
2. **Roles and identity (with 01):** owner/member/child/guest matrices.
3. **Standing grants:** "for the next 30 minutes you may archive mail"; time-boxed, scoped, listed in UI, revocable.
4. **Taint and egress control:** track untrusted content; egress allow-list; outbound URL approval after private reads.
5. **Audit log:** append-only local log of requests, decisions, approvals, results; searchable in a panel ("what did you do yesterday?"); tamper-evident hash chain. **Storage v1 done (autopilot, 2026-10-23, Q05, awaiting review); the search panel is still to do.**
6. **Undo / rollback:** per-action inverse where possible (trash instead of delete, draft instead of send, snapshot before edit).
7. **Kill switch & safe word:** "Jarvis, freeze" halts missions, devices commands and mic-to-cloud; physical/hotkey equivalent; panic mode locks to guest role.
8. **Privacy centre:** one screen: connected sources, data stored, voiceprints, retention, what leaves the machine; export & delete-all buttons.
9. **Secrets handling:** OS keychain/DPAPI for keys; never log secrets; redaction filters on logs and prompts.
10. **Third-party review:** threat model doc, external pen-test before wider release.

## Autopilot log
- **2026-10-23 — Phase 1 (Q04, extract and test).** `bridge/tool-gate.mjs` became
  `bridge/policy.mjs` and gained `createPolicy()`, which now owns every piece of tool gating
  that was inline in `server.mjs`: the write switch (`writesEnabled`), the SDK
  `disallowedTools` list, the PreToolUse hook matcher, both `canUseTool` callbacks and their
  refusal messages (`DENY_MESSAGES`), and the switch `chromeServer` builds its acting tools
  from. The PreToolUse hook runs the gate first and then an optional guard — the Q03 taint
  check (`taint.mjs`) is passed in as that guard, with the same 120 s timeout and
  fail-closed handling it had. `policy.decide({ kind: 'tool', name })` returns a plan-38
  style `PolicyDecision` (`verdict`, `rule`, `reason`); non-tool actions are denied.
  No behaviour change: the 141-case gate table is unchanged and `decideTool` is checked
  against it in both modes. A wiring test reads `server.mjs` and fails if any agent's
  `canUseTool`, `disallowedTools` or PreToolUse hook bypasses the policy, if the taint guard
  is missing, or if writes are computed inline. `tool-gate.mjs` is gone.
  **Left:** `verdict: 'ask'` is not produced yet — approval cards still live in the servers
  that act (workspace, development, workflows) and in the taint guard; folding them into
  `decide()` belongs with grants (phase 3) and taint/egress (phase 4). Add
  `bridge/policy.test.mjs` and `bridge/taint.test.mjs` to the CI test list in
  `.github/workflows/release.yml`.

- **2026-10-23 — Phase 5, storage only (Q05, audit log v1).** New `bridge/audit.mjs`: an
  append-only SQLite log (`%LOCALAPPDATA%\JARVIS\audit\audit.db`, beside traces) whose entries
  are hash-chained (SHA-256 over canonical JSON including `seq` and `prevHash`); triggers refuse
  UPDATE and DELETE, and `verify()` names the first entry that was edited, deleted or reordered.
  `createPolicy({ audit })` writes one `decision` entry per PreToolUse hook and canUseTool call
  (actor voice/worker, stage, tool name, verdict, rule, reason — including the new
  `guard-refused` / `guard-failed` rules when the taint check refuses); `decide()` and
  `decideTool()` stay pure so the HUD badge is not logged. `auditedApprove()` wraps every
  approval function the bridge hands out (voice session, workers, workflow engine) and logs each
  card's redacted title and its answer; PostToolUse logs a `result` entry (name and error flag).
  Never logged: tool arguments, results, approval details, what was said. A failing log never
  changes a decision. `JARVIS_AUDIT=0` (env or saved settings) turns it off; `GET /audit/status`
  returns the count and chain check. Tests: `bridge/audit.test.mjs` (15), including a tampered
  decision being detected.
  **Left:** the search panel ("what did you do yesterday?") and an endpoint that serves entries;
  an anchor outside the file (signed head hash) so a whole-chain rewrite or a cut tail is caught;
  retention by checkpointing (nothing is pruned today); a PostToolUseFailure hook if the SDK's
  error results are not flagged by `isError`; a Diagnostics line for `/audit/status`; and adding
  `bridge/audit.test.mjs` with the policy/taint tests to the CI list in `.github/workflows/release.yml`.

## Metrics
100 % of tool paths go through policy (test enforces via a registry); 0 R3 actions without approval/grant; audit completeness; time-to-freeze < 1 s.

## Risks
Approval fatigue → grants, batching, learned safe patterns (proposed, never silent); complexity → keep the rules in one file with exhaustive tests.

## Related plans
[35](35-ethics-limits-and-governance.md) · [16 audit tests](16-evals-and-observability.md) · [38 PolicyRequest/Decision](38-shared-data-contracts.md) · [01](01-speaker-identification.md) · [08](08-data-access-and-safety.md)
