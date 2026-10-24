# JARVIS work queue

The ordered list of tasks the **JARVIS plan autopilot** (a Claude scheduled task) works through.
It turns the phases in [37](37-execution-roadmap-and-risks.md) into tasks small enough for one
run and one reviewable pull request. The plans stay the source of truth for *what* to build;
this file decides *in what order*.

## How it works

- Each run takes the **first** task (top to bottom) whose status is `todo`, whose `Depends on`
  tasks are all `done` on `main`, and that has no open `autopilot/` pull request.
- The autopilot opens one PR per task, on a branch named `autopilot/Qnn-short-name`. In that PR
  it changes the task's status line to `done`, so the status becomes true when you merge.
- A task is only `done` once its PR is **merged**. Tasks that depend on an unmerged PR wait,
  so reviewing and merging PRs is what keeps the queue moving.

## Status values

| Status | Meaning |
|---|---|
| `todo` | Ready for the autopilot once its dependencies are done |
| `done` | Merged to `main` |
| `needs-you` | Waiting on the owner: a decision, an account, a key, recordings, or an outside review. The autopilot skips it |
| `skip` | Deferred or dropped. The autopilot ignores it |

## What you control

- **Change priorities:** move a task block up or down. Order is the only priority signal.
- **Unblock a `needs-you` task:** do what its *Needs you* line says (for a decision, write it in the
  ADR's `Decision:` line), then change the status to `todo`.
- **Stop a task:** set it to `skip`, or close its PR without merging (the autopilot won't retry it).
- **Add work:** add a block anywhere, with the next free `Q` number.

---

## Phase 0 · Trust and truth

### Q01 · Plan 08 · Fix the permission gate
- **Status:** done
- **Depends on:** none
- **Scope:** 08 phase 1. Word-split tool names; check for a read verb first and no action verb; move `decideTool` into its own module; table-driven tests including adversarial names.
- **Done when:** the known gate defects are fixed and covered by tests.

### Q02 · Plan 08 · Untrusted content and hidden text
- **Status:** done
- **Depends on:** Q01
- **Scope:** 08 phase 2, first half. Mark all tool, page, email and file text as untrusted data in the prompt and in code paths; strip or neutralise hidden text (zero-width characters, white-on-white) from fetched pages.
- **Done when:** untrusted content is labelled everywhere it enters a turn, with tests for the stripping.

### Q03 · Plan 08 · Taint tracking and URL exfiltration
- **Status:** done
- **Depends on:** Q01
- **Scope:** 08 phase 2, second half. Once a turn has read private content, outbound actions (open URL, fetch, send, write) need approval unless the user named the target; only proxy image and video URLs that appeared in a tool result.
- **Done when:** an injected "open this URL with my data" is blocked in a test.

### Q04 · Plan 15 · Extract the policy engine
- **Status:** done
- **Depends on:** Q01
- **Scope:** 15 phase 1. Move all gating into `bridge/policy.mjs` with table-driven tests. No behaviour change beyond the fixes from Q01.
- **Done when:** every tool decision goes through `policy.mjs` and the existing behaviour is pinned by tests.

### Q05 · Plan 15 · Audit log v1
- **Status:** done
- **Depends on:** Q04
- **Scope:** 15 phase 5, storage only. Append-only local log of requests, decisions, approvals and results, with a tamper-evident hash chain. The search panel comes later.
- **Done when:** each policy decision writes an entry and a test detects a tampered entry.

### Q06 · Plans 16 + 05 · Turn tracing and the latency number
- **Status:** done
- **Depends on:** none
- **Scope:** 16 component 1 and 05 phase 1. One trace per turn with timestamps for wake → STT → route → first token → first audio, model and route chosen, tools used, policy decisions and errors; local SQLite, retention-limited, redacted. Show rolling median and p95 latency in Diagnostics.
- **Done when:** Diagnostics shows a real latency number from traces.

### Q07 · Plan 02 · Correct the wake-word disclosure
- **Status:** done
- **Depends on:** none
- **Scope:** 02 phase 1. Make DISCLAIMER, the site and the Settings wording say accurately what audio leaves the machine today.
- **Done when:** no user-facing text overstates on-device wake detection.

### Q08 · Plan 02 · Wake engine decision record
- **Status:** done
- **Depends on:** none
- **Scope:** Write `plans/adr/002-wake-engine.md` comparing Porcupine and openWakeWord: licence and cost, accuracy, CPU, custom phrases, Windows support, how each fits the bridge. Leave `Decision:` empty with a recommendation.
- **Done when:** the ADR is ready for the owner to decide.

### Q09 · Plan 02 · Offline wake engine
- **Status:** done
- **Depends on:** Q08, Q06
- **Scope:** 02 phase 2, with the engine chosen in ADR 002 (openWakeWord in the page, decided 2026-10-23). Follow the ADR's "Recommendation" steps 1–5: `WakeDetector` interface and `hey_jarvis` model, drop VAD audio locally while asleep, Settings toggle and sensitivity, false-wake counter, remove the `@picovoice/*` packages, record the model licence. Update the disclosure wording and `bridge/disclosure.test.mjs` together. If the model files cannot be fetched in the run, deliver the interface and pipeline with a test model and note what is missing.
- **Done when:** no audio leaves the machine while JARVIS is asleep, verified by a test.

### Q45 · Plan 02 · Try the offline wake word with your voice
- **Status:** needs-you
- **Needs you:** after merging Q09, run `npm start` (it copies the ONNX runtime into `public/ort`), click INITIALISE and say "Hey Jarvis" about 20 times from where you usually sit, then a few minutes of normal talk or TV. Press D and note "listening for his name", "wakes", "false wakes", "score / best / bar" and "ms per 80 ms frame". If it misses or false-wakes, try the Sensitivity setting. Paste the numbers into plan 02's Autopilot log, then set this to `done`. The autopilot has no microphone, so it could only check the models against silence, noise and a tone.
- **Depends on:** Q09
- **Scope:** 02 phase 2 acceptance on real hardware; input for phase 3 tuning.
- **Done when:** the numbers are recorded in plan 02.

### Q10 · Plan 35 · Draft the never-list page
- **Status:** done
- **Depends on:** none
- **Scope:** 35 phase 1. Write the one-page "What JARVIS will never do" from the never-list in plan 35. You approve the wording in the PR review.
- **Done when:** the page exists and is linked from the README.

### Q11 · Plan 35 · Never-list as tests
- **Status:** done
- **Depends on:** Q04, Q10
- **Scope:** 35 phase 2. Encode each never-list rule as a policy rule with a test in `policy.mjs`.
- **Done when:** one green test per never-list rule.

### Q12 · Plan 36 · Licence register v1
- **Status:** done
- **Depends on:** none
- **Scope:** 36 phase 3. Create `plans/LICENCES.md` covering dependencies, models and voices; flag any blockers and suggest swaps. Add `CREDITS.md` attributions if missing.
- **Done when:** every shipped model, voice and dependency has a licence entry; blockers are listed.

### Q41 · Plan 36 · Fix the licence blockers
- **Status:** needs-you
- **Needs you:** read "Blockers and risks" in `plans/LICENCES.md` and decide B1 (Kokoro's `phonemizer` bundles GPL-3.0 eSpeak NG into the installer): (a) leave the Kokoro chunk out of installer builds, (b) swap the phonemizer for a permissive one, or (c) accept GPL-3.0 for that part with notices. Write the choice under B1, then set this to `todo`. B2 (Claude Code binary terms) was decided in ADR 001 on 2026-10-23.
- **Depends on:** Q12
- **Scope:** 36 phase 3, second half. Apply the B1 choice; ship Node's `LICENSE` next to `node.exe` in the installer (B7); confirm the `webgl-constants` licence (B8); remove the unused Picovoice packages if ADR 002 picks openWakeWord (B3).
- **Done when:** no open blocker in `plans/LICENCES.md` applies to the installer.

### Q13 · Plan 36 · Legal review of name and branding
- **Status:** needs-you
- **Needs you:** an outside legal review (36 phase 4). The autopilot cannot do this.
- **Depends on:** Q12
- **Scope:** Name, branding and IP review; record the outcome in an ADR.
- **Done when:** the outcome is recorded.

### Q46 · Plan 40 · Claim the Tamelo name
- **Status:** needs-you
- **Needs you:** steps 2–6 of "Steps to claim the name" in [plan 40](40-name-and-brand.md): trademark searches for "Tamelo" (USPTO, UK IPO, IP India, classes 9 and 42), register tamelo.com / tamelo.ai / tamelo.in, and claim the social and app-store handles. Give the search results to the Q13 legal review. If the name is clear, tick the steps in plan 40 and set this to `done`; if not, switch plan 40 to the backup name (Kalemo) and redo this task.
- **Depends on:** none
- **Scope:** Plan 40 steps 2–6. The autopilot cannot buy domains or file trademarks.
- **Done when:** the name is cleared and the domains and handles are ours.

### Q47 · Plans 02 + 40 · Wake model recipe: Tamelo, Buddy, Friend
- **Status:** done
- **Depends on:** Q09, Q12
- **Scope:** Close licence risk B4 for the wake word. The shipped `hey_jarvis` model is CC BY-NC-SA 4.0 (non-commercial), so a commercial release needs our own model. Write a reproducible openWakeWord training recipe for the phrases "Hey Tamelo", "Hey Buddy" and "Hey Friend" under `scripts/wake/` (one classifier per phrase on the shared front end, plan 02 "Multiple and custom wake words") (config, data download list, training and export steps, expected compute and time). Use **only** training inputs with licences that allow commercial use (synthetic speech from commercially usable TTS voices, negative/background audio with known licences) and add each one to `plans/LICENCES.md`. Include Hindi and Gujarati speech in the negatives, especially "tame lo" (તમે લો), and everyday English uses of "buddy" and "friend" without "hey", to limit false wakes. Confirm the licence of the mel-spectrogram and embedding front-end models, or plan to re-export them from Apache-2.0 sources.
- **Done when:** the recipe is merged, every training input has a commercial-OK licence entry, and B4 has a written path to "closed".

### Q53 · Plans 02 + 36 · Clear the wake embedding front end
- **Status:** needs-you
- **Needs you:** the autopilot built the re-export and parity check (`scripts/wake/export_embedding.py`, `embedding_parity.py`) but could not download Google's module or install TensorFlow in its sandbox. On any machine with Python 3.10/3.11 (CPU is fine, a few minutes): download https://tfhub.dev/google/speech_embedding/1?tf-hub-format=compressed and unpack it into `scripts/wake/work/speech_embedding/`; in a fresh virtual environment `pip install -r scripts/wake/requirements-embedding.txt`; from `scripts/wake/` run `python export_embedding.py work/speech_embedding --inspect`, then `python export_embedding.py work/speech_embedding`, then `python embedding_parity.py work/frontend/speech_embedding.onnx`. Paste the output into plan 02's Autopilot log and set this back to `todo`: the next run records the verdict in `plans/LICENCES.md` (or fixes the cut if it says "unusable").
- **Depends on:** Q47
- **Scope:** Step 3 of "Closing B4" in `scripts/wake/README.md`. Re-export Google's `speech_embedding` (TFHub, Apache-2.0) with the input/output shape of openWakeWord's `embedding_model.onnx` (mel windows [batch, 76, 32, 1] → [batch, 1, 1, 96]), and add an embedding parity check to `scripts/wake/prepare_frontend.py` that runs both files on the same mel windows. If the weights match, record in `plans/LICENCES.md` that the published file is Google's Apache-2.0 model; if they don't, the recipe trains on our re-export. If TensorFlow cannot be installed in the run, deliver the script and its test with a small fixture and set this to `needs-you` with what to run.
- **Done when:** the embedding model the recipe trains on has its Apache-2.0 provenance recorded in `plans/LICENCES.md`, backed by a parity check.

### Q48 · Plans 02 + 40 · Train and test the three wake models
- **Status:** needs-you
- **Needs you:** run the Q47 recipe on a machine with a GPU (the autopilot cannot train for hours). Then test each phrase the same way as Q45: say "Hey Tamelo", "Hey Buddy" and "Hey Friend" about 20 times each, plus a few minutes of normal talk and TV, including Hindi and Gujarati speech with "tame lo" and sentences with "buddy" and "friend". Paste the numbers into plan 02's Autopilot log, commit the models with their licence note, then set this to `done`.
- **Depends on:** Q47
- **Scope:** Produce `hey_tamelo`, `hey_buddy` and `hey_friend` ONNX models under `public/models/wake/`, our own licence; update `plans/LICENCES.md` (B4 closed for the wake word) and CREDITS.md.
- **Done when:** each model wakes reliably for you, false wakes are acceptable per phrase, and B4 no longer blocks a commercial release.

### Q49 · Plan 40 · Rename JARVIS to Tamelo in the product
- **Status:** todo
- **Depends on:** Q46, Q48
- **Scope:** Plan 40 step 7. Change every user-facing name to Tamelo: page and window titles, greetings and the assistant persona in the system prompt, HUD (plan 18), Settings and first-run wizard, disclosure text with `bridge/disclosure.test.mjs`, README, DISCLAIMER, CREDITS, installer and launcher display names, and the site. Switch the default wake phrases to "Hey Tamelo", "Hey Buddy" and "Hey Friend" with the Q48 models (all running at once, any one wakes it, each with its own on/off and sensitivity) and remove the non-commercial `hey_jarvis` model. Keep internal identifiers (repo name, package name, `JARVIS_*` settings keys, file paths) unchanged so nothing breaks; list them in plan 40 as the internal codename. Add a test that fails if "JARVIS" appears in user-facing UI strings.
- **Done when:** a user never sees or says "JARVIS", and "Hey Tamelo", "Hey Buddy" and "Hey Friend" all wake it.

### Q50 · Plan 02 · Custom wake word decision record
- **Status:** done
- **Depends on:** Q09
- **Scope:** Write `plans/adr/003-custom-wake-word.md` comparing the three engines in plan 02 "Multiple and custom wake words" for a name the user types in Settings: few-shot enrolment on openWakeWord embeddings, a local keyword spotter (e.g. Vosk grammar mode), and on-device training with synthetic speech. Cover accuracy, false wakes, CPU on a low-end laptop, time until it works, privacy, licences (commercial use), Windows support, and Hindi/Gujarati names. Leave `Decision:` empty with a recommendation.
- **Done when:** the ADR is ready for the owner to decide.

### Q51 · Plans 02 + 39 · Wake words in Settings, including a custom name
- **Status:** todo
- **Depends on:** Q50, Q49
- **Scope:** Only start once ADR 003's `Decision:` line is filled. Settings → Voice and hearing → Wake words: on/off and sensitivity per built-in phrase; "Add your own name" with the name checks from plan 02 (length, common words, household names, other assistants' wake words); per-person option to use the custom name in greetings and replies (brand stays Tamelo); "Test my wake word" button; per-phrase false-wake counter in Diagnostics; record which phrase woke it in the turn trace. Build the custom-name engine chosen in ADR 003, fully offline.
- **Done when:** a user can add "Hey <their name>", it wakes the assistant offline alongside the built-in phrases, and tests cover the name checks.

### Q14 · Plan 38 · Shared data contracts
- **Status:** done
- **Depends on:** none
- **Scope:** 38 phases 1–2. Walk the three scenarios (voice command with tool call, Telegram approval, morning briefing) against the core objects, then create `shared/contracts.ts` with runtime validation, fixtures and tests. Adopt nothing yet.
- **Done when:** the contracts compile, validate the fixtures and are tested.

### Q15 · Plans 21–24, 27 · Subscription brain terms record
- **Status:** done
- **Depends on:** none
- **Scope:** Write `plans/adr/001-subscription-brain-terms.md`: for each provider, the current terms on third-party use of subscription logins, with sources and the date checked. Leave `Decision:` empty with a recommendation.
- **Done when:** the ADR is ready for the owner to decide.

## Phase 1 · Identity and feel

### Q16 · Plan 21 · Claude brain behind an interface
- **Status:** done
- **Depends on:** Q04
- **Scope:** 21 phase 1. Extract the Claude code from `server.mjs` into `bridge/brains/claude.mjs` with no behaviour change; add a brain registry; add tests that pin current behaviour.
- **Done when:** JARVIS works exactly as before through the registry.

### Q17 · Plan 21 · Brain event schema and conformance suite
- **Status:** done
- **Depends on:** Q16, Q14
- **Scope:** 21 phase 2. Normalised events plus scripted scenarios every brain must pass: plain answer, one tool call, denied tool, cancel mid-stream, long answer, tool error, resume.
- **Done when:** the Claude brain passes the suite.

### Q52 · Plan 21 · Bridge reads BrainEvents
- **Status:** done
- **Depends on:** Q17
- **Scope:** 21 phase 2, second half. Move the voice pump in `server.mjs` and the worker loop in `tasks.mjs` from the SDK's message shapes onto `brain.converse()` and BrainEvents, keeping today's behaviour: speech from the first text delta, the HUD tool badge held until a refused tool is settled, barge-in that drops the abandoned answer's tail, the `ready` server list and the spoken failure messages. Anything the events cannot carry yet (the early tool badge from the partial block start, the MCP server list) gets an optional event or a side channel, added to `shared/contracts.ts` and `events.mjs` together.
- **Done when:** neither `server.mjs` nor `tasks.mjs` reads an SDK message type, the existing tests pass, and the conformance suite still passes.

### Q18 · Plan 21 · Every tool call through the policy engine
- **Status:** done
- **Depends on:** Q16, Q04
- **Scope:** 21 phase 3. Route all brain tool calls through `policy.decide()`; brains without a pre-execution hook are forced to read-only or tool-loop mode; tests on every brain.
- **Done when:** no brain can run a tool without a policy decision.

### Q19 · Plan 39 · Settings registry and API
- **Status:** done
- **Depends on:** Q14
- **Scope:** 39 phase 1. Move today's six settings into a registry with schema, `GET /settings/schema` and validated `PATCH /settings`; keep the current UI working through the schema.
- **Done when:** settings are declared once and the existing UI still works.

### Q20 · Plan 39 · Secrets to the OS keychain
- **Status:** done
- **Depends on:** Q19
- **Scope:** 39 phase 3. Move the ElevenLabs key (and future provider keys) to the OS keychain/DPAPI, with a migration that backs up first; the DB keeps only `*_set` flags.
- **Done when:** no secret is stored in plain settings or logs.

### Q21 · Plan 25 · OpenAI-compatible brain adapter
- **Status:** todo
- **Depends on:** Q17, Q18
- **Scope:** 25 phase 1. Generic adapter with an OpenAI profile: streaming, tool loop, cancellation, usage. Test against a mock server so no paid key is needed.
- **Done when:** the adapter passes the conformance suite against the mock.

### Q42 · Plan 21 · Claude API-key fallback
- **Status:** todo
- **Depends on:** Q20
- **Scope:** ADR 001 decision (Anthropic line). Add an optional Claude API-key mode next to subscription sign-in: the key is stored in the keychain from Q20 and passed to the stock binary as `ANTHROPIC_API_KEY`; subscription stays the default; `status().authMode` reports which is in use; a Settings control to choose it. Never read or store Claude.ai credentials.
- **Done when:** JARVIS runs on either the user's subscription or their API key, switchable in Settings, with tests.

### Q43 · Plan 22 · Sign in with ChatGPT for the OpenAI profile
- **Status:** todo
- **Depends on:** Q21
- **Scope:** ADR 001 decision (OpenAI line). Add a Sign in with ChatGPT auth option to the OpenAI profile from Q21, following the SIWC terms: local token storage, a "Manage usage" link, consent before background tasks, privacy notice. Test against mocks.
- **Done when:** the OpenAI profile works with SIWC or an API key, with tests.

### Q44 · Plan 21 · Written confirmation from Anthropic
- **Status:** needs-you
- **Needs you:** write to Anthropic (support or sales) describing JARVIS: each user signs in with their own subscription to the unmodified Claude Code binary through the Agent SDK. Ask them to confirm in writing that this is allowed, then paste the answer in ADR 001 and set this to `done`.
- **Depends on:** none
- **Scope:** ADR 001 option D.
- **Done when:** Anthropic's answer is recorded in ADR 001.

### Q22 · Plan 25 · Keys behind the bridge
- **Status:** todo
- **Depends on:** Q20
- **Scope:** 25 phase 4. Move API keys out of the front-end bundle and behind the bridge; migration note in the README.
- **Done when:** the built front end contains no API keys.

### Q23 · Plan 39 · Live apply and restart banner
- **Status:** todo
- **Depends on:** Q19
- **Scope:** 39 phase 4. Emit a settings-changed event so subsystems reconfigure live; where they can't, show a "Restart JARVIS to apply" banner with one button.
- **Done when:** changing a live setting needs no restart.

### Q24 · Plan 05 · Latency cheap wins
- **Status:** todo
- **Depends on:** Q06
- **Scope:** 05 phase 2. Start TTS at the first sentence, keep connections warm, cache the persona/system prompt. Report before/after numbers from the traces. Leave the effort default unchanged and note it as an open decision.
- **Done when:** median latency drops, with numbers in the PR.

### Q25 · Plan 06 · Reflex layer and routing rules
- **Status:** todo
- **Depends on:** Q06
- **Scope:** 06 phase 1. Handle stop, volume, timers and similar commands without calling the model.
- **Done when:** reflex commands respond without a model call, measured in traces.

### Q26 · Plan 06 · Fast/deep routing
- **Status:** todo
- **Depends on:** Q25, Q17
- **Scope:** 06 phase 2. Route turns to a fast or deep path, with routing metrics in Diagnostics.
- **Done when:** the route is chosen per turn and visible in traces.

### Q27 · Plan 01 · Speaker model decision record
- **Status:** todo
- **Depends on:** none
- **Scope:** Write `plans/adr/003-speaker-embedding.md`: candidate speaker-embedding models, licence, accuracy, and whether to run in the browser or the bridge. Leave `Decision:` empty with a recommendation.
- **Done when:** the ADR is ready for the owner to decide.

### Q28 · Plan 01 · Speaker ID MVP
- **Status:** needs-you
- **Needs you:** decide the model in ADR 003 (from Q27), then set this to `todo`.
- **Depends on:** Q27, Q04
- **Scope:** 01 phase 1. `/speaker/enroll`, `/speaker/identify`, spoken enrollment, a `speaker` field on utterances, name in the system prompt, owner/guest split. Voiceprints stay local.
- **Done when:** the acceptance tests in plan 01 that the MVP covers pass.

### Q29 · Plan 28 · Multilingual audit recordings
- **Status:** needs-you
- **Needs you:** record the sentence sets (English, Gujarati, Hindi, mixed). The autopilot can prepare the script and scoring harness first if you add a task for it.
- **Depends on:** none
- **Scope:** 28 phase 1. Measure STT word error rate, TTS intelligibility and answer quality; publish the table in plan 28.
- **Done when:** the table is filled in.

### Q30 · Plan 28 · Per-person language profile
- **Status:** todo
- **Depends on:** Q19
- **Scope:** 28 phase 2. Primary/secondary languages, reply-language policy and output script, stored per person through the settings registry.
- **Done when:** the reply language follows the profile, with tests.

### Q31 · Plan 29 · Wizard audit and hardware self-test
- **Status:** todo
- **Depends on:** Q06
- **Scope:** 29 phases 1–2. Audit the current welcome wizard; add mic level, noise floor, speaker and echo tests with fix-it advice per failure.
- **Done when:** the wizard catches a muted mic and a wrong default device.

## Phase 2 · Proactive and connected

### Q32 · Plan 12 · Event bus
- **Status:** todo
- **Depends on:** Q14
- **Scope:** 12 building block 1, using the event topics in plan 38.
- **Done when:** the scheduler and task completion publish typed events, with tests.

### Q33 · Plan 12 · Notification policy engine
- **Status:** todo
- **Depends on:** Q32, Q04
- **Scope:** 12 building block 2. Urgency, audience, place and privacy per alert; decision from quiet hours, presence and activity.
- **Done when:** quiet hours are respected in tests.

### Q34 · Plan 12 · Morning briefing
- **Status:** todo
- **Depends on:** Q33
- **Scope:** 12 building block 5, morning template only, using whatever connectors are set up.
- **Done when:** a briefing can be triggered and skipped by voice.

### Q35 · Plan 20 · Messaging spec and threat model
- **Status:** todo
- **Depends on:** Q04
- **Scope:** 20 phase 1. Channel interface, sender allow-list schema, threat model (spoofing, injection, flooding), data-flow disclosure. Documents only: plan 20 says no code before this is reviewed, and the PR review is that review.
- **Done when:** the spec is merged.

### Q36 · Plan 20 · Telegram adapter
- **Status:** todo
- **Depends on:** Q35
- **Scope:** 20 phase 2, built and tested against mocks. Live testing needs a bot token from you, listed in the PR.
- **Done when:** the adapter passes its tests with the sender allow-list enforced.

### Q37 · Plan 07 · Vector store decision record
- **Status:** todo
- **Depends on:** none
- **Scope:** Write `plans/adr/004-vector-store.md` with local options for semantic memory. Leave `Decision:` empty with a recommendation.
- **Done when:** the ADR is ready for the owner to decide.

### Q38 · Plan 07 · Semantic recall
- **Status:** needs-you
- **Needs you:** decide the store in ADR 004 (from Q37), then set this to `todo`.
- **Depends on:** Q37
- **Scope:** 07 phase 1. Local embeddings in the bridge, hybrid keyword + vector search, relevance threshold, used memories shown in Diagnostics.
- **Done when:** recall meets the plan 07 metric on a test set.

### Q39 · Plan 14 · Context broker
- **Status:** todo
- **Depends on:** Q14, Q04
- **Scope:** 14 phase 1. Named context slices with TTL, per-source permission, redaction and a token budget.
- **Done when:** the orchestrator can request slices, with tests.

## Next phases

### Q40 · Break down the next phase
- **Status:** todo
- **Depends on:** run this only when fewer than 3 tasks above are `todo` with their dependencies met
- **Scope:** Add the next phase from plan 37 to this file as new tasks in the same format: Phase 3 (13, 19, 33, 31), then Phase 4 (09, 03, 11, 30, 34, 20 SMS/WhatsApp, 32), then Phase 5 (17, 18, 04 offline, 26, 24, 27). Then add a new "break down the next phase" task at the end.
- **Done when:** the next phase is in the queue.
