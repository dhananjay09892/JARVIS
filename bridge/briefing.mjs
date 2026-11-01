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
 * Off switch: Settings → Alerts → Morning briefing (JARVIS_BRIEFING). Metric
 * (16): `stats()` counts briefings and sections given, never any content.
 *
 * Like notify-policy.mjs this uses only Node built-ins, so it is tested alone.
 */

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
const MAIL_CONNECTORS = ['gmail', 'gmail_imap']

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

/** A BCP 47 tag we can hand to Intl, or the fallback. */
export function safeLocale(locale, fallback = 'en-GB') {
  if (typeof locale !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(locale)) return fallback
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length ? locale : fallback
  } catch {
    return fallback
  }
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

const ordinal = (n) => {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`
}

/** "Sunday, the 1st of November", read the same by every voice. */
export function speakDate(ts) {
  const d = new Date(ts)
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(d)
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(d)
  return `${weekday}, the ${ordinal(d.getDate())} of ${month}`
}

/** "09:30" or "9:30 AM", in the page's clock style. */
export function speakTime(ts, locale) {
  return new Intl.DateTimeFormat(safeLocale(locale), { hour: 'numeric', minute: '2-digit' }).format(new Date(ts))
}

/** "a", "b and c", "a, b and c". */
export function listing(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

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

const degrees = (n, unit) => `${n} degrees${unit === '°F' ? ' Fahrenheit' : ''}`

function weatherSection(w, { short }) {
  const parts = []
  if (w.now && w.now.temperature !== null && !short) {
    parts.push(`${w.place ? `In ${w.place} it's` : "It's"} ${degrees(w.now.temperature, w.now.unit)} and ${w.now.conditions}.`)
  }
  if (w.today) {
    const t = w.today
    const range = t.low !== null && t.high !== null ? `, ${t.low} to ${degrees(t.high, t.unit)}` : ''
    const rain = t.rainChance !== null && t.rainChance >= 20 ? `, ${t.rainChance} percent chance of rain` : ''
    parts.push(`Today, ${t.conditions}${range}${rain}.`)
    if (t.rainChance !== null && t.rainChance >= 50) parts.push('Worth taking an umbrella.')
  } else if (short && w.now && w.now.temperature !== null) {
    parts.push(`It's ${degrees(w.now.temperature, w.now.unit)} and ${w.now.conditions}.`)
  }
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Calendar (C07 documents)
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Today's calendar entries that are still to come or under way, soonest
 * first: `{ title, allDay, start }`. Cancelled entries and ones you declined
 * are left out. Repeating events are only found on the day of their first
 * occurrence until the calendar connector expands them.
 */
export function todaysEvents(docs, { now }) {
  const day = localDay(now)
  const out = []
  for (const d of docs ?? []) {
    if (!isObject(d) || !isObject(d.meta)) continue
    const m = d.meta
    if (m.status === 'cancelled' || m.myResponse === 'declined' || typeof m.start !== 'string') continue
    if (/^Cancelled:/.test(String(d.title ?? ''))) continue
    const title = clip(d.title) || 'an untitled event'
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
    const over = Number.isFinite(endMs) ? endMs <= now : start < now - 3600_000
    if (over) continue
    out.push({ title, allDay: false, start })
  }
  return out.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.start - b.start || a.title.localeCompare(b.title)))
}

function calendarSection(events, { short, locale }) {
  if (!events.length) return 'Nothing else on your calendar today.'
  const shown = events.slice(0, short ? 2 : 5)
  const said = shown.map((e) => (e.allDay ? `${e.title}, all day` : `${e.title} at ${speakTime(e.start, locale)}`))
  const more = events.length - shown.length
  if (events.length === 1) return `One thing on your calendar today: ${said[0]}.`
  return `You have ${events.length} things on your calendar today: ${listing(more ? [...said, `${more} more`] : said)}.`
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

function mailSection(mail, { short, detail }) {
  if (!mail.count) return short ? '' : 'No new email.'
  let s = `${plural(mail.count, 'new email')}`
  if (mail.important) s += `, ${mail.important} marked important`
  if (detail && !short && mail.senders.length) {
    const shown = mail.senders.slice(0, 3)
    const more = mail.senders.length - shown.length
    s += `, from ${listing(more ? [...shown, plural(more, 'other')] : shown)}`
  }
  return `${s}.`
}

// ---------------------------------------------------------------------------
// Overnight jobs (bus events) and held alerts
// ---------------------------------------------------------------------------

function overnightSection(events, { short }) {
  const workflows = events.filter((e) => e.kind === 'workflow')
  const tasks = events.filter((e) => e.kind === 'task')
  if (!workflows.length && !tasks.length) return ''
  const parts = []
  const failedFlows = workflows.filter((w) => w.status === 'failed')
  if (failedFlows.length) {
    const names = [...new Set(failedFlows.map((w) => w.name))].slice(0, 3)
    parts.push(`The ${listing(names)} workflow${names.length > 1 ? 's' : ''} failed.`)
  }
  const okFlows = workflows.length - failedFlows.length
  if (okFlows && !short) parts.push(`${plural(okFlows, 'workflow run')} finished fine.`)
  const bad = tasks.filter((t) => t.status !== 'done')
  const failed = bad.filter((t) => t.status === 'failed')
  const publicFailed = failed.filter((t) => t.sensitivity === 'public').map((t) => t.title)
  if (tasks.length && (!short || bad.length)) {
    let s = `${plural(tasks.length, 'background task')} finished`
    if (bad.length) {
      const counts = []
      if (failed.length) counts.push(`${failed.length} failed`)
      const stopped = bad.length - failed.length
      if (stopped) counts.push(`${stopped} ${stopped === 1 ? 'was' : 'were'} stopped`)
      s += `; ${listing(counts)}`
    }
    parts.push(`${s}.`)
    if (publicFailed.length) parts.push(`Failed: ${listing([...new Set(publicFailed)].slice(0, 3))}.`)
  }
  if (!parts.length) return ''
  return `Overnight: ${parts.join(' ')}`
}

function heldSection(items, { short }) {
  if (!items.length) return ''
  const open = items.filter((h) => h.privacy === 'public').map((h) => clip(h.title, 60)).filter(Boolean)
  const hidden = items.length - open.length
  if (short || !open.length) {
    return `I held back ${plural(items.length, 'alert')}${hidden && open.length === 0 ? '; ask me when you are alone' : ''}.`
  }
  const shown = open.slice(0, 3)
  const more = items.length - shown.length
  const tail = more ? `, and ${plural(more, 'other')}${hidden ? ' I will tell you when you are alone' : ''}` : ''
  return `While you were away: ${listing(shown)}${tail}.`
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

const greetingWord = (ts) => {
  const h = new Date(ts).getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

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
 *   locale       the page's locale, for the clock style
 *
 * Returns `{ sections: [{ id, say }], empty }`; `empty` when no source had
 * anything (the page still says why).
 */
export function composeMorningBriefing(input) {
  const { now, short = false, mailDetail = false, locale } = input
  const sections = []
  const add = (id, say) => { if (say) sections.push({ id, say }) }

  const w = input.weather ? readWeather(input.weather, { now }) : null
  if (w) add('weather', weatherSection(w, { short }))
  if (Array.isArray(input.calendar)) add('calendar', calendarSection(todaysEvents(input.calendar, { now }), { short, locale }))
  if (Array.isArray(input.mail)) add('mail', mailSection(readMail(input.mail), { short, detail: mailDetail }))
  add('overnight', overnightSection(Array.isArray(input.overnight) ? input.overnight : [], { short }))
  add('held', heldSection(Array.isArray(input.held) ? input.held : [], { short }))

  const empty = sections.length === 0
  const hello = `${greetingWord(now)}. It's ${speakDate(now)}.`
  if (empty) {
    return {
      empty,
      sections: [
        { id: 'greeting', say: hello },
        { id: 'nothing', say: "I have nothing to brief you on yet. Set up the weather or your calendar in Settings, under Connectors, and I'll include them." },
      ],
    }
  }
  return { empty, sections: [{ id: 'greeting', say: hello }, ...sections] }
}

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
 *   now         () => ms
 */
export function createBriefing({
  store = null,
  bus = null,
  notifier = null,
  enabled = () => true,
  mailDetail = () => false,
  now = () => Date.now(),
  log = console,
} = {}) {
  const since0 = new Date(now()).toISOString()
  const events = []
  let lastBriefing = 0
  const counts = { given: 0, short: 0, empty: 0, off: 0, errors: 0 }
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
     * The morning briefing now. `{ ok: true, sections, empty }`, or
     * `{ ok: false, off: true }` when it is switched off.
     */
    morning({ short = false, locale } = {}) {
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
      for (const s of out.sections) sectionCounts[s.id] = (sectionCounts[s.id] ?? 0) + 1
      return { ok: true, ...out }
    },
    /** Counts since the bridge started (plan 16). Never any content. */
    stats() {
      return { since: since0, ...counts, sections: { ...sectionCounts }, lastAt: lastBriefing || null }
    },
    stop() {
      for (const u of unsubs) u()
    },
  }
}
