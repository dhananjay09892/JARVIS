# 37 · Execution roadmap, dependency graph and risk register

This file turns 38 plans into an order of work. It is the one to read when asking "what do
we do on Monday?". Effort numbers are rough and should be re-estimated at the start of each
phase.

## 1. Dependency graph (what blocks what)

```
                       ┌──────────────┐
                       │ 16 Evals/obs │◄──────────── everything reports here
                       └──────┬───────┘
 ┌─────────┐   ┌──────────┐   │         ┌───────────┐
 │ 08 Gate │──►│ 15 Policy│───┼────────►│ 35 Ethics │ (rules → tests)
 └─────────┘   │  engine  │   │         └───────────┘
               └────┬─────┘
     ┌──────────────┼───────────────┬─────────────────┬──────────────┐
     ▼              ▼               ▼                 ▼              ▼
 01 Speaker ID   21 Multi-brain   20 Channels    12 Proactive    13 Agents
     │              │               │                │               │
     ▼              ▼               ▼                ▼               ▼
 30 Family      22–27 Providers   34 Mobility     14 Context      19 Skills
 03 Rooms                         (push, remote)  32 Health       33 Work/meetings
 09 Home ◄── 11 Vision            31 Finance                      
                                                                   
 02 Private wake ─► 04 Speech stack ─► 28 Multilingual ─► 29 Onboarding
 05 Latency ─► 06 Routing ─► 07 Memory ─► 14 Context
 17 Resilience wraps all hubs; 18 HUD surfaces all states; 36 Economics constrains all.
```

**Critical path to a "wow" release:** 08 → 15 (core) → 16 (traces) → 02 → 05/06 → 21+25 → 01 → 12 → 20 (Telegram) → 29.

## 2. Phases with exit gates

| Phase | Weeks | Plans | Exit gate (all must pass) |
|---|---|---|---|
| **0 Trust and truth** | 1–4 | 08 (gate fix, injection), 15 (extract policy, audit), 02 (disclosure + engine), 16 (traces, latency number), 35 (never-list), 36 (licence register v1), `IMPROVEMENT_PLAN.md` P0 items | Gate tested with adversarial cases; no room audio upload while asleep; latency visible; never-list published; licence blockers resolved |
| **1 Identity and feel** | 5–10 | 01, 05, 06, 21, 25, 28 (audit + profile), 29 (wizard v2) | 2 speakers recognised ≥ 95 %; median latency ≤ 1.2 s; provider interface with Claude + API-key brain passing conformance; wizard completion ≥ 85 % |
| **2 Proactive and connected** | 11–16 | 12, 20 (Telegram), 14 (context broker), 07 (semantic memory), 23 or 22 (after terms decision) | Morning briefing and quiet hours live; message JARVIS via Telegram with approvals; semantic recall ≥ 90 % |
| **3 Autonomy and work** | 17–24 | 13, 19, 33, 31 (read-only) | Background missions with budgets/approvals; first skill packs; meeting minutes and cited retrieval |
| **4 Home and the world** | 25–34 | 09, 03, 11, 30, 34, 20 (SMS/WhatsApp), 32 | Rooms/satellites working; lights/locks with tiers; phone away-from-home with biometrics approval; family roles |
| **5 Resilience and polish** | 35–44 | 17, 18, 04 (offline), 26, 24, 27 | Always-on service, backup/restore drill, degraded modes, offline basics, upgraded HUD |

## 3. First 30 / 60 / 90 days

**Days 1–30 (Phase 0):**
1. Merge `docs/plans`; adopt this roadmap; create tracking issues per plan.
2. Fix the permission gate + tests (08); extract `policy.mjs` skeleton (15).
3. Correct wake-word disclosure; spike Porcupine/openWakeWord offline gating (02).
4. Add turn tracing and the latency number to diagnostics (16, 05).
5. Publish the never-list; licence register v1 (35, 36).
6. Decide terms stance for subscription brains (21–24, 27) and record ADRs.

**Days 31–60 (start Phase 1):**
1. Brain interface refactor with Claude adapter and conformance suite (21).
2. OpenAI-compatible API adapter, keys server-side only (25).
3. Settings registry and API, secrets to keychain (39) so every new feature gets its settings for free.
4. Speaker ID MVP: enroll/identify, owner vs guest (01).
5. Reflex layer + fast/deep routing (06); effort default decision (05).
6. Multilingual audit and per-person language profile (28).

**Days 61–90 (finish Phase 1, begin Phase 2):**
1. Wizard v2 with calibration and echo test (29).
2. Event bus, notification policy, morning briefing (12).
3. Telegram channel with pairing and approvals (20).
4. Semantic memory v1 (07). First user test with a non-technical household.

## 4. Operating cadence
- **Two-week iterations**, one demo per iteration, each plan item has a user-visible or measurable outcome.
- **Definition of ready:** plan section has acceptance tests, owner, and metrics.
- **Definition of done:** tests, metric visible in 16, settings toggle, docs/disclaimer updated, never-list tests green.
- **Release train:** every 4–6 weeks; beta channel first (17); each release re-runs the safety/red-team gate (35).
- **Decision records (ADRs):** `plans/adr/NNN-title.md` for every decision below.

## 5. Open decisions (each becomes an ADR)
1. Subscription logins for Claude/Codex/Copilot/Gemini: allowed per vendor terms? (21–24)
2. Wake engine: Porcupine vs openWakeWord (02).
3. Speaker-embedding model and where it runs: browser vs bridge (01).
4. Vector store for memory (07).
5. Messaging provider and whether WhatsApp is worth it (20).
6. Public relay vs VPN for remote access (34).
7. Project name/branding and legal review (36).
8. Sustainability model (36).
9. Windows-first vs cross-platform timing (10, 17).
10. Scheduled publishing approvals: may an approved post go out while the owner is away? (41, ADR 005)

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner plan |
|---|---|---|---|---|---|
| R1 | Vendor terms forbid subscription use in third-party apps; access revoked | M | H | Multi-brain with API-key fallback; terms register; ask vendors | 21–25 |
| R2 | Prompt injection leads to data leak or action | H | H | Taint tracking, policy engine, red-team gate | 08, 15, 35 |
| R3 | Always-listening perception / legal exposure (recording laws, biometrics) | M | H | Offline wake, indicators, consent flows, regional register | 02, 35 |
| R4 | Latency too high; product "feels dumb" | H | H | Measure first, routing, speculative start | 05, 06, 16 |
| R5 | Wrong action from misheard command (home, money) | M | H | Risk tiers, approvals, undo, dry-run | 09, 15 |
| R6 | Scope explosion; nothing ships | H | H | Phase gates, critical path, kill-or-defer rule per plan | this file |
| R7 | Maintenance burden of many adapters/CLIs | H | M | Conformance suite; ≤ 2 new brains per release; remove failing ones | 21, 27 |
| R8 | Cost surprises | M | M | Caps, cheap-first routing, cost UI | 25, 36 |
| R9 | Licence/IP problems (name, voices, models) | M | H | Licence register, legal review, original voice | 36 |
| R10 | Privacy breach from logs/telemetry/backups | L | H | Redaction, local-only, encrypted backups | 15, 16, 17 |
| R11 | Poor non-English quality (Gujarati/Hindi) | H | M | Audit + quality labels + fallbacks | 28 |
| R12 | Hardware/OS variance (mic, echo, Windows audio) | H | M | Onboarding self-tests, device profiles | 29, 03 |
| R13 | Update breaks DBs or settings | L | H | Backup-before-migrate, rollback | 17 |
| R14 | Single developer bottleneck | H | H | Prioritise ruthlessly, automate tests, document decisions | this file |
| R15 | Child/elder safety incident | L | H | Strict defaults, consent, red-team | 30, 32, 35 |

## 7. What "done" looks like for the whole programme
A household can install JARVIS, speak to him in their languages from any room or from the
phone, be recognised, get a morning briefing, hand off a multi-step task and check on it
later, control the home safely, and trust that every action is explainable, reversible,
limited by their rules, and independent of any single AI vendor.
