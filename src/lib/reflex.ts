/**
 * The reflex layer (plan 06, phase 1): commands answered on the page with no
 * model call at all. Stop, the time and date, "say that again", volume and
 * kitchen timers. They answer at once and work with no network.
 *
 * Everything here is pure: `matchReflex` decides whether an utterance is a
 * reflex, and `answerReflex` works out what to do and say, given the few
 * things it needs to know (the clock, the last answer, the volume, the
 * timers). App.respond does the speaking and the tracing.
 *
 * The rule that keeps this safe: a pattern must match the WHOLE utterance,
 * after a few polite words are trimmed. "Stop" is a reflex; "stop the
 * subscription renewal" goes to the model, as does anything not matched here.
 * A miss costs a normal model turn, never a wrong action. Reflexes only touch
 * things on this page (its own voice, its own timers), so they never pass
 * through the policy engine: there is nothing for it to decide.
 *
 * The morning briefing (plan 12, Q34) is started here too ("brief me"), and
 * while one is being read out, "skip" moves on to its next section. The
 * briefing itself is built on the bridge from the connectors (briefing.ts);
 * the reflex only decides that one was asked for.
 *
 * English here; Hindi and Gujarati phrasings, in their own scripts and in
 * Latin letters, are in reflexIndic.ts and answer in the language the owner's
 * language profile asks for (plan 28, Q75; reflexSay.ts).
 */
import { matchIndic, type Heard } from './reflexIndic.ts'
import { indicPhrasebook, type Phrasebook } from './reflexSay.ts'

export type { Heard }

export type VolumeOp = 'up' | 'down' | 'mute' | 'unmute' | 'set'

export type Reflex =
  | { kind: 'stop' }
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'repeat' }
  | { kind: 'volume'; op: VolumeOp; level?: number }
  | { kind: 'timer-set'; ms: number; label?: string }
  | { kind: 'timer-cancel'; all: boolean; label?: string }
  | { kind: 'timer-query' }
  | { kind: 'briefing'; short: boolean }
  | { kind: 'briefing-skip' }
  | { kind: 'briefing-end' }

/** What traces record: the family, never what was said. Kept in step with bridge/traces.mjs. */
export type ReflexFamily = 'stop' | 'time' | 'date' | 'repeat' | 'volume' | 'timer' | 'briefing'

/** Every family, in the order bridge/traces.mjs lists them (a test keeps the two in step). */
export const REFLEX_FAMILIES: readonly ReflexFamily[] = ['stop', 'time', 'date', 'repeat', 'volume', 'timer', 'briefing']

export const familyOf = (r: Reflex): ReflexFamily =>
  r.kind.startsWith('timer') ? 'timer' : r.kind.startsWith('briefing') ? 'briefing' : (r.kind as ReflexFamily)

/** What the page knows that changes what an utterance means. */
export type MatchContext = {
  /** A briefing is being read out (or was cut off and can carry on): "skip" means its next section. */
  briefing?: boolean
  /** He just offered the briefing at a wake (Q78): "yes" starts it, "no" declines it. */
  offered?: boolean
}

/** Longest timer accepted: a day. Anything longer is a reminder (plan 12), not a timer. */
export const MAX_TIMER_MS = 24 * 3600_000
/** At most this many timers at once. */
export const MAX_TIMERS = 10
const MAX_LABEL = 40

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

const LEAD = /^(?:(?:please|ok|okay|hey|um|uh|er|so|and|now|right|alright|all right)\s+)+/
const ASK = /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)/
const TAIL = /(?:\s+(?:please|now|for me|thanks|thank you|sir|ma'am|madam|right now|then))+$/

// Hindi and Gujarati polite words and fillers, in both scripts ("ज़रा", "please", "जी", "ને").
const INDIC_LEAD = /^(?:(?:कृपया|जरा|प्लीज|अरे|ओके|ठीक है|kripya|zara|jara|plz|arre|જરા|પ્લીઝ|ઓકે|અરે|મહેરબાની કરીને|meherbani karine)\s+)+/u
const INDIC_TAIL = /(?:\s+(?:जी|प्लीज|ना|यार|सर|ji|plz|na|yaar|yar|bhai|પ્લીઝ|ને|ભાઈ|સર|ne|જરા|जरा|zara|jara))+$/u

/** Devanagari letters written with a nukta, as the plain letter (क़ → क). */
const NUKTA_LETTERS: Record<string, string> = {
  '\u0958': 'क', '\u0959': 'ख', '\u095A': 'ग', '\u095B': 'ज', '\u095C': 'ड', '\u095D': 'ढ', '\u095E': 'फ', '\u095F': 'य',
}
/** Gujarati postpositions people write joined to the word: "મિનિટનું" is matched as "મિનિટ નું". */
const GU_JOINED = /(\p{Script=Gujarati})(નું|નો|ની|ના|માં|વાળું|વાળો|વાળી|વાળા)(?=\s|$)/gu

/**
 * Lower case, plain apostrophes, no sentence punctuation (decimal points kept),
 * polite words trimmed. For Hindi and Gujarati also: no nukta or zero-width
 * joiners, one form of the nasal mark, Indian digits as 0-9, and Gujarati
 * postpositions split off, so one spelling of each pattern covers the common
 * ways speech-to-text writes it.
 */
export function normalise(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[\u0958-\u095F]/g, (c) => NUKTA_LETTERS[c] ?? c)
    .replace(/[\u093C\u0ABC\u200C\u200D]/g, '')
    .replace(/\u0901/g, '\u0902')
    .replace(/\u0A81/g, '\u0A82')
    .replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966))
    .replace(/[\u0AE6-\u0AEF]/g, (c) => String(c.charCodeAt(0) - 0x0ae6))
    .replace(/(\d)\.(\d)/g, '$1\u0000$2')
    .replace(/[.,!?;:"()…।॥]+/g, ' ')
    .replace(/\u0000/g, '.')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(GU_JOINED, '$1 $2')
  // Twice, so "okay can you please ... now thanks" loses both ends.
  for (let i = 0; i < 2; i++) {
    s = s.replace(LEAD, '').replace(ASK, '').replace(TAIL, '').replace(INDIC_LEAD, '').replace(INDIC_TAIL, '').trim()
  }
  return s
}

// ---------------------------------------------------------------------------
// Numbers and durations
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

const NUMBER_WORD = `(?:${[...Object.keys(TENS), ...Object.keys(UNITS)].join('|')})`
/** Digits, "a"/"an", "a couple of", or number words up to ninety-nine (and "a hundred"). */
const NUMBER = `(?:\\d+(?:\\.\\d+)?|a couple of|a couple|an?|a hundred|one hundred|${NUMBER_WORD}(?:\\s+${NUMBER_WORD})?)`

/** A spoken number as a value, or null. "twenty five" → 25, "a" → 1, "7.5" → 7.5. */
export function parseNumber(raw: string): number | null {
  const s = raw.trim()
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s)
  if (s === 'a' || s === 'an') return 1
  if (s === 'a couple' || s === 'a couple of') return 2
  if (s === 'a hundred' || s === 'one hundred') return 100
  const words = s.split(/\s+/)
  if (words.length === 1) return UNITS[s] ?? TENS[s] ?? null
  if (words.length === 2 && TENS[words[0]] !== undefined && UNITS[words[1]] !== undefined && UNITS[words[1]] > 0 && UNITS[words[1]] < 10) {
    return TENS[words[0]] + UNITS[words[1]]
  }
  return null
}

const UNIT_MS: [RegExp, number][] = [
  [/^(?:s|sec|secs|second|seconds)$/, 1000],
  [/^(?:m|min|mins|minute|minutes)$/, 60_000],
  [/^(?:h|hr|hrs|hour|hours)$/, 3600_000],
]
const UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)'
const PART = new RegExp(`^(${NUMBER})\\s*(${UNIT})(\\s+and\\s+a\\s+half)?(?:\\s+|$)`)

function unitMs(word: string): number | null {
  for (const [re, ms] of UNIT_MS) if (re.test(word)) return ms
  return null
}

/**
 * A spoken duration in milliseconds, or null if any part of it is not a
 * duration. "5 minutes", "an hour and a half", "1 hour 30 minutes",
 * "half an hour", "ninety seconds", "a minute and 20 seconds".
 */
export function parseDuration(text: string): number | null {
  let s = text.trim()
  if (/^half an? hour$/.test(s)) return 30 * 60_000
  if (/^half a minute$/.test(s)) return 30_000
  if (/^(?:a )?quarter of an hour$/.test(s)) return 15 * 60_000
  let total = 0
  let parts = 0
  while (s) {
    const m = PART.exec(s)
    if (!m) return null
    const n = parseNumber(m[1])
    const unit = unitMs(m[2])
    if (n === null || unit === null) return null
    total += (n + (m[3] ? 0.5 : 0)) * unit
    parts++
    s = s.slice(m[0].length).replace(/^(?:and\s+)/, '').trim()
  }
  if (!parts || !Number.isFinite(total) || total <= 0) return null
  return Math.round(total)
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const STOP_WORD = "(?:stop|stop it|stop talking|stop that|that's enough|enough|be quiet|quiet|shut up|hush|silence|cancel|cancel that|never mind|nevermind|forget it|forget about it|that's all|that is all|that'll be all|that will be all|nothing|no thanks|no thank you)"
const STOP = new RegExp(`^(?:(?:ok|okay|no|oh)\\s+)?${STOP_WORD}(?:\\s+${STOP_WORD})*$`)

const TIME = /^(?:what(?:'s| is) the time|what time is it|what time it is|tell me the time|(?:do you )?(?:know|have) the time|got the time|(?:the )?time|(?:the )?current time|what's the current time|what is the current time|time check)$/
const DATE = /^(?:what(?:'s| is) (?:the |today's )?date(?: today)?|what date is it(?: today)?|what day is it(?: today)?|what(?:'s| is) today|what day is today|today's date|what's the day|what is the day|which day is it(?: today)?)$/
const REPEAT = /^(?:sorry )?(?:repeat|repeat that|repeat it|repeat yourself|repeat what you said|say that again|say it again|say again|what did you say|pardon|pardon me|sorry|sorry what|come again|i didn't catch that|i didn't hear that|i missed that)$/

const UP = /^(?:volume up|turn (?:it |the volume |the sound |yourself )?up|turn up (?:the )?(?:volume|sound)|louder|(?:a (?:bit|little) )?louder|speak up|speak louder|talk louder|increase (?:the )?volume|raise (?:the )?volume|more volume)(?: a (?:bit|little))?(?: more)?$/
const DOWN = /^(?:volume down|turn (?:it |the volume |the sound |yourself )?down|turn down (?:the )?(?:volume|sound)|quieter|softer|(?:a (?:bit|little) )?(?:quieter|softer)|speak (?:more )?(?:softly|quietly)|talk (?:more )?(?:softly|quietly)|lower (?:the |your )?volume|decrease (?:the )?volume|reduce (?:the )?volume|less volume)(?: a (?:bit|little))?(?: more)?$/
const MUTE = /^(?:mute|mute yourself|mute (?:the )?(?:voice|sound|volume)|volume off|sound off)$/
const UNMUTE = /^(?:unmute|unmute yourself|unmute (?:the )?(?:voice|sound|volume)|volume on|sound on)$/
const SET_VOLUME = new RegExp(`^(?:set |change |put )?(?:the |your )?volume (?:to |at )?(${NUMBER})(?: (percent|per cent|%))?$`)
const SET_VOLUME_PCT = new RegExp(`^(?:set |change |put )?(?:the |your )?volume (?:to |at )?(\\d{1,3})\\s*%$`)

const LABEL = "([a-z][a-z' ]{0,39})"
const TIMER_NOUN = '(?:timer|countdown)'
// "set a timer for 5 minutes (for the pasta)", "timer for 5 minutes", "start a 10 minute countdown (for tea)".
const TIMER_FOR = new RegExp(`^(?:(?:set|start|put on|make|create|give me)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|one\\s+)?)?${TIMER_NOUN}\\s+(?:for\\s+|of\\s+)?(.+?)(?:\\s+(?:for|called|named|labelled|labeled)\\s+${LABEL})?$`)
const TIMER_ADJ = new RegExp(`^(?:set|start|put on|make|create|give me)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|one\\s+)?(.+?)\\s+${TIMER_NOUN}(?:\\s+(?:for|called|named|labelled|labeled)\\s+${LABEL})?$`)
const TIMER_CANCEL = new RegExp(`^(?:cancel|stop|delete|clear|remove|kill|end|turn off|switch off)\\s+(?:(all)\\s+)?(?:(?:the|my|all the|all my)\\s+)?(?:${LABEL}\\s+)?(${TIMER_NOUN}s?)$`)
const TIMER_QUERY = new RegExp(`^(?:how (?:much|long) (?:time )?(?:is |has )?(?:left|remaining|to go) on (?:the |my )?(?:${LABEL}\\s+)?${TIMER_NOUN}s?|how (?:much|long) (?:is |has )?(?:the |my )?(?:${LABEL}\\s+)?${TIMER_NOUN} got(?: left)?|how(?:'s| is) (?:the |my )?${TIMER_NOUN}(?: doing)?|(?:check|status of) (?:the |my )?${TIMER_NOUN}s?|what(?:'s| is) left on (?:the |my )?${TIMER_NOUN}s?|what ${TIMER_NOUN}s (?:do i have|are (?:running|set|on))|(?:are there |do i have )?any ${TIMER_NOUN}s(?: (?:running|set|on))?|${TIMER_NOUN}s?(?: status)?|time left on (?:the |my )?${TIMER_NOUN}s?)$`)

// The morning briefing (plan 12, Q34). "Brief" alone is too often a document
// ("read the brief"), so it needs "me", "morning" or "daily".
const BRIEF_ADJ = '(?:(quick|short|brief|full)\\s+)?'
const BRIEFING_START = new RegExp(
  '^(?:(?:give|read|play|start|do|run|begin|let\'s (?:do|have|hear)|can i (?:have|get|hear)|i\'d like|i want)\\s+(?:me\\s+)?)?' +
  `(?:(?:my|the|a|today's|this morning's)\\s+)?${BRIEF_ADJ}(?:(?:morning|daily)\\s+)?briefing(?:\\s+for (?:today|this morning))?$`,
)
const BRIEFING_START_SHORT = new RegExp(
  `^(?:(?:give|read|play|start|do)\\s+(?:me\\s+)?)?(?:(?:my|the|a)\\s+)?${BRIEF_ADJ}(?:morning|daily) (?:brief|rundown)$` +
  `|^${BRIEF_ADJ}brief me(?: (?:quickly|briefly))?(?: on (?:my|the) day| on today| for today)?$`,
)
const BRIEFING_END = /^(?:skip|stop|cancel|end|forget|drop|no more of)\s+(?:the |this |my |today's )?(?:morning |daily )?(?:briefing|brief|rundown)(?: for (?:now|today))?$|^no briefing(?: today| for now)?$/
const BRIEFING_SKIP = /^(?:skip|skip it|skip that|skip this|skip this one|skip that one|skip ahead|skip on|next|next one|next part|next section|next item|next thing|move on|go on to the next(?: one| part)?)$/
const BRIEFING_SKIP_REST = /^(?:skip the rest|skip everything|skip all of it|that's enough of that)$/
// Answers to the briefing offered at a wake (Q78); they only mean that right after it.
// ("Not now" arrives as "not": the trailing "now" is trimmed like "please".)
const OFFER_YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|alright|all right|go ahead|go on|do it|please do|yes go ahead|sure go ahead|let's hear it|let's have it|why not|of course|absolutely|brief me|go for it)$/
const OFFER_NO = /^(?:no|nope|nah|not|not now|not today|not yet|later|maybe later|no need|skip it|no briefing|i'm good|i'm fine)$/

function briefingStart(s: string): Reflex | null {
  const m = BRIEFING_START.exec(s) ?? BRIEFING_START_SHORT.exec(s)
  if (!m) return null
  const adj = m.slice(1).find((x) => x)
  const quick = adj === 'quick' || adj === 'short' || adj === 'brief' || / (?:quickly|briefly)\b/.test(s)
  return { kind: 'briefing', short: quick }
}

function timerSet(durationText: string, label: string | undefined): Reflex | null {
  const ms = parseDuration(durationText)
  if (ms === null || ms < 1000 || ms > MAX_TIMER_MS) return null
  const clean = label?.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL)
  return clean ? { kind: 'timer-set', ms, label: clean } : { kind: 'timer-set', ms }
}

const notLabel = (l?: string) => !l || /^(?:the|my|all|a|an|this|that)$/.test(l.trim())

/**
 * The reflex this utterance asks for, or null to send it to the model.
 * Only whole-utterance matches count.
 */
export function matchReflex(text: string, ctx: MatchContext = {}): Reflex | null {
  return matchReflexIn(text, ctx)?.reflex ?? null
}

/**
 * The reflex and the language it was asked in ('mixed' for romanised words
 * Hindi and Gujarati share), or null to send the utterance to the model.
 */
export function matchReflexIn(text: string, ctx: MatchContext = {}): { reflex: Reflex; heard: Heard } | null {
  const s = normalise(text)
  if (!s || s.length > 120) return null
  const en = matchEnglish(s, ctx)
  if (en) return { reflex: en, heard: 'en' }
  const indic = matchIndic(s, ctx)
  if (!indic) return null
  // The same limits as English: a timer is a second to a day.
  const r = indic.reflex
  if (r.kind === 'timer-set' && (r.ms < 1000 || r.ms > MAX_TIMER_MS)) return null
  return indic
}

function matchEnglish(s: string, ctx: MatchContext): Reflex | null {

  if (STOP.test(s)) return { kind: 'stop' }
  // Right after the offer at a wake, "yes" and "no" answer it (Q78).
  if (ctx.offered && !ctx.briefing) {
    if (OFFER_YES.test(s)) return { kind: 'briefing', short: false }
    if (OFFER_NO.test(s)) return { kind: 'briefing-end' }
  }
  // "Skip" only means the briefing while one is going; otherwise it goes to the model.
  if (ctx.briefing && BRIEFING_SKIP.test(s)) return { kind: 'briefing-skip' }
  if (BRIEFING_END.test(s) || (ctx.briefing && BRIEFING_SKIP_REST.test(s))) return { kind: 'briefing-end' }
  const brief = briefingStart(s)
  if (brief) return brief
  if (TIME.test(s)) return { kind: 'time' }
  if (DATE.test(s)) return { kind: 'date' }
  if (REPEAT.test(s)) return { kind: 'repeat' }

  if (UP.test(s)) return { kind: 'volume', op: 'up' }
  if (DOWN.test(s)) return { kind: 'volume', op: 'down' }
  if (MUTE.test(s)) return { kind: 'volume', op: 'mute' }
  if (UNMUTE.test(s)) return { kind: 'volume', op: 'unmute' }
  const pct = SET_VOLUME_PCT.exec(s)
  if (pct) {
    const n = Number(pct[1])
    return n <= 100 ? { kind: 'volume', op: 'set', level: n / 100 } : null
  }
  const set = SET_VOLUME.exec(s)
  if (set) {
    const n = parseNumber(set[1])
    if (n === null || n < 0) return null
    // "volume 7" is out of ten; "volume 40" or "40 percent" is out of a hundred.
    const level = set[2] || n > 10 ? n / 100 : n / 10
    return level <= 1 ? { kind: 'volume', op: 'set', level } : null
  }

  const cancel = TIMER_CANCEL.exec(s)
  if (cancel) {
    const label = notLabel(cancel[2]) ? undefined : cancel[2].trim()
    const all = Boolean(cancel[1]) || cancel[3].endsWith('s')
    return label ? { kind: 'timer-cancel', all, label } : { kind: 'timer-cancel', all }
  }
  if (TIMER_QUERY.test(s)) return { kind: 'timer-query' }

  const adj = TIMER_ADJ.exec(s)
  if (adj) {
    const r = timerSet(adj[1], adj[2])
    if (r) return r
  }
  const form = TIMER_FOR.exec(s)
  if (form) {
    const r = timerSet(form[1], form[2])
    if (r) return r
  }
  return null
}

// ---------------------------------------------------------------------------
// Speaking numbers, times and durations
// ---------------------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "5 minutes", "1 hour and 30 minutes", "45 seconds", "2 minutes and 5 seconds". Rounded to the second. */
export function speakDuration(ms: number): string {
  let s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const parts: string[] = []
  if (h) parts.push(plural(h, 'hour'))
  if (m) parts.push(plural(m, 'minute'))
  // Seconds stop mattering once there are hours.
  if (s && !h) parts.push(plural(s, 'second'))
  if (!parts.length) return '0 seconds'
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "3:05 PM" in the given locale's clock style; 24-hour where the locale uses it. */
export function speakTime(date: Date, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date)
}

const ordinal = (n: number) => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** "Monday, the 26th of October" — read naturally by every voice, unlike "26/10". */
export function speakDate(date: Date, locale = 'en-GB'): string {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date)
  const month = new Intl.DateTimeFormat(locale, { month: 'long' }).format(date)
  return `${weekday}, the ${ordinal(date.getDate())} of ${month}`
}

/** A timer's name as said back: "the 5 minute timer" or "the pasta timer". */
export function timerName(t: { ms: number; label?: string }): string {
  if (t.label) return `the ${t.label.replace(/^(?:the|my)\s+/, '')} timer`
  return `the ${speakDuration(t.ms).replace(/(\d+) (hour|minute|second)s\b/g, '$1 $2')} timer`
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/** How much one "louder" or "quieter" moves the volume (0..1). */
export const VOLUME_STEP = 0.2
/** The quietest "quieter" goes: still audible. Silence is what mute is for. */
export const VOLUME_FLOOR = 0.1

export type VolumeState = { level: number; muted: boolean }

/** The volume after a volume reflex. Levels are 0..1, rounded to a tenth. */
export function nextVolume(cur: VolumeState, op: VolumeOp, level?: number): VolumeState {
  const r = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 10) / 10
  switch (op) {
    case 'up':
      return { level: r(cur.level + VOLUME_STEP), muted: false }
    case 'down':
      return { level: Math.max(VOLUME_FLOOR, r(cur.level - VOLUME_STEP)), muted: false }
    case 'mute':
      return { level: cur.level, muted: true }
    case 'unmute':
      return { level: cur.level, muted: false }
    case 'set': {
      const v = r(level ?? cur.level)
      // "Volume zero" is a mute that remembers the level to come back to.
      return v === 0 ? { level: cur.level, muted: true } : { level: v, muted: false }
    }
  }
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export type TimerView = { id: string; ms: number; label?: string; endsAt: number }

/** The language a reflex answers in, and how Gujarati and Hindi are written. */
export type ReplyLang = 'en' | 'hi' | 'gu'
export type Script = 'native' | 'roman'

export type ReflexContext = {
  now: Date
  /** The last thing JARVIS said this session, or '' if nothing yet. */
  lastAnswer: string
  volume: VolumeState
  timers: TimerView[]
  /** Whether a finished timer is ringing right now. */
  ringing: boolean
  locale?: string
  /** The language to answer in (replyLanguageFor). English when absent. */
  lang?: ReplyLang
  script?: Script
  /** A briefing is being read out, or was cut off part way (Q34). */
  briefing?: boolean
  /** He just offered the briefing at a wake (Q78). */
  offered?: boolean
}

/** What App.respond carries out. Everything a reflex changes is named here. */
export type ReflexAnswer = {
  /** What to say; null for nothing (stop). */
  say: string | null
  /** After speaking: keep listening for a follow-up, or go back to standby. */
  then: 'listen' | 'dormant'
  volume?: VolumeState
  startTimer?: { ms: number; label?: string }
  cancelTimers?: string[]
  /** Silence a ringing timer. */
  silence?: boolean
  /** The morning briefing (Q34): fetch and read one, go on to its next section, or drop it. */
  briefing?: 'start' | 'next' | 'end'
  /** With 'start': the quick version. */
  briefingShort?: boolean
}

const englishBook = (locale: string): Phrasebook => ({
  time: (d) => `It's ${speakTime(d, locale)}.`,
  date: (d) => `It's ${speakDate(d, locale)}.`,
  duration: speakDuration,
  timerName,
  nothingYet: "I haven't said anything yet, sir.",
  muted: 'Muted. Say "unmute" to hear me again.',
  loudest: "That's as loud as I go, sir.",
  quietest: 'That is as quiet as I go. Say "mute" for silence.',
  volume: (p) => `Volume ${p} percent.`,
  tooMany: (n) => `You already have ${n} timers running, sir. Cancel one first.`,
  timerSet: (dur, label) => `Timer set for ${dur}${label ? ` for ${label.replace(/^(?:the|my)\s+/, 'the ')}` : ''}.`,
  noTimers: 'There are no timers running.',
  cantFind: (label) => `I can't find a ${label} timer.`,
  cancelled: (name) => `Cancelled ${name}.`,
  cancelledAll: (n) => `Cancelled all ${n} timers.`,
  cancelledOne: (name, rest) => `Cancelled ${name}. ${rest === 1 ? 'One other timer is' : `${rest} other timers are`} still running.`,
  left: (dur, name) => `${dur} left on ${name}.`,
  several: (n, lines, more) =>
    `${n} timers. ${lines.join('; ')}${more ? `, and ${more} more` : ''}.`.replace(/^(\d+ timers\. )the/, '$1The'),
  timerDone: (name) => `Sir, ${name} is done.`,
  briefingEnded: "Very good. I'll leave the briefing there.",
  briefingNone: "There's no briefing running, sir.",
  nothingToSkip: "There's nothing to skip, sir.",
  briefingDeclined: 'Very good, sir. Say "brief me" whenever you like.',
})

/** The words for this reply: English, or Hindi or Gujarati in the chosen script. */
export function phrasebook(lang: ReplyLang = 'en', script: Script = 'native', locale = 'en-GB'): Phrasebook {
  return lang === 'en' ? englishBook(locale) : indicPhrasebook(lang, script)
}

export function answerReflex(r: Reflex, ctx: ReflexContext): ReflexAnswer {
  const say = phrasebook(ctx.lang, ctx.script, ctx.locale ?? 'en-GB')
  const soonest = [...ctx.timers].sort((a, b) => a.endsAt - b.endsAt)
  const left = (t: TimerView) => say.duration(Math.max(0, t.endsAt - ctx.now.getTime()))

  switch (r.kind) {
    case 'stop':
      return { say: null, then: 'dormant', silence: true }

    case 'time':
      return { say: say.time(ctx.now), then: 'listen' }

    case 'date':
      return { say: say.date(ctx.now), then: 'listen' }

    case 'repeat':
      return ctx.lastAnswer.trim()
        ? { say: ctx.lastAnswer, then: 'listen' }
        : { say: say.nothingYet, then: 'listen' }

    case 'volume': {
      const v = nextVolume(ctx.volume, r.op, r.level)
      // Muting says so first, at the old volume; there is nothing to hear after.
      if (v.muted) return { say: say.muted, then: 'listen', volume: v }
      if (r.op === 'up' && ctx.volume.level >= 1 && !ctx.volume.muted) {
        return { say: say.loudest, then: 'listen', volume: v }
      }
      if (r.op === 'down' && ctx.volume.level <= VOLUME_FLOOR && !ctx.volume.muted) {
        return { say: say.quietest, then: 'listen', volume: v }
      }
      return { say: say.volume(Math.round(v.level * 100)), then: 'listen', volume: v }
    }

    case 'timer-set': {
      if (ctx.timers.length >= MAX_TIMERS) {
        return { say: say.tooMany(MAX_TIMERS), then: 'listen' }
      }
      return {
        say: say.timerSet(say.duration(r.ms), r.label),
        then: 'listen',
        startTimer: r.label ? { ms: r.ms, label: r.label } : { ms: r.ms },
      }
    }

    case 'timer-cancel': {
      if (!ctx.timers.length) {
        return ctx.ringing
          ? { say: null, then: 'listen', silence: true }
          : { say: say.noTimers, then: 'listen' }
      }
      if (r.label) {
        const want = r.label.replace(/^(?:the|my)\s+/, '')
        const hit = soonest.filter((t) => t.label?.replace(/^(?:the|my)\s+/, '') === want)
        if (!hit.length) return { say: say.cantFind(want), then: 'listen' }
        return { say: say.cancelled(say.timerName(hit[0])), then: 'listen', cancelTimers: hit.map((t) => t.id), silence: ctx.ringing }
      }
      if (r.all || ctx.timers.length === 1) {
        const n = ctx.timers.length
        return {
          say: n === 1 ? say.cancelled(say.timerName(ctx.timers[0])) : say.cancelledAll(n),
          then: 'listen',
          cancelTimers: ctx.timers.map((t) => t.id),
          silence: ctx.ringing,
        }
      }
      // Several running and none named: the one that would ring next.
      const t = soonest[0]
      return {
        say: say.cancelledOne(say.timerName(t), ctx.timers.length - 1),
        then: 'listen',
        cancelTimers: [t.id],
        silence: ctx.ringing,
      }
    }

    // The briefing itself is built on the bridge, in the reply language
    // (Q78); App passes the language on when it fetches it.
    case 'briefing':
      return { say: null, then: 'listen', briefing: 'start', briefingShort: r.short }

    case 'briefing-skip':
      return ctx.briefing
        ? { say: null, then: 'listen', briefing: 'next' }
        : { say: say.nothingToSkip, then: 'listen' }

    case 'briefing-end':
      if (ctx.briefing) return { say: say.briefingEnded, then: 'listen', briefing: 'end' }
      if (ctx.offered) return { say: say.briefingDeclined, then: 'listen', briefing: 'end' }
      return { say: say.briefingNone, then: 'listen' }

    case 'timer-query': {
      if (!soonest.length) return { say: say.noTimers, then: 'listen' }
      if (soonest.length === 1) return { say: say.left(left(soonest[0]), say.timerName(soonest[0])), then: 'listen' }
      const lines = soonest.slice(0, 3).map((t) => `${say.timerName(t)}: ${left(t)}`)
      return { say: say.several(soonest.length, lines, Math.max(0, soonest.length - 3)), then: 'listen' }
    }
  }
}

/** What JARVIS says when a timer finishes. */
export function timerDoneLine(t: { ms: number; label?: string }, lang: ReplyLang = 'en', script: Script = 'native'): string {
  const say = phrasebook(lang, script)
  return say.timerDone(say.timerName(t))
}

// ---------------------------------------------------------------------------
// Which language a reflex answers in (plan 28, Q30's language profile)
// ---------------------------------------------------------------------------

export type ReflexLanguageProfile = {
  primary: ReplyLang
  secondary: ReplyLang | 'none'
  reply: 'primary' | 'mirror' | ReplyLang
  script: Script
}

export const DEFAULT_LANGUAGE_PROFILE: ReflexLanguageProfile = Object.freeze({
  primary: 'en',
  secondary: 'none',
  reply: 'primary',
  script: 'native',
})

const LANGS: readonly string[] = ['en', 'hi', 'gu']

/**
 * The profile from the settings the bridge serves (JARVIS_LANG_PRIMARY and so
 * on). The same fallbacks as bridge/language-profile.mjs: anything missing or
 * unknown is the default, so reflexes keep answering whatever arrives.
 */
export function languageProfileFrom(s: Partial<Record<string, unknown>> | null | undefined): ReflexLanguageProfile {
  const pick = <T extends string>(v: unknown, allowed: readonly string[], d: T): T =>
    typeof v === 'string' && allowed.includes(v) ? (v as T) : d
  const primary = pick<ReplyLang>(s?.JARVIS_LANG_PRIMARY, LANGS, 'en')
  let secondary = pick<ReplyLang | 'none'>(s?.JARVIS_LANG_SECONDARY, ['none', ...LANGS], 'none')
  if (secondary === primary) secondary = 'none'
  return {
    primary,
    secondary,
    reply: pick<ReflexLanguageProfile['reply']>(s?.JARVIS_REPLY_LANGUAGE, ['primary', 'mirror', ...LANGS], 'primary'),
    script: pick<Script>(s?.JARVIS_TEXT_SCRIPT, ['native', 'roman'], 'native'),
  }
}

/**
 * The language a reflex answers in. The profile's policy, as for the model:
 * always the main language, always a fixed one, or (mirror) the language the
 * command was said in. Romanised words both languages share are answered in
 * whichever of Hindi or Gujarati the owner speaks, Hindi if neither.
 * `heard` absent (a timer ringing, not a reply) mirrors the main language.
 */
export function replyLanguageFor(p: ReflexLanguageProfile, heard?: Heard): ReplyLang {
  if (p.reply === 'primary') return p.primary
  if (p.reply !== 'mirror') return p.reply
  if (!heard) return p.primary
  if (heard !== 'mixed') return heard
  if (p.primary !== 'en') return p.primary
  if (p.secondary === 'hi' || p.secondary === 'gu') return p.secondary
  return 'hi'
}

let profile: ReflexLanguageProfile = DEFAULT_LANGUAGE_PROFILE

/** The owner's language profile, as last loaded from or saved in Settings. */
export const reflexLanguageProfile = (): ReflexLanguageProfile => profile

export function setReflexLanguageProfile(p: ReflexLanguageProfile): void {
  profile = p
}

// ---------------------------------------------------------------------------
// The switch (Settings → Voice → Quick commands; JARVIS_REFLEXES)
// ---------------------------------------------------------------------------

let enabled = true

/** Whether reflexes answer at all. Off: every utterance goes to the model. */
export const reflexesEnabled = (): boolean => enabled

export function setReflexesEnabled(on: boolean): void {
  enabled = on
}
