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
 * English only for now. Hindi and Gujarati phrasings are a follow-up (plan 28).
 */

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

/** What traces record: the family, never what was said. Kept in step with bridge/traces.mjs. */
export type ReflexFamily = 'stop' | 'time' | 'date' | 'repeat' | 'volume' | 'timer'

export const familyOf = (r: Reflex): ReflexFamily =>
  r.kind.startsWith('timer') ? 'timer' : (r.kind as ReflexFamily)

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

/** Lower case, plain apostrophes, no sentence punctuation (decimal points kept), polite words trimmed. */
export function normalise(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/(\d)\.(\d)/g, '$1\u0000$2')
    .replace(/[.,!?;:"()…]+/g, ' ')
    .replace(/\u0000/g, '.')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Twice, so "okay can you please ... now thanks" loses both ends.
  for (let i = 0; i < 2; i++) s = s.replace(LEAD, '').replace(ASK, '').replace(TAIL, '').trim()
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
export function matchReflex(text: string): Reflex | null {
  const s = normalise(text)
  if (!s || s.length > 120) return null

  if (STOP.test(s)) return { kind: 'stop' }
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

export type ReflexContext = {
  now: Date
  /** The last thing JARVIS said this session, or '' if nothing yet. */
  lastAnswer: string
  volume: VolumeState
  timers: TimerView[]
  /** Whether a finished timer is ringing right now. */
  ringing: boolean
  locale?: string
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
}

const pct = (v: number) => `${Math.round(v * 100)} percent`

export function answerReflex(r: Reflex, ctx: ReflexContext): ReflexAnswer {
  const locale = ctx.locale ?? 'en-GB'
  const soonest = [...ctx.timers].sort((a, b) => a.endsAt - b.endsAt)
  const left = (t: TimerView) => speakDuration(Math.max(0, t.endsAt - ctx.now.getTime()))

  switch (r.kind) {
    case 'stop':
      return { say: null, then: 'dormant', silence: true }

    case 'time':
      return { say: `It's ${speakTime(ctx.now, locale)}.`, then: 'listen' }

    case 'date':
      return { say: `It's ${speakDate(ctx.now, locale)}.`, then: 'listen' }

    case 'repeat':
      return ctx.lastAnswer.trim()
        ? { say: ctx.lastAnswer, then: 'listen' }
        : { say: "I haven't said anything yet, sir.", then: 'listen' }

    case 'volume': {
      const v = nextVolume(ctx.volume, r.op, r.level)
      // Muting says so first, at the old volume; there is nothing to hear after.
      if (v.muted) return { say: 'Muted. Say "unmute" to hear me again.', then: 'listen', volume: v }
      if (r.op === 'up' && ctx.volume.level >= 1 && !ctx.volume.muted) {
        return { say: "That's as loud as I go, sir.", then: 'listen', volume: v }
      }
      if (r.op === 'down' && ctx.volume.level <= VOLUME_FLOOR && !ctx.volume.muted) {
        return { say: 'That is as quiet as I go. Say "mute" for silence.', then: 'listen', volume: v }
      }
      return { say: `Volume ${pct(v.level)}.`, then: 'listen', volume: v }
    }

    case 'timer-set': {
      if (ctx.timers.length >= MAX_TIMERS) {
        return { say: `You already have ${MAX_TIMERS} timers running, sir. Cancel one first.`, then: 'listen' }
      }
      const name = r.label ? ` for ${r.label.replace(/^(?:the|my)\s+/, 'the ')}` : ''
      return {
        say: `Timer set for ${speakDuration(r.ms)}${name}.`,
        then: 'listen',
        startTimer: r.label ? { ms: r.ms, label: r.label } : { ms: r.ms },
      }
    }

    case 'timer-cancel': {
      if (!ctx.timers.length) {
        return ctx.ringing
          ? { say: null, then: 'listen', silence: true }
          : { say: 'There are no timers running.', then: 'listen' }
      }
      if (r.label) {
        const want = r.label.replace(/^(?:the|my)\s+/, '')
        const hit = soonest.filter((t) => t.label?.replace(/^(?:the|my)\s+/, '') === want)
        if (!hit.length) return { say: `I can't find a ${want} timer.`, then: 'listen' }
        return { say: `Cancelled ${timerName(hit[0])}.`, then: 'listen', cancelTimers: hit.map((t) => t.id), silence: ctx.ringing }
      }
      if (r.all || ctx.timers.length === 1) {
        const n = ctx.timers.length
        return {
          say: n === 1 ? `Cancelled ${timerName(ctx.timers[0])}.` : `Cancelled all ${n} timers.`,
          then: 'listen',
          cancelTimers: ctx.timers.map((t) => t.id),
          silence: ctx.ringing,
        }
      }
      // Several running and none named: the one that would ring next.
      const t = soonest[0]
      const rest = ctx.timers.length - 1
      return {
        say: `Cancelled ${timerName(t)}. ${rest === 1 ? 'One other timer is' : `${rest} other timers are`} still running.`,
        then: 'listen',
        cancelTimers: [t.id],
        silence: ctx.ringing,
      }
    }

    case 'timer-query': {
      if (!soonest.length) return { say: 'There are no timers running.', then: 'listen' }
      if (soonest.length === 1) return { say: `${left(soonest[0])} left on ${timerName(soonest[0])}.`, then: 'listen' }
      const lines = soonest.slice(0, 3).map((t) => `${timerName(t)}: ${left(t)}`)
      const more = soonest.length > 3 ? `, and ${soonest.length - 3} more` : ''
      return { say: `${soonest.length} timers. ${lines.join('; ')}${more}.`.replace(/^(\d+ timers\. )the/, '$1The'), then: 'listen' }
    }
  }
}

/** What JARVIS says when a timer finishes. */
export function timerDoneLine(t: { ms: number; label?: string }): string {
  const name = timerName(t)
  return `Sir, ${name} is done.`
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
