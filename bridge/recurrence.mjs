/**
 * Repeating calendar events for the briefing (plan 12 block 5, task Q78).
 *
 * The Google Calendar connector (C07) stores a repeating event as ONE
 * document for the whole series, with its repeat rule on a "Repeats:" line
 * (RRULE / EXDATE, RFC 5545), plus a document for each occurrence that was
 * moved or cancelled. This file answers one question: does the series have an
 * occurrence on a given local day, and when does it start?
 *
 * Supported: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL,
 * BYDAY (with ordinals like 2TU or -1FR for monthly and yearly), BYMONTHDAY,
 * BYMONTH and WKST; EXDATE. Anything else (BYSETPOS, BYWEEKNO, BYYEARDAY,
 * HOURLY and finer, RDATE) makes the rule "unknown", and an unknown rule never
 * produces an occurrence: missing a meeting in the briefing is better than
 * inventing one.
 *
 * Times: an occurrence keeps the series' wall-clock start in the bridge
 * computer's time zone. That is exact when the event's zone is the computer's
 * zone (the usual case) and can be an hour out across a daylight-saving
 * change in another zone.
 *
 * Pure: no I/O, no clock. Days are local calendar dates ("YYYY-MM-DD").
 */

const DAY_MS = 86_400_000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
/** How far COUNT is followed from the first occurrence. */
const MAX_COUNT_DAYS = 3700
const MAX_RULE = 300

const pad = (n) => String(n).padStart(2, '0')

/** "YYYY-MM-DD" → { y, m (0-11), d }, or null. */
function ymd(s) {
  if (typeof s !== 'string' || !DATE_ONLY.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return { y, m: m - 1, d }
}

const dayNumber = ({ y, m, d }) => Math.round(Date.UTC(y, m, d) / DAY_MS)
const fromDayNumber = (n) => {
  const t = new Date(n * DAY_MS)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() }
}
const weekday = (day) => new Date(Date.UTC(day.y, day.m, day.d)).getUTCDay()
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

/** The local date of a timestamp as "YYYY-MM-DD". */
const localDateOf = (ms) => {
  const t = new Date(ms)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/**
 * A DATE or DATE-TIME value from an RRULE or EXDATE ("20261102",
 * "20261102T090000", "20261102T090000Z") as `{ date, ms? }`: the local date
 * it falls on, and for a UTC time the instant.
 */
function icalDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(v).trim())
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  if (!ymd(date)) return null
  if (m[4] === undefined) return { date }
  if (m[7]) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
    return { date: localDateOf(ms), ms }
  }
  // A floating or TZID time: taken as local wall-clock time.
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  return { date, ms }
}

const BYDAY = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/
const KNOWN = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'])
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

/**
 * Parses the strings of a series' "Repeats:" line (or a recurrence array):
 * `{ rule, exdates }`, where `rule` is null when there is no rule this file
 * understands. Never throws.
 */
export function parseRecurrence(lines) {
  const out = { rule: null, exdates: new Set(), unknown: false }
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (typeof raw !== 'string' || raw.length > MAX_RULE) continue
    const line = raw.trim()
    if (/^EXDATE[;:]/i.test(line)) {
      const values = line.slice(line.indexOf(':') + 1).split(',')
      for (const v of values) {
        const d = icalDate(v)
        if (d) out.exdates.add(d.date)
      }
      continue
    }
    if (!/^RRULE:/i.test(line)) continue
    if (out.rule) {
      out.unknown = true // two rules: not something we expand
      continue
    }
    const parts = {}
    for (const p of line.slice(6).split(';')) {
      const [k, v] = p.split('=')
      if (!k || v === undefined) continue
      parts[k.toUpperCase()] = v.toUpperCase()
    }
    if (!FREQS.has(parts.FREQ) || Object.keys(parts).some((k) => !KNOWN.has(k))) {
      out.unknown = true
      continue
    }
    const rule = { freq: parts.FREQ, interval: 1, wkst: 1 }
    if (parts.INTERVAL !== undefined) {
      const n = Number(parts.INTERVAL)
      if (!Number.isInteger(n) || n < 1 || n > 1000) { out.unknown = true; continue }
      rule.interval = n
    }
    if (parts.COUNT !== undefined) {
      const n = Number(parts.COUNT)
      if (!Number.isInteger(n) || n < 1) { out.unknown = true; continue }
      rule.count = n
    }
    if (parts.UNTIL !== undefined) {
      const u = icalDate(parts.UNTIL)
      if (!u) { out.unknown = true; continue }
      rule.until = u
    }
    if (parts.WKST !== undefined) {
      const i = WEEKDAYS.indexOf(parts.WKST)
      if (i < 0) { out.unknown = true; continue }
      rule.wkst = i
    }
    if (parts.BYDAY !== undefined) {
      const days = parts.BYDAY.split(',').map((x) => BYDAY.exec(x))
      if (days.some((x) => !x)) { out.unknown = true; continue }
      rule.byday = days.map((x) => ({ n: x[1] ? Number(x[1]) : 0, wd: WEEKDAYS.indexOf(x[2]) }))
      // An ordinal ("2TU") only means something monthly or yearly.
      if (rule.byday.some((b) => b.n !== 0) && (rule.freq === 'DAILY' || rule.freq === 'WEEKLY')) { out.unknown = true; continue }
    }
    if (parts.BYMONTHDAY !== undefined) {
      const days = parts.BYMONTHDAY.split(',').map(Number)
      if (days.some((n) => !Number.isInteger(n) || n === 0 || n < -31 || n > 31)) { out.unknown = true; continue }
      rule.bymonthday = days
    }
    if (parts.BYMONTH !== undefined) {
      const months = parts.BYMONTH.split(',').map(Number)
      if (months.some((n) => !Number.isInteger(n) || n < 1 || n > 12)) { out.unknown = true; continue }
      rule.bymonth = months.map((n) => n - 1)
    }
    out.rule = rule
  }
  if (out.unknown) out.rule = null
  return out
}

/** Whether `day` is the n-th (or, negative, n-th from last) `wd` of its month. */
function nthWeekdayOfMonth(day, n) {
  if (n > 0) return Math.ceil(day.d / 7) === n
  return Math.ceil((daysInMonth(day.y, day.m) - day.d + 1) / 7) === -n
}

/** Day-of-month matches, counting negative days from the end of the month. */
function monthDayMatches(day, list) {
  const last = daysInMonth(day.y, day.m)
  return list.some((n) => (n > 0 ? day.d === n : day.d === last + n + 1))
}

/** Whether the rule's pattern (not COUNT/UNTIL) puts an occurrence on `day`. */
function patternMatches(rule, start, day) {
  const wd = weekday(day)
  const days = dayNumber(day) - dayNumber(start)
  if (days < 0) return false
  if (days === 0) return true // the first occurrence is always the start
  const bydayPlain = rule.byday?.filter((b) => b.n === 0).map((b) => b.wd)
  switch (rule.freq) {
    case 'DAILY':
      if (days % rule.interval) return false
      if (rule.bymonth && !rule.bymonth.includes(day.m)) return false
      if (rule.bymonthday && !monthDayMatches(day, rule.bymonthday)) return false
      return !rule.byday || bydayPlain.includes(wd)
    case 'WEEKLY': {
      const weekStart = (x) => dayNumber(x) - ((weekday(x) - rule.wkst + 7) % 7)
      const weeks = Math.round((weekStart(day) - weekStart(start)) / 7)
      if (weeks % rule.interval) return false
      if (rule.bymonth && !rule.bymonth.includes(day.m)) return false
      return (rule.byday ? bydayPlain : [weekday(start)]).includes(wd)
    }
    case 'MONTHLY': {
      const months = (day.y - start.y) * 12 + (day.m - start.m)
      if (months % rule.interval) return false
      if (rule.bymonth && !rule.bymonth.includes(day.m)) return false
      return dayInMonthMatches(rule, start, day, wd)
    }
    case 'YEARLY': {
      const years = day.y - start.y
      if (years % rule.interval) return false
      const months = rule.bymonth ?? [start.m]
      if (!months.includes(day.m)) return false
      return dayInMonthMatches(rule, start, day, wd)
    }
    default:
      return false
  }
}

function dayInMonthMatches(rule, start, day, wd) {
  if (rule.bymonthday && !monthDayMatches(day, rule.bymonthday)) return false
  if (rule.byday) return rule.byday.some((b) => b.wd === wd && (b.n === 0 || nthWeekdayOfMonth(day, b.n)))
  if (rule.bymonthday) return true
  return day.d === start.d
}

/**
 * Whether a series that started on `startDate` (its first occurrence, local
 * "YYYY-MM-DD") has an occurrence on `onDate`. `startMs` is the first
 * occurrence's start instant for a timed event (used for a timed UNTIL),
 * undefined for an all-day one.
 */
export function occursOn(recurrence, { startDate, onDate, startMs }) {
  const { rule, exdates } = recurrence ?? {}
  if (!rule) return false
  const start = ymd(startDate)
  const day = ymd(onDate)
  if (!start || !day) return false
  if (exdates?.has(onDate)) return false
  if (!patternMatches(rule, start, day)) return false
  if (rule.until) {
    if (rule.until.ms !== undefined && Number.isFinite(startMs)) {
      const s = new Date(startMs)
      const at = new Date(day.y, day.m, day.d, s.getHours(), s.getMinutes(), s.getSeconds()).getTime()
      if (at > rule.until.ms) return false
    } else if (onDate > rule.until.date) {
      return false
    }
  }
  if (rule.count !== undefined) {
    const from = dayNumber(start)
    const to = dayNumber(day)
    if (to - from > MAX_COUNT_DAYS) return false
    let n = 0
    // EXDATEs still count towards COUNT (RFC 5545), so they are not skipped here.
    for (let i = from; i <= to; i++) {
      if (patternMatches(rule, start, fromDayNumber(i))) n++
      if (n > rule.count) return false
    }
  }
  return true
}

/**
 * The repeat lines of a stored calendar document: `meta.recurrence` when the
 * connector provides it, otherwise the "Repeats:" line among the header lines
 * the C07 connector writes before the description (a blank line ends them, so
 * a description can never add a rule). Only lines that look like RRULE or
 * EXDATE values are returned.
 */
export function recurrenceLines(doc) {
  if (Array.isArray(doc?.meta?.recurrence)) return doc.meta.recurrence.filter((r) => typeof r === 'string').slice(0, 5)
  const text = String(doc?.text ?? '')
  const lines = text.split('\n')
  let i = 0
  if (/^<untrusted_data\b/.test(lines[0] ?? '')) i = 1
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) break
    if (!l.startsWith('Repeats: ')) continue
    const rules = l.slice(9).split('; ').map((r) => r.trim())
    if (rules.every((r) => /^(?:RRULE|EXDATE)[;:][A-Za-z0-9=;:,/_+\-.]+$/.test(r))) return rules.slice(0, 5)
    return []
  }
  return []
}
