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
1. ✅ **Fix the gate (P0, 2–3 h) — done (autopilot, 2026-10-22, awaiting review):** word-split names; read verb first and no action verb; move `decideTool` into its own module (`bridge/tool-gate.mjs`); table-driven tests including adversarial names (`bridge/tool-gate.test.mjs`, 141 cases).
2. **Injection defence (P1, 1–2 d) — first half done (autopilot Q02, 2026-10-22, awaiting review):**
   - ✅ Mark all tool/page/email/file text as *untrusted data* in the prompt and in code paths.
   - **Taint tracking:** once a turn has read private content, outbound actions (open URL, fetch, send, write) require approval unless the target was named by the user.
   - Only proxy image/video URLs that appeared in a tool result.
   - ✅ Strip/neutralise hidden text (zero-width, white-on-white) from fetched pages.
3. **Connector catalogue (1 w):** curated, documented setups for calendar, mail, tasks, notes, files, weather, news, finance (read-only), GitHub; each with a read-only profile and an "enable writes" profile.
4. **Scopes and consent:** per-connector, per-speaker (01/15), time-boxed grants ("allow sending for 10 minutes").
5. **Data minimisation:** summarise before sending to the model; don't pass full mailboxes; redact secrets/PII patterns.
6. **Spend caps** for credit-spending tools (image/video/voice generation).
7. **Connector health:** token expiry detection, "your calendar connection expired, shall I walk you through it?".

## Metrics
Gate test suite ≥ 100 cases; red-team prompt-injection suite (pages, emails, filenames) with 0 successful exfiltrations; connector availability dashboard.

## Risks
Over-blocking annoys users → risk tiers instead of blanket denial; MCP servers that mislabel tools → policy by tool name *and* capability annotations *and* user-defined overrides.

## Autopilot log
- **2026-10-22 — Phase 1 (fix the gate).** Moved `decideTool` and its lists out of
  `bridge/server.mjs` into dependency-free `bridge/tool-gate.mjs` (`createToolGate`).
  Read verbs now match the *first whole word* of the tool name (`checkout_cart` no longer
  passes as `check`), and a new whole-word `ACTION_WORDS` veto (archive, move, share,
  forward, reply, order, checkout, transfer, approve, merge, submit, upload, run, set,
  cancel, plus money/access/machine verbs) withholds names like `read_and_archive`. The old
  substring `EFFECTFUL_VERB` veto is kept unchanged. A parity check against the old gate
  showed only tightenings (old allow → new deny), no loosening. 141 table-driven cases.
  Known trade-off: reads whose noun is an action word (`get_order`) and unseparated names
  (`listdevices`) are now withheld in read-only mode; per-tool overrides belong to 15.
  **Left:** add `bridge/tool-gate.test.mjs` to the CI test list in
  `.github/workflows/release.yml` (not touched by autopilot); Phase 2 injection defence next.
- **2026-10-22 — Q02, Phase 2 first half (untrusted content and hidden text).** New
  dependency-free `bridge/untrusted.mjs`: `stripHiddenText` (zero-width, bidi controls,
  Unicode tag characters, variation selectors), `stripHiddenHtml` (display:none,
  visibility, opacity, zero font size, white-on-white and same-colour text, off-screen,
  clip, `hidden` attribute, `sr-only`-style classes, comments), and `wrapUntrusted`, an
  `<untrusted_data source="…">` envelope whose closing tag cannot be forged from inside
  (control tags are defanged). Applied where text enters a turn: every `chrome_*` result
  (`chrome.mjs`), `probe_url` (`panels.mjs`), the reading view and probe excerpt
  (`page.mjs`, hidden elements and entity-encoded invisible characters removed), and a
  `PostToolUse` hook in the voice session and background workers that labels every other
  result — built-ins such as WebFetch/Read and third-party MCP servers — as untrusted.
  Both system prompts gained an "Untrusted content" section (`UNTRUSTED_PROMPT`).
  Tests: `bridge/untrusted.test.mjs` (122) and `bridge/page.test.mjs` (3).
  **Left:** the `PostToolUse` `additionalContext` field could not be checked against the
  installed SDK in this run (npm registry unreachable), so confirm once on a real bridge
  that the note reaches the model; add the new test files to the CI list in
  `.github/workflows/release.yml`; a metric (hidden characters removed per turn) for 16;
  Q03 (taint tracking, image/video URL proxy limits) next.

## Related plans
[15](15-policy-trust-and-privacy.md) · [35 never-list](35-ethics-limits-and-governance.md) · [16 red-team suite](16-evals-and-observability.md) · [20 channel injection](20-messaging-channels.md) · [38 PolicyRequest](38-shared-data-contracts.md)
