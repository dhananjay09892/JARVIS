import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_STEP_UPDATES, MIN_GAP_MS, createNarrator, missionMetrics, narrateMode } from './mission-narration.mjs'
import { createBus } from './bus.mjs'
import { createNotifier, decide, parseQuietHours } from './notify-policy.mjs'

const snap = (over = {}) => ({
  id: 't1', title: 'Plan the trip', goal: 'g', status: 'running',
  steps: [{ label: 'Find flights', state: 'active' }, { label: 'Book hotel', state: 'todo' }, { label: 'Write itinerary', state: 'todo' }, { label: 'Send it', state: 'todo' }],
  log: [], result: '', error: '', ...over,
})
const passedSteps = (n, over = {}) => snap({
  steps: ['a', 'b', 'c', 'd'].map((label, i) => ({ label, state: i < n ? 'done' : 'todo', ...(i < n && { outcome: 'passed' }) })),
  ...over,
})
const frame = (task) => ({ type: 'task', task })

function setup(mode = 'milestones') {
  const sent = []
  const clock = { t: 1_000_000 }
  const narrator = createNarrator({ notify: (n) => sent.push(n), mode: () => mode, now: () => clock.t })
  return { sent, clock, narrator }
}

test('narrateMode: unknown values give the default', () => {
  assert.equal(narrateMode('done'), 'done')
  assert.equal(narrateMode('off'), 'off')
  assert.equal(narrateMode(''), 'milestones')
  assert.equal(narrateMode(undefined), 'milestones')
})

test('a passed step is narrated once, and not again inside the gap', () => {
  const { sent, clock, narrator } = setup()
  narrator.observe(frame(snap()))
  narrator.observe(frame(passedSteps(1)))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /step 1 of 4 done/)
  assert.equal(sent[0].urgency, 'important')
  assert.equal(sent[0].privacy, 'private')
  assert.ok(sent[0].expiresAt > clock.t)
  clock.t += 1000
  narrator.observe(frame(passedSteps(2)))
  assert.equal(sent.length, 1)
  assert.equal(narrator.stats().skipped, 1)
  clock.t += MIN_GAP_MS
  narrator.observe(frame(passedSteps(3)))
  assert.equal(sent.length, 2)
  clock.t += MIN_GAP_MS
  narrator.observe(frame(passedSteps(4)))
  assert.equal(sent.length, 2, 'the last step is left to the completion summary')
})

test('step updates are capped per mission', () => {
  const { sent, clock, narrator } = setup()
  const steps = (n, total) => snap({ steps: Array.from({ length: total }, (_, i) => ({ label: `s${i}`, state: 'todo', ...(i < n && { outcome: 'passed' }) })) })
  narrator.observe(frame(steps(0, 12)))
  for (let i = 1; i <= 10; i++) {
    clock.t += MIN_GAP_MS
    narrator.observe(frame(steps(i, 12)))
  }
  assert.equal(sent.length, MAX_STEP_UPDATES)
})

test('blocked says why and gives the options', () => {
  const { sent, narrator } = setup()
  narrator.observe(frame(snap()))
  narrator.observe(frame(snap({ status: 'blocked', blocked: { kind: 'worker', reason: 'The site needs a login', options: ['Give me the login', 'Skip the site'] } })))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /is blocked/)
  assert.match(sent[0].body, /needs a login/)
  assert.match(sent[0].body, /A\) Give me the login; B\) Skip the site/)
  // A repeat frame while still blocked says nothing more.
  narrator.observe(frame(snap({ status: 'blocked', blocked: { kind: 'worker', reason: 'x', options: [] } })))
  assert.equal(sent.length, 1)
})

test('done and failed give a summary once; cancelled says nothing', () => {
  const a = setup()
  a.narrator.observe(frame(snap()))
  a.narrator.observe(frame(snap({ status: 'done', result: 'Trip planned: 3 days.' })))
  a.narrator.observe(frame(snap({ status: 'done', result: 'Trip planned: 3 days.' })))
  assert.equal(a.sent.length, 1)
  assert.match(a.sent[0].title, /is done/)
  assert.match(a.sent[0].body, /3 days/)

  const b = setup()
  b.narrator.observe(frame(snap()))
  b.narrator.observe(frame(snap({ status: 'failed', error: 'It ran out of time.' })))
  assert.match(b.sent[0].title, /could not finish/)

  const c = setup()
  c.narrator.observe(frame(snap()))
  c.narrator.observe(frame(snap({ status: 'cancelled' })))
  assert.equal(c.sent.length, 0)
})

test('modes: done skips steps, off says nothing', () => {
  const d = setup('done')
  d.narrator.observe(frame(snap()))
  d.narrator.observe(frame(passedSteps(1)))
  assert.equal(d.sent.length, 0)
  d.narrator.observe(frame(snap({ status: 'done', result: 'ok' })))
  assert.equal(d.sent.length, 1)

  const o = setup('off')
  o.narrator.observe(frame(snap()))
  o.narrator.observe(frame(passedSteps(1)))
  o.narrator.observe(frame(snap({ status: 'blocked', blocked: { kind: 'worker', reason: 'r', options: [] } })))
  o.narrator.observe(frame(snap({ status: 'done' })))
  assert.equal(o.sent.length, 0)
})

test('missions already over, or held, when first seen are baseline only', () => {
  const { sent, narrator } = setup()
  narrator.observe(frame(snap({ id: 'old', status: 'done', result: 'old news' })))
  narrator.observe(frame(snap({ id: 'old', status: 'done', result: 'old news' })))
  narrator.observe(frame(snap({ id: 'held', status: 'blocked', blocked: { kind: 'worker', reason: 'r', options: [] } })))
  assert.equal(sent.length, 0)
})

test('agents, children and team runs are not narrated', () => {
  const { sent, narrator } = setup()
  for (const extra of [{ agentId: 'writer' }, { parentId: 'p' }, { team: { id: 'x' } }]) {
    narrator.observe(frame(snap({ id: `x${sent.length}`, ...extra })))
    narrator.observe(frame(snap({ id: `x${sent.length}`, ...extra, status: 'done', result: 'r' })))
  }
  assert.equal(sent.length, 0)
})

test('a throwing notify never breaks observe, and a bad frame is ignored', () => {
  const narrator = createNarrator({ notify: () => { throw new Error('nope') } })
  narrator.observe(frame(snap()))
  narrator.observe(frame(snap({ status: 'done', result: 'ok' })))
  narrator.observe(null)
  narrator.observe({ type: 'task' })
  narrator.observe({ type: 'task_removed', id: 't1' })
  assert.equal(narrator.stats().finished, 1)
  assert.throws(() => createNarrator({}), TypeError)
})

test('every notification passes the bus check and the policy: spoken only when idle', () => {
  const { sent, narrator } = setup()
  narrator.observe(frame(snap()))
  narrator.observe(frame(passedSteps(1)))
  const n = sent[0]
  const bus = createBus()
  assert.equal(bus.publish('notification.created', n) !== null, true)
  const base = { now: 1_000_000, minute: 12 * 60, enabled: true, quietHours: parseQuietHours('22:00-07:00') }
  assert.deepEqual(decide(n, { ...base, activity: 'idle' }).channels, ['speak', 'hud'])
  assert.deepEqual(decide(n, { ...base, activity: 'conversation' }).channels, ['hud'])
  assert.equal(decide(n, { ...base, activity: 'meeting' }).channels.includes('speak'), false)
  assert.equal(decide(n, { ...base, activity: 'idle', minute: 23 * 60 }).verdict, 'hold')
  assert.equal(decide(n, { ...base, now: n.expiresAt + 1, activity: 'idle' }).verdict, 'suppress')
})

test('through the notifier: a recurring-style stream reaches the channel only when idle', () => {
  const bus = createBus()
  let activity = 'conversation'
  const spoken = []
  const notifier = createNotifier({ bus, context: () => ({ activity }), quietHours: () => 'off', now: () => 1_000_000 })
  notifier.addChannel((n, d) => { if (d.channels.includes('speak')) spoken.push(n.title) })
  const narrator = createNarrator({ notify: (n) => notifier.submit(n), now: () => 1_000_000 })
  narrator.observe(frame(snap()))
  narrator.observe(frame(snap({ status: 'done', result: 'ok' })))
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.deepEqual(spoken, [], 'in a conversation it is shown, not spoken')
    activity = 'idle'
    const narrator2 = createNarrator({ notify: (n) => notifier.submit(n), now: () => 1_000_000 })
    narrator2.observe(frame(snap({ id: 't2' })))
    narrator2.observe(frame(snap({ id: 't2', status: 'done', result: 'ok' })))
    return new Promise((r) => setImmediate(r))
  }).then(() => {
    assert.equal(spoken.length, 1)
  })
})

test('missionMetrics: rates, help and cost; counts only', () => {
  const m = missionMetrics([
    { id: '1', status: 'done', costUsd: 0.2, log: [] },
    { id: '2', status: 'done', costUsd: 0.4, log: [{ kind: 'approval', text: 'secret title' }] },
    { id: '3', status: 'failed', costUsd: 0.3, handoff: { reason: 'r', choice: 'c' }, log: [] },
    { id: '4', status: 'cancelled', log: [] },
    { id: '5', status: 'running', log: [] },
    { id: '6', status: 'done', parentId: '1', log: [] },
  ])
  assert.equal(m.missions, 5)
  assert.equal(m.open, 1)
  assert.equal(m.done, 2)
  assert.equal(m.failed, 1)
  assert.equal(m.cancelled, 1)
  assert.ok(Math.abs(m.successRate - 2 / 3) < 1e-9)
  assert.ok(Math.abs(m.helpRate - 2 / 3) < 1e-9)
  assert.ok(Math.abs(m.avgCostUsd - 0.3) < 1e-9)
  assert.equal(JSON.stringify(m).includes('secret'), false)
  const empty = missionMetrics([])
  assert.equal(empty.successRate, undefined)
  assert.deepEqual(missionMetrics(undefined).missions, 0)
})
