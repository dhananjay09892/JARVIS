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

test('reflex turns keep their family, never free text (plan 06, Q25)', () => {
  const r = normaliseTrace(base({ route: 'reflex', reflex: 'timer', marks: { speechEnd: -300, firstAudio: 120, end: 900 } }))
  assert.equal(r.route, 'reflex')
  assert.equal(r.reflex, 'timer')
  // Unknown or free-text families are dropped, and only reflex turns carry one.
  assert.equal(normaliseTrace(base({ route: 'reflex', reflex: 'set a timer for my pasta' })).reflex, undefined)
  assert.equal(normaliseTrace(base({ reflex: 'time' })).reflex, undefined)
})

test('summarise reports reflex turns apart from model turns (plan 06, Q25)', () => {
  const traces = [
    ...[1000, 1200, 1400].map((ms, i) => base({ id: `m${i}`, marks: { speechEnd: 0, firstToken: ms - 200, firstAudio: ms, end: ms + 1 } })),
    ...[150, 200, 250, 300].map((ms, i) =>
      base({ id: `r${i}`, route: 'reflex', reflex: 'time', marks: { speechEnd: 0, firstAudio: ms, end: ms + 1 } })),
    base({ id: 'stop', route: 'reflex', reflex: 'stop', marks: { speechEnd: 0, end: 5 } }),
  ].map((t) => normaliseTrace(t))
  const s = summarise(traces)
  assert.equal(s.turns, 8)
  assert.deepEqual(s.routes, { bridge: 3, direct: 0, reflex: 5 })
  // The headline is the model's number alone.
  assert.deepEqual(s.latency, { n: 3, median: 1200, p95: 1400 })
  assert.equal(s.stages.firstAudio.n, 3)
  // Reflexes: five turns, none with a first token (no model call), four that spoke.
  assert.equal(s.reflex.turns, 5)
  assert.equal(s.reflex.modelCalls, 0)
  assert.deepEqual(s.reflex.latency, { n: 4, median: 200, p95: 300 })
})

test('bridge turns keep the routed path and reason, never free text (plan 06 phase 2, Q26)', () => {
  const t = normaliseTrace(base({ path: 'fast', pathReason: 'chat', model: 'claude-sonnet-5' }), { model: 'claude-opus-5' })
  assert.equal(t.path, 'fast')
  assert.equal(t.pathReason, 'chat')
  // The model that answered this turn wins over the bridge's default.
  assert.equal(t.model, 'claude-sonnet-5')
  // Unknown paths and reasons are dropped; only bridge turns carry a path.
  assert.equal(normaliseTrace(base({ path: 'medium' })).path, undefined)
  const odd = normaliseTrace(base({ path: 'deep', pathReason: 'because I asked about my bank' }))
  assert.equal(odd.path, 'deep')
  assert.equal(odd.pathReason, undefined)
  assert.equal(normaliseTrace(base({ route: 'direct', path: 'fast', pathReason: 'chat' })).path, undefined)
  assert.equal(normaliseTrace(base({ route: 'reflex', reflex: 'time', path: 'fast' })).path, undefined)
})

test('summarise reports fast/deep routing (plan 06 phase 2, Q26)', () => {
  const turn = (id, path, pathReason, firstAudio, tools = []) =>
    base({ id, path, pathReason, tools, marks: { speechEnd: 0, firstToken: firstAudio - 100, firstAudio, end: firstAudio + 1 } })
  const traces = [
    turn('f1', 'fast', 'chat', 600),
    turn('f2', 'fast', 'chat', 700),
    turn('f3', 'fast', 'chat', 800, ['mcp__gcal__list_events']),
    turn('d1', 'deep', 'tools', 2000, ['WebSearch']),
    turn('d2', 'deep', 'follow-up', 3000),
    // Older pages send no path; they count as turns but not as routed.
    base({ id: 'old', marks: { speechEnd: 0, firstAudio: 1500, end: 1501 } }),
    base({ id: 'r', route: 'reflex', reflex: 'time', marks: { speechEnd: 0, firstAudio: 100, end: 101 } }),
  ].map((t) => normaliseTrace(t))
  const s = summarise(traces).paths
  assert.equal(s.routed, 5)
  assert.equal(s.fastShare, 0.6)
  assert.deepEqual(s.fast, { turns: 3, toolTurns: 1, latency: { n: 3, median: 700, p95: 800 } })
  assert.deepEqual(s.deep, { turns: 2, toolTurns: 1, latency: { n: 2, median: 2000, p95: 3000 } })
  assert.deepEqual(s.reasons, { off: 0, chat: 3, tools: 1, reasoning: 0, long: 0, 'follow-up': 1, default: 0 })
  assert.equal(summarise([]).paths.fastShare, null)
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
