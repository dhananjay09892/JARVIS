/**
 * Apple Health (task C28): the README's acceptance tests against fixture
 * export files in a temp folder — xml and zip, sleep/steps/workouts mapping,
 * de-duplication across sources, size and zip-bomb limits, malformed files,
 * links, injection, the health vault gate and erase. No real data is touched.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import {
  appleHealthConnector, scanHealthXml, parseAttributes, parseHealthDate, parseHealthCursor,
  resolveExportFile, createAggregator,
} from './apple_health.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { documentsConnector } from './documents.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const ID = 'apple_health'
const NOW = Date.parse('2026-11-03T08:00:00Z')
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'health-')))
  temps.push(d)
  return d
}

const rec = (type, value, start, end = start, extra = '') =>
  `<Record type="${type}" sourceName="${extra || 'iPhone'}" unit="count" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"/>`
const D1 = '2026-11-01'
const xml = (body, { doctype = true } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
${doctype ? '<!DOCTYPE HealthData [\n<!ENTITY x SYSTEM "file:///etc/passwd">\n<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout)*)>\n]>' : ''}
<HealthData locale="en_IN">
 <ExportDate value="2026-11-03 07:00:00 +0530"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1985-01-01"/>
${body}
</HealthData>
`

function fixtureBody({ injection } = {}) {
  const asleep = (v, s, e) => rec('HKCategoryTypeIdentifierSleepAnalysis', v, s, e, 'Apple Watch')
  return [
    rec('HKQuantityTypeIdentifierStepCount', 3000, `${D1} 08:00:00 +0530`, `${D1} 09:00:00 +0530`),
    rec('HKQuantityTypeIdentifierStepCount', 2500, `${D1} 10:00:00 +0530`, `${D1} 11:00:00 +0530`),
    rec('HKQuantityTypeIdentifierStepCount', injection ? 9000 : 4000, `${D1} 08:00:00 +0530`, `${D1} 09:00:00 +0530`, injection ?? 'Apple Watch'),
    rec('HKQuantityTypeIdentifierHeartRate', 60, `${D1} 12:00:00 +0530`),
    rec('HKQuantityTypeIdentifierHeartRate', 100, `${D1} 13:00:00 +0530`),
    rec('HKQuantityTypeIdentifierRestingHeartRate', 55, `${D1} 06:00:00 +0530`),
    asleep('HKCategoryValueSleepAnalysisAsleepCore', '2026-10-31 23:00:00 +0530', '2026-11-01 03:00:00 +0530'),
    asleep('HKCategoryValueSleepAnalysisAsleepDeep', '2026-11-01 03:00:00 +0530', '2026-11-01 04:00:00 +0530'),
    asleep('HKCategoryValueSleepAnalysisAsleepREM', '2026-11-01 04:00:00 +0530', '2026-11-01 06:00:00 +0530'),
    asleep('HKCategoryValueSleepAnalysisAwake', '2026-11-01 06:00:00 +0530', '2026-11-01 06:30:00 +0530'),
    // Too old: outside the window.
    rec('HKQuantityTypeIdentifierStepCount', 999, '2020-01-01 08:00:00 +0000', '2020-01-01 09:00:00 +0000'),
    '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="32.5" durationUnit="min" totalDistance="5.2" totalDistanceUnit="km" totalEnergyBurned="410" totalEnergyBurnedUnit="kcal" startDate="2026-11-02 06:00:00 +0530" endDate="2026-11-02 06:33:00 +0530">',
    '  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150"/>',
    '</Workout>',
  ].join('\n')
}

// -- a minimal zip writer for fixtures (stored or deflated, one or more entries)
function zip(entries, { method = 8, lieSize } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, data] of entries) {
    const raw = Buffer.from(data)
    const body = method === 8 ? deflateRawSync(raw) : raw
    const nm = Buffer.from(name)
    const size = lieSize ?? raw.length
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nm.length, 26)
    locals.push(lh, nm, body)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42)
    central.push(ch, nm)
    offset += 30 + nm.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

function fixture({ kind = 'xml', body = fixtureBody(), mtime = NOW } = {}) {
  const dir = tempDir()
  const file = join(dir, kind === 'xml' ? 'export.xml' : 'export.zip')
  writeFileSync(file, kind === 'xml' ? xml(body) : zip([['apple_health_export/export.xml', xml(body)], ['apple_health_export/export_cda.xml', '<ClinicalDocument/>']]))
  utimesSync(file, new Date(mtime), new Date(mtime))
  return { dir, file }
}

function setup({ file, onErase, home } = {}) {
  const credentials = createMemoryCredentialStore()
  if (file) credentials.set(ID, 'file', file)
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase, now: () => NOW })
  assert.equal(registry.register(appleHealthConnector(home ? { home } : {})).ok, true)
  return { registry, credentials, lines }
}

test('apple_health: the card is valid, read-only, R2 and says health data stays local', () => {
  const { registry } = setup()
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.equal(c.risk, 'R2')
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.match(c.setup.sees.join(' '), /stays on this device/)
  assert.deepEqual(c.tools, [])
})

for (const kind of ['xml', 'zip']) {
  test(`apple_health: a fixture ${kind} export syncs to wrapped, health-class documents`, async () => {
    const { file } = fixture({ kind })
    const { registry } = setup({ file })
    const r = await registry.sync(ID)
    assert.equal(r.ok, true, JSON.stringify(r.error))
    for (const d of r.documents) {
      assert.equal(d.untrusted, true)
      assert.ok(isWrapped(d.text))
      assert.match(d.text, /source="connector:apple_health"/)
      assert.equal(d.sensitivity, 'health')
    }
    assert.deepEqual(r.documents.map((d) => d.id).sort(), ['day:2026-11-01', 'workout:' + Date.parse('2026-11-02T06:00:00+05:30')])
    const day = r.documents.find((d) => d.id === 'day:2026-11-01')
    assert.equal(day.updatedAt, Date.parse('2026-11-01T12:00:00Z'))
    // iPhone 5,500 vs Apple Watch 4,000: the larger source, never the sum.
    assert.match(day.text, /5,500 steps/)
    assert.match(day.text, /sleep 7 h \(core 4, deep 1, REM 2\)/)
    assert.match(day.text, /heart rate average 80 \(low 60, high 100\) bpm/)
    assert.match(day.text, /resting heart rate 55 bpm/)
    assert.ok(!day.text.includes('999'), 'records outside the window are ignored')
    const w = r.documents.find((d) => d.id.startsWith('workout:'))
    assert.match(w.text, /Workout on 2026-11-02: Running, 33 min, 5.2 km, 410 kcal\./)
    assert.ok(!r.documents.some((d) => d.text.includes('1985')), 'profile details are never read')
    assert.ok(registry.status(ID).lastSync)
  })
}

test('apple_health: re-syncing an unchanged file reads nothing; a changed file is read again', async () => {
  const { file } = fixture()
  const { registry } = setup({ file })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 2)
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0)
    writeFileSync(file, xml(fixtureBody() + '\n' + rec('HKQuantityTypeIdentifierStepCount', 1, `${D1} 20:00:00 +0530`)))
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 2)
  } finally {
    store.close()
  }
})

test('apple_health: connect needs consent and a real .zip/.xml file, and stores nothing otherwise', async () => {
  const { dir, file } = fixture()
  const { registry, credentials } = setup()
  assert.equal((await registry.connect(ID, { path: file })).error.code, 'consent-denied')
  for (const path of ['', 'export.xml', join(dir, 'missing.xml'), dir, join(dir, 'notes.txt')]) {
    const r = await registry.connect(ID, { confirmed: true, path })
    assert.equal(r.ok, false, path)
    assert.equal(r.error.code, 'folder-missing')
  }
  assert.deepEqual(credentials.describe(ID).keys, [])
  const ok = await registry.connect(ID, { confirmed: true, path: file })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  assert.deepEqual(credentials.describe(ID).keys, [{ key: 'file', set: true }])
  assert.equal((await registry.test(ID)).ok, true)
})

test('apple_health: ~ is the home folder, and a symlinked file is refused', async () => {
  const { dir, file } = fixture()
  assert.equal((await resolveExportFile('~/export.xml', { home: dir })).real, file)
  const link = join(tempDir(), 'link.xml')
  symlinkSync(file, link)
  const { registry } = setup({ file: link })
  const r = await registry.sync(ID)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'folder-missing', 'a stored path that is a link is not followed')
})

test('apple_health: a file that is not a Health export fails cleanly and stores nothing', async () => {
  const dir = tempDir()
  const bad = join(dir, 'export.xml')
  writeFileSync(bad, '<html>hello</html>')
  const { registry } = setup({ file: bad })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    const r = await syncConnectorInto(registry, store, ID)
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'bad-response')
    assert.equal(store.state(ID).cursor, null)
  } finally {
    store.close()
  }
  assert.equal((await registry.test(ID)).ok, false)
})

test('apple_health: truncated xml, a zip without export.xml, and a zip that lies about its size fail cleanly', async () => {
  const dir = tempDir()
  const cases = {
    'trunc.xml': '<?xml version="1.0"?><HealthData><Record type="HKQuantityTypeIdentifierStepCount" sourceName="x" value="1" startDate="2026-11-01 08:00',
    'empty.zip': zip([['readme.txt', 'hi']]),
    'junk.zip': Buffer.from('this is not a zip file at all, just bytes'),
    'lie.zip': zip([['export.xml', xml(fixtureBody())]], { lieSize: 10 }),
  }
  for (const [name, data] of Object.entries(cases)) {
    const file = join(dir, name)
    writeFileSync(file, data)
    const { registry } = setup({ file })
    const r = await registry.sync(ID)
    if (name === 'trunc.xml') assert.equal(r.ok, true, 'a cut-off tag is ignored, not fatal')
    else {
      assert.equal(r.ok, false, name)
      assert.equal(r.error.code, 'bad-response', name)
    }
  }
})

test('apple_health: the byte limit stops an oversized stream', async () => {
  async function* huge() { for (let i = 0; i < 50; i++) yield Buffer.alloc(1024, 32) }
  await assert.rejects(() => scanHealthXml(huge(), () => {}, { maxBytes: 10_000 }), (e) => e.code === 'bad-response')
})

test('apple_health: tags split across chunk boundaries and multi-byte text parse the same', async () => {
  const text = xml(fixtureBody())
  const bytes = Buffer.from(text.replace('Apple Watch', 'Appel Wätch ✓'))
  const seen = []
  async function* pieces(size) { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size) }
  for (const size of [1, 7, 64, 100000]) {
    seen.length = 0
    const r = await scanHealthXml(pieces(size), (n, a) => seen.push(`${n}:${a.type ?? a.workoutActivityType}:${a.sourceName ?? ''}`))
    assert.equal(r.sawRoot, true)
    assert.equal(seen.length, 12, `chunk size ${size}`)
    assert.ok(seen.some((s) => s.includes('Appel Wätch ✓')))
  }
})

test('apple_health: helpers', () => {
  assert.deepEqual(parseAttributes('a="1&amp;2" b="&lt;x&gt;" c="&#65;&#x42;" d="&bogus;"'), { a: '1&2', b: '<x>', c: 'AB', d: '&bogus;' })
  assert.equal(parseHealthDate('2026-11-01 08:00:00 +0530').ms, Date.parse('2026-11-01T08:00:00+05:30'))
  assert.equal(parseHealthDate('2026-11-01 08:00:00 +0530').day, '2026-11-01')
  assert.equal(parseHealthDate('nonsense'), null)
  assert.equal(parseHealthCursor('{"v":2}'), null)
  assert.equal(parseHealthCursor('x'), null)
  const agg = createAggregator({ nowMs: NOW })
  agg.add('Record', { type: 'HKQuantityTypeIdentifierStepCount', value: '-5', startDate: `${D1} 08:00:00 +0000`, sourceName: 'a' })
  agg.add('Record', { type: 'HKQuantityTypeIdentifierStepCount', value: 'abc', startDate: `${D1} 08:00:00 +0000`, sourceName: 'a' })
  agg.add('Workout', { workoutActivityType: 'not-a-type', startDate: `${D1} 08:00:00 +0000` })
  assert.deepEqual(agg.finish(), { days: [], workouts: [] })
})

test('apple_health: injection text in a source name is neutralised and changes nothing', async () => {
  const { file } = fixture({ body: fixtureBody({ injection: INJECTION_TEXT.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]) }) })
  const { registry } = setup({ file })
  const before = registry.grants.of(ID)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true)
  const hit = r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.ok(hit, 'the fixture must reach a document')
  for (const d of r.documents) {
    assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
    assert.ok(!/<system>/i.test(d.text))
  }
  assert.deepEqual(registry.grants.of(ID), before, 'no grant changed')
})

test('apple_health: health documents are withheld from the model unless the vault is allowed; erase clears them', async () => {
  const { file } = fixture()
  const erased = []
  const { registry, credentials } = setup({ file, onErase: (id) => erased.push(id) })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 2)
    let allow = false
    const search = documentsConnector({ store, isActive: () => true, allowVault: () => allow }).tools().find((t) => /search/.test(t.name))
    assert.equal(JSON.stringify(await search.run({ query: 'steps' })).includes('5,500'), false)
    allow = true
    assert.match(JSON.stringify(await search.run({ query: 'steps' })), /steps/)
    assert.equal((await registry.disconnect(ID, { eraseData: true })).ok, true)
    assert.deepEqual(erased, [ID])
    assert.deepEqual(credentials.describe(ID).keys, [])
    assert.equal((await registry.sync(ID)).error.code, 'not-connected')
  } finally {
    store.close()
  }
})

test('apple_health: no write tools; kill switches stop sync', async () => {
  const { file } = fixture()
  const { registry } = setup({ file })
  assert.throws(() => registry.grants.grant(ID, 'write'))
  registry.grants.disable(ID)
  assert.equal((await registry.sync(ID)).error.code, 'disabled')
  registry.grants.enable(ID)
  registry.grants.freezeAll()
  assert.equal((await registry.sync(ID)).error.code, 'frozen')
})
