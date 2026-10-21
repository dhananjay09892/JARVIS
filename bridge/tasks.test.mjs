import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskManager } from './tasks.mjs'

const silent = { error() {} }
const tick = () => new Promise((r) => setImmediate(r))

/** An agent whose messages the test feeds by hand. */
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
        yield m
      }
    })()
  }
  return { runAgent, runs }
}
const result = (over = {}) => ({ type: 'result', subtype: 'success', result: 'all done', total_cost_usd: 0.02, ...over })

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
  runs[0].push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'x', name: 'mcp__jarvis_workspace__read_file' } } })
  runs[0].push(result())
  await tick(); await tick()
  const t = m.get(task.id)
  assert.equal(t.status, 'done')
  assert.equal(t.percent, 100)
  assert.equal(t.result, 'all done')
  assert.equal(t.costUsd, 0.02)
  assert.ok(t.log.some((l) => l.kind === 'tool' && l.text.includes('read_file')))
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

test('failures: a thrown error, an error result and a silent end all fail the task', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const ids = [1, 2, 3].map((n) => m.spawn({ title: `t${n}`, goal: 'g' }).task.id)
  await tick()
  runs[0].push(new Error('boom'))
  runs[1].push(result({ subtype: 'error_max_turns' }))
  runs[2].end()
  await tick(); await tick()
  assert.deepEqual(ids.map((id) => m.get(id).status), ['failed', 'failed', 'failed'])
  assert.match(m.get(ids[0]).error, /boom/)
  assert.match(m.get(ids[1]).error, /error_max_turns/)
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
