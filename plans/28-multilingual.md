# 28 · Multilingual JARVIS: English, Gujarati, Hindi and mixing them

**Status:** Partial (language option exists) · **Priority:** P1 · **Effort:** 3–5 weeks · **Depends on:** 04 (speech stack), 06 (brain), 01 (per-speaker)

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

## Phases
1. **Audit (2 d):** record 100 sentences per language and code-switched; measure STT word error rate (Scribe, browser, later Whisper), TTS intelligibility, and model answer quality. Publish the table in this file.
2. **Per-person language profile (2 d):** primary/secondary languages, reply-language policy (mirror / always X / by topic), script for text output (Gujarati script vs. romanised), stored with the speaker profile (01).
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
