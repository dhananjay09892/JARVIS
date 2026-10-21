# Codex as a connector (tool executor or brain)

**Kind:** tool-provider / brain · **Auth:** ChatGPT sign-in or API key · **Platform:** Any · **Risk tier:** R2–R3 (it can edit files and run commands) · **Priority:** P1 (research), build with [plan 22](../../../22-brain-openai-codex.md)

## What it gives JARVIS
A strong coding and long-task agent that JARVIS can hand work to ("fix the failing test", "refactor this module") and report on, instead of JARVIS doing it itself. It can be wired in as:
- **Mission executor** for background missions (plan 13), or
- **A brain option** in the multi-brain framework (plan 21).

## What is known (OpenAI docs, 2026-10-21)
- Sign-in options: ChatGPT subscription or API key; credentials cached in `~/.codex/auth.json` or the OS credential store; for automation OpenAI recommends **API keys**; headless machines can use device-code login (beta); enterprise admins can issue access tokens for trusted scripts.
- The docs list a non-interactive mode and an SDK (not read in detail here).
- Whether a third-party app may use a user's ChatGPT login with Codex is **unconfirmed** (plan 22, week 0 research).

## How a user connects it
1. Install the Codex CLI (or use the bundled one if we ship it, subject to licence).
2. Sign in: `codex login` with ChatGPT, or provide an API key (preferred for automation).
3. In JARVIS: **Settings → Brains / Executors → Codex** → "Detect" → pick the **working folder** it may touch (the dedicated workspace, not the whole disk) → choose approval mode (JARVIS shows the approval card; Codex runs read-only or workspace-write sandbox).
4. Test: "Jarvis, ask Codex to explain this repository" (read-only).

## How we implement it in JARVIS
1. Adapter `bridge/brains/codex.mjs` / `bridge/executors/codex.mjs` per plans 21 and 22: spawn Codex in non-interactive mode, stream events to the normalised `BrainEvent` shape (plan 38).
2. **Sandbox and scope:** read-only by default; workspace-write only inside the dedicated workspace; no network unless approved; environment scrubbed.
3. **Approvals:** every command/file change request surfaces as a JARVIS approval (HUD, phone), not auto-approved by Codex. Map Codex approval modes (`auto|prompt|writes|approve`) conservatively.
4. **MCP and skills passthrough:** give Codex only the MCP servers and skills the owner allows for that task (see [mcp](../mcp/README.md), [skills](../skills/README.md)).
5. **Budgets and cancel:** token/time/command limits per mission; barge-in "stop" cancels the process.
6. **Reporting:** summarise results by voice; full diff and logs on the mission board.
7. **Fallback:** if Codex is unavailable or rate-limited, the mission falls back to another executor or pauses with a clear message.

## Acceptance tests
Read-only task completes and reports; a write request pauses for approval; denied command stays denied; cancel stops the process within the latency budget; no secrets from JARVIS's environment appear in Codex's environment.

## Risks
Terms for subscription login in third-party apps; coding agents running commands with user privileges; changing CLI behaviour; cost and rate limits.

## Related
[Codex overview](../README.md) · [plans 13](../../../13-autonomy-and-background-agents.md), [21](../../../21-multi-brain-framework.md), [22](../../../22-brain-openai-codex.md), [15](../../../15-policy-trust-and-privacy.md)
