/**
 * Google Calendar connector (task C07): the shared connector test pack plus
 * Calendar's own acceptance tests — calendar selection, full and incremental
 * sync by sync token, 410 Gone, the per-sync page budget carried in the
 * cursor, cancelled events, the read-only tools, and disconnect revoking.
 * Google is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gcalendarConnector, eventToDocument, calendarEntry, descriptionText, parseCalendarCursor, calendarCursor,
  GCAL_HOST,
} from './gcalendar.mjs'
import { createGoogleClient, GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPES } from './google-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry, connectorToolName, connectorMcpName } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'

const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com'
const REFRESH = '1//gcal-refresh-token-abcdefghijklmnopqrstuvwxyz'
const ACCESS = 'ya29.gcal-access-abcdefghijklmnop'
const NOW = Date.parse('2026-10-25T12:00:00Z')

function googleClient() {
  const c = createGoogleClient(createMemoryCredentialStore().scoped(GOOGLE_CLIENT_ID))
  c.save({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-gcal-test-secret' })
  return c
}

function event(id, { summary = `Meeting ${id}`, start = '2026-10-26T09:00:00+01:00', end = '2026-10-26T10:00:00+01:00', allDay = false, ...rest } = {}) {
  return {
    id,
    status: 'confirmed',
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    summary,
    created: '2026-10-01T08:00:00.000Z',
    updated: '2026-10-20T08:00:00.000Z',
    organizer: { email: 'boss@example.com', displayName: 'The Boss' },
    start: allDay ? { date: start.slice(0, 10) } : { dateTime: start, timeZone: 'Europe/London' },
    end: allDay ? { date: end.slice(0, 10) } : { dateTime: end, timeZone: 'Europe/London' },
    ...rest,
  }
}

const CALENDARS = [
  { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader', selected: true },
  { id: 'me@example.com', summary: 'me@example.com', summaryOverride: 'Me', accessRole: 'owner', primary: true },
  { id: 'hidden@group.calendar.google.com', summary: 'Hidden', accessRole: 'owner', selected: true, hidden: true },
  { id: 'unshown@group.calendar.google.com', summary: 'Not shown', accessRole: 'owner' },
  { id: 'fb@group.calendar.google.com', summary: 'Busy only', accessRole: 'freeBusyReader', selected: true },
]

/**
 * A fake Google Calendar. `pages[calendarId]` is the full-sync list of pages
 * (arrays of events); `changes[calendarId][syncToken]` is an incremental
 * page `{ items, nextSyncToken }`, or 'gone' for a 410.
 */
function fakeCalendar({
  calendars = CALENDARS,
  pages = { 'me@example.com': [[event('a1'), event('a2')]], 'team@group.calendar.google.com': [[event('t1')]] },
  changes = {},
  injection,
  windowEvents = null,
  seen = { lists: [], revokes: 0, refreshes: 0 },
} = {}) {
  const respond = ({ url, init }) => {
    if (url === GOOGLE_TOKEN_URL) {
      seen.refreshes++
      return { body: { access_token: ACCESS, expires_in: 3599, scope: GOOGLE_SCOPES.gcalendar.join(' '), token_type: 'Bearer' } }
    }
    if (url === GOOGLE_REVOKE_URL) {
      seen.revokes++
      return { status: 200, body: '' }
    }
    const u = new URL(url)
    assert.equal(u.hostname, GCAL_HOST)
    assert.equal(init.headers.authorization, `Bearer ${ACCESS}`)
    const path = u.pathname.replace('/calendar/v3', '')
    if (path === '/users/me/calendarList') {
      assert.equal(u.searchParams.get('minAccessRole'), 'reader')
      return { body: { items: calendars } }
    }
    const m = /^\/calendars\/([^/]+)\/events$/.exec(path)
    if (m) {
      const cal = decodeURIComponent(m[1])
      const q = Object.fromEntries(u.searchParams)
      seen.lists.push({ cal, ...q })
      if (q.singleEvents === 'true') {
        return { body: { items: windowEvents?.[cal] ?? [] } }
      }
      if (q.syncToken) {
        for (const k of ['timeMin', 'timeMax', 'q', 'orderBy', 'updatedMin', 'iCalUID']) {
          assert.equal(q[k], undefined, `${k} must not be sent with syncToken`)
        }
        const c = changes[cal]?.[q.syncToken]
        if (!c || c === 'gone') return { status: 410, body: { error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.' } } }
        return { body: c }
      }
      const list = pages[cal] ?? [[]]
      const i = Number(q.pageToken ?? 0)
      let items = list[i] ?? []
      if (injection && cal === 'me@example.com' && i === 0) {
        items = [event('inj', { summary: `Sync: ${injection.slice(0, 40)}`, description: `<p>${injection}</p>`, location: injection.slice(0, 60) }), ...items]
      }
      const more = i + 1 < list.length
      return { body: { items, ...(more ? { nextPageToken: String(i + 1) } : { nextSyncToken: `sync-${cal}-1` }) } }
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = gcalendarConnector({ googleClient: googleClient() })

// The shared pack: untrusted sync, injection, auth failure, revoked, rate limit, offline, erase, writes, kill switches.
for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeCalendar({ injection }).respond({ url, init }),
  onlyHosts: [GCAL_HOST, 'oauth2.googleapis.com'],
})) test(name, run)

function setup(cal = fakeCalendar(), opts = {}) {
  const credentials = createMemoryCredentialStore()
  credentials.set('gcalendar', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => cal.respond({ url, init }))
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log, now: () => NOW })
  const f = Object.keys(opts).length ? gcalendarConnector({ googleClient: googleClient(), ...opts }) : factory
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, lines, seen: cal.seen }
}

test('gcalendar: card is read-only Google sign-in with only the two read-only scopes', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'gcalendar')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, [
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'list_events', capability: 'read' }, { name: 'check_free_busy', capability: 'read' }])
  assert.throws(() => gcalendarConnector({}), /shared Google client/)
})

test('gcalendar: reads the primary and shown calendars, not hidden, unshown or free/busy-only ones', () => {
  const picked = CALENDARS.map(calendarEntry).filter(Boolean)
  assert.deepEqual(picked.map((c) => c.id), ['team@group.calendar.google.com', 'me@example.com'])
  assert.equal(picked[1].name, 'Me')
  assert.equal(calendarEntry({ id: 'x/y', accessRole: 'owner', primary: true }), null, 'no slash in a calendar id')
})

test('gcalendar: full sync maps events to documents with ids, times and a per-calendar sync token', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('gcalendar')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  // Primary first.
  assert.deepEqual(r.documents.map((d) => d.id), ['me@example.com/a1', 'me@example.com/a2', 'team@group.calendar.google.com/t1'])
  const d = r.documents[0]
  assert.equal(d.title, 'Meeting a1')
  assert.equal(d.author, 'The Boss <boss@example.com>')
  assert.equal(d.updatedAt, Date.parse('2026-10-20T08:00:00.000Z'))
  assert.equal(d.createdAt, Date.parse('2026-10-01T08:00:00.000Z'))
  assert.equal(d.sensitivity, 'personal')
  assert.equal(d.url, 'https://www.google.com/calendar/event?eid=a1')
  assert.match(d.text, /When: 2026-10-26T09:00:00\+01:00 – 2026-10-26T10:00:00\+01:00 \[Europe\/London\]/)
  assert.match(d.text, /Calendar: Me/)
  // Full sync is windowed (90 days back) and never sends a sync token.
  const first = seen.lists.find((l) => l.cal === 'me@example.com')
  assert.equal(first.timeMin, new Date(NOW - 90 * 86_400_000).toISOString())
  assert.equal(first.showDeleted, 'false')
  assert.equal(first.syncToken, undefined)
  assert.deepEqual(parseCalendarCursor(r.cursor).c, {
    'team@group.calendar.google.com': { s: 'sync-team@group.calendar.google.com-1' },
    'me@example.com': { s: 'sync-me@example.com-1' },
  })
  assert.ok(!seen.lists.some((l) => /hidden|unshown|fb@/.test(l.cal)), 'only chosen calendars are read')
})

test('gcalendar: incremental sync sends only the sync token and returns only changes, cancelled ones included', async () => {
  const changes = {
    'me@example.com': { s1: { items: [event('a3', { summary: 'New one' }), { id: 'a1', status: 'cancelled' }], nextSyncToken: 's2' } },
    'team@group.calendar.google.com': { t1: { items: [], nextSyncToken: 't2' } },
  }
  const { registry, seen } = setup(fakeCalendar({ changes }))
  const cursor = calendarCursor({ c: { 'me@example.com': { s: 's1' }, 'team@group.calendar.google.com': { s: 't1' } } })
  const r = await registry.sync('gcalendar', { cursor })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['me@example.com/a3', 'me@example.com/a1'])
  const gone = r.documents[1]
  assert.match(gone.title, /^Cancelled/)
  assert.match(gone.text, /cancelled or deleted/)
  assert.equal(gone.meta.status, 'cancelled')
  assert.equal(gone.updatedAt, NOW, 'a bare cancelled entry is stamped with the sync time')
  assert.deepEqual(parseCalendarCursor(r.cursor).c, { 'me@example.com': { s: 's2' }, 'team@group.calendar.google.com': { s: 't2' } })
  assert.ok(seen.lists.every((l) => l.syncToken && l.timeMin === undefined))
})

test('gcalendar: 410 Gone restarts that calendar with a full sync, the others carry on', async () => {
  const changes = { 'me@example.com': { old: 'gone' }, 'team@group.calendar.google.com': { t1: { items: [event('t9')], nextSyncToken: 't2' } } }
  const { registry, seen } = setup(fakeCalendar({ changes }))
  const cursor = calendarCursor({ c: { 'me@example.com': { s: 'old' }, 'team@group.calendar.google.com': { s: 't1' } } })
  const r = await registry.sync('gcalendar', { cursor })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['me@example.com/a1', 'me@example.com/a2', 'team@group.calendar.google.com/t9'])
  assert.deepEqual(parseCalendarCursor(r.cursor).c['me@example.com'], { s: 'sync-me@example.com-1' })
  const mine = seen.lists.filter((l) => l.cal === 'me@example.com')
  assert.equal(mine.length, 2)
  assert.equal(mine[0].syncToken, 'old')
  assert.ok(mine[1].timeMin && !mine[1].syncToken)
})

test('gcalendar: a page budget stops the sync and the cursor resumes where it stopped', async () => {
  const pages = { 'me@example.com': [[event('p1')], [event('p2')], [event('p3')]], 'team@group.calendar.google.com': [[event('t1')]] }
  const { registry } = setup(fakeCalendar({ pages }), { maxPagesPerSync: 2 })
  const r1 = await registry.sync('gcalendar')
  assert.equal(r1.ok, true)
  assert.deepEqual(r1.documents.map((d) => d.id), ['me@example.com/p1', 'me@example.com/p2'])
  assert.deepEqual(parseCalendarCursor(r1.cursor).c, { 'me@example.com': { p: '2' }, 'team@group.calendar.google.com': {} })
  const r2 = await registry.sync('gcalendar', { cursor: r1.cursor })
  assert.deepEqual(r2.documents.map((d) => d.id), ['me@example.com/p3', 'team@group.calendar.google.com/t1'])
  assert.deepEqual(parseCalendarCursor(r2.cursor).c, {
    'me@example.com': { s: 'sync-me@example.com-1' },
    'team@group.calendar.google.com': { s: 'sync-team@group.calendar.google.com-1' },
  })
})

test('gcalendar: a calendar the owner stops showing drops out of the cursor', async () => {
  const { registry } = setup(fakeCalendar({ calendars: [CALENDARS[1]], changes: { 'me@example.com': { s1: { items: [], nextSyncToken: 's2' } } } }))
  const cursor = calendarCursor({ c: { 'me@example.com': { s: 's1' }, 'team@group.calendar.google.com': { s: 't1' } } })
  const r = await registry.sync('gcalendar', { cursor })
  assert.deepEqual(Object.keys(parseCalendarCursor(r.cursor).c), ['me@example.com'])
})

test('gcalendar: a cursor that is not ours means a fresh full sync', () => {
  for (const bad of [null, '', 'nope', '{"v":2,"c":{}}', '{"v":1,"c":{"a b":{"s":"x"}}}', JSON.stringify({ v: 1, c: { ok: { s: 'has space' } } })]) {
    const c = parseCalendarCursor(bad).c
    assert.ok(Object.values(c).every((e) => !e.s), String(bad))
  }
})

test('gcalendar: all-day, recurring, attendees, video link and HTML description', () => {
  const doc = eventToDocument(event('r1', {
    allDay: true, start: '2026-10-30', end: '2026-10-31',
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
    attendees: [
      { email: 'me@example.com', self: true, responseStatus: 'accepted' },
      { email: 'ann@example.com', displayName: 'Ann', responseStatus: 'declined' },
      { email: 'bob@example.com', responseStatus: 'needsAction' },
    ],
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    description: '<p>Agenda:<br>1. Budget &amp; plans</p><script>alert(1)</script>',
    attachments: [{ title: 'slides.pdf', fileUrl: 'https://drive.google.com/x' }],
    transparency: 'transparent',
  }), { id: 'me@example.com', name: 'Me' })
  assert.match(doc.text, /When: 2026-10-30 – 2026-10-31 \(all day\)/)
  assert.match(doc.text, /Repeats: RRULE:FREQ=WEEKLY;BYDAY=FR/)
  assert.match(doc.text, /Attendees: me@example.com \(accepted\), Ann <ann@example.com> \(declined\), bob@example.com\n/)
  assert.match(doc.text, /Video call: https:\/\/meet.google.com\/abc-defg-hij/)
  assert.match(doc.text, /Attachments \(not opened\): slides.pdf/)
  assert.match(doc.text, /Shows as: free/)
  assert.match(doc.text, /Agenda:\n1\. Budget & plans/)
  assert.ok(!doc.text.includes('alert(1)'))
  assert.equal(doc.meta.allDay, true)
  assert.equal(doc.meta.myResponse, 'accepted')
  assert.equal(doc.meta.free, true)
  // A link that is not a plain https meeting link is left out; so is an odd htmlLink.
  const odd = eventToDocument(event('x', { hangoutLink: 'javascript:alert(1)', htmlLink: 'https://evil.example/x' }), { id: 'c', name: 'C' })
  assert.ok(!/Video call/.test(odd.text))
  assert.equal(odd.url, undefined)
  assert.equal(eventToDocument({ id: 'bad id' }, { id: 'c', name: 'C' }), null)
  assert.equal(descriptionText('a&#x41;&#66;&nbsp;c'), 'aAB c')
})

test('gcalendar: list_events expands occurrences in a window, soonest first, across calendars', async () => {
  const windowEvents = {
    'me@example.com': [event('w2', { start: '2026-10-26T15:00:00Z', end: '2026-10-26T16:00:00Z', location: 'Room 1' })],
    'team@group.calendar.google.com': [event('w1', { start: '2026-10-26T08:00:00Z', end: '2026-10-26T09:00:00Z', hangoutLink: 'https://meet.google.com/x' }), { id: 'c', status: 'cancelled' }],
  }
  const { registry, seen } = setup(fakeCalendar({ windowEvents }))
  const res = await registry.callTool(connectorToolName('gcalendar', 'read', 'list_events'), { from: '2026-10-26', to: '2026-10-27', query: 'sync\u0000 up' })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  const text = res.content[0].text
  assert.match(text, /^<untrusted_data/)
  const body = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  assert.deepEqual(body.events.map((e) => e.title), ['Meeting w1', 'Meeting w2'])
  assert.equal(body.events[0].calendar, 'Team')
  assert.equal(body.events[0].videoCall, 'https://meet.google.com/x')
  assert.equal(body.events[1].location, 'Room 1')
  const q = seen.lists.filter((l) => l.singleEvents === 'true')
  assert.equal(q.length, 2)
  assert.equal(q[0].timeMin, '2026-10-26T00:00:00.000Z')
  assert.equal(q[0].timeMax, '2026-10-27T00:00:00.000Z')
  assert.equal(q[0].orderBy, 'startTime')
  assert.equal(q[0].q, 'sync  up')
})

test('gcalendar: list_events defaults to the next 24 hours and caps the window at 92 days', async () => {
  const { registry, seen } = setup()
  await registry.callTool(connectorToolName('gcalendar', 'read', 'list_events'), {})
  const q = seen.lists.find((l) => l.singleEvents === 'true')
  assert.equal(q.timeMin, new Date(NOW).toISOString())
  assert.equal(q.timeMax, new Date(NOW + 86_400_000).toISOString())
  seen.lists.length = 0
  await registry.callTool(connectorToolName('gcalendar', 'read', 'list_events'), { from: '2026-01-01', to: '2027-12-31', limit: 999 })
  const q2 = seen.lists.find((l) => l.singleEvents === 'true')
  assert.equal(Date.parse(q2.timeMax) - Date.parse(q2.timeMin), 92 * 86_400_000)
  assert.equal(q2.maxResults, '50')
  seen.lists.length = 0
  // Anything that is not an ISO time is ignored, not passed on.
  await registry.callTool(connectorToolName('gcalendar', 'read', 'list_events'), { from: 'tomorrow&q=x' })
  assert.equal(seen.lists.find((l) => l.singleEvents === 'true').timeMin, new Date(NOW).toISOString())
})

test('gcalendar: check_free_busy merges busy blocks and skips free, declined and all-day events', async () => {
  const windowEvents = {
    'me@example.com': [
      event('b1', { start: '2026-10-26T09:00:00Z', end: '2026-10-26T10:00:00Z' }),
      event('b2', { start: '2026-10-26T09:30:00Z', end: '2026-10-26T11:00:00Z' }),
      event('free', { start: '2026-10-26T12:00:00Z', end: '2026-10-26T13:00:00Z', transparency: 'transparent' }),
      event('no', { start: '2026-10-26T14:00:00Z', end: '2026-10-26T15:00:00Z', attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }] }),
      event('day', { allDay: true, start: '2026-10-26', end: '2026-10-27', summary: 'Holiday' }),
    ],
    'team@group.calendar.google.com': [event('b3', { start: '2026-10-26T16:00:00Z', end: '2026-10-26T17:00:00Z' })],
  }
  const { registry } = setup(fakeCalendar({ windowEvents }))
  const res = await registry.callTool(connectorToolName('gcalendar', 'read', 'check_free_busy'), { from: '2026-10-26T00:00:00Z', to: '2026-10-27T00:00:00Z' })
  const text = res.content[0].text
  const body = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  assert.deepEqual(body.busy, [
    { start: '2026-10-26T09:00:00.000Z', end: '2026-10-26T11:00:00.000Z' },
    { start: '2026-10-26T16:00:00.000Z', end: '2026-10-26T17:00:00.000Z' },
  ])
  assert.deepEqual(body.allDay, [{ title: 'Holiday', date: '2026-10-26' }])
})

test('gcalendar: the read tools are offered as read-only and pass the policy engine', () => {
  const { registry } = setup()
  const names = registry.tools().map((t) => t.name)
  assert.ok(names.includes(connectorMcpName('gcalendar', 'read', 'list_events')))
  assert.ok(names.includes(connectorMcpName('gcalendar', 'read', 'check_free_busy')))
  assert.ok(registry.tools().filter((t) => t.name.includes('gcalendar')).every((t) => t.readOnly))
  for (const n of ['list_events', 'check_free_busy']) {
    assert.equal(registry.policyRule(connectorToolName('gcalendar', 'read', n)).allow, true)
  }
})

test('gcalendar: test() counts the calendars it reads; disconnect revokes and forgets the tokens', async () => {
  const { registry, credentials, seen, lines } = setup()
  const t = await registry.test('gcalendar')
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.match(t.detail, /2 calendars/)
  const d = await registry.disconnect('gcalendar')
  assert.equal(d.ok, true)
  assert.equal(seen.revokes, 1)
  assert.deepEqual(credentials.describe('gcalendar').keys, [])
  assert.equal(registry.status('gcalendar').state, 'disconnected')
  for (const l of lines) assert.ok(!l.includes(REFRESH) && !l.includes(ACCESS))
})

test('gcalendar: a calendar that vanishes between listing and reading is skipped, not fatal', async () => {
  const cal = fakeCalendar()
  const respond = ({ url, init }) => (url.includes(encodeURIComponent('team@group.calendar.google.com') + '/events')
    ? { status: 404, body: { error: { code: 404 } } }
    : cal.respond({ url, init }))
  const { registry } = setup({ respond, seen: cal.seen })
  const r = await registry.sync('gcalendar')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['me@example.com/a1', 'me@example.com/a2'])
  assert.deepEqual(Object.keys(parseCalendarCursor(r.cursor).c), ['me@example.com'])
})
