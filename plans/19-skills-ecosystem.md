# 19 · Skills: packaged abilities anyone can add

**Status:** Pending (workflows exist) · **Priority:** Later · **Effort:** 3–6 weeks · **Depends on:** 15, 13

## End state
New abilities install like apps: a signed **skill pack** declares what it does, what
permissions it needs, what data it touches, triggers (voice phrases, schedules, events) and UI
panels. Users browse, review permissions, install, update and remove in one place. Power users
write their own; JARVIS can draft one for you ("make a skill that…") for review.

## Today (verified)
Workflows (`workflows.mjs`, `workflow-tools.mjs`) with up to 20 steps, daily scheduling,
voice-proposed with approval. MCP servers provide tools.

## Skill pack format (proposal)
```
skill/
  skill.json   name, version, author, description, permissions (tools, domains, paths, spend),
               triggers (phrases/schedule/events), inputs schema, risk tier, data-use notes
  steps.*      declarative steps or sandboxed script
  ui/          optional panel definitions
  tests/       example utterances + expected outcomes
```

## Phases
1. **Spec and loader (1 w):** manifest schema, validation, permission display; map onto the policy engine (15) so a skill cannot exceed its declared grants.
2. **Runtime and sandbox (1–2 w):** declarative steps first; scripts run in a restricted worker/process with network/file allow-lists and timeouts.
3. **First-party packs (2 w):** Morning briefing (12), Meeting prep, Dev standup, Inbox triage (read-only → draft replies), Travel planner (13), Focus mode, Expense capture, Home scenes (09), Study/quiz buddy, Daily journal.
4. **Install/update/remove UX:** permission review screen, version pinning, rollback, per-skill kill switch.
5. **Authoring by voice/chat:** JARVIS drafts a skill from a described task or from a successful mission (13), runs its tests, shows a diff for approval.
6. **Distribution:** local folder → git URL → curated registry; signatures and publisher identity; malware/injection scanning of skill content.
7. **Telemetry-free ratings:** local-only usage stats shown to the user, no phone-home.

## Metrics
Time to author a skill < 15 min; first-party pack success ≥ 90 % on their test utterances; zero permission escapes in a red-team suite.

## Risks
Supply-chain attacks (the main one) → signatures, permission prompts, sandbox, review; skill sprawl → quotas and curated defaults.

## Related plans
[13](13-autonomy-and-background-agents.md) · [15](15-policy-trust-and-privacy.md) · [33](33-knowledge-work-and-meetings.md) · [36 marketplace licensing](36-economics-and-licensing.md)
