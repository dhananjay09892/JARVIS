# 40 · Name and brand

**Status:** Proposal · **Priority:** P1 (before any public launch) · **Effort:** 1–2 days of checks, then filing · **Depends on:** 28 (multilingual), 18 (HUD and presence UI), 36 (economics and licensing)

## End state
JARVIS ships under a name we own outright: a coined word with no existing product, company
or trademark in software or AI, that sounds the same in US English, UK English, Hindi and
Gujarati (and close to it in most other languages), with a full form in each, a tagline set,
and a wordmark. "JARVIS" stays only as an internal codename.

## Why rename
- "JARVIS" is a Marvel / Iron Man character name. Using it for a public product risks a
  trademark or IP dispute and can never be claimed as ours.
- Many existing assistants and repos already use JARVIS, so it is not searchable or distinct.

## Chosen name: Tamelo

| | |
|---|---|
| Spelling | **Tamelo** (T-a-m-e-**l**-o, lowercase L) |
| Pronunciation | tah-MEH-loh (stress on the middle syllable) |
| Hindi (Devanagari) | तमेलो |
| Gujarati | તમેલો |
| Wake word | "Hey Tamelo" (3 syllables, distinct from "Hey Siri", "Alexa", "OK Google") |

> **Spelling note:** it was also written as "TameIO" (capital I + capital O). In many fonts a
> capital I and a lowercase l look identical, but "TameIO" would be read as "Tame-I-O"
> (TAYM-eye-oh), which breaks the pronunciation rules below and loses the Hindi/Gujarati
> spelling. Decide one form before filing. **Recommended: Tamelo.** If the "I/O" tech
> reference is wanted, use it only as a styled logo treatment, never as the registered name.

### Why it works in every language
- **Only stable sounds:** t, m, l and the plain vowels a, e, o. No "ai", "ou", "th", "j" or
  "w", which change between languages.
- **No "r":** US and UK English pronounce "r" differently, so leaving it out means both say
  the name identically.
- **No "v":** German speakers often say "v" like "f".
- **Open syllables (ta-me-lo):** read the same way in Spanish, Italian, German, French,
  Portuguese, Hindi, Gujarati and Arabic. Japanese speakers will say "ta-me-ro" (no "l" in
  Japanese) but it stays recognisable.
- **Gujarati bonus:** "tame lo" (તમે લો) means "you take it", a good fit for an assistant
  that hands you what you need.
- **One caution:** in Sanskrit-heavy Hindi, "tam" (तम) means darkness. Most listeners will
  not make the link; stressing "MEH" helps.

### Full forms (backronyms)
| Language | Full form | Meaning |
|---|---|---|
| English | **T**rusted **A**ssistant for **M**emory, **E**xecution, **L**earning & **O**rganization | — |
| English (short) | **T**rusted **A**ssistant **M**aking **E**veryday **L**ife **O**rganized | — |
| Hindi | **T**umhara **A**pna **M**itra, **E**k **L**ajawab **O**jasvi — तुम्हारा अपना मित्र, एक लाजवाब ओजस्वी | Your own friend, a wonderful and brilliant one |
| Gujarati | **T**amaro **A**tmiya **M**itra, **E**k **L**ajawab **O**jasvi — તમારો આત્મીય મિત્ર, એક લાજવાબ ઓજસ્વી | Your dear friend, a wonderful and brilliant one |

### Taglines
- English: "Your mind, organized." · "Ask. Done." · "Smart help, right beside you."
- Hindi: "आपका अपना मित्र" (Aapka apna mitra — your very own friend) · "बोलो, हो जाएगा" (Bolo, ho jaayega — just say it, it'll be done)
- Gujarati: "તમે કહો, તમેલો કરે" (Tame kaho, Tamelo kare — you say it, Tamelo does it) · "તમે લો, તમેલો" (Tame lo, Tamelo — here you go, Tamelo)

### Wordmark and identity ideas
1. **Lowercase and friendly:** "tamelo" in a rounded sans-serif; the final "o" is a glowing
   ring that doubles as the "listening" indicator in the HUD (plan 18) and the app icon.
2. **Smart dot:** an accent dot over the "e" that pulses while the assistant is thinking.
3. **Three scripts:** Tamelo / तमेलो / તમેલો stacked in matching weights.
4. **Monogram:** a "T" whose crossbar curves into a speech bubble, for icon and favicon.
- **Colours:** deep indigo (trust, intelligence) with a warm saffron/amber accent.

## Uniqueness check (web search, 2026-10-22)
A web search found **no product, company or AI tool named "Tamelo"**. Nearest names:
- **Tamplo** — French company with an AI meeting assistant and collaboration tools. Different
  spelling and sound, but same broad field: mention it to the trademark attorney.
- **Tamela Health** — maternal and infant healthcare company in Lagos. Unrelated field.

A web search is **not** legal clearance. The steps below are what actually make it ours.

## Candidates considered and rejected
| Name | Reason |
|---|---|
| Corvel | CorVel Corporation (public company) sells AI products |
| Vantrix | AI companion app launched Oct 2026 |
| Orrin | Existing AI app on the App Store |
| Quorvane | Too close to Qorvo (semiconductor company) |
| Kaivro | "ai" is read differently across languages (KAY-vro, KEH-vro) |
| Zevarion, Kavelo, Tavimo | Contain "v" (sounds like "f" in German) |
| Kalemo | Backup only: sounds close to Kallo, an existing AI platform |

**Backup name:** Kalemo (kah-LEH-moh), same pronunciation rules.

## Steps to claim the name
1. [ ] Confirm final spelling (Tamelo vs TameIO).
2. [ ] Trademark search: USPTO (tmsearch.uspto.gov), UK IPO, and India (IP India / ipindia.gov.in), classes **9** (software) and **42** (SaaS / AI services).
3. [ ] Trademark attorney clearance search, including the Tamplo similarity.
4. [ ] Register domains: tamelo.com, tamelo.ai, tamelo.in.
5. [ ] Claim handles: X, Instagram, YouTube, LinkedIn, GitHub org, Google Play, App Store.
6. [ ] File trademark applications (India + US + UK first, then Madrid Protocol if needed).
7. [ ] Rename in product: app title, wake word (plans 02, 29), HUD (18), installer and launcher, README.

## Risks
- Name collision found during legal search → fall back to Kalemo.
- Wake-word false triggers on "tamelo" in Gujarati speech ("tame lo") → test with plan 02's
  wake-word evals before locking the wake phrase; "Hey Tamelo" mitigates this.
