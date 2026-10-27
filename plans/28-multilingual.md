# 28 · Multilingual JARVIS: English, Gujarati, Hindi and mixing them

**Status:** Partial (language option and owner's language profile exist) · **Priority:** P1 · **Effort:** 3–5 weeks · **Depends on:** 04 (speech stack), 06 (brain), 01 (per-speaker)

## Why this is its own plan
The product already assumes a multilingual user: `src/lib/brain.ts` tells the model that the
user "may be in English, Gujarati, or Hindi" and to *answer in English*; `src/lib/language.ts`
holds a language option used for STT. Real households mix languages mid-sentence
("Jarvis, kal ka meeting kitne baje che?"). Today the pipeline is English-out only and
language handling is a single setting.

## End state
Speak to JARVIS in any of your languages, or mix them, and he understands, answers in the
language you used (or the one you prefer), and speaks with a natural voice and correct
pronunciation. Each person has their own language profile. Wake word, commands, alerts,
briefings and chat replies all follow it.

## Today (verified)
- `brain.ts` preface: understand English/Gujarati/Hindi, **reply in English**.
- `language.ts` + `languageOption()`: `speechCode` passed to bridge `/stt?language=` and a `locale` for browser recognition.
- TTS voice quality for Gujarati/Hindi is unverified.
- Language profile (phase 2, Q30): main and second language, reply policy (main language,
  mirror, or always one language) and script for Gujarati/Hindi text, in Settings → Languages.
  The bridge adds the matching instruction to every turn (`bridge/language-profile.mjs`).

## Phases
1. **Audit (2 d):** record 100 sentences per language and code-switched; measure STT word error rate (Scribe, browser, later Whisper), TTS intelligibility, and model answer quality. Publish the table in this file.
2. **Per-person language profile (2 d) — owner's profile done (Q30); per person waits on 01 (Q76):** primary/secondary languages, reply-language policy (mirror / always X / by topic), script for text output (Gujarati script vs. romanised), stored with the speaker profile (01).
3. **Language auto-detection per utterance (3 d):** detect language from STT metadata/text; pass `language: auto` for mixed speech; keep an explicit override ("speak Hindi").
4. **Code-switching STT (1 w):** evaluate multilingual models (Scribe auto-detect, Whisper large/turbo) on Hinglish/Gujlish; add hotwords and name lists from memory; fall back to the browser engine per language where better.
5. **Reply language and TTS (1 w):** choose voice per language; verify Gujarati/Hindi voices (ElevenLabs multilingual, other TTS); pronunciation dictionary for names and loan words; consistent persona tone across languages.
6. **Model prompting (3 d):** persona translated/adapted per language (not literal), humour calibrated, formality levels (Hindi/Gujarati honorifics), date/number/currency formats, units (INR, local time).
7. **Wake and commands (3 d):** wake word and the reflex commands (stop, volume, timers) recognised in each language (06 reflex layer needs multilingual patterns).
8. **Text channels (with 20):** reply in the user's script; right-to-left support not needed for these, but test Unicode in HUD and messaging.
9. **Translation mode:** "translate this to Gujarati", live interpreter mode for conversations, and reading foreign text through the camera (11).
10. **More languages:** add via the same profile mechanism; a checklist for adding a language (STT, TTS, persona, patterns, eval set).

## Metrics (tracked in 16)
- STT WER per language and code-switched set, targets set after the audit (Phase 1).
- Language-detection accuracy ≥ 95 % on a labelled set.
- Reply in the intended language ≥ 98 %.
- Native-speaker rating of naturalness ≥ 4/5 for each shipped language.

## Risks
- Weak STT/TTS quality for Gujarati → ship per-language "quality labels" and fall back gracefully rather than pretend.
- Mixed-script output confusing TTS → normalise text before synthesis.
- Evaluation needs native speakers → recruit family/testers; never rely on machine judgement alone.

## Done when
A bilingual family can switch languages mid-conversation with correct replies, and each language has a published quality table and a regression set.

## Autopilot log
- **2026-10-27 — Phase 2 (language profile), Q30.** Four settings in the registry's Languages
  section, all `scope: 'person'` and applied live: main language, second language, reply
  language (`primary` / `mirror` / always `en`/`gu`/`hi`) and script for Gujarati and Hindi
  (`native` / `roman`). `bridge/language-profile.mjs` turns the profile into the turn's
  preface; the bridge reads it every turn, so a change applies to the next message. Mirror
  uses the message's letters (Gujarati script → Gujarati, Devanagari → Hindi) and otherwise
  asks the model to mirror, falling back to the main language. The defaults reproduce the old
  behaviour exactly (understand all three, answer in English); the page no longer sends its own
  "reply in English" on the bridge path (the direct API path still does: it has no settings).
  Tests: `bridge/language-profile.test.mjs`. **Left:** a profile per person once speaker ID
  exists, the "by topic" policy and a reply-language metric (Q76); spoken replies in Gujarati or
  Hindi still need a voice that speaks them (phase 5); reflexes in each language (Q75).
