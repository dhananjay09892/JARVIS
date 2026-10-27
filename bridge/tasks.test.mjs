import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskManager } from './tasks.mjs'
import { createBus, checkBusEvent } from './bus.mjs'

const silent = { error() {} }
const tick = () => new Promise((r) => setImmediate(r))

/** An agent whose BrainEvents the test feeds by hand. */
function fakeAgent() {
  const runs = []
  const runAgent = (ctx) => {
    const queue = []
    let wake = null
    const run = { ctx, push: (m) => { queue.push(m); wake?.(); wake = null }, end: () => run.push(null) }
    runs.push(run)
    return (async function* () {
      for (;;) {
        while (!queue.length) await new Promise((r) => { wake = r })
        const m = queue.shift()
        if (m === null) return
        if (m instanceof Error) throw m
        if (Array.isArray(m)) yield* m
        else yield m
      }
    })()
  }
  return { runAgent, runs }
}
/** One finished turn as BrainEvents: the summary, what it cost, and its done. */
const result = ({ text = 'all done', costUsd = 0.02, error = null, reason = error ? 'limit' : 'complete' } = {}) => [
  { t: 'text', delta: text },
  { t: 'usage', inTokens: 10, outTokens: 5, costUsd },
  ...(error ? [{ t: 'error', retryable: false, ...error }] : []),
  { t: 'done', reason },
]

test('a task runs, reports progress and finishes with its result and cost', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const frames = []
  m.subscribe((f) => frames.push(f.task))
  const { task } = m.spawn({ title: 'Audit', goal: 'look at things' })
  await tick()
  runs[0].ctx.report({ plan: ['read', 'write'], note: 'reading' })
  runs[0].ctx.report({ step: 2, note: 'writing' })
  assert.equal(m.get(task.id).percent, 50)
  assert.deepEqual(m.get(task.id).steps.map((s) => s.state), ['done', 'active'])
  runs[0].push({ t: 'text', delta: 'Let me look first. ' })
  runs[0].push({ t: 'tool_start', id: 'x', name: 'mcp__jarvis_workspace__read_file' })
  runs[0].push({ t: 'tool_call', id: 'x', name: 'mcp__jarvis_workspace__read_file', args: { path: 'a' } })
  runs[0].push({ t: 'tool_result', id: 'x', ok: true, summary: 'ok', tainted: false })
  runs[0].push(result())
  await tick(); await tick()
  const t = m.get(task.id)
  assert.equal(t.status, 'done')
  assert.equal(t.percent, 100)
  assert.equal(t.result, 'all done')
  assert.equal(t.costUsd, 0.02)
  assert.equal(t.log.filter((l) => l.kind === 'tool' && l.text.includes('read_file')).length, 1, 'one note per tool, from tool_start or tool_call')
  assert.ok(frames.length > 3)
})

test('only `concurrency` tasks run at once; the rest queue and start as slots free', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, concurrency: 2, log: silent })
  const ids = ['a', 'b', 'c'].map((n) => m.spawn({ title: n, goal: n }).task.id)
  await tick()
  assert.deepEqual(ids.map((id) => m.get(id).status), ['running', 'running', 'queued'])
  runs[0].push(result())
  await tick(); await tick()
  assert.deepEqual(ids.map((id) => m.get(id).status), ['done', 'running', 'running'])
})

test('cancel aborts the signal, ends only that task, and frees its slot', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, concurrency: 1, log: silent })
  const a = m.spawn({ title: 'a', goal: 'a' }).task.id
  const b = m.spawn({ title: 'b', goal: 'b' }).task.id
  await tick()
  assert.equal(m.cancel(a).ok, true)
  assert.equal(runs[0].ctx.signal.aborted, true)
  assert.equal(m.get(a).status, 'cancelled')
  await tick()
  assert.equal(m.get(b).status, 'running')
  assert.equal(m.cancel(a).ok, false)
  assert.equal(m.cancel('nope').ok, false)
})

test('failures: a thrown error, an error result, a session error and a silent end all fail the task', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, concurrency: 5, log: silent })
  const ids = [1, 2, 3, 4, 5].map((n) => m.spawn({ title: `t${n}`, goal: 'g' }).task.id)
  await tick()
  runs[0].push(new Error('boom'))
  runs[1].push(result({ error: { code: 'max_turns' } }))
  runs[2].end()
  runs[3].push([{ t: 'error', code: 'session_error', retryable: true, message: 'socket closed' }, { t: 'done', reason: 'error' }])
  runs[4].push([{ t: 'error', code: 'ended', retryable: true }, { t: 'done', reason: 'error' }])
  await tick(); await tick()
  assert.deepEqual(ids.map((id) => m.get(id).status), ['failed', 'failed', 'failed', 'failed', 'failed'])
  assert.match(m.get(ids[0]).error, /boom/)
  assert.match(m.get(ids[1]).error, /stopped: max_turns/)
  assert.match(m.get(ids[2]).error, /without a result/)
  assert.match(m.get(ids[3]).error, /socket closed/)
  assert.match(m.get(ids[4]).error, /without a result/)
})

test('a brain that ends the turn cancelled cancels the task; the summary is the text after the last tool', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const a = m.spawn({ title: 'a', goal: 'g' }).task.id
  const b = m.spawn({ title: 'b', goal: 'g' }).task.id
  await tick()
  runs[0].push({ t: 'done', reason: 'cancelled' })
  runs[1].push([
    { t: 'text', delta: 'Checking.' },
    { t: 'tool_call', id: 'c1', name: 'Read', args: {} },
    { t: 'tool_result', id: 'c1', ok: true, summary: '', tainted: false },
    { t: 'text', delta: 'Found ' }, { t: 'text', delta: 'two files.' },
    { t: 'done', reason: 'complete' },
  ])
  await tick(); await tick()
  assert.equal(m.get(a).status, 'cancelled')
  assert.equal(m.get(b).status, 'done')
  assert.equal(m.get(b).result, 'Found two files.')
  assert.equal(m.get(b).costUsd, null, 'no usage event, no cost')
})

test('approvals are tagged with the task and mark it waiting until answered', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const { task } = m.spawn({ title: 'Deploy', goal: 'g' })
  await tick()
  let release
  const seen = []
  const approve = runs[0].ctx.wrapApprove((title) => { seen.push(title); return new Promise((r) => { release = r }) })
  const answer = approve('Run command', 'npm test')
  assert.equal(m.get(task.id).status, 'waiting_approval')
  assert.equal(seen[0], 'Task "Deploy": Run command')
  release(true)
  assert.equal(await answer, true)
  assert.equal(m.get(task.id).status, 'running')
})

test('an ended task refuses progress and approvals; empty goals are rejected', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  assert.equal(m.spawn({ title: 'x', goal: '  ' }).ok, false)
  const { task } = m.spawn({ title: 'x', goal: 'g' })
  await tick()
  m.cancel(task.id)
  assert.equal(runs[0].ctx.report({ note: 'late' }).ok, false)
  assert.equal(await runs[0].ctx.wrapApprove(async () => true)('t', 'd'), false)
})

test('a late subscriber is replayed every task', async () => {
  const { runAgent } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  m.spawn({ title: 'one', goal: 'g' })
  const seen = []
  m.subscribe((f) => seen.push(f.task.title))
  assert.deepEqual(seen, ['one'])
})

test('a question parks the task until answered; cancel releases it with no answer', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const a = m.spawn({ title: 'a', goal: 'g' }).task.id
  const b = m.spawn({ title: 'b', goal: 'g' }).task.id
  await tick()
  const first = runs[0].ctx.ask('Which branch?')
  assert.equal(m.get(a).status, 'waiting_input')
  assert.equal(m.get(a).question, 'Which branch?')
  assert.equal(await runs[0].ctx.ask('second at once'), null)
  assert.equal(m.answer(a, 'main').ok, true)
  assert.equal(await first, 'main')
  assert.equal(m.get(a).status, 'running')
  assert.equal(m.answer(a, 'again').ok, false)

  const pending = runs[1].ctx.ask('Sure?')
  m.cancel(b)
  assert.equal(await pending, null)
  assert.equal(m.get(b).status, 'cancelled')
})

test('an approval and a question can overlap without losing the waiting state', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const id = m.spawn({ title: 'a', goal: 'g' }).task.id
  await tick()
  let release
  const gate = runs[0].ctx.wrapApprove(() => new Promise((r) => { release = r }))('Run', 'x')
  const q = runs[0].ctx.ask('Q?')
  release(true)
  await gate
  assert.equal(m.get(id).status, 'waiting_input')
  m.answer(id, 'ok')
  await q
  assert.equal(m.get(id).status, 'running')
})

/** A real bus whose `task.finished` events the test collects. */
function taskBus() {
  const bus = createBus({ log: silent })
  const events = []
  bus.subscribe('task.finished', (e) => events.push(e))
  return { bus, events }
}

test('every way a task ends publishes one valid task.finished event', async () => {
  const { bus, events } = taskBus()
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, bus, concurrency: 5, log: silent })
  const done = m.spawn({ title: 'Audit', goal: 'look at things' }).task.id
  const failed = m.spawn({ title: 'Break', goal: 'fail' }).task.id
  const cancelled = m.spawn({ title: 'Stop', goal: 'wait' }).task.id
  await tick()
  runs[0].push(result({ text: 'x'.repeat(1000), costUsd: 0.03 }))
  runs[1].push(new Error('disk on fire'))
  m.cancel(cancelled)
  await tick(); await tick(); await tick()
  assert.equal(events.length, 3)
  const by = Object.fromEntries(events.map((e) => [e.payload.taskId, e]))
  for (const e of events) assert.deepEqual(checkBusEvent(e), { ok: true })
  assert.deepEqual(
    { ...by[done].payload, summary: by[done].payload.summary.length },
    { taskId: done, title: 'Audit', status: 'done', summary: 300, costUsd: 0.03, startedAt: by[done].payload.startedAt, endedAt: by[done].payload.endedAt, sensitivity: 'private' },
  )
  assert.equal(by[failed].payload.status, 'failed')
  assert.equal(by[failed].payload.summary, 'disk on fire')
  assert.equal(by[cancelled].payload.status, 'cancelled')
  assert.equal('costUsd' in by[cancelled].payload, false, 'no cost when none was reported')
  // Ending twice (a cancel after the end) publishes nothing more.
  m.cancel(done)
  await tick()
  assert.equal(events.length, 3)
})

test('a task cut off by a restart is published as interrupted', async () => {
  const { bus, events } = taskBus()
  const saved = [{
    id: 'told', title: 'Long job', goal: 'g', status: 'running', steps: [], note: '', log: [], result: '', error: '',
    costUsd: null, createdAt: 1, startedAt: 2, endedAt: null,
  }]
  const store = { load: () => saved, save() {}, remove() {} }
  createTaskManager({ runAgent: fakeAgent().runAgent, store, bus, now: () => 10, log: silent })
  await tick()
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.status, 'interrupted')
  assert.equal(events[0].payload.endedAt, 10)
  assert.match(events[0].payload.summary, /restarted/)
})

test('without a bus, tasks work exactly as before', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const id = m.spawn({ title: 'a', goal: 'g' }).task.id
  await tick()
  runs[0].push(result())
  await tick(); await tick()
  assert.equal(m.get(id).status, 'done')
})

