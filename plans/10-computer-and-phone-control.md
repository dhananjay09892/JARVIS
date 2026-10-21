# 10 · Hands: computer, phone and browser control

**Status:** Partial · **Priority:** P1 (labels), Later (breadth) · **Effort:** 2–6 weeks

## End state
"Open the project, run the tests, and email me the summary." / "Book the 7pm table." /
"Find that PDF Sam sent last month." JARVIS operates your PC, phone and browser reliably
using the **cheapest dependable method first** (API → MCP → saved automation → UI agent),
shows what it is doing, and asks before anything consequential.

## Today (verified)
Android MCP (phone), approved Windows app launching & commands (`apps.mjs`, throws on
non-Windows), development workspace (`workspace.mjs`), Chrome driving (`chrome.mjs`), daily
workflows (`workflows.mjs`), mission board for tasks (`tasks.mjs`, `task-store.mjs`).

## Execution ladder
1. Direct API / MCP tool (fast, reliable).
2. Saved workflow/automation (deterministic, reviewed).
3. Local OS scripting (PowerShell/AppleScript/Shortcuts) via approved command runner.
4. Browser automation (DOM/accessibility tree).
5. Screen-vision "computer use" agent (slowest, last resort, always visible + interruptible).

## Phases
1. **Truthful platform support (hours):** label Windows-only features; platform check before cards.
2. **Skill library (1–2 w):** 15–20 reviewed, parameterised automations: open project, daily standup summary, file search, meeting prep, expense capture, screenshot-to-note, etc. (see 19).
3. **Safer command runner:** allow-listed commands with argument schemas, dry-run preview, working-dir sandbox, timeouts, output size caps, secrets redaction.
4. **Window/screen awareness (with 14):** "what's on my screen?", "fix this error" with consent per capture.
5. **Phone depth:** notifications triage, calls/messages draft-and-approve, location-aware reminders.
6. **Computer-use agent (optional):** gated, step-by-step narration, hard stop word, region/app allow-list, recorded run log.
7. **macOS/Linux parity:** abstract the launcher behind platform adapters.
8. **Undo & audit:** every action logged with enough detail to reverse (move file → record original path).

## Metrics
Task success rate per skill (target ≥ 90 %), mean steps vs. ladder level used, % tasks solved at levels 1–3, interrupted-run recovery rate.

## Risks
UI agents mis-click → last resort + approval; destructive commands → schema-validated runner and policy tiers; credentials exposure → never read password managers, never type secrets.
