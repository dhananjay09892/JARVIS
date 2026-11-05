/**
 * Apple Calendar data connector (task C29; macOS local database, read-only).
 *
 * Grant-local-access pattern on a Mac: the owner ticks consent after reading
 * what is read and why Full Disk Access is needed; there is no credential and
 * no path to type. The adapter reads the Calendar app's own database through
 * the shared macOS helper (macos-local.mjs): a private snapshot copy opened
 * read-only, never the live file, never written. Off macOS it reports itself
 * unavailable (`unsupported-platform`) and cannot be connected.
 *
 * Why the database and not EventKit/AppleScript: EventKit needs a signed native
 * helper and its own prompt, AppleScript needs a shell and Automation rights;
 * reading one file needs only the Full Disk Access the other Apple connectors
 * (Contacts, Notes, Music, iMessage) share. Read-only by construction.
 *
 * Database facts (checked against community references 2026-11-05; Apple does
 * not document the schema, so the layout is verified at run time and an
 * unrecognised one fails with a clear message instead of guessing):
 *   - location: ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb
 *     (older macOS: ~/Library/Calendars/Calendar.sqlitedb)
 *   - dates are Core Data seconds since 2001-01-01 UTC; all-day events are
 *     "floating" (the written date, no zone)
 *   - CalendarItem.start_date of a repeating event is only its first
 *     occurrence; later ones are in OccurrenceCache, which is used when present
 *
 * Mapping (plan 38 Document): `event:<uuid>` (or `event:<uuid>:<startSec>` for
 * one occurrence of a repeating event), title = summary, text = when / where /
 * calendar / repeat note / description, sensitivity `personal`. Window: 30 days
 * back to 90 days ahead, at most 3000 events. Guests are not read.
 *
 * Sync: the cursor is the database's size and modified time (and its -wal's)
 * plus today's date, so nothing is re-read until Calendar changed or the day
 * rolled over. Every document is upserted by id. Events deleted since the last
 * sync are not reported (a snapshot has no change log); they leave with the
 * retention setting or "erase synced data". Fetched text is untrusted data
 * (wrapped by the registry); no live tool is offered.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConnectorError } from './http.mjs'
import { columnsOf, ensureMac, explainAccess, findDatabase, isMac, withSnapshot } from './macos-local.mjs'

const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1)
const DAY_MS = 86_400_000
const BACK_DAYS = 30
const AHEAD_DAYS = 90
const MAX_EVENTS = 3000
const MAX_TEXT = 4000

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim().slice(0, max)
const coreToMs = (sec) => (Number.isFinite(sec) ? Math.round(CORE_DATA_EPOCH_MS + sec * 1000) : null)
const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v === null || v === undefined || v === '' ? NaN : Number(v))

export const databaseCandidates = (home = homedir()) => [
  join(home, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'),
  join(home, 'Library', 'Calendars', 'Calendar.sqlitedb'),
]

const pad = (n) => String(n).padStart(2, '0')
function isoDay(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
function validZone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return null
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch { return null }
}
/** `2026-11-04 09:30` in the event's zone (UTC when it has none). */
export function formatWhen(ms, tz) {
  const zone = validZone(tz) ?? 'UTC'
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${zone === 'UTC' ? ' UTC' : ` [${zone}]`}`
}

/**
 * One event (or one occurrence of it) to a document.
 * @param {{ uuid: string, rowid: number, summary: string, location: string, description: string, calendar: string,
 *   startMs: number, endMs: number|null, allDay: boolean, tz: string|null, repeats: boolean, occurrence: boolean, modifiedMs: number|null }} e
 */
export function eventToDocument(e) {
  const id = e.occurrence ? `event:${e.uuid}:${Math.floor(e.startMs / 1000)}` : `event:${e.uuid}`
  const lines = []
  let when
  if (e.allDay) {
    const s = isoDay(e.startMs)
    const last = e.endMs !== null && e.endMs > e.startMs ? isoDay(e.endMs - 1) : s
    when = last > s ? `${s} – ${last} (all day)` : `${s} (all day)`
  } else {
    const from = formatWhen(e.startMs, e.tz)
    const to = e.endMs !== null && e.endMs > e.startMs ? formatWhen(e.endMs, e.tz) : null
    when = !to ? from : to.slice(0, 10) === from.slice(0, 10) ? `${from} – ${to.slice(11)}` : `${from} – ${to}`
  }
  lines.push(`When: ${when}`)
  if (e.location) lines.push(`Where: ${e.location}`)
  if (e.repeats) lines.push(e.occurrence ? 'Repeats: this is one occurrence of a repeating event' : 'Repeats: yes (later occurrences are not listed here)')
  lines.push(`Calendar: ${e.calendar || 'Calendar'}`)
  const desc = e.description ? (e.description.length > MAX_TEXT ? `${e.description.slice(0, MAX_TEXT)}\n[… notes shortened]` : e.description) : ''
  return {
    id,
    title: e.summary || '(no title)',
    text: `${lines.join('\n')}${desc ? `\n\n${desc}` : ''}`,
    createdAt: undefined,
    updatedAt: e.modifiedMs ?? e.startMs,
    sensitivity: 'personal',
    meta: { calendar: e.calendar, start: new Date(e.startMs).toISOString(), allDay: e.allDay, repeats: e.repeats },
  }
}

const NEED = ['ROWID', 'summary', 'start_date', 'end_date', 'all_day', 'calendar_id']

/**
 * Read the events in the window from an open (snapshot) database.
 * @returns {object[]} event records for `eventToDocument`
 */
export function readEvents(db, { nowMs }) {
  const item = columnsOf(db, 'CalendarItem')
  if (!NEED.every((c) => item.has(c))) throw new ConnectorError('bad-response', { detail: 'unrecognised Calendar database layout' })
  const cal = columnsOf(db, 'Calendar')
  const calNames = new Map()
  if (cal.has('ROWID') && cal.has('title')) for (const r of db.prepare('SELECT ROWID AS id, title FROM Calendar').all()) calNames.set(num(r.id), clean(r.title, 120))
  const locNames = new Map()
  const loc = columnsOf(db, 'Location')
  if (item.has('location_id') && loc.has('ROWID') && loc.has('title')) for (const r of db.prepare('SELECT ROWID AS id, title FROM Location').all()) locNames.set(num(r.id), clean(r.title, 300))

  const from = nowMs - BACK_DAYS * DAY_MS
  const to = nowMs + AHEAD_DAYS * DAY_MS
  const col = (c, alias = c) => (item.has(c) ? `${c} AS ${alias}` : `NULL AS ${alias}`)
  const sql = `SELECT ROWID AS rowid, summary, start_date, end_date, all_day, calendar_id, ${col('description')}, ${col('location_id')}, ${col('UUID', 'uuid')}, ${col('has_recurrences')}, ${col('status')}, ${col('start_tz')}, ${col('last_modified')}${item.has('entity_type') ? ' FROM CalendarItem WHERE entity_type = 2' : ' FROM CalendarItem'}`
  const rows = db.prepare(sql).all()

  // Later occurrences of repeating events live in OccurrenceCache, when it is there.
  const oc = columnsOf(db, 'OccurrenceCache')
  const occStart = oc.has('occurrence_start_date') ? 'occurrence_start_date' : oc.has('occurrence_date') ? 'occurrence_date' : null
  const occEnd = oc.has('occurrence_end_date') ? 'occurrence_end_date' : null
  /** @type {Map<number, {s:number,e:number|null}[]>} */
  const occ = new Map()
  if (oc.has('event_id') && occStart) {
    const lo = (from - CORE_DATA_EPOCH_MS) / 1000
    const hi = (to - CORE_DATA_EPOCH_MS) / 1000
    const q = db.prepare(`SELECT event_id, ${occStart} AS s, ${occEnd ? `${occEnd} AS e` : 'NULL AS e'} FROM OccurrenceCache WHERE ${occStart} >= ? AND ${occStart} <= ? ORDER BY ${occStart} LIMIT ${MAX_EVENTS * 2}`)
    for (const r of q.all(lo, hi)) {
      const id = num(r.event_id)
      const s = coreToMs(num(r.s))
      if (s === null) continue
      const list = occ.get(id) ?? []
      const e = coreToMs(num(r.e))
      if (!list.some((x) => x.s === s)) list.push({ s, e })
      occ.set(id, list)
    }
  }

  const out = []
  for (const r of rows) {
    if (out.length >= MAX_EVENTS) break
    if (num(r.status) === 3) continue // cancelled
    const rowid = num(r.rowid)
    const baseS = coreToMs(num(r.start_date))
    if (baseS === null) continue
    const baseE = coreToMs(num(r.end_date))
    const allDay = num(r.all_day) === 1
    const repeats = num(r.has_recurrences) === 1
    const uuid = typeof r.uuid === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(r.uuid) ? r.uuid : `r${rowid}`
    const base = {
      uuid, rowid, summary: clean(r.summary, 300), description: clean(r.description, MAX_TEXT + 100),
      location: locNames.get(num(r.location_id)) ?? '', calendar: calNames.get(num(r.calendar_id)) ?? '',
      allDay, tz: allDay || r.start_tz === '_float' ? null : clean(r.start_tz, 60) || null, repeats,
      modifiedMs: coreToMs(num(r.last_modified)),
    }
    const list = occ.get(rowid)
    if (repeats && list?.length) {
      const span = baseE !== null ? baseE - baseS : null
      for (const o of list) {
        if (out.length >= MAX_EVENTS) break
        out.push({ ...base, startMs: o.s, endMs: o.e ?? (span !== null ? o.s + span : null), occurrence: true })
      }
    } else if ((baseE ?? baseS) >= from && baseS <= to) {
      out.push({ ...base, startMs: baseS, endMs: baseE, occurrence: false })
    }
  }
  return out
}

export function parseCalendarCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 300) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.g !== 'string' || !Number.isFinite(c.d)) return null
    return { g: c.g.slice(0, 120), d: Math.floor(c.d) }
  } catch {
    return null
  }
}
export const calendarCursor = ({ g, d }) => JSON.stringify({ v: 1, g, d })

const SEES = [
  'Event titles, times, places, which calendar they are on, whether they repeat, and the notes you wrote on them. From 30 days ago to 90 days ahead.',
  'Not the guest list, reminders, attachments or video links. Nothing is sent anywhere by this connector.',
  'Read-only: JARVIS works on a private copy of the Calendar database, deletes the copy right away, and never changes Calendar.',
  'Needs Full Disk Access on a Mac; it does not work on Windows or Linux.',
  'Notes inside events are treated as information, never as instructions.',
]

/** @param {{ home?: string, platform?: string }} [opts] */
export function appleCalendarConnector({ home, platform } = {}) {
  const here = platform ?? process.platform
  return Object.freeze({
    id: 'apple_calendar',
    create({ credentials, now }) {
      let lastSync

      const open = () => findDatabase(databaseCandidates(home))

      return {
        id: 'apple_calendar',
        name: 'Apple Calendar',
        kind: 'data',
        auth: 'local',
        platforms: ['mac'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'personal',
        setup: {
          sees: SEES,
          localWhy: explainAccess({ app: 'Calendar', reads: 'your event titles, times, places and notes', notReads: 'your mail, messages, photos or other apps' }),
          steps: [
            'Open System Settings → Privacy & Security → Full Disk Access and turn it on for JARVIS (or the terminal that runs it). Restart JARVIS if you just did.',
            'Tick the box here and press Grant access.',
            'Press Test: JARVIS checks it can read Calendar and shows nothing else.',
          ],
          testQuestion: "What's on my calendar tomorrow?",
        },

        /** Grant pattern: `{ confirmed: true }`. Stores a marker only when the database is readable. */
        async connect({ confirmed } = {}) {
          ensureMac(here)
          if (confirmed !== true) throw new ConnectorError('consent-denied', { detail: 'not confirmed' })
          const db = await open()
          await withSnapshot(db.path, (d) => {
            if (!columnsOf(d, 'CalendarItem').has('start_date')) throw new ConnectorError('bad-response', { detail: 'unrecognised Calendar database layout' })
          })
          credentials.set('granted', '1')
          lastSync = undefined
          return { account: 'This Mac', detail: 'Connected to the Calendar app on this Mac (read-only, on a private copy).' }
        },

        async disconnect() {
          credentials.delete('granted')
          lastSync = undefined
        },

        status() {
          if (!isMac(here)) return { state: 'error', detail: 'Apple Calendar only works on a Mac' }
          if (!credentials.get('granted')) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: 'Reading the Calendar app on this Mac (read-only)' }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          ensureMac(here)
          const db = await open()
          const n = await withSnapshot(db.path, (d) => readEvents(d, { nowMs: now() }).length)
          return { detail: `Apple Calendar works: ${n} event${n === 1 ? '' : 's'} between 30 days ago and 90 days ahead (read-only).` }
        },

        async *sync({ cursor } = {}) {
          ensureMac(here)
          if (!credentials.get('granted')) throw new ConnectorError('not-connected')
          const db = await open()
          const day = Math.floor(now() / DAY_MS)
          const prev = parseCalendarCursor(cursor)
          if (prev && prev.g === db.signature && prev.d === day) {
            lastSync = now()
            yield { cursor }
            return
          }
          const events = await withSnapshot(db.path, (d) => readEvents(d, { nowMs: now() }))
          events.sort((a, b) => a.startMs - b.startMs)
          for (const e of events) yield eventToDocument(e)
          yield { cursor: calendarCursor({ g: db.signature, d: day }) }
          lastSync = now()
        },
      }
    },
  })
}
