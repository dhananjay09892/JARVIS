import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTask, keyWords, resumeBrief, workingOn } from './mission-control.mjs'
import { PAUSE_REFUSALS, createTaskManager } from './tasks.mjs'
import { openTaskStore } from './task-store.mjs'
import { isTaskTool, taskOperations } from './task-tools.mjs'
import { createPolicy } from './policy.mjs'
import { createBus } from './bus.mjs'
import { checkAgentDefinition } from './agent-definition.mjs'

const silent = { error() {} }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }

/** An agent whose BrainEvents the test feeds by hand; each run is kept with what it was handed. */
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
        if (Array.isArray(m)) yield* m
        else yield m
      }
    })()
  }
  return { runAgent, runs }
}
const complete = (text = 'all done', costUsd = 0.01) => [
  { t: 'text', delta: text }, { t: 'usage', inTokens: 1, outTokens: 1, costUsd }, { t: 'done', reason: 'complete' },
]

const agentDef = (over = {}) => {
  const r = checkAgentDefinition({
    id: 'researcher', name: 'Researcher', description: 'Finds and cites sources.', tools: ['WebSearch'], memory: 'none',
    createdBy: 'builtin', body: 'Cite.', ...over,
  })
  assert.ok(r.ok, JSON.stringify(r.errors))
  return r.value
}

const snap = (id, title, status = 'running', over = {}) => ({ id, title, status, percent: 0, note: '', createdAt: 1, ...over })

// --- Finding a task from the owner's words ------------------------------------

test('key words drop filler and stem, so "the trip planning task" means "Berlin trip plan"', () => {
  assert.deepEqual(keyWords('pause the trip planning task'), ['trip', 'plan'])
  assert.deepEqual(keyWords('Berlin trip plan'), ['berlin', 'trip', 'plan'])
  assert.deepEqual(keyWords('Stopped CI checks'), ['stop', 'ci', 'check'])
})

test('findTask: an id wins; words must all match the title; ambiguity and misses ask which one', () => {
  const tasks = [
    snap('t1', 'Berlin trip plan'),
    snap('t2', 'Get CI green'),
    snap('t3', 'Paris trip plan', 'paused'),
    snap('t4', 'Old report', 'done'),
  ]
  const live = (t) => t.status === 'running'
  assert.equal(findTask(tasks, 't2').task.id, 't2')
  assert.equal(findTask(tasks, 'the trip planning', { accept: live }).task.id, 't1')
  assert.equal(findTask(tasks, 'CI', { accept: live }).task.id, 't2')
  // Both trips match when paused ones count too.
  const both = findTask(tasks, 'trip planning')
  assert.equal(both.task, undefined)
  assert.deepEqual(both.candidates, ['Berlin trip plan', 'Paris trip plan'])
  const miss = findTask(tasks, 'the garden', { accept: live, kind: 'running' })
  assert.match(miss.reason, /No running task matches "the garden"/)
  assert.deepEqual(miss.candidates, ['Berlin trip plan', 'Get CI green'])
  // An id that is not acceptable says so rather than acting on it.
  assert.match(findTask(tasks, 't4', { accept: live, kind: 'running' }).reason, /not running/)
  // "Pause it" with exactly one candidate means that one; with two, it asks.
  assert.equal(findTask(tasks, '', { accept: (t) => t.status === 'paused' }).task.id, 't3')
  assert.match(findTask(tasks, 'it', { accept: live }).reason, /Which one\? There are 2/)
  assert.match(findTask([], 'x', { kind: 'paused' }).reason, /There is no paused task/)
})

test('workingOn lists live and paused tasks only, newest first, with a summary', () => {
  const w = workingOn([
    snap('a', 'Older', 'running', { createdAt: 1, agentName: 'Researcher', note: 'reading' }),
    snap('b', 'Newer', 'paused', { createdAt: 5 }),
    snap('c', 'Finished', 'done', { createdAt: 9 }),
  ])
  assert.deepEqual(w.tasks.map((t) => t.id), ['b', 'a'])
  assert.equal(w.tasks[1].agent, 'Researcher')
  assert.equal(w.summary, '1 running, 1 paused')
  assert.equal(workingOn([snap('c', 'x', 'failed')]).summary, 'Nothing in progress.')
})

test('the resume brief carries the goal, the plan, what was done and a warning not to repeat actions', () => {
  const brief = resumeBrief({
    goal: 'Plan a Berlin trip',
    steps: [{ label: 'Find flights', state: 'done' }, { label: 'Find hotels', state: 'active' }, { label: 'Write it up', state: 'todo' }],
    note: 'comparing three hotels',
  })
  assert.match(brief, /^Plan a Berlin trip\n/)
  assert.match(brief, /paused and is now being resumed/)
  assert.match(brief, /Steps reported done: Find flights\./)
  assert.match(brief, /It was on: Find hotels\./)
  assert.match(brief, /Last note: comparing three hotels\./)
  assert.match(brief, /never repeat an action/)
  assert.ok(resumeBrief({ goal: 'x'.repeat(5000), steps: [] }).length <= 4000)
})

// --- Pause and resume in the task manager -------------------------------------

test('pause stops the session, keeps plan and log, frees the slot; resume starts a new run from the board', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, concurrency: 1, log: silent })
  const a = m.spawn({ title: 'Berlin trip plan', goal: 'Plan a Berlin trip' }).task.id
  const b = m.spawn({ title: 'Other', goal: 'g' }).task.id
  await tick()
  runs[0].ctx.report({ plan: ['Find flights', 'Find hotels'], step: 2, note: 'hotels' })
  assert.equal(m.get(b).status, 'queued')

  const p = m.pause(a)
  assert.equal(p.ok, true)
  assert.equal(runs[0].ctx.signal.aborted, true)
  const paused = m.get(a)
  assert.equal(paused.status, 'paused')
  assert.deepEqual(paused.steps.map((s) => s.state), ['done', 'active'])
  assert.ok(paused.log.some((l) => l.kind === 'paused'))
  await settle()
  // The slot is free, so the queued task started.
  assert.equal(m.get(b).status, 'running')
  assert.equal(m.pause(a).reason, PAUSE_REFUSALS.already)
  // The stopped run's late calls change nothing.
  assert.deepEqual(runs[0].ctx.report({ note: 'late' }), { ok: false, reason: 'This task has ended.' })

  // Resume waits for the slot like any task.
  assert.equal(m.resume(a).ok, true)
  assert.equal(m.get(a).status, 'queued')
  runs[1].push(complete('other done'))
  await settle()
  assert.equal(runs.length, 3)
  assert.equal(m.get(a).status, 'running')
  assert.match(runs[2].ctx.task.goal, /^Plan a Berlin trip\n/)
  assert.match(runs[2].ctx.task.goal, /Steps reported done: Find flights/)
  assert.equal(runs[2].ctx.signal.aborted, false)

  // The old run ending late (even "complete") does not touch the new run.
  runs[0].push(complete('stale'))
  await settle()
  assert.equal(m.get(a).status, 'running')
  runs[2].push(complete('trip planned'))
  await settle()
  assert.equal(m.get(a).status, 'done')
  assert.equal(m.get(a).result, 'trip planned')
  assert.equal(m.get(a).resumed, 1)
  assert.equal(m.resume(a).reason, PAUSE_REFUSALS.ended)
})

test('a resumed task keeps what it spent: cost adds up and tool calls count against the same budget', async () => {
  const { runAgent, runs } = fakeAgent()
  const def = agentDef({ budget: { maxToolCalls: 2, maxMinutes: 5, maxCostUsd: 5 } })
  const agents = { has: () => true, get: () => def, isActive: () => true }
  const m = createTaskManager({ runAgent, agents, log: silent })
  const id = m.spawn({ title: 'Desks', goal: 'g', agentId: 'researcher' }).task.id
  await tick()
  assert.equal(runs[0].ctx.budget.toolCall(), null)
  runs[0].push([{ t: 'usage', inTokens: 1, outTokens: 1, costUsd: 0.5 }])
  await settle()
  m.pause(id)
  // The paused run's guard refuses: its run is over.
  assert.notEqual(runs[0].ctx.budget.toolCall(), null)
  assert.equal(m.get(id).usage.toolCalls, 1)

  m.resume(id)
  await settle()
  assert.equal(runs[1].ctx.budget.toolCall(), null)
  runs[1].push([{ t: 'usage', inTokens: 1, outTokens: 1, costUsd: 0.25 }])
  await settle()
  assert.equal(m.get(id).costUsd, 0.75)
  // The third call in all is over the limit of two: the task stops.
  assert.notEqual(runs[1].ctx.budget.toolCall(), null)
  assert.equal(m.get(id).status, 'failed')
})

test('a child cannot be paused on its own; pausing its parent ends it; resume waits for held work and a live agent', async () => {
  const { runAgent } = fakeAgent()
  let held = null
  const off = new Set()
  const defs = new Map([
    ['coordinator', agentDef({ id: 'coordinator', name: 'Coordinator', description: 'Hands work on.', delegate: ['researcher'] })],
    ['researcher', agentDef()],
  ])
  const agents = { has: (id) => defs.has(id), get: (id) => defs.get(id), isActive: (id) => defs.has(id) && !off.has(id) }
  const m = createTaskManager({ runAgent, agents, paused: () => held, maxDepth: () => 2, log: silent })
  const parent = m.spawn({ title: 'Lead', goal: 'g', agentId: 'coordinator' }).task.id
  await tick()
  const d = m.delegate(parent, { agent: 'researcher', goal: 'find things' })
  assert.equal(d.ok, true)
  await tick()
  const child = d.task.id
  assert.equal(m.pause(child).reason, PAUSE_REFUSALS.child)
  // By voice, the child is not offered as something to pause.
  assert.equal(taskOperations(m).pause({ id: '' }).id, parent)
  assert.equal(m.get(parent).status, 'paused')
  assert.equal(m.get(child).status, 'cancelled')

  held = 'Background work is paused.'
  assert.equal(m.resume(parent).reason, held)
  held = null
  off.add('coordinator')
  assert.match(m.resume(parent).reason, /Coordinator agent is not switched on/)
  off.delete('coordinator')
  assert.equal(m.resume(parent).ok, true)
  assert.equal(m.resume(parent).reason, PAUSE_REFUSALS.notPaused)
  assert.equal(m.pause('nope').reason, PAUSE_REFUSALS.missing)
  assert.equal(m.pause(child).reason, PAUSE_REFUSALS.ended)
})

test('a paused task is kept: not pruned, not dismissable, and cancelling it publishes one task.finished', async () => {
  const { runAgent } = fakeAgent()
  const bus = createBus({ log: silent })
  const finished = []
  bus.subscribe('task.finished', (e) => finished.push(e.payload))
  const m = createTaskManager({ runAgent, bus, log: silent })
  const id = m.spawn({ title: 'Keep me', goal: 'g' }).task.id
  await tick()
  m.pause(id)
  assert.equal(m.dismiss(id).reason, 'Cancel it first.')
  // Fill the board with finished tasks well past what it keeps.
  for (let i = 0; i < 60; i++) {
    const t = m.spawn({ title: `n${i}`, goal: 'g' }).task.id
    m.cancel(t)
  }
  assert.equal(m.get(id).status, 'paused')
  await tick()
  const before = finished.length
  assert.equal(m.cancel(id).ok, true)
  await tick()
  assert.equal(finished.length, before + 1)
  assert.equal(finished.at(-1).taskId, id)
  assert.equal(finished.at(-1).status, 'cancelled')
})

test('pausing a task with an open question releases it, and an approval answered after the pause changes nothing', async () => {
  const { runAgent, runs } = fakeAgent()
  const m = createTaskManager({ runAgent, log: silent })
  const id = m.spawn({ title: 'Q', goal: 'g' }).task.id
  await tick()
  const answer = runs[0].ctx.ask('Which city?')
  let release
  const card = runs[0].ctx.wrapApprove(() => new Promise((r) => { release = r }))('Send it', {})
  await tick()
  assert.equal(m.get(id).status, 'waiting_approval')
  m.pause(id)
  assert.equal(await answer, null)
  assert.equal(m.get(id).status, 'paused')
  m.resume(id)
  await settle()
  assert.equal(m.get(id).status, 'running')
  release(true)
  await card
  assert.equal(m.get(id).status, 'running')
})

// --- By voice, across a restart -----------------------------------------------

test('done when: a mission survives a bridge restart and is paused and resumed by voice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-missions-'))
  const stores = []
  const open = () => { const s = openTaskStore({ dir }); stores.push(s); return s }
  try {
    const first = fakeAgent()
    const before = createTaskManager({ store: open(), runAgent: first.runAgent, log: silent })
    const id = before.spawn({ title: 'Berlin trip plan', goal: 'Plan a Berlin trip' }).task.id
    await tick()
    first.runs[0].ctx.report({ plan: ['Find flights', 'Find hotels', 'Write it up'], step: 2, note: 'hotels' })

    // The bridge stops without warning and starts again.
    const second = fakeAgent()
    const after = createTaskManager({ store: open(), runAgent: second.runAgent, log: silent })
    const voice = taskOperations(after)
    const t = after.get(id)
    assert.equal(t.status, 'paused')
    assert.match(t.note, /restarted/)
    assert.deepEqual(t.steps.map((s) => s.state), ['done', 'active', 'todo'])
    assert.equal(second.runs.length, 0, 'nothing restarts on its own')

    // "What are you working on?"
    const w = voice.list({ active_only: true })
    assert.equal(w.summary, '1 paused')
    assert.equal(w.tasks[0].title, 'Berlin trip plan')

    // "Carry on with the trip planning."
    const r = voice.resume({ id: 'the trip planning' })
    assert.deepEqual([r.ok, r.id, r.title], [true, id, 'Berlin trip plan'])
    await settle()
    assert.equal(after.get(id).status, 'running')
    assert.match(second.runs[0].ctx.task.goal, /It was on: Find hotels/)

    // "Pause the trip planning."
    const p = voice.pause({ id: 'pause the trip planning' })
    assert.equal(p.ok, true)
    assert.equal(after.get(id).status, 'paused')
    assert.equal(second.runs[0].ctx.signal.aborted, true)
    assert.match(voice.pause({ id: 'trip' }).reason, /There is no running task/)

    // Paused by the owner survives the next restart too, and resumes.
    const third = fakeAgent()
    const again = createTaskManager({ store: open(), runAgent: third.runAgent, log: silent })
    assert.equal(again.get(id).status, 'paused')
    assert.equal(again.get(id).resumed, 1)
    assert.equal(taskOperations(again).resume({ id: '' }).ok, true)
    await settle()
    third.runs[0].push(complete('Trip planned.'))
    await settle()
    assert.equal(again.get(id).status, 'done')
    assert.equal(taskOperations(again).cancel({ id: 'trip' }).ok, false)
  } finally {
    for (const s of stores) { try { s.close() } catch { /* closed */ } }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the mission tools go through the policy engine as the voice session\'s own tools', () => {
  for (const t of ['pause_task', 'resume_task', 'list_tasks', 'cancel_task']) assert.equal(isTaskTool(t), true)
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool, audit() {} })
  for (const name of ['mcp__jarvis_tasks__pause_task', 'mcp__jarvis_tasks__resume_task']) {
    const d = policy.decide({ kind: 'tool', name })
    assert.equal(d.verdict, 'allow')
    assert.equal(d.rule, 'own-server-list')
  }
  // A name the server does not list is refused, and a frozen policy refuses them all.
  assert.equal(policy.decide({ kind: 'tool', name: 'mcp__jarvis_tasks__resume_all_tasks' }).verdict, 'deny')
  const frozen = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool, isFrozen: () => true, audit() {} })
  assert.equal(frozen.decide({ kind: 'tool', name: 'mcp__jarvis_tasks__resume_task' }).verdict, 'deny')
})
