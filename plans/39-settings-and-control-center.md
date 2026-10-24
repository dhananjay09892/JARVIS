# 39 · Settings and control center

**Status:** Partial (basic Settings + 3-step wizard exist; phase 1 done) · **Priority:** P1 (grows with every plan) · **Effort:** 3–5 weeks for the framework and first sections, then incremental · **Depends on:** 15 (secrets, policy), 21 (brains), 38 (contracts), 29 (onboarding)

## End state
One place to see and control everything JARVIS is and does: which brain, which voice, who
is allowed what, what is connected, what it costs, what leaves the machine, and whether
everything is healthy. It is safe by default, plain-language, searchable, live (no restarts),
and scoped per person. Each plan adds its own section instead of piling controls onto one page.

## Today (verified in the repo)
- `src/ui/Settings.tsx` (288 lines): a first-run wizard ("Welcome — step 1 of 3": Claude, optional ElevenLabs voice, all set) and a Settings dialog with **Claude** sign-in, **Voice** (ElevenLabs key), **Brain** (model, effort), **Actions** (allow writes).
- `src/lib/settings.ts`: `PublicSettings` = `ELEVENLABS_API_KEY_set`, `JARVIS_MODEL`, `JARVIS_EFFORT`, `JARVIS_VOICE_ID`, `JARVIS_ALLOW_WRITES`, `setupDone`, `storage`; `GET/POST /settings`, `/setup/status`, `/setup/test-elevenlabs`, `/setup/claude-login`.
- Model, effort and actions apply **after a restart**. The ElevenLabs key re-probes capabilities live.
- Single user, flat key/value settings, no sections, search, per-person scope, status badges or export.

## Information architecture
Left rail with search, status dot per section, and a **Simple / Advanced** toggle.

| # | Section | Main controls | Owner plans |
|---|---|---|---|
| 1 | Brains | default brain, sign-in/status, subscription vs API key, fast/deep model, effort, fallback order, test button | 21–27, 06 |
| 2 | Voice and hearing | STT/TTS engine, voice picker + preview, speed, whisper mode, wake words (built-in Tamelo/Buddy/Friend on/off, custom name, per-phrase sensitivity, test button), conversation window, mic/speaker test, calibration | 02, 04, 05, 29 |
| 3 | Languages | spoken languages, reply language, script, pronunciation dictionary, per-language voice | 28 |
| 4 | People and voices | members and roles, enroll/forget voice, per-person language/brain/permissions, guest mode, presence | 01, 30 |
| 5 | Safety and permissions | read-only/write switch, risk-tier table, standing grants, PIN/safe word, freeze phrase and hotkey, spend caps, never-list viewer | 15, 08, 35 |
| 6 | Connectors and tools | MCP servers, health, read/write scope, add/test/remove, per-person access | 08, 10 |
| 7 | Memory and privacy | memories (view/edit/delete), retention, vault, voiceprints, data-flow table per provider, export/erase all, telemetry off | 07, 15, 35 |
| 8 | Alerts and routines | quiet hours, DND rules, urgency→channel, briefings, muted sources, held-back log, workflows | 12, 19 |
| 9 | Channels | Telegram/SMS/WhatsApp connect and pair, allowed senders, approval PIN, sensitivity rules, budgets | 20 |
| 10 | Devices and rooms | paired devices/satellites with revoke, rooms, Home Assistant + entity allow-list, cameras/zones, remote access | 03, 09, 11, 34 |
| 11 | Context and capture | per-source switches, app denylist, capture indicator, meeting-recording defaults | 14, 33 |
| 12 | Costs and limits | spend per brain/service, caps, warning thresholds, cheap-first routing | 36, 25 |
| 13 | Display and accessibility | HUD theme/quality, reduced motion, high contrast, captions, text input mode, visual alerts | 18 |
| 14 | System | start with Windows, tray, auto-restart, update channel/button, backup/restore, health, logs, support bundle, licences, re-run wizard | 17, 29, 36 |
| 15 | Diagnostics | latency, wake/false-wake log, speaker confidence, routing, policy decisions, audit timeline | 05, 16, 15 |

Not in Settings (live in the HUD, Settings only configures them): approvals inbox, mission board, memory browsing, audit timeline viewer.

## Architecture
1. **Settings registry (single source of truth):** each setting declared once with `id, section, label, help, type, default, scope (global|person|device), risk (normal|sensitive|dangerous), apply (live|restart|reconnect), visibleIn (simple|advanced), validate(), secret?`. The UI, the API, the docs and the tests are all generated from it.
2. **Storage tiers:** plain settings in the settings DB; **secrets in the OS keychain/DPAPI** (API keys, tokens), the DB holds only `*_set` flags; per-person settings keyed by `personId`; device settings keyed by `deviceId`.
3. **API:** `GET /settings/schema`, `GET /settings?scope=…`, `PATCH /settings` (batch, validated, transactional), `POST /settings/test/:id` (connection tests), `POST /settings/export|erase`. Every write returns the new effective state plus `appliedLive` / `needsRestart`.
4. **Live apply:** a settings-changed event on the bus (38) so subsystems reconfigure without restart; where impossible, a clear "Restart JARVIS to apply" banner with one button.
5. **Validation and safety:** server-side validation; dangerous changes (enable writes, add allowed sender, disable freeze, raise caps) require confirmation and, for R3, the owner PIN and a short cooldown; all changes written to the audit log (15) with old and new values (secrets redacted).
6. **Roles:** owner sees everything; members see their own scope; children see almost nothing; guests none.
7. **Profiles and presets:** "Private & offline", "Balanced", "Maximum capability" bundles that set many options at once, shown with the exact differences before applying.
8. **Import/export:** settings (without secrets) as JSON for backup and migration (17); secrets re-entered or restored from an encrypted backup.
9. **Deep links:** `jarvis://settings/alerts#quiet-hours`; voice: "open alert settings"; error messages link to the relevant control.
10. **Status model:** each section reports `ok | attention | error` from live probes (sign-in valid, mic working, backup recent, quota near limit).

## UX rules
- Safe defaults; plain language; say what data each setting touches.
- Show **state**, not only inputs ("Claude: signed in as X", "Backup 2 days ago").
- Secrets never displayed back; "set" with Replace/Remove.
- Per-setting reset and per-section "restore defaults".
- Searchable, keyboard-accessible, screen-reader labelled, works at phone width (PWA 34).
- Mobile/remote: sensitive sections require biometrics or PIN.

## Phases
1. **Registry and API (1 w):** ✅ done (Q19). Extract today's 6 settings into the registry; schema endpoint; PATCH with validation; keep current UI working through the schema.
2. **New shell (1 w):** left rail, search, Simple/Advanced, status dots; migrate Claude/Voice/Brain/Actions into Brains, Voice, Safety.
3. **Secrets to keychain (3 d):** move the ElevenLabs key and future provider keys; migration with backup (17).
4. **Live apply + restart banner (3 d):** event on settings change; remove restart where possible.
5. **Safety section (1 w):** risk-tier table, standing grants, PIN/freeze setup, change confirmation + audit entries (15).
6. **Brains section (1 w)** alongside the first extra provider (21, 25).
7. **People, Languages, Voice sections** as 01, 28, 02 land.
8. **Memory/privacy centre and data-flow table (1 w)** with export and erase-all.
9. **Alerts, Channels, Devices, Context, Costs** incrementally as their plans ship; each plan's definition of done includes "its settings section exists".
10. **System and Diagnostics sections** with 17 and 16.
11. **Presets and import/export (3 d).**
12. **Accessibility and mobile pass (3 d).**

## Metrics (in 16)
- Time to find a setting (task test with 5 users) ≤ 20 s.
- Settings changes that need a restart: only the ones listed as such (target 0 for new settings).
- Mis-configuration rate: users who accidentally enable writes or unsafe options = 0 in testing.
- 100 % of settings declared in the registry, with tests generated from it.
- Secrets in plain storage = 0 (automated scan).

## Risks
- Settings sprawl → registry rules: every setting needs a section, a default, help text and a test; delete unused ones.
- Hidden risky options → dangerous flag, confirmation, audit, owner-only.
- Live reconfiguration bugs → conformance tests per subsystem, safe fallback to last good config.
- Migration breakage → backup-before-migrate (17).

## Done when
All current settings live in the registry; the new shell ships with search and status; secrets are in the keychain; a settings change audit entry exists for every write; and adding a new setting for a future plan takes one registry entry, with the UI, API and tests following automatically.

## Autopilot log
- **2026-10-23 — Phase 1 (Q19).** `bridge/settings-registry.mjs` declares all eight current
  settings (the six above plus `JARVIS_TRACES` and `JARVIS_AUDIT`, added by Q05/Q06) with
  `id, section, label, help, type, options/pattern, default, scope, risk, apply, visibleIn,
  secret`, and the 15 sections from the information architecture. `checkRegistry` enforces the
  "every setting needs a section, a default, help text" rule at boot. `bridge/settings.mjs`
  validates through it; `updateSettings` now also accepts `true/false` for booleans and `null`
  to clear, and returns `changed / appliedLive / needsRestart / overridden`. The bridge serves
  `GET /settings/schema` and a validated, all-or-nothing `PATCH /settings` (POST kept for older
  pages; same Origin rule; the CORS preflight now names PATCH). Model, effort and voice defaults
  come from the registry. The Settings dialog reads the schema for the effort options, defaults
  and help text, saves with PATCH, and says "Restart to apply" only when the bridge reports it.
  Tests are generated from the registry (`bridge/settings-registry.test.mjs`: one save/read/
  clear/reject test per setting, schema has no values, secrets never public).
  **Left:** phases 2–12. Values are still flat strings in one global scope; `person`/`device`
  scope, the settings-change audit entry and confirmation for `dangerous` settings come with
  phases 5 and 7. Restart-only settings are unchanged (phase 4, Q23). The registry is plain
  `.mjs`, not a `shared/contracts.ts` schema, for the same reason as plan 38 phase 3: the bridge
  cannot import `.ts` on Node 22.13.
- **2026-10-24 — Section 6, first slice (connector task C03).** Settings now has a Connectors part: one card per registered connector with status dot, what it can see, scopes, last sync, Test, Disconnect, Erase data, on/off switch, permissions and Freeze all, served by `bridge/connectors/routes.mjs`. Grants are saved in `connectors.json` (no secrets); tokens go only to the credential store. It sits in the current single-page dialog until the phase 2 shell.

## Related plans
[15](15-policy-trust-and-privacy.md) · [17](17-deployment-and-resilience.md) · [21](21-multi-brain-framework.md) · [29](29-onboarding-and-first-run.md) · [35](35-ethics-limits-and-governance.md) · [36](36-economics-and-licensing.md) · [38](38-shared-data-contracts.md)
