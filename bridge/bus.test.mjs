import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBus, checkBusEvent, TOPICS, PUBLISHABLE } from './bus.mjs'
import { checkContract, TOPICS as CONTRACT_TOPICS } from '../shared/contracts.ts'

const silent = { error() {} }
const tick = () => new Promise((r) => setImmediate(r))
const T0 = 1_766_000_000_000

const RUN = {
  runId: 'run-1', workflowId: 'wf-1', name: 'Morning build', trigger: 'schedule',
  status: 'running', stepsTotal: 2, stepsCompleted: 0, startedAt: T0,
}
const ENDED = { ...RUN, status: 'completed', stepsCompleted: 2, finishedAt: T0 + 1000 }
const OUTCOME = {
  taskId: 't1a2b3c4', title: 'Summarise the report', status: 'done', summary: 'Three points.',
  endedAt: T0, sensitivity: 'private',
}
const ev = (topic, payload, extra = {}) => ({ v: 1, id: 'ev-1', ts: T0, topic, payload, ...extra })

const VALID = [
  ev('workflow.started', RUN),
  ev('workflow.started', RUN, { traceId: '0123456789abcdef' }),
  ev('workflow.finished', ENDED),
  ev('workflow.finished', { ...RUN, status: 'failed', stepsCompleted: 1, finishedAt: T0 }),
  ev('workflow.started', { ...RUN, trigger: 'manual', stepsTotal: 0 }),
  ev('task.finished', OUTCOME),
  ev('task.finished', { ...OUTCOME, status: 'interrupted', summary: '', costUsd: 0, startedAt: T0 - 5 }),
  ev('task.finished', { ...OUTCOME, status: 'cancelled', sensitivity: 'vault' }),
  ev('task.finished', { ...OUTCOME, extra: 'unknown fields are allowed' }),
]

const INVALID = [
  null,
  [],
  'task.finished',
  ev('made.up', OUTCOME),
  ev('task.finished', OUTCOME, { v: 2 }),
  ev('task.finished', OUTCOME, { id: 'has space' }),
  ev('task.finished', OUTCOME, { ts: -1 }),
  ev('task.finished', OUTCOME, { ts: 1.5 }),
  ev('task.finished', OUTCOME, { traceId: 'not-hex' }),
  ev('task.finished', null),
  ev('task.finished', [OUTCOME]),
  ev('task.finished', { ...OUTCOME, status: 'running' }),
  ev('task.finished', { ...OUTCOME, title: '' }),
  ev('task.finished', { ...OUTCOME, title: 'x'.repeat(61) }),
  ev('task.finished', { ...OUTCOME, summary: 'x'.repeat(301) }),
  ev('task.finished', { ...OUTCOME, costUsd: -1 }),
  ev('task.finished', { ...OUTCOME, costUsd: Number.NaN }),
  ev('task.finished', { ...OUTCOME, endedAt: undefined }),
  ev('task.finished', { ...OUTCOME, taskId: 'has space' }),
  ev('workflow.started', { ...RUN, trigger: 'cron' }),
  ev('workflow.started', { ...RUN, finishedAt: T0 }),
  ev('workflow.finished', { ...RUN, status: 'failed' }),
  ev('workflow.started', { ...RUN, stepsCompleted: 3 }),
  ev('workflow.started', { ...RUN, stepsTotal: -1 }),
  ev('workflow.started', { ...RUN, name: '' }),
  ev('workflow.finished', { ...ENDED, status: 'interrupted' }),
]

test('the bridge topic list is the contract topic list', () => {
  assert.deepEqual([...TOPICS], [...CONTRACT_TOPICS])
  for (const t of PUBLISHABLE) assert.ok(TOPICS.includes(t), t)
})

test('bridge check and contract agree on every sample', () => {
  for (const e of VALID) {
    assert.deepEqual(checkBusEvent(e), { ok: true }, JSON.stringify(e))
    const c = checkContract('BusEvent', e)
    assert.ok(c.ok, `${JSON.stringify(e)}: ${c.ok ? '' : c.errors.join('; ')}`)
  }
  for (const e of INVALID) {
    assert.equal(checkBusEvent(e).ok, false, `bridge accepted ${JSON.stringify(e)}`)
    assert.equal(checkContract('BusEvent', e).ok, false, `contract accepted ${JSON.stringify(e)}`)
  }
})

test('a topic with no bridge payload check cannot be published yet', () => {
  const r = checkBusEvent(ev('presence.changed', { room: 'study' }))
  assert.equal(r.ok, false)
  assert.match(r.error, /no payload check/)
})

test('errors name the field, never the value', () => {
  const secret = 'sk-live-THIS-SHOULD-NOT-APPEAR'
  for (const e of [
    ev('task.finished', { ...OUTCOME, status: secret }),
    ev('task.finished', { ...OUTCOME, title: secret.repeat(5) }),
    ev(secret, OUTCOME),
    ev('task.finished', OUTCOME, { traceId: secret }),
  ]) {
    const r = checkBusEvent(e)
    assert.equal(r.ok, false)
    assert.ok(!r.error.includes(secret), r.error)
  }
})

test('publish wraps the payload in a contract-valid envelope and delivers it after returning', async () => {
  const bus = createBus({ now: () => T0, log: silent })
  const got = []
  bus.subscribe('task.finished', (e) => got.push(e))
  const r = bus.publish('task.finished', OUTCOME, { traceId: '0123456789abcdef' })
  assert.ok(r.ok)
  assert.equal(got.length, 0, 'listeners run after publish returns')
  await tick()
  assert.equal(got.length, 1)
  assert.equal(got[0], r.event)
  assert.equal(got[0].v, 1)
  assert.equal(got[0].ts, T0)
  assert.equal(got[0].traceId, '0123456789abcdef')
  assert.match(got[0].id, /^ev-/)
  assert.ok(checkContract('BusEvent', got[0]).ok)
})

test('each event gets its own id', () => {
  const bus = createBus({ log: silent })
  const a = bus.publish('task.finished', OUTCOME)
  const b = bus.publish('task.finished', OUTCOME)
  assert.notEqual(a.event.id, b.event.id)
})

test('an invalid event is refused, counted and never delivered', async () => {
  const logged = []
  const bus = createBus({ log: { error: (...a) => logged.push(a.join(' ')) } })
  let heard = 0
  bus.subscribe('*', () => { heard += 1 })
  const secret = 'private words'
  const r = bus.publish('task.finished', { ...OUTCOME, status: secret })
  assert.equal(r.ok, false)
  assert.equal(bus.publish('made.up', {}).ok, false)
  await tick()
  assert.equal(heard, 0)
  assert.equal(bus.stats().rejected, 2)
  assert.deepEqual(bus.stats().published, {})
  assert.ok(logged.every((l) => !l.includes(secret)), logged.join('\n'))
  assert.ok(logged.some((l) => l.includes('unknown-topic')))
})

test('unknown payload fields are dropped before listeners see them', async () => {
  const bus = createBus({ log: silent })
  const got = []
  bus.subscribe('task.finished', (e) => got.push(e))
  bus.publish('task.finished', { ...OUTCOME, internal: { abort: 'signal' } })
  await tick()
  assert.equal('internal' in got[0].payload, false)
  assert.equal(got[0].payload.summary, OUTCOME.summary)
})

test('patterns: exact topic, prefix and everything; typos throw', async () => {
  const bus = createBus({ log: silent })
  const seen = { exact: [], prefix: [], all: [] }
  bus.subscribe('workflow.finished', (e) => seen.exact.push(e.topic))
  bus.subscribe('workflow.*', (e) => seen.prefix.push(e.topic))
  bus.subscribe('*', (e) => seen.all.push(e.topic))
  bus.publish('workflow.started', RUN)
  bus.publish('workflow.finished', ENDED)
  bus.publish('task.finished', OUTCOME)
  await tick()
  assert.deepEqual(seen.exact, ['workflow.finished'])
  assert.deepEqual(seen.prefix, ['workflow.started', 'workflow.finished'])
  assert.deepEqual(seen.all, ['workflow.started', 'workflow.finished', 'task.finished'])
  for (const bad of ['task.finish', 'nope.*', 'task', '', null, 'task.finished.*']) {
    assert.throws(() => bus.subscribe(bad, () => {}), /Unknown bus topic pattern/, String(bad))
  }
  assert.throws(() => bus.subscribe('*', 'not a function'), TypeError)
})

test('a failing listener does not stop the others or the publisher, and is counted', async () => {
  const bus = createBus({ log: silent })
  let after = 0
  bus.subscribe('*', () => { throw new Error('boom') })
  bus.subscribe('*', async () => { throw new Error('async boom') })
  bus.subscribe('*', () => { after += 1 })
  assert.ok(bus.publish('task.finished', OUTCOME).ok)
  await tick()
  assert.equal(after, 1)
  assert.equal(bus.stats().listenerErrors, 2)
})

test('listeners get a frozen event, so one cannot change what another sees', async () => {
  const bus = createBus({ log: silent })
  const original = { ...OUTCOME }
  const got = []
  bus.subscribe('*', (e) => {
    assert.throws(() => { e.payload.summary = 'changed' }, TypeError)
    assert.throws(() => { e.topic = 'freeze.on' }, TypeError)
    got.push(e.payload.summary)
  })
  bus.subscribe('*', (e) => got.push(e.payload.summary))
  bus.publish('task.finished', original)
  original.summary = 'changed by the publisher afterwards'
  await tick()
  assert.deepEqual(got, [OUTCOME.summary, OUTCOME.summary])
})

test('unsubscribe stops delivery, including for an event already queued', async () => {
  const bus = createBus({ log: silent })
  let heard = 0
  const off = bus.subscribe('*', () => { heard += 1 })
  bus.publish('task.finished', OUTCOME)
  off()
  await tick()
  assert.equal(heard, 0)
  assert.equal(bus.stats().listeners, 0)
})

test('stats hold counts per topic and never a payload', async () => {
  const bus = createBus({ now: () => T0, log: silent })
  bus.subscribe('*', () => {})
  bus.publish('task.finished', { ...OUTCOME, summary: 'the secret plan' })
  bus.publish('workflow.started', RUN)
  bus.publish('workflow.finished', ENDED)
  bus.publish('task.finished', OUTCOME)
  const s = bus.stats()
  assert.deepEqual(s.published, { 'task.finished': 2, 'workflow.started': 1, 'workflow.finished': 1 })
  assert.equal(s.listeners, 1)
  assert.equal(s.since, new Date(T0).toISOString())
  assert.ok(!JSON.stringify(s).includes('secret'))
})
