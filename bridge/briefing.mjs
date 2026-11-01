/**
 * The morning briefing (plan 12 building block 5, task Q34): morning template
 * only, from whatever connectors are set up.
 *
 *   "Good morning. It's Sunday, the 1st of November.
 *    In London it's 9 degrees and partly cloudy. Today, light rain, 5 to 11
 *    degrees, 80 percent chance of rain. Worth taking an umbrella.
 *    You have 3 things today: stand-up at 09:30, lunch with Sam at 13:00 …
 *    4 new emails, 1 marked important.
 *    Overnight: the nightly backup workflow failed. 2 background tasks finished."
 *
 * The briefing is a list of short sections (greeting, weather, calendar, mail,
 * overnight, held). The page speaks them one at a time, so "skip" moves to
 * the next section and "stop" or "skip the briefing" ends it (src/lib/reflex.ts).
 *
 * Where each section comes from:
 *   weather    the weather connector's two documents (C16) in the local store
 *   calendar   Google Calendar documents (C07) whose start is today, local time;
 *              cancelled entries and ones you declined are left out
 *   mail       Gmail (C06) or Gmail over IMAP (C09) documents that arrived in
 *              the window; sent mail and drafts left out. Counts only unless
 *              Settings → Alerts → "Say who mail is from" is on, because the
 *              briefing is spoken aloud and anyone in the room hears it
 *   overnight  `workflow.finished` and `task.finished` on the event bus (Q32),
 *              kept in memory here. Private task titles are never spoken,
 *              only counted
 *   held       alerts the notification policy (Q33) is holding, raised in the
 *              window. Private ones are counted, not read out
 *
 * "The window" is since the last briefing, or the last 18 hours, whichever is
 * shorter. Nothing here goes to a model: the text is built from plain rules
 * and read out by the page. Connector text is untrusted; it is only ever
 * clipped and spoken, never followed.
 *
 * Language (Q78): the briefing is said in English, Hindi or Gujarati, in the
 * script the owner's language profile asks for (briefing-words.mjs). The page
 * sends the reply language it worked out for the request (plan 28).
 *
 * Repeating events (Q78): the calendar connector stores a series as one
 * document with its repeat rule; recurrence.mjs works out whether the series
 * has an occurrence today. A moved or cancelled occurrence has its own
 * document, which wins over the series.
 *
 * A set time (Q78): Settings → Alerts → "Offer the briefing at"
 * (JARVIS_BRIEFING_TIME, off by default). From that time on, the first time
 * he is woken that day he offers the briefing instead of his usual "Yes,
 * sir?" (`offer()`), once a day, and only when the notification policy would
 * let a normal alert out right now, so never during quiet hours.
 *
 * Off switch: Settings → Alerts → Morning briefing (JARVIS_BRIEFING). Metric
 * (16): `stats()` counts briefings, offers and sections given, never any content.
 *
 * Like notify-policy.mjs this uses only Node built-ins, so it is tested alone.
 */

import { briefingWords, BRIEFING_LANGS, safeLocale } from './briefing-words.mjs'
import { occursOn, parseRecurrence, recurrenceLines } from './recurrence.mjs'
import { decide, parseQuietHours, DEFAULT_QUIET_HOURS } from './notify-policy.mjs'

export { safeLocale }

export const SECTIONS = Object.freeze(['greeting', 'weather', 'calendar', 'mail', 'overnight', 'held', 'nothing'])

/** How far back "overnight" reaches when there was no briefing since. */
export const WINDOW_MS = 18 * 3600_000
/** Bus events kept for the overnight section. */
const MAX_EVENTS = 50
/** Calendar documents read per briefing (newest change first). */
const MAX_CALENDAR_DOCS = 500
const MAX_MAIL_DOCS = 200
const MAX_TITLE = 80

const CALENDAR_CONNECTORS = ['gcalendar']
const MAIL_CONNECTORS = ['gmail', 'gmail_imap', 'imap']

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Untrusted text made safe to say: no control or hidden characters, one line, clipped. */
export function clip(text, max = MAX_TITLE) {
  const s = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, ' ')
    .replace(/[<>{}[\]`*_#|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}…`
}

const pad = (n) => String(n).padStart(2, '0')

/** Local calendar date of `ts` as YYYY-MM-DD. */
export function localDate(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight at the start and end of the day `ts` falls in. */
export function localDay(ts) {
  const d = new Date(ts)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return { start, end, date: localDate(ts) }
}

const EN = briefingWords('en')

/** "Sunday, the 1st of November", read the same by every voice. */
export function speakDate(ts) {
  return EN.hello(ts).replace(/^[^.]+\. It's /, '').replace(/\.$/, '')
}

/** "09:30" or "9:30 AM", in the page's clock style. */
export function speakTime(ts, locale) {
  return EN.time(ts, locale)
}

/** "a", "b and c", "a, b and c". */
export const listing = EN.list

// ---------------------------------------------------------------------------
// Weather (C16 documents)
// ---------------------------------------------------------------------------

const NUM = '(-?\\d+(?:\\.\\d+)?|\\?)'
const CURRENT_LINE = new RegExp(`^Weather in (.+?) at .+?: ([^,]+), ${NUM}(?: (°[CF]))? \\(feels like`)
const DAY_LINE = new RegExp(`^\\w{3} (\\d{4}-\\d{2}-\\d{2}): ([^,]+), ${NUM}–${NUM}(?: (°[CF]))?, chance of rain ${NUM}%`)
const num = (s) => (s === undefined || s === '?' ? null : Math.round(Number(s)))

/**
 * Reads the weather connector's `current` and `forecast` documents (the
 * lines weather.mjs writes). Returns null when there is nothing usable.
 */
export function readWeather(docs, { now }) {
  const byId = new Map((docs ?? []).filter(isObject).map((d) => [d.id, d]))
  const out = {}
  const cur = byId.get('current')
  const m = cur && CURRENT_LINE.exec(String(cur.text ?? ''))
  if (m) {
    out.place = clip(m[1], 60)
    out.now = { conditions: clip(m[2], 40).toLowerCase(), temperature: num(m[3]), unit: m[4] ?? '' }
  }
  const fc = byId.get('forecast')
  if (fc) {
    const today = localDate(now)
    const days = String(fc.text ?? '').split('\n').map((l) => DAY_LINE.exec(l)).filter(Boolean)
    const d = days.find((x) => x[1] === today) ?? null
    if (d) {
      out.today = { conditions: clip(d[2], 40).toLowerCase(), low: num(d[3]), high: num(d[4]), unit: d[5] ?? '', rainChance: num(d[6]) }
    }
    if (!out.place && isObject(fc.meta) && typeof fc.meta.place === 'string') out.place = clip(fc.meta.place, 60)
  }
  return out.now || out.today ? out : null
}

function weatherSection(w, { short, t }) {
  const parts = []
  if (w.now && w.now.temperature !== null && !short) {
    parts.push(t.weatherNow(w.place, t.degrees(w.now.temperature, w.now.unit), t.condition(w.now.conditions)))
  }
  if (w.today) {
    const d = w.today
    const ranged = d.low !== null && d.high !== null
    const rain = d.rainChance !== null && d.rainChance >= 20 ? d.rainChance : null
    parts.push(t.weatherToday(t.condition(d.conditions), ranged ? d.low : null, ranged ? t.degrees(d.high, d.unit) : null, rain))
    if (d.rainChance !== null && d.rainChance >= 50) parts.push(t.umbrella)
  } else if (short && w.now && w.now.temperature !== null) {
    parts.push(t.weatherNowShort(t.degrees(w.now.temperature, w.now.unit), t.condition(w.now.conditions)))
  }
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Calendar (C07 documents)
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** The local date an occurrence was originally on ("YYYY-MM-DD"), from `meta.originalStart`. */
function originalDate(v) {
  if (typeof v !== 'string') return null
  if (DATE_ONLY.test(v)) return v
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? localDate(ms) : null
}

/**
 * Where a repeating series' occurrence falls today, or null: `{ start, end }`
 * (end may be NaN), or `{ allDay: true }`. The series document's start is its
 * first occurrence; occurrences keep its wall-clock time and length.
 */
function seriesToday(doc, day) {
  const m = doc.meta
  const recurrence = parseRecurrence(recurrenceLines(doc))
  if (!recurrence.rule) return null
  if (m.allDay === true || DATE_ONLY.test(m.start)) {
    if (!DATE_ONLY.test(m.start) || m.start === day.date) return null // the first one is found as a plain event
    return occursOn(recurrence, { startDate: m.start, onDate: day.date }) ? { allDay: true } : null
  }
  const first = Date.parse(m.start)
  if (!Number.isFinite(first)) return null
  const startDate = localDate(first)
  if (startDate === day.date) return null
  if (!occursOn(recurrence, { startDate, onDate: day.date, startMs: first })) return null
  const f = new Date(first)
  const d = new Date(day.start)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), f.getHours(), f.getMinutes(), f.getSeconds()).getTime()
  const firstEnd = typeof m.end === 'string' ? Date.parse(m.end) : NaN
  return { start, end: Number.isFinite(firstEnd) ? start + (firstEnd - first) : NaN }
}

/**
 * Today's calendar entries that are still to come or under way, soonest
 * first: `{ title, allDay, start }`. Cancelled entries and ones you declined
 * are left out. A repeating series counts on each day its rule gives (Q78),
 * except on a day where one of its occurrences was moved or cancelled: that
 * occurrence has its own document, which is used instead.
 */
export function todaysEvents(docs, { now }) {
  const day = localDay(now)
  const out = []
  const list = (docs ?? []).filter((d) => isObject(d) && isObject(d.meta))
  // Occurrences of a series that were moved or cancelled, by "<calendar>|<series id>|<original date>".
  const replaced = new Set()
  for (const d of list) {
    const m = d.meta
    if (typeof m.recurringEventId !== 'string') continue
    const was = originalDate(m.originalStart)
    if (was) replaced.add(`${m.calendarId ?? ''}|${m.recurringEventId}|${was}`)
  }
  const seriesKey = (d) => {
    const id = String(d.id ?? '')
    return `${d.meta.calendarId ?? ''}|${id.slice(id.lastIndexOf('/') + 1)}|${day.date}`
  }
  const still = (start, endMs) => !(Number.isFinite(endMs) ? endMs <= now : start < now - 3600_000)

  for (const d of list) {
    const m = d.meta
    if (m.status === 'cancelled' || m.myResponse === 'declined' || typeof m.start !== 'string') continue
    if (/^Cancelled:/.test(String(d.title ?? ''))) continue
    const title = clip(d.title) || 'an untitled event'
    if (typeof m.recurringEventId !== 'string' && !replaced.has(seriesKey(d))) {
      const occ = seriesToday(d, day)
      if (occ?.allDay) {
        out.push({ title, allDay: true, start: day.start })
        continue
      }
      if (occ) {
        if (still(occ.start, occ.end)) out.push({ title, allDay: false, start: occ.start })
        continue
      }
    }
    if (m.allDay === true || DATE_ONLY.test(m.start)) {
      if (!DATE_ONLY.test(m.start)) continue
      // All-day ends are exclusive dates: a one-day event on the 1st ends on the 2nd.
      const endDate = typeof m.end === 'string' && DATE_ONLY.test(m.end) ? m.end : null
      const on = endDate ? m.start <= day.date && day.date < endDate : m.start === day.date
      if (on) out.push({ title, allDay: true, start: day.start })
      continue
    }
    const start = Date.parse(m.start)
    if (!Number.isFinite(start) || start < day.start || start >= day.end) continue
    const endMs = typeof m.end === 'string' ? Date.parse(m.end) : NaN
    if (!still(start, endMs)) continue
    out.push({ title, allDay: false, start })
  }
  return out.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.start - b.start || a.title.localeCompare(b.title)))
}

function calendarSection(events, { short, locale, t }) {
  if (!events.length) return t.calendarNone
  const shown = events.slice(0, short ? 2 : 5)
  const said = shown.map((e) => (e.allDay ? t.allDay(e.title) : t.at(e.title, t.time(e.start, locale))))
  const more = events.length - shown.length
  if (events.length === 1) return t.calendarOne(said[0])
  return t.calendarMany(events.length, more ? [...said, t.moreItems(more)] : said)
}

// ---------------------------------------------------------------------------
// Mail (C06 / C09 documents)
// ---------------------------------------------------------------------------

/** The name part of "Sam Lee <sam@example.com>", or the address. */
const senderName = (author) => {
  const s = String(author ?? '')
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]*>\s*$/.exec(s)
  return clip(m ? m[1] : s, 40)
}

/** New mail in the window: `{ count, important, senders }`. Sent mail and drafts left out. */
export function readMail(docs) {
  let count = 0
  let important = 0
  const senders = []
  for (const d of docs ?? []) {
    if (!isObject(d)) continue
    const labels = String(d.meta?.labels ?? '').toUpperCase().split(',').map((l) => l.trim())
    if (labels.includes('SENT') || labels.includes('DRAFT') || labels.includes('SPAM') || labels.includes('TRASH')) continue
    count++
    if (labels.includes('IMPORTANT') || labels.includes('STARRED')) important++
    const who = senderName(d.author)
    if (who && !senders.includes(who)) senders.push(who)
  }
  return { count, important, senders }
}

function mailSection(mail, { short, detail, t }) {
  if (!mail.count) return short ? '' : t.mailNone
  let senders = null
  if (detail && !short && mail.senders.length) {
    const shown = mail.senders.slice(0, 3)
    senders = { shown, more: mail.senders.length - shown.length }
  }
  return t.mail(mail.count, mail.important, senders)
}

// ---------------------------------------------------------------------------
// Overnight jobs (bus events) and held alerts
// ---------------------------------------------------------------------------

function overnightSection(events, { short, t }) {
  const workflows = events.filter((e) => e.kind === 'workflow')
  const tasks = events.filter((e) => e.kind === 'task')
  if (!workflows.length && !tasks.length) return ''
  const parts = []
  const failedFlows = workflows.filter((w) => w.status === 'failed')
  if (failedFlows.length) parts.push(t.workflowsFailed([...new Set(failedFlows.map((w) => w.name))].slice(0, 3)))
  const okFlows = workflows.length - failedFlows.length
  if (okFlows && !short) parts.push(t.workflowsFine(okFlows))
  const bad = tasks.filter((x) => x.status !== 'done')
  const failed = bad.filter((x) => x.status === 'failed')
  const publicFailed = failed.filter((x) => x.sensitivity === 'public').map((x) => x.title)
  if (tasks.length && (!short || bad.length)) {
    parts.push(t.tasks(tasks.length, failed.length, bad.length - failed.length))
    if (publicFailed.length) parts.push(t.failedTitles([...new Set(publicFailed)].slice(0, 3)))
  }
  if (!parts.length) return ''
  return t.overnight(parts)
}

function heldSection(items, { short, t }) {
  if (!items.length) return ''
  const open = items.filter((h) => h.privacy === 'public').map((h) => clip(h.title, 60)).filter(Boolean)
  const hidden = items.length - open.length
  if (short || !open.length) return t.heldCount(items.length, Boolean(hidden) && open.length === 0)
  const shown = open.slice(0, 3)
  return t.heldList(shown, items.length - shown.length, Boolean(hidden))
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/** 'en', 'hi' or 'gu'; English for anything else. */
const langOf = (lang) => (BRIEFING_LANGS.includes(lang) ? lang : 'en')
const scriptOf = (script) => (script === 'roman' ? 'roman' : 'native')

/**
 * Builds the morning briefing. Pure: everything comes in `input`.
 *
 *   now          timestamp (ms); local time decides "today"
 *   weather      weather connector documents, or null when not set up
 *   calendar     calendar documents, or null when no calendar is set up
 *   mail         mail documents from the window, or null when no mail is set up
 *   overnight    `{ kind: 'workflow'|'task', name|title, status, sensitivity? }[]`
 *   held         notifier.held() entries raised in the window
 *   short        "quick briefing": fewer items, no mail senders
 *   mailDetail   say who mail is from (off by default)
 *   locale       the page's locale, for the clock style (English)
 *   lang         'en' | 'hi' | 'gu' (Q78); English when absent
 *   script       'native' | 'roman', how Hindi and Gujarati are written
 *
 * Returns `{ sections: [{ id, say }], empty, lang }`; `empty` when no source
 * had anything (the page still says why).
 */
export function composeMorningBriefing(input) {
  const { now, short = false, mailDetail = false, locale } = input
  const lang = langOf(input.lang)
  const t = briefingWords(lang, scriptOf(input.script))
  const sections = []
  const add = (id, say) => { if (say) sections.push({ id, say }) }

  const w = input.weather ? readWeather(input.weather, { now }) : null
  if (w) add('weather', weatherSection(w, { short, t }))
  if (Array.isArray(input.calendar)) add('calendar', calendarSection(todaysEvents(input.calendar, { now }), { short, locale, t }))
  if (Array.isArray(input.mail)) add('mail', mailSection(readMail(input.mail), { short, detail: mailDetail, t }))
  add('overnight', overnightSection(Array.isArray(input.overnight) ? input.overnight : [], { short, t }))
  add('held', heldSection(Array.isArray(input.held) ? input.held : [], { short, t }))

  const empty = sections.length === 0
  const hello = t.hello(now)
  if (empty) return { empty, lang, sections: [{ id: 'greeting', say: hello }, { id: 'nothing', say: t.nothing }] }
  return { empty, lang, sections: [{ id: 'greeting', say: hello }, ...sections] }
}

// ---------------------------------------------------------------------------
// A set time (Q78)
// ---------------------------------------------------------------------------

/** The JARVIS_BRIEFING_TIME pattern: "HH:MM" local time, or "off". */
export const BRIEFING_TIME_PATTERN = /^(off|([01]\d|2[0-3]):[0-5]\d)$/

/** Minutes since local midnight for a JARVIS_BRIEFING_TIME value, or null for off or malformed. */
export function parseBriefingTime(value) {
  if (typeof value !== 'string' || value === 'off' || !BRIEFING_TIME_PATTERN.test(value)) return null
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

/**
 * The alert the offer stands for when asking the notification policy: a
 * normal, public alert for the household, so it obeys the alerts switch,
 * quiet hours, sleep and "busy" exactly as any other normal alert would.
 */
export const OFFER_NOTIFICATION = Object.freeze({
  id: 'briefing-offer',
  source: 'briefing',
  urgency: 'normal',
  audience: Object.freeze(['household']),
  privacy: 'public',
  title: 'Your briefing is ready',
  body: '',
})

// ---------------------------------------------------------------------------
// The bridge's briefing service
// ---------------------------------------------------------------------------

/**
 * The bridge's briefing: collects overnight events from the bus, reads the
 * connector store and the notifier when asked, and counts what it gave.
 *
 * Options:
 *   store       the connector document store (connectors/store.mjs), or null
 *   bus         the event bus, or null (no overnight section)
 *   notifier    the notifier (notify-policy.mjs), or null (no held section)
 *   enabled     () => boolean, JARVIS_BRIEFING (live)
 *   mailDetail  () => boolean, JARVIS_BRIEFING_MAIL (live)
 *   time        () => string, JARVIS_BRIEFING_TIME (live): "HH:MM" or "off"
 *   quietHours  () => string, JARVIS_QUIET_HOURS, used for the offer only
 *               when there is no notifier (with one, the notifier decides)
 *   now         () => ms
 */
export function createBriefing({
  store = null,
  bus = null,
  notifier = null,
  enabled = () => true,
  mailDetail = () => false,
  time = () => 'off',
  quietHours = () => DEFAULT_QUIET_HOURS,
  now = () => Date.now(),
  log = console,
} = {}) {
  const since0 = new Date(now()).toISOString()
  const events = []
  let lastBriefing = 0
  /** The local date the set-time offer was made (or made unnecessary) on. */
  let offeredOn = null
  const counts = { given: 0, short: 0, empty: 0, off: 0, errors: 0 }
  const offers = { offered: 0, held: 0 }
  const langCounts = Object.fromEntries(BRIEFING_LANGS.map((l) => [l, 0]))
  const sectionCounts = Object.fromEntries(SECTIONS.map((s) => [s, 0]))

  const remember = (e) => {
    events.push(e)
    if (events.length > MAX_EVENTS) events.shift()
  }
  const unsubs = []
  if (bus) {
    unsubs.push(bus.subscribe('workflow.finished', ({ payload: p, ts }) => {
      remember({ kind: 'workflow', name: clip(p.name, 60), status: p.status, at: p.finishedAt ?? ts })
    }))
    unsubs.push(bus.subscribe('task.finished', ({ payload: p }) => {
      remember({ kind: 'task', title: clip(p.title, 60), status: p.status, sensitivity: p.sensitivity, at: p.endedAt })
    }))
  }

  /** Documents of the first of these connectors that has synced, or null when none has. */
  const docsOf = (ids, opts) => {
    if (!store) return null
    let found = null
    for (const id of ids) {
      let state
      try {
        state = store.state(id)
      } catch {
        continue
      }
      const docs = store.recent(id, opts)
      if (state.lastSync === null && !docs.length) continue
      found = [...(found ?? []), ...docs]
    }
    return found
  }

  return {
    /**
     * The morning briefing now, in `lang` ('en' | 'hi' | 'gu') and `script`
     * ('native' | 'roman'). `{ ok: true, sections, empty, lang }`, or
     * `{ ok: false, off: true }` when it is switched off.
     */
    morning({ short = false, locale, lang, script } = {}) {
      if (enabled() === false) {
        counts.off++
        return { ok: false, off: true, reason: 'The morning briefing is switched off in Settings.' }
      }
      const t = now()
      const since = Math.max(t - WINDOW_MS, lastBriefing)
      let input
      try {
        input = {
          now: t,
          short: Boolean(short),
          mailDetail: mailDetail() === true,
          locale: safeLocale(locale),
          lang: langOf(lang),
          script: scriptOf(script),
          weather: docsOf(['weather'], { limit: 5 }),
          calendar: docsOf(CALENDAR_CONNECTORS, { limit: MAX_CALENDAR_DOCS }),
          mail: docsOf(MAIL_CONNECTORS, { since, limit: MAX_MAIL_DOCS, classes: ['messages'] }),
          overnight: events.filter((e) => Number.isFinite(e.at) && e.at >= since),
          held: notifier ? notifier.held().filter((h) => h.heldAt >= since) : [],
        }
      } catch (err) {
        counts.errors++
        log.error?.('[jarvis] briefing could not read its sources:', err?.message ?? String(err))
        return { ok: false, reason: 'I could not put the briefing together.' }
      }
      const out = composeMorningBriefing(input)
      lastBriefing = t
      counts.given++
      if (short) counts.short++
      if (out.empty) counts.empty++
      langCounts[out.lang]++
      for (const s of out.sections) sectionCounts[s.id] = (sectionCounts[s.id] ?? 0) + 1
      return { ok: true, ...out }
    },
    /**
     * Asked by the page when he is woken (Q78): should he offer the briefing
     * instead of his usual greeting? Yes once a day, at the first wake from
     * the set time on, when the notification policy would let a normal alert
     * out now (so never in quiet hours: the offer waits for the first wake
     * after they end). A briefing already given since the set time counts as
     * the offer. `{ offer: true, say, lang }` or `{ offer: false, why }`.
     */
    offer({ lang, script } = {}) {
      const no = (why, extra) => ({ offer: false, why, ...extra })
      if (enabled() === false) return no('off')
      const at = parseBriefingTime(time())
      if (at === null) return no('no-time')
      const t = now()
      const today = localDate(t)
      if (offeredOn === today) return no('already')
      const d = new Date(t)
      const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(at / 60), at % 60).getTime()
      if (t < due) return no('not-yet')
      if (lastBriefing >= due) {
        offeredOn = today
        return no('already')
      }
      let decision
      try {
        decision = typeof notifier?.check === 'function'
          ? notifier.check(OFFER_NOTIFICATION)
          : decide(OFFER_NOTIFICATION, { now: t, quietHours: parseQuietHours(quietHours()) })
      } catch (err) {
        log.error?.('[jarvis] briefing offer could not ask the notification policy:', err?.message ?? String(err))
        return no('error')
      }
      if (decision?.verdict !== 'deliver') {
        offers.held++
        return no('held', { rule: decision?.rule ?? 'unknown' })
      }
      offeredOn = today
      offers.offered++
      const l = langOf(lang)
      return { offer: true, lang: l, say: briefingWords(l, scriptOf(script)).offer(t) }
    },
    /** Counts since the bridge started (plan 16). Never any content. */
    stats() {
      return {
        since: since0,
        ...counts,
        sections: { ...sectionCounts },
        languages: { ...langCounts },
        offers: { ...offers },
        lastAt: lastBriefing || null,
      }
    },
    stop() {
      for (const u of unsubs) u()
    },
  }
}
