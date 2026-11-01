// Plan 12 building block 5 (Q34): the morning briefing template and service.
// Times are built in local time so the tests pass in any time zone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clip,
  composeMorningBriefing,
  createBriefing,
  listing,
  localDate,
  readMail,
  readWeather,
  safeLocale,
  todaysEvents,
  WINDOW_MS,
} from './briefing.mjs'
import { forecastDocuments } from './connectors/weather.mjs'
import { createBus } from './bus.mjs'
import { openDocumentStore } from './connectors/store.mjs'
import { createConnectorRegistry } from './connectors/registry.mjs'

const at = (h, m = 0, day = 1) => new Date(2026, 10, day, h, m).getTime()
const NOW = at(7, 30)
const TODAY = localDate(NOW)
const iso = (ms) => new Date(ms).toISOString()
const HOUR = 3600_000

/** Weather documents exactly as the C16 connector writes them. */
function weatherDocs({ rain = 80, fahrenheit = false } = {}) {
  const unit = fahrenheit ? '°F' : '°C'
  const f = {
    at: NOW,
    localTime: `${TODAY}T07:30`,
    timezone: 'Europe/London',
    units: { temp: unit, wind: fahrenheit ? 'mph' : 'km/h', rain: fahrenheit ? 'in' : 'mm' },
    current: { conditions: 'Partly cloudy', temperature: 9, feelsLike: 7, humidity: 80, precipitation: 0, wind: 12 },
    days: [
      { date: TODAY, conditions: 'Light rain', low: 5, high: 11, rainChance: rain, precipitation: 2, windMax: 20, sunrise: '06:55', sunset: '16:35' },
      { date: localDate(at(12, 0, 2)), conditions: 'Clear sky', low: 3, high: 10, rainChance: 0, precipitation: 0, windMax: 10 },
    ],
  }
  return forecastDocuments({ label: 'London' }, f).map((d) => ({ ...d, meta: d.meta }))
}

const event = (id, title, meta) => ({ id, title, text: '', meta: { status: 'confirmed', ...meta } })

const CALENDAR = [
  event('a', 'Stand-up', { start: iso(at(9, 30)), end: iso(at(9, 45)), allDay: false }),
  event('b', 'Lunch with Sam', { start: iso(at(13)), end: iso(at(14)), allDay: false }),
  event('c', 'Bank holiday', { start: TODAY, allDay: true }),
  event('d', 'Yesterday', { start: iso(at(9, 0, 0)), allDay: false }),
  event('e', 'Tomorrow', { start: iso(at(9, 0, 2)), allDay: false }),
  event('f', 'Declined thing', { start: iso(at(15)), allDay: false, myResponse: 'declined' }),
  event('g', 'Cancelled: Gym', { start: iso(at(18)), allDay: false }),
  event('h', 'Early call', { start: iso(at(6)), end: iso(at(7)), allDay: false }),
  event('i', 'Conference', { start: localDate(at(12, 0, 0)), end: localDate(at(12, 0, 3)), allDay: true }),
]

test('clip makes untrusted text safe to say', () => {
  assert.equal(clip('  hi\u0000there‮  <b>x</b> '), 'hi there b x /b')
  assert.equal(clip('a'.repeat(100), 10), `${'a'.repeat(10)}…`)
  assert.equal(clip('one two three four five', 12), 'one two…')
  assert.equal(clip(undefined), '')
})

test('safeLocale only accepts a real tag', () => {
  assert.equal(safeLocale('en-US'), 'en-US')
  assert.equal(safeLocale('x"); alert(1)'), 'en-GB')
  assert.equal(safeLocale(undefined), 'en-GB')
})

test('listing joins naturally', () => {
  assert.equal(listing([]), '')
  assert.equal(listing(['a']), 'a')
  assert.equal(listing(['a', 'b']), 'a and b')
  assert.equal(listing(['a', 'b', 'c']), 'a, b and c')
})

test('readWeather reads the lines the weather connector writes', () => {
  const w = readWeather(weatherDocs(), { now: NOW })
  assert.deepEqual(w, {
    place: 'London',
    now: { conditions: 'partly cloudy', temperature: 9, unit: '°C' },
    today: { conditions: 'light rain', low: 5, high: 11, unit: '°C', rainChance: 80 },
  })
  assert.equal(readWeather([], { now: NOW }), null)
  assert.equal(readWeather([{ id: 'current', text: 'nonsense' }], { now: NOW }), null)
  // A forecast from another day has no "today" line; current conditions still count.
  const later = readWeather(weatherDocs(), { now: at(8, 0, 5) })
  assert.equal(later.today, undefined)
  assert.equal(later.now.temperature, 9)
})

test('todaysEvents: today only, still to come, soonest first, all-day first', () => {
  const got = todaysEvents(CALENDAR, { now: NOW })
  assert.deepEqual(got.map((e) => e.title), ['Bank holiday', 'Conference', 'Stand-up', 'Lunch with Sam'])
  assert.ok(got.every((e) => typeof e.start === 'number'))
  // Under way still counts; over does not.
  assert.deepEqual(todaysEvents(CALENDAR, { now: at(9, 40) }).filter((e) => !e.allDay).map((e) => e.title), ['Stand-up', 'Lunch with Sam'])
  assert.deepEqual(todaysEvents(CALENDAR, { now: at(9, 50) }).filter((e) => !e.allDay).map((e) => e.title), ['Lunch with Sam'])
  assert.deepEqual(todaysEvents([{ id: 'x', title: 'no meta' }, null, 'junk'], { now: NOW }), [])
})

test('readMail counts new mail, leaves out sent mail and drafts, and names senders', () => {
  const m = readMail([
    { author: 'Sam Lee <sam@example.com>', meta: { labels: 'INBOX,UNREAD,IMPORTANT' } },
    { author: '"Shop" <no-reply@shop.example>', meta: { labels: 'INBOX' } },
    { author: 'Sam Lee <sam@example.com>', meta: { labels: 'INBOX' } },
    { author: 'me@example.com', meta: { labels: 'SENT' } },
    { author: 'me@example.com', meta: { labels: 'DRAFT' } },
    { author: 'plain@example.com' },
  ])
  assert.deepEqual(m, { count: 4, important: 1, senders: ['Sam Lee', 'Shop', 'plain@example.com'] })
})

test('the full morning briefing, section by section', () => {
  const b = composeMorningBriefing({
    now: NOW,
    locale: 'en-GB',
    weather: weatherDocs(),
    calendar: CALENDAR,
    mail: [{ author: 'Sam <s@x.io>', meta: { labels: 'INBOX,IMPORTANT' } }, { author: 'Ann <a@x.io>', meta: { labels: 'INBOX' } }],
    overnight: [
      { kind: 'workflow', name: 'Nightly backup', status: 'failed' },
      { kind: 'workflow', name: 'Tidy downloads', status: 'completed' },
      { kind: 'task', title: 'Private research', status: 'done', sensitivity: 'private' },
      { kind: 'task', title: 'Build site', status: 'failed', sensitivity: 'public' },
    ],
    held: [{ title: 'Parcel delivered', privacy: 'public' }, { title: 'Secret thing', privacy: 'private' }],
  })
  assert.equal(b.empty, false)
  assert.deepEqual(b.sections.map((s) => s.id), ['greeting', 'weather', 'calendar', 'mail', 'overnight', 'held'])
  const say = Object.fromEntries(b.sections.map((s) => [s.id, s.say]))
  assert.match(say.greeting, /^Good morning\. It's \w+day, the 1st of November\.$/)
  assert.equal(say.weather, "In London it's 9 degrees and partly cloudy. Today, light rain, 5 to 11 degrees, 80 percent chance of rain. Worth taking an umbrella.")
  assert.equal(say.calendar, 'You have 4 things on your calendar today: Bank holiday, all day, Conference, all day, Stand-up at 9:30 and Lunch with Sam at 13:00.')
  assert.equal(say.mail, '2 new emails, 1 marked important.', 'no senders unless the owner turns it on')
  assert.equal(say.overnight, 'Overnight: The Nightly backup workflow failed. 1 workflow run finished fine. 2 background tasks finished; 1 failed. Failed: Build site.')
  assert.ok(!say.overnight.includes('Private research'), 'private task titles are never spoken')
  assert.equal(say.held, 'While you were away: Parcel delivered, and 1 other I will tell you when you are alone.')
  assert.ok(!say.held.includes('Secret'), 'private alerts are counted, not read out')
})

test('mail senders only when the owner allows it', () => {
  const mail = [1, 2, 3, 4].map((i) => ({ author: `P${i} <p${i}@x.io>`, meta: { labels: 'INBOX' } }))
  const b = composeMorningBriefing({ now: NOW, mail, mailDetail: true })
  assert.equal(b.sections.find((s) => s.id === 'mail').say, '4 new emails, from P1, P2, P3 and 1 other.')
})

test('a quick briefing is shorter', () => {
  const b = composeMorningBriefing({
    now: NOW,
    short: true,
    locale: 'en-US',
    weather: weatherDocs({ rain: 10 }),
    calendar: CALENDAR,
    mail: [],
    mailDetail: true,
    overnight: [{ kind: 'workflow', name: 'Tidy', status: 'completed' }],
  })
  const say = Object.fromEntries(b.sections.map((s) => [s.id, s.say]))
  assert.equal(say.weather, 'Today, light rain, 5 to 11 degrees.')
  assert.match(say.calendar, /^You have 4 things on your calendar today: Bank holiday, all day, Conference, all day and 2 more\.$/)
  assert.equal(say.mail, undefined, 'no "no new email" line in a quick one')
  assert.equal(say.overnight, undefined, 'only failures overnight in a quick one')
})

test('empty calendar and Fahrenheit are said plainly', () => {
  const b = composeMorningBriefing({ now: at(19), weather: weatherDocs({ fahrenheit: true }), calendar: [] })
  const say = Object.fromEntries(b.sections.map((s) => [s.id, s.say]))
  assert.match(say.greeting, /^Good evening\./)
  assert.match(say.weather, /9 degrees Fahrenheit/)
  assert.equal(say.calendar, 'Nothing else on your calendar today.')
})

test('with nothing set up it says how to get one', () => {
  const b = composeMorningBriefing({ now: NOW, weather: null, calendar: null, mail: null })
  assert.equal(b.empty, true)
  assert.deepEqual(b.sections.map((s) => s.id), ['greeting', 'nothing'])
  assert.match(b.sections[1].say, /Settings, under Connectors/)
})

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

const reg = createConnectorRegistry({ log: { warn() {}, error() {} } })
const stored = (connectorId, raw) => reg.untrustedDocument(connectorId, raw)

function setup({ enabled = true, mailDetail = false } = {}) {
  let t = NOW
  const now = () => t
  const store = openDocumentStore({ file: ':memory:', now })
  const bus = createBus({ now })
  store.ingest('weather', { ok: true, documents: weatherDocs().map((d) => stored('weather', d)) })
  store.ingest('gcalendar', {
    ok: true,
    documents: CALENDAR.map((e) => stored('gcalendar', { ...e, text: 'When: today', updatedAt: NOW - 2 * HOUR, sensitivity: 'personal' })),
  })
  store.ingest('gmail', {
    ok: true,
    documents: [
      stored('gmail', { id: 'm1', title: 'Hi', text: 'hello', author: 'Sam <s@x.io>', updatedAt: NOW - HOUR, sensitivity: 'messages', meta: { labels: 'INBOX' } }),
      stored('gmail', { id: 'm0', title: 'Old', text: 'old', author: 'Old <o@x.io>', updatedAt: NOW - WINDOW_MS - HOUR, sensitivity: 'messages', meta: { labels: 'INBOX' } }),
    ],
  })
  const held = [
    { id: 'n1', title: 'Parcel delivered', privacy: 'public', heldAt: NOW - HOUR },
    { id: 'n0', title: 'Last week', privacy: 'public', heldAt: NOW - 3 * WINDOW_MS },
  ]
  const notifier = { held: () => held }
  const briefing = createBriefing({ store, bus, notifier, enabled: () => enabled, mailDetail: () => mailDetail, now })
  return { briefing, bus, store, held, advance: (ms) => { t += ms } }
}

test('the service reads the store, the bus and held alerts in the window', async () => {
  const { briefing, bus } = setup()
  bus.publish('workflow.finished', { runId: 'r1', workflowId: 'w1', name: 'Nightly backup', trigger: 'schedule', status: 'failed', stepsTotal: 2, stepsCompleted: 1, startedAt: NOW - 5 * HOUR, finishedAt: NOW - 5 * HOUR })
  bus.publish('task.finished', { taskId: 't1', title: 'Secret', status: 'done', summary: '', endedAt: NOW - 4 * HOUR, sensitivity: 'private' })
  await new Promise((r) => setImmediate(r)) // the bus delivers on a microtask
  const out = briefing.morning({ locale: 'en-GB' })
  assert.equal(out.ok, true)
  const say = Object.fromEntries(out.sections.map((s) => [s.id, s.say]))
  assert.match(say.weather, /^In London it's 9 degrees/)
  assert.match(say.calendar, /Stand-up at 9:30/)
  assert.equal(say.mail, '1 new email.', 'mail older than the window is not new')
  assert.equal(say.overnight, 'Overnight: The Nightly backup workflow failed. 1 background task finished.')
  assert.equal(say.held, 'While you were away: Parcel delivered.')
  const stats = briefing.stats()
  assert.equal(stats.given, 1)
  assert.equal(stats.sections.weather, 1)
  assert.ok(!JSON.stringify(stats).includes('London'), 'stats never carry content')
})

test('a second briefing only reports what is new since the first', () => {
  const { briefing } = setup()
  briefing.morning()
  const again = briefing.morning()
  const say = Object.fromEntries(again.sections.map((s) => [s.id, s.say]))
  assert.equal(say.mail, 'No new email.')
  assert.equal(say.held, undefined)
  assert.equal(say.overnight, undefined)
  assert.ok(say.calendar, 'the calendar is always today’s')
})

test('the off switch and an empty store', () => {
  const off = setup({ enabled: false }).briefing
  assert.deepEqual(off.morning(), { ok: false, off: true, reason: 'The morning briefing is switched off in Settings.' })
  assert.equal(off.stats().off, 1)

  const bare = createBriefing({ store: openDocumentStore({ file: ':memory:' }), now: () => NOW })
  const out = bare.morning()
  assert.equal(out.ok, true)
  assert.equal(out.empty, true)
  assert.equal(bare.stats().empty, 1)

  const none = createBriefing({ now: () => NOW })
  assert.equal(none.morning().empty, true, 'no store at all still answers')
})

test('a failing source is reported, not thrown', () => {
  const briefing = createBriefing({
    store: { state() { return { lastSync: 1 } }, recent() { throw new Error('disk gone') } },
    now: () => NOW,
    log: { error() {} },
  })
  const out = briefing.morning()
  assert.equal(out.ok, false)
  assert.equal(briefing.stats().errors, 1)
})

test('stop() unsubscribes from the bus', async () => {
  const { briefing, bus } = setup()
  briefing.stop()
  bus.publish('workflow.finished', { runId: 'r1', workflowId: 'w1', name: 'Late', trigger: 'schedule', status: 'failed', stepsTotal: 1, stepsCompleted: 0, startedAt: NOW, finishedAt: NOW })
  await new Promise((r) => setImmediate(r))
  assert.equal(Object.fromEntries(briefing.morning().sections.map((s) => [s.id, s.say])).overnight, undefined)
})
