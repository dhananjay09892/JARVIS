# 29 · Onboarding: from install to "wow" in ten minutes

**Status:** Partial (welcome wizard exists) · **Priority:** P1 · **Effort:** 2–3 weeks · **Depends on:** 02, 01, 15, 21

## End state
A new user installs JARVIS and, in ten minutes, has: a working mic and speakers, wake word
tuned to their room, their voice enrolled, a brain chosen and signed in, safe defaults
explained in plain language, two or three connectors working, and one real thing done by
voice (e.g. "what's on my calendar tomorrow?"). Nothing risky is switched on by accident.

## Today (verified)
README describes a first-start wizard: sign in to Claude, optional ElevenLabs key, INITIALISE,
allow mic. A branch `fix/wizard-above-ignition` exists. No calibration, no tour, no
capability checklist, no guided connectors.

## Flow (target)
1. **Welcome and honesty screen:** what JARVIS is, what leaves the machine (02, 15), not endorsed by any vendor (disclaimer), who it's for.
2. **Hardware check:** mic level, noise floor, speaker test, echo test (JARVIS speaks, listens to himself), camera optional. Fix-it advice per failure (wrong default device, muted, privacy settings).
3. **Brain:** choose brain and sign in (21–27) with plain statements of cost/limits.
4. **Wake calibration:** say "Jarvis" 5 times at normal and far distance; set sensitivity; test with TV/music on.
5. **Voice enrollment (optional):** speaker ID (01) with consent text; guests skip.
6. **Language and voice:** pick languages (28) and a voice; hear samples.
7. **Safety defaults:** read-only mode on; explain approvals with a safe demo ("I'll ask before I send anything"); set the owner PIN/safe word (15).
8. **Connect one thing:** guided connector setup (calendar or mail, read-only first) with a test question.
9. **First success:** scripted but real task; JARVIS asks "was that right?" to tune the tone.
10. **Next steps checklist** in the HUD: add phone (03), enable Telegram (20), try a morning briefing (12). Dismissible.

## Progressive disclosure
Unlock complexity as trust grows: day 1 voice + read-only; day 3 offer writes for one connector; week 1 propose a briefing; week 2 suggest a skill (19). Never push everything at once.

## Phases
1. **Audit the current wizard (1 d)** and measure drop-off points (local, opt-in metrics, 16). — **audit done (autopilot Q31, 2026-10-27, awaiting review; see below)**; drop-off metric is Q77.
2. **Hardware self-test and echo test (3 d).** — **built (autopilot Q31, 2026-10-27, awaiting review):** mic open errors, muted mic, virtual/loopback or dead default device, noise floor, voice level, speaker and echo, each with fix-it advice; first wizard step and in Settings. Left (Q77): choosing the microphone inside JARVIS, the optional camera check.
3. **Wake calibration (2 d)** once 02's engine exists.
4. **Guided connector wizard (4 d)** with "copy this config" help and error explanations.
5. **First-success scripts (2 d)** per connector/persona.
6. **Re-entrant setup:** every step re-runnable from Settings; "fix my voice" repair mode.
7. **Documentation in-product:** "what can I say?" panel with examples tailored to connected tools; it can also be asked by voice.
8. **Uninstall/reset flow:** one screen to export data and erase everything (15, 17).

## Wizard audit (Q31, 2026-10-27)
What the first run was, read from `src/ui/Settings.tsx`, `src/ui/Ignition.tsx` and `src/lib/audio.ts`:
- The wizard opens on its own when `setupDone` is not `1`, portalled above INITIALISE. Three steps: Claude sign-in (with "Check again"), an optional ElevenLabs key, "All set" with the listening disclosure. "Skip setup" on every step marks setup done. "Run setup wizard again" sits at the bottom of Settings.
- **No hardware check at all.** The microphone is first opened after INITIALISE (`getMic()`), so a blocked, muted or wrong microphone showed up only as JARVIS not reacting, with no explanation. This is the biggest gap and the one Q31 closes.
- Brain choice (OpenAI) and the language profile exist only in full Settings, not in the wizard; no wake calibration, voice enrollment, safety-defaults explanation, guided connector or first-success step (flow steps 4–9).
- No record of where people stop: the wizard keeps no step state beyond `setupDone`, so drop-off cannot be measured yet (Q77, opt-in and local).
- Step 1 of the old wizard re-checked Claude every time it was shown, which is fine; "Skip setup" from step 1 skipped the whole wizard, which is kept (every step stays skippable).

Q31 added **1 · Microphone and speakers** as the first step (Claude is now step 2 of 4) and the same check under Settings → Microphone and speakers. The judgement is in `src/lib/selftest.ts` (pure, tested in `src/lib/selftest.test.ts`), the measuring in `src/lib/selftestRunner.ts`, the screen in `src/ui/SelfTest.tsx`. Levels are measured on the same processed stream JARVIS listens to; nothing is recorded or sent.

## Metrics
Time to first successful task (target ≤ 10 min); setup completion ≥ 85 % in testing with non-technical users; support issues per 100 installs; % who keep safe defaults on.

## Risks
Too many steps → allow skip with defaults; permission prompts (mic) blocked in embedded panes (see README) → detect and explain; accessibility of the wizard itself.

## Done when
Five non-technical testers complete setup unaided and say their first command by minute ten.

## Autopilot log
- **2026-10-27 · Q31 · Wizard audit and hardware self-test.** Audit above. New first wizard step and Settings section run a ~15 s check: opening the microphone (blocked / none / busy, with Windows privacy and browser advice), the device (muted track; a Stereo Mix / virtual cable / VoiceMeeter default, with a real microphone suggested), a quiet moment (digital silence → muted, or the wrong default when another microphone is plugged in; room noise), a spoken line (too quiet, buried in noise), and a test sound (did you hear it; how much the microphone hears it, i.e. echo). Reuses JARVIS's microphone stream if it is already open. 13 unit tests cover the muted and wrong-device cases from "Done when". **Left:** opt-in drop-off metric and Diagnostics, a microphone picker inside JARVIS, camera check (Q77); phases 3–8. Thresholds are first guesses on Chrome's processed stream and need a check on real Windows machines.
