/**
 * The language profile (plan 28, phase 2): which languages the owner speaks,
 * which one JARVIS answers in, and how Gujarati and Hindi are written.
 *
 *   JARVIS_LANG_PRIMARY    'en' | 'gu' | 'hi'           the main language
 *   JARVIS_LANG_SECONDARY  'none' | 'en' | 'gu' | 'hi'  a second one, or none
 *   JARVIS_REPLY_LANGUAGE  'primary' | 'mirror' | 'en' | 'gu' | 'hi'
 *                            primary: always the main language
 *                            mirror:  the language the owner just used
 *                            en/gu/hi: always that language
 *   JARVIS_TEXT_SCRIPT     'native' | 'roman'
 *                            how a Gujarati or Hindi reply is written:
 *                            Gujarati/Devanagari letters, or Latin letters
 *
 * The settings are declared with scope 'person' in settings-registry.mjs. Until
 * there are speaker profiles (plan 01) the only person is the owner, so the
 * values are the owner's; `get` is how a caller reads them, which keeps this
 * file free of storage and lets a future per-person store plug in unchanged.
 *
 * The defaults (English, reply in the main language) give exactly what JARVIS
 * did before the profile existed: understand all three, answer in English.
 *
 * Pure functions only: no state, no I/O.
 */

export const LANGUAGE_NAMES = Object.freeze({ en: 'English', gu: 'Gujarati', hi: 'Hindi' })
const CODES = Object.keys(LANGUAGE_NAMES)
const SCRIPT_NAMES = Object.freeze({ gu: 'Gujarati script', hi: 'Devanagari script' })

export const PROFILE_DEFAULTS = Object.freeze({ primary: 'en', secondary: 'none', reply: 'primary', script: 'native' })

const ALLOWED = Object.freeze({
  primary: CODES,
  secondary: ['none', ...CODES],
  reply: ['primary', 'mirror', ...CODES],
  script: ['native', 'roman'],
})

const KEYS = Object.freeze({
  primary: 'JARVIS_LANG_PRIMARY',
  secondary: 'JARVIS_LANG_SECONDARY',
  reply: 'JARVIS_REPLY_LANGUAGE',
  script: 'JARVIS_TEXT_SCRIPT',
})

/**
 * Read a profile through `get(settingId)`. Anything missing or not allowed
 * falls back to the default for that field, so a bad value can never stop a
 * turn; the settings API already refuses bad values on save.
 */
export function readLanguageProfile(get = () => undefined) {
  const out = {}
  for (const [field, id] of Object.entries(KEYS)) {
    let v
    try {
      v = get(id)
    } catch {
      v = undefined
    }
    out[field] = ALLOWED[field].includes(v) ? v : PROFILE_DEFAULTS[field]
  }
  if (out.secondary === out.primary) out.secondary = 'none'
  return Object.freeze(out)
}

/**
 * The language a message is visibly written in, from its letters: 'gu' when
 * most letters are Gujarati script, 'hi' when most are Devanagari, otherwise
 * null. Latin letters are left undecided on purpose: "kal ka meeting kitne
 * baje che?" is romanised Hindi and Gujarati, not English, and only the model
 * can tell (per-utterance detection is plan 28 phase 3).
 */
export function scriptLanguage(text) {
  if (typeof text !== 'string' || !text) return null
  let gu = 0
  let hi = 0
  let latin = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (c >= 0x0a80 && c <= 0x0aff) gu++
    else if (c >= 0x0900 && c <= 0x097f) hi++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++
  }
  const total = gu + hi + latin
  if (!total) return null
  if (gu * 2 > total) return 'gu'
  if (hi * 2 > total) return 'hi'
  return null
}

/**
 * Which language the reply should be in for this message: a code, or null
 * when the policy is to mirror and the letters alone cannot tell (the model
 * then mirrors, falling back to the main language).
 */
export function replyLanguage(profile, text) {
  const p = profile ?? PROFILE_DEFAULTS
  if (p.reply === 'primary') return p.primary
  if (p.reply === 'mirror') return scriptLanguage(text)
  return p.reply
}

/** "Reply in Hindi, written in Devanagari script" and so on. */
function inLanguage(code, script) {
  const name = LANGUAGE_NAMES[code]
  if (code === 'en') return name
  return script === 'roman'
    ? `${name}, written in Latin letters (romanised ${name}), not ${SCRIPT_NAMES[code]}`
    : `${name}, written in ${SCRIPT_NAMES[code]}`
}

/**
 * The instruction sent with each turn so the reply follows the profile. It
 * travels as the turn's preface (see conversation.mjs), so the stored
 * conversation keeps only what the owner actually said.
 */
export function languagePreface(profile, text) {
  const p = profile ?? PROFILE_DEFAULTS
  const understand = "The user's message may be in English, Gujarati, or Hindi, or mix them; understand it either way."
  const target = replyLanguage(p, text)
  if (target) {
    const why = p.reply === 'mirror' ? ' (the language of this message)' : ''
    return `Reply in ${inLanguage(target, p.script)}${why}. ${understand} Keep names, commands and code as they are.`
  }
  // Mirror, and the letters did not say which language this is.
  const fallback = inLanguage(p.primary, p.script)
  const speaks = p.secondary !== 'none' ? ` The user mainly speaks ${LANGUAGE_NAMES[p.primary]} and also ${LANGUAGE_NAMES[p.secondary]}.` : ''
  const romanNote = p.script === 'roman'
    ? ' Write Gujarati or Hindi in Latin letters.'
    : ' Write Gujarati in Gujarati script and Hindi in Devanagari, even when the user typed them in Latin letters.'
  return (
    `Reply in the language the user used in this message; if they mixed languages, use the one most of the message is in; ` +
    `if you cannot tell, reply in ${fallback}.${speaks}${romanNote} ${understand} Keep names, commands and code as they are.`
  )
}
