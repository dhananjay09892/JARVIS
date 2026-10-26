// Q24 · Plan 05 phase 2: before/after numbers from the local turn traces.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTraces } from '../bridge/traces.mjs'
import { parseArgs, report, splitAt } from './latency-report.mjs'

const SPLIT = Date.parse('2026-10-27T12:00:00Z')

const turn = (id, startedAt, firstToken, firstAudio, outcome = 'ok') => ({
  id, startedAt, route: 'bridge', outcome,
  marks: { speechEnd: -300, firstToken, firstAudio, end: firstAudio + 2000 },
})

test('splits traces at the given moment', () => {
  const { before, after } = splitAt([{ startedAt: SPLIT - 1 }, { startedAt: SPLIT }, { startedAt: SPLIT + 1 }], SPLIT)
  assert.equal(before.length, 1)
  assert.equal(after.length, 2)
})

test('reports median and p95 before and after, with the change', () => {
  const traces = [
    turn('a1', SPLIT - 3000, 900, 1400),
    turn('a2', SPLIT - 2000, 1000, 1500),
    turn('a3', SPLIT - 1000, 1100, 1600),
    turn('b1', SPLIT + 1000, 900, 1100),
    turn('b2', SPLIT + 2000, 1000, 1200),
    turn('b3', SPLIT + 3000, 1100, 1300),
  ]
  const out = report(traces, SPLIT)
  assert.match(out, /Before: 3 turns \(3 with audio\) · After: 3 turns \(3 with audio\)/)
  // Measured from end of speech (−300 ms), so 1500 → 1800 and 1200 → 1500.
  assert.match(out, /\| end of speech → first audio, median \| 1800 ms \| 1500 ms \| -300 ms \|/)
  assert.match(out, /\| end of speech → first token, median \| 1300 ms \| 1300 ms \| 0 ms \|/)
})

test('a side with no turns shows dashes rather than inventing numbers', () => {
  const out = report([turn('a1', SPLIT - 1000, 900, 1400)], SPLIT)
  assert.match(out, /\| end of speech → first audio, median \| 1700 ms \| — \| — \|/)
})

test('without a split it summarises everything', () => {
  const out = report([turn('a1', SPLIT, 900, 1400), turn('a2', SPLIT, 900, 0, 'error')])
  assert.match(out, /Turns: 2 \(1 with audio, 1 errors, 0 interrupted\)/)
})

test('reads the real trace store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-latency-'))
  try {
    const store = openTraces({ dir, retentionDays: 0, maxRows: 0, clock: () => SPLIT })
    store.record(turn('a1', SPLIT - 1000, 900, 1400))
    store.record(turn('b1', SPLIT + 1000, 800, 1000))
    const out = report(store.recent(100), SPLIT)
    store.close()
    assert.match(out, /Before: 1 turns.*After: 1 turns/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parses --since and refuses a bad date', () => {
  assert.equal(parseArgs(['--since', '2026-10-27T12:00:00Z']).since, SPLIT)
  assert.equal(parseArgs([]).since, null)
  assert.throws(() => parseArgs(['--since', 'yesterday-ish']), /--since needs a date/)
})
