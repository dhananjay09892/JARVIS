import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latencyOf, normaliseTrace, openTraces, percentile, summarise } from './traces.mjs'

const base = (over = {}) => ({
  id: 't1',
  route: 'bridge',
  outcome: 'ok',
  marks: { speechEnd: -400, transcribed: -50, firstToken: 700, firstAudio: 900, end: 3000 },
  tools: [],
  ...over,
})

const withStore = (fn, opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-traces-'))
  const store = openTraces({ dir, ...opts })
  try {
    return fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('percentile uses nearest rank', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([5], 95), 5)
  assert.equal(percentile([1, 2, 3, 4], 50), 2)
  assert.equal(percentile([3, 1, 2], 50), 2)
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(percentile(hundred, 95), 95)
  assert.equal(percentile([1, NaN, 3], 50), 1)
})

test('latency is end of speech to first audio, or from turn start without speech', () => {
  assert.equal(latencyOf(base()), 1300)
  assert.equal(latencyOf(base({ marks: { firstAudio: 800, end: 900 } })), 800)
  assert.equal(latencyOf(base({ marks: { speechEnd: -100, end: 900 } })), null)
})

test('normaliseTrace keeps timings and tool names, never text', () => {
  const t = normaliseTrace(
    base({ said: 'my password is hunter2', answer: 'secret', tools: ['mcp__gcal__list_events', 'bad name!'] }),
    { model: 'claude-opus-5' },
  )
  assert.equal(t.model, 'claude-opus-5')
  assert.deepEqual(t.tools, ['mcp__gcal__list_events'])
  assert.equal('said' in t, false)
  assert.equal('answer' in t, false)
  assert.doesNotMatch(JSON.stringify(t), /hunter2|secret/)
})

test('normaliseTrace redacts and truncates errors', () => {
  const t = normaliseTrace(base({ outcome: 'error', error: `failed with sk-ant-${'x'.repeat(30)} ${'y'.repeat(500)}` }))
  assert.match(t.error, /\[redacted\]/)
  assert.ok(t.error.length <= 200)
})

test('normaliseTrace rejects malformed traces', () => {
  for (const bad of [
    null, [], 'x',
    base({ id: '' }), base({ id: '../etc' }),
    base({ route: 'smoke-signal' }), base({ outcome: 'great' }),
    base({ marks: { firstAudio: 10 } }),
    base({ marks: { end: Infinity } }), base({ marks: { end: '5' } }),
    base({ marks: { end: 10, firstToken: 1e12 } }),
  ]) {
    assert.throws(() => normaliseTrace(bad), undefined, JSON.stringify(bad))
  }
})

test('summarise reports rolling median and p95 over completed turns', () => {
  const traces = [
    ...[800, 900, 1000, 1100, 3000].map((ms, i) => base({ id: `a${i}`, marks: { speechEnd: 0, firstAudio: ms, end: ms + 1 } })),
    base({ id: 'e', outcome: 'error', marks: { end: 50 } }),
    base({ id: 'i', outcome: 'interrupted', marks: { speechEnd: 0, firstAudio: 99999, end: 100000 } }),
  ].map((t) => normaliseTrace(t))
  const s = summarise(traces)
  assert.equal(s.turns, 7)
  assert.equal(s.errors, 1)
  assert.equal(s.interrupted, 1)
  assert.deepEqual(s.latency, { n: 5, median: 1000, p95: 3000 })
})

test('store records, returns newest first, and summarises', () => {
  let now = 1_000_000_000_000
  withStore((store) => {
    for (let i = 0; i < 3; i++) {
      now += 1000
      store.record(base({ id: `t${i}`, startedAt: now }))
    }
    assert.deepEqual(store.recent(10).map((t) => t.id), ['t2', 't1', 't0'])
    const s = store.stats(50)
    assert.equal(s.turns, 3)
    assert.equal(s.latency.median, 1300)
  }, { clock: () => now })
})

test('store prunes by age and by count', () => {
  let now = 1_000_000_000_000
  withStore((store) => {
    store.record(base({ id: 'old', startedAt: now }))
    now += 3 * 24 * 3600_000
    for (let i = 0; i < 5; i++) store.record(base({ id: `n${i}`, startedAt: now + i }))
    const ids = store.recent(100).map((t) => t.id)
    assert.equal(ids.includes('old'), false)
    assert.equal(store.count(), 3)
    assert.deepEqual(ids, ['n4', 'n3', 'n2'])
  }, { clock: () => now, retentionDays: 2, maxRows: 3 })
})
