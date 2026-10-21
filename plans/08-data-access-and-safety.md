# 08 · Data access and safety

**Status:** Partial · **Priority:** P0/P1 · **Effort:** 2–3 h (gate), 1–2 days (injection)

## Today
JARVIS reaches any MCP server in the user's Claude config (mail, calendar, files, web).
Effectful tools are off by default and go through an approval queue (`bridge/approvals.mjs`).

## Gaps (from `IMPROVEMENT_PLAN.md` #3, #4)
1. **Permission gate guesses from tool names.** `READ_VERB` (`server.mjs` ~309) only checks a
   read-verb prefix, so `checkout_cart` or `read_and_archive` would run read-only. Fix: split
   names into words, require a read verb first and no action verb anywhere; move
   `decideTool` to its own file with table-driven tests; consider spend caps for
   credit-spending tools.
2. **Read-only can still leak.** Page/email content could trick JARVIS into putting your data
   in a URL. Fix: persona rule that content is data, never instructions; require approval to
   visit unnamed sites after reading private content; only proxy image/video URLs that
   appeared in a tool result (`proxyRemote`, `chrome_navigate`).
3. **Connect read-only first** is the policy; document how to add send/edit per account.

## Done when
`decideTool` has a test table including the bad names above, and an injection test shows a
malicious page cannot trigger a navigation without approval.
