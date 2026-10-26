/**
 * Google Calendar data connector (task C07; plans/connectors/openjarvis/data-connectors/gcalendar).
 *
 * Read-only: the only scopes are `calendar.events.readonly` and
 * `calendar.calendarlist.readonly`, requested through the shared Google OAuth
 * module (google-oauth.mjs, task C04), which also keeps the tokens in this
 * connector's own credential view. Nothing here can create, change, accept or
 * delete an event; that would be a separate `write` capability with its own
 * scope and task.
 *
 * Written fresh against Google's Calendar API v3 reference (checked
 * 2026-10-25), not ported from OpenJarvis:
 *   - Calendars: calendarList.list?minAccessRole=reader. JARVIS reads the
 *     calendars the owner shows in Google Calendar (`selected`) plus the
 *     primary one; hidden, deleted and free/busy-only calendars are left out.
 *   - Full sync per calendar: events.list with timeMin = now − lookback
 *     (default 90 days) and showDeleted=false; Google returns
 *     `nextSyncToken` on the last page.
 *   - Incremental sync: events.list?syncToken=… with none of the parameters
 *     Google forbids beside it (timeMin, timeMax, q, orderBy, updatedMin,
 *     iCalUID, extended properties). Deleted events come back with status
 *     `cancelled`; the adapter yields a deletion marker (task C96) so the
 *     stored copy is removed. One cancelled occurrence of a repeating event
 *     (it has recurringEventId and originalStartTime) is kept as a short
 *     note instead, because the series document still lists that date.
 *   - 410 Gone: the sync token expired or the calendar's sharing changed.
 *     That calendar starts a fresh full sync (once per run).
 *   - Paging: up to 250 events a page (Google's default; max 2500), and at
 *     most `maxPagesPerSync` pages per run across all calendars. The rest wait
 *     in the cursor (the page token) for the next sync instead of being
 *     skipped. 429s, and the 403 rateLimitExceeded / userRateLimitExceeded
 *     Calendar also sends (classified as rate limits since task C08), are
 *     retried with backoff by http.mjs.
 *   - Recurring events are synced as one document for the series (with its
 *     RRULE) plus any changed instances, not one document per occurrence; the
 *     list_events tool expands occurrences (singleEvents=true) when asked.
 *
 * The cursor is a small JSON string
 *   {"v":1,"c":{"<calendarId>":{"s":"<syncToken>","p":"<pageToken>"}}}
 * One entry per calendar: `s` is where incremental sync resumes, `p` is a page
 * still to fetch (in a full sync, or the middle of an incremental one).
 *
 * Mapping (plan 38 Document): id = "<calendarId>/<eventId>", title = summary,
 * author = organizer, createdAt/updatedAt = created/updated, sensitivity
 * `personal`, text = when, where, who, video link, repeat rule, status and
 * the description (HTML reduced to text). Attachments are listed by title,
 * never downloaded. Every field is untrusted: the registry wraps it before
 * anything else sees it.
 */
import { createHttp, ConnectorError } from './http.mjs'
import { createGoogleOAuth, googleSetup } from './google-oauth.mjs'

export const GCAL_HOST = 'www.googleapis.com'
export const GCAL_API = `https://${GCAL_HOST}/calendar/v3`

const MAX_CALENDARS = 25
const PAGE_SIZE = 250
const MAX_DESCRIPTION = 20_000
const MAX_ATTENDEES = 30
const MAX_TOOL_EVENTS = 50
const MAX_WINDOW_MS = 92 * 86_400_000
const DAY = 86_400_000

const CALENDAR_ID = /^[^\s\u0000-\u001f/]{1,200}$/
const EVENT_ID = /^[A-Za-z0-9_@.-]{1,300}$/
const TOKEN = /^[\x21-\x7e]{1,4000}$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v, max = 500) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max) : '')

/** Read the cursor; an empty state when there is none or it is not ours. */
export function parseCalendarCursor(cursor) {
  const empty = { c: {} }
  if (typeof cursor !== 'string' || !cursor || cursor.length > 200_000) return empty
  try {
    const raw = JSON.parse(cursor)
    if (!isObject(raw) || raw.v !== 1 || !isObject(raw.c)) return empty
    const c = {}
    for (const [id, st] of Object.entries(raw.c).slice(0, MAX_CALENDARS)) {
      if (!CALENDAR_ID.test(id) || !isObject(st)) continue
      const entry = {}
      if (typeof st.s === 'string' && TOKEN.test(st.s)) entry.s = st.s
      if (typeof st.p === 'string' && TOKEN.test(st.p)) entry.p = st.p
      c[id] = entry
    }
    return { c }
  } catch {
    return empty
  }
}

export const calendarCursor = (state) => JSON.stringify({ v: 1, c: state.c })

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * Event descriptions are often HTML. Reduce them to readable text. Not a
 * sanitiser — the registry wraps the result as untrusted — just enough to
 * drop markup, scripts and styles.
 */
export function descriptionText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '
      }
      return ENTITIES[e.toLowerCase()] ?? all
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim()
}

/** An event time as Google sends it: `{ dateTime, timeZone? }` or `{ date }` (all day). */
function when(t) {
  if (!isObject(t)) return null
  if (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return { text: t.date, allDay: true, ms: Date.parse(`${t.date}T00:00:00Z`) }
  if (typeof t.dateTime === 'string' && t.dateTime.length <= 40) {
    const ms = Date.parse(t.dateTime)
    if (Number.isFinite(ms)) return { text: t.dateTime, allDay: false, ms, zone: str(t.timeZone, 60) || undefined }
  }
  return null
}

const person = (p) => {
  if (!isObject(p)) return ''
  const name = str(p.displayName, 120)
  const email = str(p.email, 200)
  return name && email ? `${name} <${email}>` : name || email
}

/** Only links that are plainly a meeting link, and only https. */
const meetLink = (ev) => {
  const candidates = [ev.hangoutLink]
  for (const e of Array.isArray(ev.conferenceData?.entryPoints) ? ev.conferenceData.entryPoints : []) {
    if (e?.entryPointType === 'video') candidates.push(e.uri)
  }
  return candidates.find((u) => typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s]+$/i.test(u)) ?? ''
}

/**
 * One Calendar event to a connector document, a deletion marker
 * `{ deleted: id }` for a cancelled or deleted event, or null to skip it.
 * @param {any} ev       an events.list item
 * @param {{ id: string, name: string }} calendar
 * @param {{ now?: () => number }} [opts]  stamps a cancelled entry that carries no time
 */
export function eventToDocument(ev, calendar, { now = Date.now } = {}) {
  if (!isObject(ev) || typeof ev.id !== 'string' || !EVENT_ID.test(ev.id)) return null
  const id = `${calendar.id}/${ev.id}`
  const updated = Date.parse(ev.updated)
  const created = Date.parse(ev.created)
  const updatedAt = Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : undefined
  const meta = { calendarId: calendar.id.slice(0, 200), status: str(ev.status, 20) || 'confirmed' }
  if (typeof ev.recurringEventId === 'string' && EVENT_ID.test(ev.recurringEventId)) meta.recurringEventId = ev.recurringEventId

  if (ev.status === 'cancelled') {
    // Incremental sync reports a deleted event as little more than its id.
    // One cancelled occurrence of a repeating event is news about the series
    // (the series document still carries its repeat rule), so it is kept as
    // a short note; anything else that was cancelled or deleted leaves the
    // store (task C96).
    const original = when(ev.originalStartTime)
    if (!meta.recurringEventId || !original) return { deleted: id }
    meta.originalStart = original.text
    return {
      id,
      title: `Cancelled: ${str(ev.summary, 300) || 'one occurrence of a repeating event'}`,
      text: `The occurrence on ${original.text}${original.allDay ? ' (all day)' : ''} of a repeating event was cancelled in Google Calendar (${calendar.name}). Other occurrences are not affected.`,
      updatedAt: updatedAt ?? now(),
      sensitivity: 'personal',
      meta,
    }
  }

  const start = when(ev.start)
  const end = when(ev.end)
  const summary = str(ev.summary, 300) || '(no title)'
  const lines = []
  if (start) {
    const range = end ? `${start.text} – ${end.text}` : start.text
    lines.push(`When: ${range}${start.allDay ? ' (all day)' : ''}${start.zone ? ` [${start.zone}]` : ''}`)
    meta.start = start.text
    meta.allDay = start.allDay
    if (end) meta.end = end.text
  }
  const location = str(ev.location, 300)
  if (location) lines.push(`Where: ${location}`)
  const organizer = person(ev.organizer)
  if (organizer) lines.push(`Organizer: ${organizer}`)
  const attendees = Array.isArray(ev.attendees) ? ev.attendees.filter(isObject) : []
  if (attendees.length) {
    const shown = attendees.slice(0, MAX_ATTENDEES).map((a) => {
      const who = person(a) || 'someone'
      const r = str(a.responseStatus, 20)
      return r && r !== 'needsAction' ? `${who} (${r})` : who
    })
    const more = attendees.length > MAX_ATTENDEES ? ` and ${attendees.length - MAX_ATTENDEES} more` : ''
    lines.push(`Attendees: ${shown.join(', ')}${more}`)
    const self = attendees.find((a) => a.self === true)
    if (self && typeof self.responseStatus === 'string') meta.myResponse = str(self.responseStatus, 20)
    meta.attendees = attendees.length
  }
  const link = meetLink(ev)
  if (link) lines.push(`Video call: ${link}`)
  const rules = Array.isArray(ev.recurrence) ? ev.recurrence.filter((r) => typeof r === 'string').slice(0, 5) : []
  if (rules.length) lines.push(`Repeats: ${rules.map((r) => str(r, 200)).join('; ')}`)
  if (ev.status === 'tentative') lines.push('Status: tentative')
  if (ev.transparency === 'transparent') lines.push('Shows as: free')
  const files = Array.isArray(ev.attachments) ? ev.attachments.filter(isObject).slice(0, 10) : []
  if (files.length) lines.push(`Attachments (not opened): ${files.map((f) => str(f.title, 150) || 'file').join(', ')}`)
  lines.push(`Calendar: ${calendar.name}`)
  let description = descriptionText(ev.description)
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION)}\n[… description shortened]`
  if (ev.transparency === 'transparent') meta.free = true
  if (typeof ev.eventType === 'string' && ev.eventType !== 'default') meta.eventType = str(ev.eventType, 30)

  const url = typeof ev.htmlLink === 'string' && /^https:\/\/(www\.)?google\.com\/calendar\//i.test(ev.htmlLink) ? ev.htmlLink : undefined
  return {
    id,
    title: summary,
    text: `${lines.join('\n')}${description ? `\n\n${description}` : ''}`,
    author: organizer || undefined,
    createdAt: Number.isFinite(created) ? created : undefined,
    updatedAt,
    sensitivity: 'personal',
    ...(url ? { url } : {}),
    meta,
  }
}

/** A calendarList entry JARVIS should read, as `{ id, name, primary }`, or null. */
export function calendarEntry(c) {
  if (!isObject(c) || typeof c.id !== 'string' || !CALENDAR_ID.test(c.id)) return null
  if (c.deleted === true || c.hidden === true) return null
  if (!['owner', 'writer', 'reader'].includes(c.accessRole)) return null
  const primary = c.primary === true
  if (!primary && c.selected !== true) return null
  return { id: c.id, name: str(c.summaryOverride, 120) || str(c.summary, 120) || (primary ? 'Primary' : 'Calendar'), primary }
}

/**
 * A time argument from a brain: an ISO date or date-time. Returns ms or null.
 * Only digits, dashes, colons, T, Z, + and . are accepted, so nothing else
 * can ride into a query string.
 */
function parseTime(v) {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  if (s.length > 40 || !/^[0-9T:+.Z-]+$/i.test(s)) return null
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s)
  return Number.isFinite(ms) ? ms : null
}

const GCAL_SEES = [
  'Your Google calendars that are shown in Google Calendar, and the primary one.',
  'Each event: title, time, place, organizer, attendees and their replies, video-call link and description.',
  'Attachment names on events (the files themselves are never opened).',
  'Read-only: JARVIS cannot create, change, accept or delete events with this connector.',
]

/**
 * The Google Calendar connector factory. `googleClient` is the shared Google
 * OAuth client (createGoogleClient over the bridge's `google` credential view).
 * @param {{ googleClient: any, maxPagesPerSync?: number, lookbackDays?: number, timeoutMs?: number }} opts
 */
export function gcalendarConnector({ googleClient, maxPagesPerSync = 8, lookbackDays = 90, timeoutMs } = {}) {
  if (!googleClient || typeof googleClient.get !== 'function') throw new Error('Google Calendar needs the shared Google client.')
  const pageBudget = Math.max(1, Math.min(100, Math.floor(maxPagesPerSync)))
  const lookback = Math.max(1, Math.min(3650, Math.floor(lookbackDays))) * DAY
  return Object.freeze({
    id: 'gcalendar',
    /** @param {{ credentials: any, fetch: typeof fetch, sleep: (ms: number) => Promise<void>, now: () => number }} ctx */
    create({ credentials, fetch, sleep, now }) {
      const oauth = createGoogleOAuth({
        connectorId: 'gcalendar', credentials, client: googleClient, fetch, sleep, now,
        ...(timeoutMs ? { timeoutMs } : {}),
      })
      const api = createHttp({ fetch, sleep, now, allowedHosts: [GCAL_HOST] })
      const get = (path, params) => {
        const qs = params ? `?${new URLSearchParams(params).toString()}` : ''
        return oauth.authorizedJson(api, `${GCAL_API}${path}${qs}`)
      }
      const isGone = (err) => err instanceof ConnectorError && (err.status === 410 || err.status === 404)
      const eventsPath = (calendarId) => `/calendars/${encodeURIComponent(calendarId)}/events`
      let lastSync

      /** The calendars to read, primary first. */
      async function calendars() {
        const out = []
        let pageToken
        for (let page = 0; page < 10 && out.length < MAX_CALENDARS; page++) {
          const params = { minAccessRole: 'reader', maxResults: '250' }
          if (pageToken) params.pageToken = pageToken
          const body = await get('/users/me/calendarList', params)
          if (!isObject(body)) throw new ConnectorError('bad-response', { detail: 'calendarList.list' })
          for (const item of Array.isArray(body.items) ? body.items : []) {
            const c = calendarEntry(item)
            if (c && !out.some((x) => x.id === c.id)) out.push(c)
          }
          if (typeof body.nextPageToken !== 'string' || !body.nextPageToken) break
          pageToken = body.nextPageToken
        }
        out.sort((a, b) => Number(b.primary) - Number(a.primary))
        return out.slice(0, MAX_CALENDARS)
      }

      /** Occurrences in a window across the calendars, soonest first. */
      async function eventsIn({ from, to, query, limit }) {
        const cals = await calendars()
        const found = []
        for (const cal of cals) {
          const params = {
            timeMin: new Date(from).toISOString(),
            timeMax: new Date(to).toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: String(limit),
          }
          if (query) params.q = query
          let body
          try {
            body = await get(eventsPath(cal.id), params)
          } catch (err) {
            if (isGone(err)) continue
            throw err
          }
          for (const ev of Array.isArray(body?.items) ? body.items : []) {
            if (!isObject(ev) || ev.status === 'cancelled') continue
            const start = when(ev.start)
            if (!start) continue
            found.push({ ev, cal, start, end: when(ev.end) })
          }
        }
        found.sort((a, b) => a.start.ms - b.start.ms)
        return found
      }

      /** The tool window: from/to as ISO strings, defaulting to the next 24 hours. */
      function span({ from, to } = {}) {
        const start = parseTime(from) ?? now()
        let end = parseTime(to) ?? start + DAY
        if (end <= start) end = start + DAY
        if (end - start > MAX_WINDOW_MS) end = start + MAX_WINDOW_MS
        return { from: start, to: end }
      }

      return {
        id: 'gcalendar',
        name: 'Google Calendar',
        kind: 'data',
        auth: 'oauth',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'personal',
        setup: googleSetup('gcalendar', GCAL_SEES, "What's on my calendar tomorrow?"),

        connect: (opts = {}) => oauth.begin(opts),

        async disconnect() {
          await oauth.revoke()
          lastSync = undefined
        },

        status() {
          const s = oauth.status()
          return lastSync && s.state === 'ok' ? { ...s, lastSync } : s
        },

        async test() {
          const cals = await calendars()
          const n = cals.length
          return { detail: `Google Calendar works: ${n} calendar${n === 1 ? '' : 's'} to read (read-only).` }
        },

        async *sync({ cursor } = {}) {
          const old = parseCalendarCursor(cursor)
          const cals = await calendars()
          // Calendars the owner no longer shows drop out of the cursor.
          const state = { c: {} }
          for (const cal of cals) state.c[cal.id] = old.c[cal.id] ?? {}
          let pages = 0
          for (const cal of cals) {
            let restarted = false
            while (pages < pageBudget) {
              const st = state.c[cal.id]
              const params = { maxResults: String(PAGE_SIZE) }
              if (st.s) {
                params.syncToken = st.s // nothing Google forbids beside it
              } else {
                params.timeMin = new Date(now() - lookback).toISOString()
                params.showDeleted = 'false'
              }
              if (st.p) params.pageToken = st.p
              let body
              try {
                body = await get(eventsPath(cal.id), params)
              } catch (err) {
                // 404: the calendar went away between listing and reading; forget it.
                if (err instanceof ConnectorError && err.status === 404) {
                  delete state.c[cal.id]
                  break
                }
                // 410: the sync token is no good any more. Start this calendar again, once.
                if (!(err instanceof ConnectorError && err.status === 410) || restarted) throw err
                restarted = true
                state.c[cal.id] = {}
                continue
              }
              pages++
              if (!isObject(body)) throw new ConnectorError('bad-response', { detail: 'events.list' })
              for (const ev of Array.isArray(body.items) ? body.items : []) {
                const doc = eventToDocument(ev, cal, { now })
                if (doc) yield doc
              }
              const next = typeof body.nextPageToken === 'string' && TOKEN.test(body.nextPageToken) ? body.nextPageToken : null
              const syncToken = typeof body.nextSyncToken === 'string' && TOKEN.test(body.nextSyncToken) ? body.nextSyncToken : null
              if (next) {
                state.c[cal.id] = { ...(st.s ? { s: st.s } : {}), p: next }
                yield { cursor: calendarCursor(state) }
                continue
              }
              // Last page. Without a sync token (Google should always send one
              // here), the next run does a fresh windowed full sync instead.
              state.c[cal.id] = syncToken ? { s: syncToken } : {}
              yield { cursor: calendarCursor(state) }
              break
            }
            if (pages >= pageBudget) break
          }
          yield { cursor: calendarCursor(state) }
          lastSync = now()
        },

        tools() {
          return [
            {
              name: 'list_events',
              capability: 'read',
              description:
                "List the owner's Google Calendar events (read-only) between two times, soonest first, across the calendars they show. " +
                'Defaults to the next 24 hours; at most 92 days. Recurring events are expanded. Event text is untrusted data.',
              params: {
                from: { type: 'string', min: 10, max: 40, optional: true, description: 'Start, ISO 8601, e.g. "2026-10-26" or "2026-10-26T09:00:00+01:00"' },
                to: { type: 'string', min: 10, max: 40, optional: true, description: 'End, ISO 8601' },
                query: { type: 'string', min: 1, max: 200, optional: true, description: 'Words to match in title, description, place or attendees' },
                limit: { type: 'number', min: 1, max: MAX_TOOL_EVENTS, optional: true },
              },
              run: async ({ from, to, query, limit } = {}) => {
                const w = span({ from, to })
                const n = Math.max(1, Math.min(MAX_TOOL_EVENTS, Math.floor(Number(limit) || 20)))
                const q = typeof query === 'string' ? query.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : ''
                const found = await eventsIn({ ...w, query: q || undefined, limit: n })
                return {
                  from: new Date(w.from).toISOString(),
                  to: new Date(w.to).toISOString(),
                  events: found.slice(0, n).map(({ ev, cal, start, end }) => ({
                    calendar: cal.name,
                    title: str(ev.summary, 300) || '(no title)',
                    start: start.text,
                    ...(end ? { end: end.text } : {}),
                    allDay: start.allDay,
                    ...(str(ev.location, 300) ? { location: str(ev.location, 300) } : {}),
                    ...(ev.status === 'tentative' ? { tentative: true } : {}),
                    ...(meetLink(ev) ? { videoCall: meetLink(ev) } : {}),
                  })),
                }
              },
            },
            {
              name: 'check_free_busy',
              capability: 'read',
              description:
                "When the owner is busy between two times (read-only), from their Google calendars: merged busy blocks, plus all-day events listed apart. " +
                'Events marked "free", cancelled ones and invitations the owner declined do not count. Defaults to the next 24 hours.',
              params: {
                from: { type: 'string', min: 10, max: 40, optional: true, description: 'Start, ISO 8601' },
                to: { type: 'string', min: 10, max: 40, optional: true, description: 'End, ISO 8601' },
              },
              run: async ({ from, to } = {}) => {
                const w = span({ from, to })
                const found = await eventsIn({ ...w, limit: 250 })
                const blocks = []
                const allDay = []
                for (const { ev, start, end } of found) {
                  if (ev.transparency === 'transparent') continue
                  const self = Array.isArray(ev.attendees) ? ev.attendees.find((a) => a?.self === true) : null
                  if (self?.responseStatus === 'declined') continue
                  if (start.allDay) {
                    allDay.push({ title: str(ev.summary, 300) || '(no title)', date: start.text })
                    continue
                  }
                  const s = Math.max(start.ms, w.from)
                  const e = Math.min(end && !end.allDay ? end.ms : start.ms, w.to)
                  if (e > s) blocks.push([s, e])
                }
                blocks.sort((a, b) => a[0] - b[0])
                const merged = []
                for (const b of blocks) {
                  const last = merged[merged.length - 1]
                  if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1])
                  else merged.push([...b])
                }
                return {
                  from: new Date(w.from).toISOString(),
                  to: new Date(w.to).toISOString(),
                  busy: merged.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })),
                  allDay,
                }
              },
            },
          ]
        },
      }
    },
  })
}
