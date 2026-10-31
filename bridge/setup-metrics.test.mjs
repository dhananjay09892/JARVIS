// Plan 29 phase 1 + plan 16 (Q77): the opt-in setup drop-off metric.
// "Done when": a completed and an abandoned wizard are counted correctly with
// metrics on, and nothing is stored with them off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FINDING_IDS,
  WIZARD_STEPS,
  createSetupMetrics,
  normaliseSetupEvent,
  setupMetricsOn,
  summariseSetup,
} from './setup-metrics.mjs'

const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-setup-'))
  return { dir, file: join(dir, 'nested', 'setup-metrics.json') }
}
const ev = (run, kind, step, extra = {}) => ({ run, kind, step, at: Date.now(), ...extra })

test('a completed and an abandoned wizard are counted correctly with metrics on', (t) => {
  const { dir, file } = tmpFile()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const m = createSetupMetrics({ enabled: () => true, file })

  // Run A: all four steps, then Finish.
  m.record(ev('run-aaaaaa', 'start', 'hardware'))
  m.record(ev('run-aaaaaa', 'reach', 'claude'))
  m.record(ev('run-aaaaaa', 'reach', 'voice'))
  m.record(ev('run-aaaaaa', 'reach', 'finish'))
  m.record(ev('run-aaaaaa', 'complete', 'finish'))
  // Run B: got to the Claude step and the window was closed.
  m.record(ev('run-bbbbbb', 'start', 'hardware'))
  m.record(ev('run-bbbbbb', 'reach', 'claude'))

  const s = m.stats()
  assert.equal(s.enabled, true)
  assert.equal(s.runs, 2)
  assert.equal(s.completed, 1)
  assert.equal(s.abandoned, 1)
  assert.equal(s.skipped, 0)
  assert.equal(s.completionRate, 0.5)
  assert.deepEqual(s.leftAt, { hardware: 0, claude: 1, voice: 0, finish: 0 })
})

test('nothing is stored with metrics off, and the file is not even created', (t) => {
  const { dir, file } = tmpFile()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const m = createSetupMetrics({ enabled: () => false, file })
  assert.equal(m.record(ev('run-aaaaaa', 'start', 'hardware')), false)
  assert.equal(m.record(ev('run-aaaaaa', 'complete', 'finish')), false)
  assert.equal(m.record({ kind: 'selftest', run: 'run-aaaaaa', findings: ['mic-muted'] }), false)
  assert.equal(existsSync(file), false)
  assert.deepEqual(m.stats(), { enabled: false })
})

test('turning it off part-way stops at once, and clear() deletes what was kept', (t) => {
  const { dir, file } = tmpFile()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let on = true
  const m = createSetupMetrics({ enabled: () => on, file })
  m.record(ev('run-aaaaaa', 'start', 'hardware'))
  on = false
  m.record(ev('run-aaaaaa', 'complete', 'finish'))
  on = true
  assert.equal(m.stats().completed, 0)
  m.clear()
  assert.equal(existsSync(file), false)
  assert.equal(m.stats().runs, 0)
})

test('skipping counts as stopping at the step it was skipped from', () => {
  const s = summariseSetup([
    ev('r1', 'start', 'hardware'),
    ev('r1', 'skip', 'hardware'),
    ev('r2', 'start', 'hardware'),
    ev('r2', 'reach', 'claude'),
    ev('r2', 'reach', 'voice'),
    // Back to Claude, then skipped: the furthest step is still "voice".
    ev('r2', 'reach', 'claude'),
    ev('r2', 'skip', 'claude'),
  ])
  assert.equal(s.skipped, 2)
  assert.equal(s.completionRate, 0)
  assert.deepEqual(s.leftAt, { hardware: 1, claude: 0, voice: 1, finish: 0 })
})

test('no runs yet: the completion rate is null, not 0 %', () => {
  const s = summariseSetup([])
  assert.equal(s.runs, 0)
  assert.equal(s.completionRate, null)
})

test('the most common self-test problems, most frequent first', () => {
  const st = (findings) => ({ kind: 'selftest', run: 'x', place: 'wizard', findings })
  const s = summariseSetup([st(['mic-muted', 'echo-some']), st(['mic-muted']), st([]), st(['noise-some'])])
  assert.equal(s.selftest.runs, 4)
  assert.equal(s.selftest.clean, 1)
  assert.deepEqual(s.selftest.failures, [
    { id: 'mic-muted', count: 2 },
    { id: 'echo-some', count: 1 },
    { id: 'noise-some', count: 1 },
  ])
})

test('only known step and finding words are stored: never device names or free text', (t) => {
  const { dir, file } = tmpFile()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const m = createSetupMetrics({ enabled: () => true, file })
  m.record({
    kind: 'selftest',
    run: 'run-aaaaaa',
    place: 'wizard',
    findings: ['mic-muted', 'Microphone (Realtek(R) Audio)', 'mic-muted', 42],
    label: 'Headset (Jabra Evolve 65)',
    levels: [-60, -20],
  })
  const raw = readFileSync(file, 'utf8')
  assert.doesNotMatch(raw, /Realtek|Jabra|label|levels|-60/)
  assert.deepEqual(JSON.parse(raw).events[0].findings, ['mic-muted'])
})

test('malformed events are refused, not half-stored', () => {
  assert.throws(() => normaliseSetupEvent(null), /object/)
  assert.throws(() => normaliseSetupEvent({ kind: 'nope', run: 'run-aaaaaa' }), /kind/)
  assert.throws(() => normaliseSetupEvent({ kind: 'reach', run: 'x' }), /run id/)
  assert.throws(() => normaliseSetupEvent({ kind: 'reach', run: 'run-aaaaaa', step: 'Realtek' }), /step/)
  // A clock far off is replaced by the bridge's own time.
  const e = normaliseSetupEvent({ kind: 'start', run: 'run-aaaaaa', at: 1 }, { now: 5_000_000_000 })
  assert.equal(e.at, 5_000_000_000)
})

test('the store keeps only the newest events', (t) => {
  const { dir, file } = tmpFile()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const m = createSetupMetrics({ enabled: () => true, file, maxEvents: 3 })
  for (let i = 0; i < 5; i++) m.record(ev(`run-${i}aaaaa`, 'start', 'hardware'))
  assert.equal(m.stats().runs, 3)
})

test('off unless explicitly turned on', () => {
  assert.equal(setupMetricsOn(undefined), false)
  assert.equal(setupMetricsOn(''), false)
  assert.equal(setupMetricsOn('0'), false)
  assert.equal(setupMetricsOn('1'), true)
})

test('every problem the self-test can report is on the list (kept in step with src/lib/selftest.ts)', () => {
  const src = readFileSync(new URL('../src/lib/selftest.ts', import.meta.url), 'utf8')
  // Each finding is written as `id: '…', severity: '…'`.
  const found = [...src.matchAll(/id: '([a-z-]+)',\s*severity: '(ok|warn|fail)'/g)]
  assert.ok(found.length > 20, 'expected to find the self-test findings')
  for (const [, id, severity] of found) {
    if (severity === 'ok') assert.ok(!FINDING_IDS.includes(id), `${id} is ok and should not be counted`)
    else assert.ok(FINDING_IDS.includes(id), `${id} missing from FINDING_IDS`)
  }
  const ui = readFileSync(new URL('../src/lib/setupMetrics.ts', import.meta.url), 'utf8')
  assert.ok(ui.includes(`[${WIZARD_STEPS.map((s) => `'${s}'`).join(', ')}]`), 'WIZARD_STEPS differ between page and bridge')
})

test('the bridge serves the metric with the Origin rule on writes and deletes it when turned off', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const route = src.slice(src.indexOf("if (requestUrl.pathname === '/setup-metrics' && req.method === 'POST') {"))
  assert.match(route.slice(0, 200), /if \(!origin\) \{\s*res\.writeHead\(403/)
  assert.match(src, /if \(changed\.includes\('JARVIS_SETUP_METRICS'\)\) applySetupMetrics\(\)/)
})
