/**
 * The Translator agent (bridge/agents/translator.md): what its runs are told
 * about the owner's languages, and how its answer is read and checked.
 *
 * The Translator has no tools. Its file says how to translate; this module
 * adds the one thing the file cannot know, the owner's language profile
 * (language-profile.mjs), so a request that names no language goes the way
 * the owner would expect and Gujarati or Hindi comes out in the script they
 * chose. The profile is read at each run, so a change in Settings applies to
 * the next translation.
 *
 * Its answer is one or more blocks:
 *
 *   Translation: Gujarati
 *   <the text>
 *
 *   Notes for you:
 *   - optional
 *
 * `readTranslations` reads them and `translationProblems` lists what is wrong
 * with the shape or the script, in words the agent can fix (the reviewer pass
 * uses them when review is on for this agent).
 *
 * Pure functions only: no state, no I/O.
 */
import { LANGUAGE_NAMES, PROFILE_DEFAULTS, scriptLanguage } from './language-profile.mjs'

export const TRANSLATOR_ID = 'translator'

/** Is this the built-in Translator? Only the shipped file gets the owner's languages added. */
export const isTranslatorAgent = (def) =>
  def !== null && typeof def === 'object' && def.id === TRANSLATOR_ID && def.createdBy === 'builtin'

const CODE_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(LANGUAGE_NAMES).map(([code, name]) => [name.toLowerCase(), code])))
const SCRIPT_WORDS = Object.freeze({ gu: 'Gujarati script', hi: 'Devanagari' })
/** Most translations we read; more blocks than this is not a translation. */
export const MAX_TRANSLATIONS = 3
/** Most problems listed for one answer. */
export const MAX_TRANSLATION_PROBLEMS = 4

/**
 * Where a request that names no language goes: text not in the main language
 * goes into it; text already in the main language goes into the second one,
 * else into English (or, for an English speaker with no second language,
 * nowhere: the agent asks).
 */
export function defaultTargets(profile) {
  const p = profile ?? PROFILE_DEFAULTS
  const primary = LANGUAGE_NAMES[p.primary] ? p.primary : PROFILE_DEFAULTS.primary
  const secondary = p.secondary !== 'none' && LANGUAGE_NAMES[p.secondary] && p.secondary !== primary ? p.secondary : null
  return { into: primary, also: secondary, fromPrimary: secondary ?? (primary === 'en' ? null : 'en') }
}

/**
 * The section added to the Translator's prompt for one run: the owner's
 * languages, their script, and where text goes when the request names no
 * language.
 */
export function translatorContext(profile) {
  const p = profile ?? PROFILE_DEFAULTS
  const { into, also, fromPrimary } = defaultTargets(p)
  const main = LANGUAGE_NAMES[into]
  const lines = [
    '## The owner\'s languages',
    `- Main language: ${main}.${also ? ` Also speaks ${LANGUAGE_NAMES[also]}.` : ''}`,
    p.script === 'roman'
      ? '- They read Gujarati and Hindi in Latin letters: write those languages romanised unless the request asks for their own script.'
      : '- Write Gujarati in Gujarati script and Hindi in Devanagari unless the request asks for Latin letters.',
    `- When the request names no language: translate text that is not in ${main} into ${main}.`,
    fromPrimary
      ? `- Text that is already in ${main} goes into ${LANGUAGE_NAMES[fromPrimary]}.`
      : `- If the text is already in ${main}, ask the owner with ask_owner which language they want; do not guess.`,
  ]
  return lines.join('\n')
}

const HEADER = /^\s*(?:\*\*)?translation(?:\*\*)?:(?:\*\*)?\s*(.*?)\s*$/i
const NOTES = /^\s*(?:#+\s*)?(?:\*\*)?notes for you:?(?:\*\*)?:?\s*$/i

/** "Hindi (romanised)" → { language: 'hi', romanised: true }; null when not one of ours. */
function readLanguage(label) {
  const m = /^([A-Za-z]+)\s*(\((?:romanised|romanized|latin letters)\))?\s*$/i.exec(label ?? '')
  if (!m) return null
  const language = CODE_BY_NAME[m[1].toLowerCase()]
  if (!language) return null
  return { language, romanised: Boolean(m[2]) && language !== 'en' }
}

const strip = (s) => s.replace(/^\s*```[a-z]*\s*$/gim, '').trim()

/**
 * The Translator's answer as data, or null when it does not start with a
 * `Translation:` line naming English, Gujarati or Hindi.
 *
 * @returns {{ translations: { language: string, romanised: boolean, text: string }[], notes?: string } | null}
 */
export function readTranslations(result) {
  if (typeof result !== 'string') return null
  const lines = strip(result).split(/\r?\n/)
  const first = lines.findIndex((l) => l.trim())
  if (first < 0 || !HEADER.test(lines[first])) return null
  const translations = []
  let current = null
  let notes = null
  for (const line of lines.slice(first)) {
    if (notes) { notes.push(line); continue }
    if (NOTES.test(line)) { notes = []; continue }
    const h = HEADER.exec(line)
    if (h) {
      const lang = readLanguage(h[1])
      if (!lang) return null
      current = { ...lang, lines: [] }
      translations.push(current)
      if (translations.length > MAX_TRANSLATIONS) return null
      continue
    }
    current.lines.push(line)
  }
  const out = {
    translations: translations.map(({ language, romanised, lines: l }) => ({ language, romanised, text: l.join('\n').trim() })),
  }
  const n = notes?.join('\n').trim()
  if (n) out.notes = n
  return out
}

/**
 * What is wrong with a Translator answer, in words the agent can fix: the
 * shape, an empty translation, or a translation not written in the script its
 * header names. An empty list when it is fine.
 */
export function translationProblems(result) {
  const read = readTranslations(result)
  if (!read) return ['The answer does not start with a "Translation:" line naming English, Gujarati or Hindi.']
  const problems = []
  for (const { language, romanised, text } of read.translations) {
    const name = LANGUAGE_NAMES[language]
    if (!text) { problems.push(`The ${name} translation is empty.`); continue }
    const seen = scriptLanguage(text)
    if (language === 'en' && seen) {
      problems.push(`The English translation is written in ${SCRIPT_WORDS[seen]}.`)
    } else if (language !== 'en' && romanised && seen) {
      problems.push(`The ${name} translation is marked romanised but is written in ${SCRIPT_WORDS[seen]}.`)
    } else if (language !== 'en' && !romanised && seen !== language) {
      problems.push(`The ${name} translation is not written in ${SCRIPT_WORDS[language]}; write it in that script or mark it "(romanised)".`)
    }
  }
  return problems.slice(0, MAX_TRANSLATION_PROBLEMS)
}
