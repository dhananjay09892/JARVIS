# 08 · Data access, connectors and injection defence

**Status:** Partial · **Priority:** P0/P1 · **Effort:** 1–3 weeks

## End state
JARVIS can read your calendar, mail, messages, files, tasks, finances (read-only), the web and
your devices through vetted connectors, **without ever being tricked by the content it reads**,
and without silently doing anything irreversible.

## Today (verified)
Any MCP server in the user's Claude config; effectful tools default-deny; approval queue in
`approvals.mjs`. Known defects from `IMPROVEMENT_PLAN.md`: #3 name-prefix read heuristic
(`READ_VERB`), #4 read-only mode can still exfiltrate via URLs.

## Phases
1. **Fix the gate (P0, 2–3 h):** word-split names; read verb first and no action verb; move `decideTool` into its own module; table-driven tests including adversarial names.
2. **Injection defence (P1, 1–2 d):**
   - Mark all tool/page/email/file text as *untrusted data* in the prompt and in code paths.
   - **Taint tracking:** once a turn has read private content, outbound actions (open URL, fetch, send, write) require approval unless the target was named by the user.
   - Only proxy image/video URLs that appeared in a tool result.
   - Strip/neutralise hidden text (zero-width, white-on-white) from fetched pages.
3. **Connector catalogue (1 w):** curated, documented setups for calendar, mail, tasks, notes, files, weather, news, finance (read-only), GitHub; each with a read-only profile and an "enable writes" profile.
4. **Scopes and consent:** per-connector, per-speaker (01/15), time-boxed grants ("allow sending for 10 minutes").
5. **Data minimisation:** summarise before sending to the model; don't pass full mailboxes; redact secrets/PII patterns.
6. **Spend caps** for credit-spending tools (image/video/voice generation).
7. **Connector health:** token expiry detection, "your calendar connection expired, shall I walk you through it?".

## Metrics
Gate test suite ≥ 100 cases; red-team prompt-injection suite (pages, emails, filenames) with 0 successful exfiltrations; connector availability dashboard.

## Risks
Over-blocking annoys users → risk tiers instead of blanket denial; MCP servers that mislabel tools → policy by tool name *and* capability annotations *and* user-defined overrides.

## Related plans
[15](15-policy-trust-and-privacy.md) · [35 never-list](35-ethics-limits-and-governance.md) · [16 red-team suite](16-evals-and-observability.md) · [20 channel injection](20-messaging-channels.md) · [38 PolicyRequest](38-shared-data-contracts.md)
