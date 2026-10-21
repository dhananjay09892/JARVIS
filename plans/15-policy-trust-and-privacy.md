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
1. **Extract and test (P0):** move gating into `bridge/policy.mjs`; table-driven tests; no behaviour change except fixing known defects (08).
2. **Roles and identity (with 01):** owner/member/child/guest matrices.
3. **Standing grants:** "for the next 30 minutes you may archive mail"; time-boxed, scoped, listed in UI, revocable.
4. **Taint and egress control:** track untrusted content; egress allow-list; outbound URL approval after private reads.
5. **Audit log:** append-only local log of requests, decisions, approvals, results; searchable in a panel ("what did you do yesterday?"); tamper-evident hash chain.
6. **Undo / rollback:** per-action inverse where possible (trash instead of delete, draft instead of send, snapshot before edit).
7. **Kill switch & safe word:** "Jarvis, freeze" halts missions, devices commands and mic-to-cloud; physical/hotkey equivalent; panic mode locks to guest role.
8. **Privacy centre:** one screen: connected sources, data stored, voiceprints, retention, what leaves the machine; export & delete-all buttons.
9. **Secrets handling:** OS keychain/DPAPI for keys; never log secrets; redaction filters on logs and prompts.
10. **Third-party review:** threat model doc, external pen-test before wider release.

## Metrics
100 % of tool paths go through policy (test enforces via a registry); 0 R3 actions without approval/grant; audit completeness; time-to-freeze < 1 s.

## Risks
Approval fatigue → grants, batching, learned safe patterns (proposed, never silent); complexity → keep the rules in one file with exhaustive tests.
