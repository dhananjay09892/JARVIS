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
1. **Audit the current wizard (1 d)** and measure drop-off points (local, opt-in metrics, 16).
2. **Hardware self-test and echo test (3 d).**
3. **Wake calibration (2 d)** once 02's engine exists.
4. **Guided connector wizard (4 d)** with "copy this config" help and error explanations.
5. **First-success scripts (2 d)** per connector/persona.
6. **Re-entrant setup:** every step re-runnable from Settings; "fix my voice" repair mode.
7. **Documentation in-product:** "what can I say?" panel with examples tailored to connected tools; it can also be asked by voice.
8. **Uninstall/reset flow:** one screen to export data and erase everything (15, 17).

## Metrics
Time to first successful task (target ≤ 10 min); setup completion ≥ 85 % in testing with non-technical users; support issues per 100 installs; % who keep safe defaults on.

## Risks
Too many steps → allow skip with defaults; permission prompts (mic) blocked in embedded panes (see README) → detect and explain; accessibility of the wizard itself.

## Done when
Five non-technical testers complete setup unaided and say their first command by minute ten.
