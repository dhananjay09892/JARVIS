/**
 * Apple Calendar (task C29) and the shared macOS helper: the README's acceptance
 * tests against fixture SQLite databases built in a temp folder. No real
 * Calendar data is touched; the platform is injected so this runs everywhere.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { appleCalendarConnector, databaseCandidates, eventToDocument, formatWhen, parseCalendarCursor } from './apple_calendar.mjs'
import { ensureMac, findDatabase, withSnapshot, accessError } from './macos-local.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const ID = 'apple_calendar'
const NOW = Date.parse('2026-11-05T08:00:00Z')
const CORE = Date.UTC(2001, 0, 1)
const sec = (iso) => (Date.parse(iso) - CORE) / 1000
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cal-')))
  temps.push(d)
  return d
}

/** A Calendar.sqlitedb look-alike under a fake home. */
function fixture({ summary = 'Dentist', description = 'Bring the forms', layout = 'ok', modern = true } = {}) {
  const home = tempDir()
  const dir = modern ? join(home, 'Library', 'Group Containers', 'group.com.apple.calendar') : join(home, 'Library', 'Calendars')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'Calendar.sqlitedb')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY, title TEXT)')
  db.exec('CREATE TABLE Location (ROWID INTEGER PRIMARY KEY, title TEXT)')
  if (layout === 'ok') {
    db.exec(`CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY, summary TEXT, description TEXT, location_id INTEGER, UUID TEXT,
      start_date REAL, end_date REAL, start_tz TEXT, all_day INTEGER, calendar_id INTEGER, has_recurrences INTEGER, status INTEGER,
      entity_type INTEGER, last_modified REAL)`)
  } else {
    db.exec('CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY, something TEXT)')
  }
  db.exec('CREATE TABLE OccurrenceCache (day INTEGER, event_id INTEGER, occurrence_start_date REAL, occurrence_end_date REAL)')
  db.exec("INSERT INTO Calendar VALUES (1, 'Home'), (2, 'Work')")
  db.exec("INSERT INTO Location VALUES (1, 'Dental clinic')")
  if (layout === 'ok') {
    const ins = db.prepare('INSERT INTO CalendarItem VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    // 1: a timed event tomorrow in Asia/Kolkata
    ins.run(1, summary, description, 1, 'AAAA-1111-aaaa', sec('2026-11-06T04:30:00Z'), sec('2026-11-06T05:30:00Z'), 'Asia/Kolkata', 0, 1, 0, 0, 2, sec('2026-11-01T00:00:00Z'))
    // 2: all-day, floating
    ins.run(2, 'Diwali', null, null, 'BBBB-2222-bbbb', sec('2026-11-08T00:00:00Z'), sec('2026-11-09T00:00:00Z'), '_float', 1, 2, 0, 0, 2, null)
    // 3: weekly repeating, first occurrence long ago; two occurrences in the cache window
    ins.run(3, 'Standup', null, null, 'CCCC-3333-cccc', sec('2026-01-05T09:00:00Z'), sec('2026-01-05T09:15:00Z'), 'UTC', 0, 2, 1, 0, 2, null)
    db.exec(`INSERT INTO OccurrenceCache VALUES (1, 3, ${sec('2026-11-09T09:00:00Z')}, ${sec('2026-11-09T09:15:00Z')}), (2, 3, ${sec('2026-11-16T09:00:00Z')}, ${sec('2026-11-16T09:15:00Z')}), (3, 3, ${sec('2026-01-05T09:00:00Z')}, ${sec('2026-01-05T09:15:00Z')})`)
    // 4: far in the past; 5: cancelled; 6: a reminder (entity_type 3)
    ins.run(4, 'Old trip', null, null, 'DDDD-4444-dddd', sec('2025-01-01T00:00:00Z'), sec('2025-01-02T00:00:00Z'), 'UTC', 0, 1, 0, 0, 2, null)
    ins.run(5, 'Cancelled lunch', null, null, 'EEEE-5555-eeee', sec('2026-11-07T10:00:00Z'), sec('2026-11-07T11:00:00Z'), 'UTC', 0, 1, 0, 3, 2, null)
    ins.run(6, 'Buy milk', null, null, 'FFFF-6666-ffff', sec('2026-11-07T10:00:00Z'), sec('2026-11-07T11:00:00Z'), 'UTC', 0, 1, 0, 0, 3, null)
  }
  db.close()
  return { home, file }
}

function setup({ home, platform = 'darwin', granted = true, onErase } = {}) {
  const credentials = createMemoryCredentialStore()
  if (granted) credentials.set(ID, 'granted', '1')
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase, now: () => NOW })
  assert.equal(registry.register(appleCalendarConnector({ home, platform })).ok, true)
  return { registry, credentials, lines }
}

test('apple_calendar: the card is valid, read-only, R1, mac-only and explains Full Disk Access', () => {
  const { registry } = setup({ home: tempDir() })
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.equal(c.risk, 'R1')
  assert.deepEqual(c.platforms, ['mac'])
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.match(c.setup.localWhy, /Full Disk Access/)
  assert.match(c.setup.localWhy, /private copy/)
  assert.deepEqual(c.tools, [])
})

test('apple_calendar: a fixture database syncs wrapped documents with correct ids, times and mapping', async () => {
  for (const modern of [true, false]) {
    const { home } = fixture({ modern })
    const { registry } = setup({ home })
    const r = await registry.sync(ID)
    assert.equal(r.ok, true, JSON.stringify(r.error))
    for (const d of r.documents) {
      assert.equal(d.untrusted, true)
      assert.ok(isWrapped(d.text))
      assert.match(d.text, /source="connector:apple_calendar"/)
      assert.equal(d.sensitivity, 'personal')
    }
    const ids = r.documents.map((d) => d.id).sort()
    assert.deepEqual(ids, [
      'event:AAAA-1111-aaaa', 'event:BBBB-2222-bbbb',
      `event:CCCC-3333-cccc:${Math.floor(Date.parse('2026-11-09T09:00:00Z') / 1000)}`,
      `event:CCCC-3333-cccc:${Math.floor(Date.parse('2026-11-16T09:00:00Z') / 1000)}`,
    ].sort(), 'past, cancelled and reminder items are left out')
    const dentist = r.documents.find((d) => d.id === 'event:AAAA-1111-aaaa')
    assert.equal(dentist.title, 'Dentist')
    assert.match(dentist.text, /When: 2026-11-06 10:00 \[Asia\/Kolkata\] – 11:00/)
    assert.match(dentist.text, /Where: Dental clinic/)
    assert.match(dentist.text, /Calendar: Home/)
    assert.match(dentist.text, /Bring the forms/)
    const allDay = r.documents.find((d) => d.id === 'event:BBBB-2222-bbbb')
    assert.match(allDay.text, /When: 2026-11-08 \(all day\)/)
    assert.match(allDay.text, /Calendar: Work/)
    assert.match(r.documents.find((d) => d.title === 'Standup').text, /one occurrence of a repeating event/)
  }
})

test('apple_calendar: incremental sync reads nothing until Calendar changes (WAL included) or the day rolls over', async () => {
  const { home, file } = fixture()
  const { registry } = setup({ home })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 4)
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0, 'unchanged: nothing to read')
    const db = new DatabaseSync(file)
    db.exec("UPDATE CalendarItem SET summary = 'Dentist (moved)' WHERE ROWID = 1")
    db.close()
    const again = await syncConnectorInto(registry, store, ID)
    assert.equal(again.saved, 4)
  } finally {
    store.close()
  }
  assert.equal(parseCalendarCursor('{"v":2}'), null)
  assert.equal(parseCalendarCursor('nope'), null)
})

test('apple_calendar: off macOS it reports itself unavailable and cannot connect or sync', async () => {
  const { home } = fixture()
  const { registry } = setup({ home, platform: 'win32', granted: false })
  assert.equal(registry.status(ID).state, 'error')
  assert.match(registry.status(ID).detail, /only works on a Mac/)
  const c = await registry.connect(ID, { confirmed: true })
  assert.equal(c.ok, false)
  assert.equal(c.error.code, 'unsupported-platform')
  const s = await registry.sync(ID)
  assert.equal(s.ok, false)
  assert.equal(s.error.code, 'unsupported-platform')
  assert.throws(() => ensureMac('linux'), (e) => e.code === 'unsupported-platform')
})

test('apple_calendar: connect needs consent and a readable database; nothing is stored otherwise', async () => {
  const { home } = fixture()
  const { registry, credentials } = setup({ home, granted: false })
  assert.equal((await registry.connect(ID, {})).error.code, 'consent-denied')
  assert.deepEqual(credentials.describe(ID).keys, [])
  const none = setup({ home: tempDir(), granted: false })
  assert.equal((await none.registry.connect(ID, { confirmed: true })).error.code, 'folder-missing')
  assert.deepEqual(none.credentials.describe(ID).keys, [])
  const ok = await registry.connect(ID, { confirmed: true })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  assert.equal(registry.status(ID).state, 'ok')
})

test('apple_calendar: missing permission gives the Full Disk Access message, not a crash', async () => {
  const { home, file } = fixture()
  const { registry } = setup({ home })
  // What macOS does without Full Disk Access: EPERM on lstat/read.
  assert.equal(accessError(Object.assign(new Error('x'), { code: 'EPERM' })).code, 'permission-needed')
  assert.equal(accessError(Object.assign(new Error('x'), { code: 'EACCES' })).code, 'permission-needed')
  assert.equal(accessError(Object.assign(new Error('x'), { code: 'ENOENT' })).code, 'folder-missing')
  // A real unreadable file (skipped where permissions are not enforced, e.g. root).
  let enforced = true
  chmodSync(file, 0o000)
  try { new DatabaseSync(file, { readOnly: true }).close(); enforced = false } catch { /* denied, as wanted */ }
  if (enforced) {
    const r = await registry.sync(ID)
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'permission-needed')
    assert.match(r.error.message, /Full Disk Access/)
  }
  chmodSync(file, 0o600)
})

test('apple_calendar: an unrecognised database layout fails cleanly', async () => {
  const { home } = fixture({ layout: 'odd' })
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
  assert.equal((await registry.test(ID)).ok, false)
})

test('apple_calendar: a link in place of the database is not followed; a non-database file fails cleanly', async () => {
  const home = tempDir()
  const dir = join(home, 'Library', 'Group Containers', 'group.com.apple.calendar')
  mkdirSync(dir, { recursive: true })
  const real = join(home, 'secret.sqlite')
  new DatabaseSync(real).close()
  symlinkSync(real, join(dir, 'Calendar.sqlitedb'))
  await assert.rejects(() => findDatabase(databaseCandidates(home)), (e) => e.code === 'folder-missing')
  rmSync(join(dir, 'Calendar.sqlitedb'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'Calendar.sqlitedb'), 'this is not a database, just text '.repeat(50))
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
})

test('macos-local: the snapshot is a private copy that is deleted afterwards, the original untouched, and size is capped', async (t) => {
  const { file } = fixture()
  // Snapshots go to the system temp folder. Every test file shares it, and the
  // other connectors' tests put their own snapshots there while this one runs,
  // so a count taken there includes theirs. Give this test a temp folder of its
  // own: the count is then exactly this test's copies.
  const own = tempDir()
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
  for (const k of Object.keys(saved)) process.env[k] = own
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  assert.equal(realpathSync.native(tmpdir()), own, 'snapshots will be made in the private folder')
  const snapshots = () => readdirSync(own).filter((n) => n.startsWith('jarvis-snap-')).length
  const { statSync } = await import('node:fs')
  const m0 = statSync(file).mtimeMs
  let during = -1
  const n = await withSnapshot(file, (db) => {
    during = snapshots()
    return db.prepare('SELECT COUNT(*) AS n FROM CalendarItem').get().n
  })
  assert.equal(Number(n), 6)
  assert.equal(during, 1, 'the copy exists while it is in use')
  assert.equal(snapshots(), 0, 'copy removed')
  assert.equal(statSync(file).mtimeMs, m0)
  // read-only: a write inside the callback fails
  await assert.rejects(() => withSnapshot(file, (db) => db.exec('DELETE FROM CalendarItem')))
  await assert.rejects(() => withSnapshot(file, () => 1, { maxBytes: 10 }), (e) => e.code === 'bad-response')
  assert.equal(snapshots(), 0)
})

test('apple_calendar: injection text in an event is neutralised and changes nothing', async () => {
  const { home } = fixture({ summary: INJECTION_TEXT, description: INJECTION_TEXT })
  const { registry } = setup({ home })
  const before = registry.grants.of(ID)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true)
  const hit = r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.ok(hit, 'the fixture must reach a document')
  for (const d of r.documents) assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
  assert.deepEqual(registry.grants.of(ID), before, 'no grant changed')
  assert.deepEqual(registry.tools?.(ID) ?? [], [])
})

test('apple_calendar: disconnect forgets the marker and erase clears the store; no write; kill switches stop sync', async () => {
  const { home } = fixture()
  const erased = []
  const { registry, credentials } = setup({ home, onErase: (id) => erased.push(id) })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 4)
    assert.equal((await registry.disconnect(ID, { eraseData: true })).ok, true)
    assert.deepEqual(erased, [ID])
    assert.deepEqual(credentials.describe(ID).keys, [])
    assert.equal((await registry.sync(ID)).error.code, 'not-connected')
  } finally {
    store.close()
  }
  const second = setup({ home })
  assert.throws(() => second.registry.grants.grant(ID, 'write'))
  second.registry.grants.disable(ID)
  assert.equal((await second.registry.sync(ID)).error.code, 'disabled')
  second.registry.grants.enable(ID)
  second.registry.grants.freezeAll()
  assert.equal((await second.registry.sync(ID)).error.code, 'frozen')
})

test('apple_calendar: time formatting and the document shape', () => {
  assert.equal(formatWhen(Date.parse('2026-11-06T04:30:00Z'), 'Asia/Kolkata'), '2026-11-06 10:00 [Asia/Kolkata]')
  assert.equal(formatWhen(Date.parse('2026-11-06T04:30:00Z'), 'Not/AZone; DROP'), '2026-11-06 04:30 UTC')
  const d = eventToDocument({
    uuid: 'U-1', rowid: 1, summary: '', location: '', description: 'x'.repeat(5000), calendar: '', startMs: NOW, endMs: null,
    allDay: false, tz: null, repeats: true, occurrence: false, modifiedMs: null,
  })
  assert.equal(d.title, '(no title)')
  assert.match(d.text, /later occurrences are not listed/)
  assert.match(d.text, /notes shortened/)
  assert.equal(d.updatedAt, NOW)
})
