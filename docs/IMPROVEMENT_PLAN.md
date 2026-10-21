# JARVIS improvement plan

What to fix, in what order, and what can wait. Each item was checked against the
code where it could be (marked ✔ verified). Effort figures are rough.

Last updated: October 2026 · app version 0.1.4 · #5 decision recorded

---

## How to read the priorities

| Tier | Meaning | When |
|---|---|---|
| **P0** | Could hurt users or the project's right to ship. Do before promoting JARVIS to non-technical users. | Now |
| **P1** | Real defect or false claim, cheap or medium to fix. | Next |
| **P2** | Quality and polish. Worth doing, nothing breaks without it. | After P1 |
| **Later** | New features. Good ideas, none of them needed for a safe, honest v1. | When the base is solid |

---

## P0 — do first

### 5. Subscription login vs Anthropic's terms — DECIDED: keep it; manage the risk (~half a day)
- **Decision (October 2026): JARVIS keeps using Claude Code on the user's own Claude
  subscription.** No API-key path becomes the default.
- **The risk that remains.** Anthropic's Agent SDK overview says: *"Unless previously
  approved, Anthropic does not allow third party developers to offer claude.ai login or
  rate limits for their products, including agents built on the Claude Agent SDK."*
  ✔ verified (code.claude.com/docs/en/agent-sdk/overview). Keeping subscription login
  means shipping on something Anthropic may not have approved. It is a known, accepted
  risk, not a closed question.
- **Do under this decision:**
  1. **Ask Anthropic for approval** (the page names the sales team as the contact for
     partner and branding questions) and record the answer here. This turns "unless
     previously approved" into a yes or a no.
  2. **Be plain on the site and in the wizard** that JARVIS runs on the user's *own*
     Claude login and is billed to their account, and is not made or endorsed by Anthropic
     (the disclaimer already says the second part).
  3. **Fix the branding.** The same page says third-party products may not use the name
     "Claude Code" and "should maintain [their] own branding and not appear to be Claude
     Code". Allowed wording: "Claude", or "{YourAgentName} Powered by Claude". We say
     "Claude Code" in ~12 places in the README, ~8 in `Settings.tsx` and on 9 landing-site
     files. Reword to "your Claude subscription" / "Powered by Claude".
  4. **Keep a fallback.** Optional and small: an *Anthropic API key* field in Settings
     (stored in `settings.db`, passed to the bridge as `ANTHROPIC_API_KEY`) as an
     alternative sign-in, so there is a ready path if approval is refused.
- **Revisit if** Anthropic says no, or changes the terms. Then the API-key path becomes
  the default and the site headline, download page and guides change with it.

---

### 3. The permission gate guesses from tool names — 2–3 h
- **Problem.** `READ_VERB` in `bridge/server.mjs:309` only checks that a tool name
  *starts with* a read verb. `check` matches `checkout`, so `checkout_cart` or
  `read_and_archive` would run in read-only mode ✔ verified. `decideTool` is the main
  safety function and has no tests.
- **Fix.** Split names into words; first word must be a read verb and no word may be an
  action verb (archive, move, share, forward, reply, order, checkout, transfer, approve,
  merge, submit, upload, run, set, cancel…). Move `decideTool` to its own file with
  table-driven tests. Consider a spending cap for credit-spending tools (Higgsfield,
  HeyGen, ElevenLabs).
- **Why P0.** Cheap, and it protects every user who connects their own tools.

### 2. Wake-word listening sends room audio to the cloud — disclose now (30 min), fix later (~1 day)
- **Problem.** While asleep, every phrase the mic picks up is transcribed by ElevenLabs
  (or Google in browser mode) just to look for "Jarvis". Porcupine (offline, has
  "Jarvis" built in) is a dependency, but `WAKE_ENGINE` in `src/config.ts` is defined
  and never used ✔ verified.
- **Our DISCLAIMER and the site say** "what you say to JARVIS is sent to the services you
  connect". That understates it: room audio is sent *before* anyone says the wake word.
- **Do now:** correct the disclaimer, the download page and the Settings text.
- **Do next:** run Porcupine while asleep and start cloud transcription only after it
  fires. It needs a free Picovoice key, so keep today's behaviour as the no-key fallback.
- **Why P0.** Trust. Business owners will ask whether the assistant listens all the time.

### 1. Bridge crashes on Node 20 — 30 min
- **Problem.** `bridge/memory.mjs`, `workflows.mjs` and now `settings.mjs` import
  `node:sqlite` at the top; it is unflagged only from Node 22.13. `package.json` says
  `>=20` ✔ verified. Source users on Node 20 get a crash, and `npm start` fails.
- **Installed users are not affected** — the installer bundles Node 24.
- **Fix.** Require Node 22.13+ in `package.json`, `scripts/setup.mjs`,
  `restart-jarvis.ps1`, README and the site. Optional: lazy `await import()` for memory
  and workflows.
- **Why P0 (small).** A false "Node 20 works" claim plus a 30-minute fix.

---

## P1 — next

### 4. Read-only mode can still leak data — 1–2 days
- **Problem.** With writes off, JARVIS can still open any URL in your signed-in Chrome,
  use WebFetch, and fetch image URLs it puts on a panel. A malicious email or web page
  could trick it into placing your data inside such a link (prompt injection).
- **Fix.** Tell the persona that page, email, file and tool content is data, never
  instructions. After a turn reads private content, require a browser approval before
  visiting any site you did not name. Only proxy image/video links that appeared in a
  tool result.
- **Where.** `SYSTEM_PROMPT`, `decideTool`, `proxyRemote` in `bridge/server.mjs`;
  `chrome_navigate` in `bridge/chrome.mjs`.

### 6. "Windows, macOS and Linux" is not fully true — a few hours
- App launching and approved commands are Windows-only (`bridge/apps.mjs:34` throws on
  other platforms ✔ verified). On a Mac it can show an approval card, then fail.
- **Fix.** Label those features "Windows only" in the README and on the site; check the
  platform before showing the card. Our installer is Windows-only already, so this is
  mostly wording. macOS/Linux support is a Later item.

### 8. Docs and config cleanup — ~30 min (bundle with #1)
- README and `.env.example` say effort defaults to *medium*; the code uses *high*
  (`bridge/server.mjs`) ✔ verified. Pick one (see #7).
- Add `"test": "node --test \"bridge/*.test.mjs\""` to `package.json` — no test script
  exists ✔ verified. Our CI lists test files by hand; it should call `npm test` once one
  known-flaky test (`workflows.test.mjs`, time-of-day dependent) is fixed.
- Move the Hermes section out of the README — it describes a different app ✔ verified.

---

## P2 — worth doing, not urgent

### 7. Replies are slower than they need to be — hours to 2 days
- Default is Opus at effort *high*; the code's own comments argue *medium* suits voice.
- **Quick part (hours):** default to medium. It is also now a Settings option.
- **Bigger part:** route quick chat to a faster model, keep Opus for tool-heavy tasks.
- Add one number to the diagnostics panel: time from end of speech to first sound.

---

## Later — new features (none needed for a safe v1)

| # | Idea | Effort | Verdict |
|---|---|---|---|
| 10 | **Proactive alerts**: "announce" workflow step, morning briefing, "build failed", quiet hours | 2–4 days | **Most valuable of this group** for business owners (daily briefing). Do first. |
| 13 | **Smarter memory**: local semantic search, suggestions saved only after approval | 2–4 days | Nice; current keyword memory works. |
| 9 | **Smart home** via Home Assistant MCP, with risk levels (lights free, locks need approval) | 2–3 days | Niche for small businesses. Needs #3 done first. |
| 11 | **Phone / other rooms** as second screen and mic, with pairing code | 3–5 days | Needs a local HTTPS certificate for the mic. High effort for the gain. |
| 12 | **Offline fallback**: local speech-to-text and small local model | 1–2 weeks | Biggest effort, smallest audience. Last. |

---

## Not in the original list, but open from our own work

**Release and trust**
- **Code-sign the installer** (about $100–400/yr) so Windows SmartScreen stops warning.
  Highest-impact fix for non-technical users. (P1)
- **App icon** for the installer and shortcuts (currently the generic script icon). (P2)
- **CI on pull requests** (`ci.yml`: typecheck, lint, tests), then require it in the
  branch ruleset. `release.yml` only runs on tags. (P1)

**Voice**
- **Pause-then-continue fix** is in PR #8 (guard only while JARVIS is audible; join a
  continuation sent within 15 s). It is typecheck-clean only: **needs a real-voice
  try-out**. A "how long JARVIS waits when you pause" setting is optional. (P1: verify)

**Landing site**
- ~15 screenshot placeholders remain (Windows desktop shots, public Claude / ElevenLabs
  pages, logged-in shots with the key blurred). Merge the open guide PRs after the next
  release exists. (P2)
- Update the guides' "Claude Code" wording when the branding change in #5 lands.

---

## Suggested order

1. **This week:** #1 + #8 (one small PR), #3, correct the wake-word disclosure (#2, wording only).
2. **#5 (decided: keep subscription login):** ask Anthropic for approval, and fix the "Claude Code" wording on the site, the README and the Settings screen, before any wider promotion.
3. **Then:** #4, #6, installer signing, PR CI.
4. **Then:** wake-word engine (#2 full), #7.
5. **Later:** #10 first, then #13 / #9 / #11 / #12 as demand appears.
