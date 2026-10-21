# 13 · Autonomy: background agents and long-running work

**Status:** Partial (mission board + task store exist on `release/0.1.5`) · **Priority:** P1 · **Effort:** 3–6 weeks

## End state
You hand JARVIS a goal ("plan my trip to Berlin", "get the repo's CI green", "prepare Friday's
board pack") and he works on it in the background — planning, using tools, checking his own
work, asking only for approvals or missing facts — and reports progress and results when you
are free. Several jobs run in parallel and can be paused, steered and audited.

## Today (verified)
`bridge/tasks.mjs`, `task-store.mjs`, `task-tools.mjs`, `src/ui/Missions.tsx` (mission board).
Verify exact capabilities of these before building on them.

## Model
Mission = goal + plan (steps) + budget + permissions + status + log + artifacts.
```
plan → step → tool call → policy check → (approval?) → result → self-check → next step
                         ↘ failure → retry/alternate/ask → …
```

## Phases
1. **Mission lifecycle (1 w):** create/pause/resume/cancel; persistent; survives restarts; voice commands ("what are you working on?", "pause the trip planning").
2. **Planner and verifier (1 w):** explicit plan shown for approval on risky missions; each step has a success check; the agent verifies the result against the goal before reporting done.
3. **Budgets and guardrails:** time, tokens/cost, tool-call count, allowed tools, allowed paths/domains; hard stops; "ask me before spending more".
4. **Approvals inbox:** batch approvals across missions into one card list; approve by voice ("approve the first two").
5. **Progress narration:** short spoken updates at milestones only when idle; summary on completion; full log on the board.
6. **Parallelism and sub-agents (2 w):** research, code, browser and writing sub-agents with a coordinator; isolated workspaces (git worktrees, temp dirs) to avoid collisions.
7. **Scheduled & triggered missions:** recurring ("every Friday compile the status report"), event-driven (12).
8. **Learning from outcomes:** save successful plans as reusable skills (19) after approval.
9. **Handoff to human:** clean "I'm blocked because X; options A/B" messages.

## Metrics
Mission success rate; % requiring human help; average cost per mission; approval turnaround; zero out-of-scope tool calls (policy audit).

## Risks
Runaway cost/loops → budgets and watchdogs; compounding errors → verifier step and checkpoints; hidden side effects → dry-run first, reversible actions preferred, full audit trail.
