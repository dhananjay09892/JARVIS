# 10 · Computer and phone control

**Status:** Partial · **Priority:** P1 (wording), Later (cross-platform) · **Effort:** hours / 1–2 weeks

## Today
Android MCP (phone), approved Windows app launching and commands (`bridge/apps.mjs`),
dedicated development workspace (`workspace.mjs`), Chrome driving (`chrome.mjs`), and daily
workflows (`workflows.mjs`).

## Steps
1. **Honest labels (hours):** `apps.mjs:34` throws off Windows. Mark launching and approved
   commands "Windows only" in README/site and check the platform before showing the card.
2. **Fixed automations first:** a small library of saved workflows for repeated jobs
   ("open project and email report"). Use screen-clicking agents only for one-offs.
3. **macOS/Linux** launching later, behind the same approval queue.

## Done when
No feature claims a platform it does not support; at least three example workflows ship.
