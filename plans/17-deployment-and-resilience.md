# 17 · Always-on, self-healing, recoverable

**Status:** Partial (Windows installer + update check) · **Priority:** P1/P2 · **Effort:** 3–5 weeks

## End state
JARVIS runs like an appliance: starts with the machine, survives crashes, updates safely,
degrades gracefully when the internet or a service dies, backs up and restores in one click,
and can move to a dedicated mini-PC/home server so your laptop isn't required.

## Today (verified)
Windows installer (bundles Node), launcher, `update.mjs` (UPDATE button), `restart-jarvis.ps1`.
Unsigned installer (SmartScreen warning); no service mode; CI only on tags.

## Phases
1. **Release trust (P1):** code-sign installer; app icon; CI on PRs (typecheck, lint, tests); required status checks.
2. **Run as a service (1 w):** start at login/boot, tray icon with status, auto-restart with backoff, crash reports (local, opt-in upload).
3. **Headless hub mode (1 w):** bridge on a mini PC/NAS/Raspberry Pi-class box; UI served over LAN with TLS & auth; edges (03) connect to it.
4. **Degraded modes (1 w):** explicit state machine: *Full* → *No-cloud-voice* (browser STT/Kokoro) → *No-brain* (reflex layer + HA local intents + timers) → *Offline basics*. The HUD and voice announce the current mode.
5. **Backup / restore / migrate (3 d):** encrypted export of memory, settings, voiceprints, workflows, missions; scheduled backups; verified restore; move to a new machine.
6. **Safe updates (3 d):** staged channel (stable/beta), signature check, auto-rollback if health check fails after update, migration tests for DBs.
7. **Cross-platform (later):** macOS/Linux packages (app launching adapters from 10).
8. **Resource governor:** CPU/RAM limits; heavy local models only if hardware allows; battery-aware.
9. **Support bundle:** one-click redacted diagnostics zip.

## Metrics
Uptime, crash-free sessions ≥ 99.5 %, restore drill passes quarterly, update rollback success, time to recover from network loss < 10 s into degraded mode.

## Risks
Signing cost/process, DB migrations corrupting data → backup-before-migrate, LAN exposure → auth + TLS + local-only default.

## Related plans
[29 onboarding](29-onboarding-and-first-run.md) · [34 remote access](34-wearables-and-mobility.md) · [36 licences](36-economics-and-licensing.md) · [37 phases](37-execution-roadmap-and-risks.md)
