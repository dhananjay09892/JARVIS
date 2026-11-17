/**
 * Plain words for scheduled missions (plan 13 phase 7; task Q129).
 *
 * The owner says or picks "every Friday at 4 pm"; the schedule store keeps a
 * 5-field cron string. This module goes both ways and is the one place that
 * knows how:
 *
 *   - `cronFromWhen`   a picker choice ({ every, day, time, ... }) → cron
 *   - `parseWhenWords` spoken or typed words → a picker choice
 *   - `describeCron`   a cron string → words (or "custom schedule")
 *
 * It only builds a cron string. Whether that cron is allowed (not more often
 * than every 15 minutes, at most 20 schedules) is still decided by
 * `checkSchedule` in mission-schedule.mjs, so nothing here can loosen a rule.
 * No imports, no clock: pure, so it is tested without a machine.
 */

export const DAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'])
const DAY_ABBR = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 }
export const EVERY = Object.freeze(['day', 'weekday', 'weekend', 'week', 'month', 'hours'])

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const int = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN)

function dayIndex(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6) return v
  if (typeof v !== 'string') return -1
  const w = v.trim().toLowerCase().replace(/s$/, '')
  const full = DAYS.indexOf(w)
  if (full >= 0) return full
  return w in DAY_ABBR ? DAY_ABBR[w] : /^[0-6]$/.test(w) ? Number(w) : -1
}

/** "16:00", "4pm", "4:30 pm", "09:05" → { h, m } or null. */
export function parseTime(v) {
  if (typeof v !== 'string') return null
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(v)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  const ap = m[3]?.toLowerCase().replace(/\./g, '')
  if (min > 59) return null
  if (ap) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (ap === 'pm' ? 12 : 0)
  } else if (h > 23) return null
  return { h, m: min }
}

/**
 * A picker choice → a cron string, or a reason the owner can read.
 * `{ every: 'week', day: 'friday', time: '16:00' }`, `{ every: 'day', time: '9:00' }`,
 * `{ every: 'weekday' | 'weekend', time }`, `{ every: 'month', dayOfMonth: 1, time }`,
 * `{ every: 'hours', hours: 2 }`.
 */
export function cronFromWhen(when) {
  if (!when || typeof when !== 'object') return { ok: false, reason: 'Say when it should run.' }
  const every = typeof when.every === 'string' ? when.every.trim().toLowerCase() : ''
  if (!EVERY.includes(every)) return { ok: false, reason: `Pick how often: ${EVERY.join(', ')}.` }
  if (every === 'hours') {
    const n = int(when.hours)
    if (!Number.isInteger(n) || n < 1 || n > 12) return { ok: false, reason: 'Hours must be a whole number from 1 to 12.' }
    return { ok: true, cron: n === 1 ? '0 * * * *' : `0 */${n} * * *` }
  }
  const t = parseTime(when.time)
  if (!t) return { ok: false, reason: 'The time is not understood. Use something like 16:00 or 4 pm.' }
  const at = `${t.m} ${t.h}`
  if (every === 'day') return { ok: true, cron: `${at} * * *` }
  if (every === 'weekday') return { ok: true, cron: `${at} * * 1-5` }
  if (every === 'weekend') return { ok: true, cron: `${at} * * 0,6` }
  if (every === 'week') {
    const d = dayIndex(when.day)
    if (d < 0) return { ok: false, reason: 'Pick a day of the week.' }
    return { ok: true, cron: `${at} * * ${d}` }
  }
  const dom = int(when.dayOfMonth)
  // Up to the 28th, so the day exists in every month and nothing is silently skipped.
  if (!Number.isInteger(dom) || dom < 1 || dom > 28) return { ok: false, reason: 'The day of the month must be from 1 to 28.' }
  return { ok: true, cron: `${at} ${dom} * *` }
}

const ORDINAL = /^(\d{1,2})(?:st|nd|rd|th)?$/

/**
 * Words → a picker choice (English), or a reason. Understands "every Friday at
 * 4 pm", "every day at 9", "weekdays at 8:30", "on weekends at 10",
 * "every month on the 1st at 10 am", "every 2 hours", "hourly".
 */
export function parseWhenWords(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'Say when it should run, for example "every Friday at 4 pm".' }
  const s = text.trim().toLowerCase().replace(/[,.;]+$/g, '').replace(/\s+/g, ' ')
  const bad = { ok: false, reason: `I did not understand "${s.slice(0, 60)}". Try "every Friday at 4 pm", "every day at 9" or "weekdays at 8:30".` }
  if (s === 'hourly' || s === 'every hour') return { ok: true, when: { every: 'hours', hours: 1 } }
  const hrs = /^every (\d{1,2}) hours?$/.exec(s)
  if (hrs) return { ok: true, when: { every: 'hours', hours: Number(hrs[1]) } }
  const m = /^(.*?)(?: at ([0-9:.]+ ?(?:[ap]\.?m\.?)?))?$/.exec(s)
  const head = m[1].trim()
  const time = m[2]?.trim()
  if (!time) return bad
  const sched = head.replace(/^(every|each|on) /, '').replace(/^the /, '')
  if (sched === 'day' || sched === 'daily' || sched === 'morning' || sched === 'evening') return { ok: true, when: { every: 'day', time } }
  if (sched === 'weekday' || sched === 'weekdays') return { ok: true, when: { every: 'weekday', time } }
  if (sched === 'weekend' || sched === 'weekends') return { ok: true, when: { every: 'weekend', time } }
  const dayWord = sched.replace(/s$/, '')
  if (dayIndex(dayWord) >= 0 && /^[a-z]+$/.test(dayWord)) return { ok: true, when: { every: 'week', day: dayWord, time } }
  const mo = /^month (?:on )?(?:the )?(.+)$/.exec(sched) ?? /^(?:the )?(.+?) of (?:the |every |each )?month$/.exec(sched)
  if (mo) {
    const o = ORDINAL.exec(mo[1].trim())
    if (o) return { ok: true, when: { every: 'month', dayOfMonth: Number(o[1]), time } }
  }
  return bad
}

const clock12 = (h, m) => `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10]}`

/** A cron string → words. A cron the picker could not have made reads "custom schedule (…)". */
export function describeCron(cron) {
  const f = typeof cron === 'string' ? cron.trim().split(/\s+/) : []
  const custom = `custom schedule (${String(cron ?? '').slice(0, 60)})`
  if (f.length !== 5) return custom
  const [mi, h, dom, mon, dow] = f
  if (mon !== '*') return custom
  if (mi === '0' && dom === '*' && dow === '*') {
    if (h === '*') return 'every hour'
    const r = /^\*\/(\d{1,2})$/.exec(h)
    if (r) return `every ${r[1]} hours`
  }
  if (!/^\d{1,2}$/.test(mi) || !/^\d{1,2}$/.test(h) || Number(mi) > 59 || Number(h) > 23) return custom
  const at = clock12(Number(h), Number(mi))
  if (dom === '*') {
    if (dow === '*') return `every day at ${at}`
    if (dow === '1-5') return `every weekday at ${at}`
    if (dow === '0,6' || dow === '6,0') return `every weekend at ${at}`
    if (/^[0-6]$/.test(dow)) return `every ${cap(DAYS[Number(dow)])} at ${at}`
    return custom
  }
  if (dow === '*' && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) return `every month on the ${ordinal(Number(dom))} at ${at}`
  return custom
}

/** What a saved schedule waits for, in words: its cron, or its event. */
export function describeSchedule(s) {
  if (s?.cron) return describeCron(s.cron)
  if (s?.topic === 'meeting.ended') return 'when a meeting ends'
  return s?.topic ? `when "${s.topic}" happens` : 'never'
}

/**
 * A create request from the page or the voice tool → the `{ title, goal, cron | topic }`
 * `checkSchedule` takes. `when` may be a picker object or words; `cron` and
 * `topic` pass through unchanged. Returns `{ ok: false, reason }` when the
 * words are not understood.
 */
export function resolveRequest(input) {
  const { when, ...rest } = input ?? {}
  if (when === undefined || when === null || when === '') return { ok: true, request: rest }
  if (rest.cron || rest.topic) return { ok: false, reason: 'Give one way to say when: words, a schedule or an event.' }
  let pick = when
  if (typeof when === 'string') {
    const p = parseWhenWords(when)
    if (!p.ok) return p
    pick = p.when
  }
  const c = cronFromWhen(pick)
  return c.ok ? { ok: true, request: { ...rest, cron: c.cron } } : c
}
