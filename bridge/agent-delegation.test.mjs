// Agents phase A4 (A12): Coordinator delegation. Only the Coordinator may
// start agents from inside its run, only those on its list, only to
// agents.maxDepth (hard ceiling 2), with a children cap and a share of its
// budget; workers are refused by the runtime and by the policy engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DELEGATE_TOOLS, DELEGATION_REFUSALS, DELEGATION_STOPS, DELEGATOR_ID, MAX_CHILDREN, budgetSpent, depthLimit,
  mayDelegate, remainingBudget, shareBudget,
} from './agent-delegation.mjs'
import { COORDINATOR_ID, checkAgentDefinition } from './agent-definition.mjs'
import { BUDGET_STOPS, agentGuard, agentToolPlan } from './agent-runtime.mjs'
import { createPolicy, createToolGate } from './policy.mjs'
import { createTaskManager } from './tasks.mjs'
import { outboundKind } from './taint.mjs'

const silent = { error() {}, log() {}, warn() {} }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick() }

function def(over = {}) {
  const r = checkAgentDefinition({
    id: 'researcher', name: 'Researcher', description: 'Finds and cites sources.',
    tools: ['WebSearch', 'Read'], memory: 'read', createdBy: 'builtin', body: 'Cite every claim.', ...over,
  })
  assert.ok(r.ok, JSON.stringify(r.errors))
  return r.value
}

const coordinator = (over = {}) => def({
  id: 'coordinator', name: 'Coordinator', description: 'Hands work to the right agent.',
  tools: ['Read'], delegate: ['researcher', 'writer'], ...over,
})

/** A roster: the Coordinator, two agents on its list and one that is not. */
function roster({ coord = coordinator(), off = new Set() } = {}) {
  const defs = new Map([
    ['coordinator', coord],
    ['researcher', def()],
    ['writer', def({ id: 'writer', name: 'Writer', description: 'Drafts text.' })],
    ['coder', def({ id: 'coder', name: 'Coder', description: 'Writes code.' })],
  ])
  return { has: (id) => defs.has(id), get: (id) => defs.get(id), isActive: (id) => defs.has(id) && !off.has(id), defs, off }
}

/** Runs whose BrainEvents the test feeds by hand. */
function fakeRun() {
  const runs = []
  const runAgent = (ctx) => {
    const queue = []
    let wake = null
    const run = { ctx, push: (m) => { queue.push(m); wake?.(); wake = null } }
    runs.push(run)
    return (async function* () {
      for (;;) {
        while (!queue.length) await new Promise((r) => { wake = r })
        const m = queue.shift()
        if (m === null) return
        yield m
      }
    })()
  }
  const runOf = (taskId) => runs.find((r) => r.ctx.task.id === taskId)
  const complete = (taskId, text = 'all done', costUsd = 0) => {
    const r = runOf(taskId)
    r.push({ t: 'text', delta: text })
    r.push({ t: 'usage', inTokens: 1, outTokens: 1, costUsd })
    r.push({ t: 'done', reason: 'complete' })
  }
  return { runAgent, runs, runOf, complete }
}

function manager(o = {}) {
  const fr = fakeRun()
  const agents = o.agents ?? roster()
  const m = createTaskManager({ runAgent: fr.runAgent, agents, log: silent, maxDepth: () => 2, ...o })
  return { m, agents, ...fr }
}

// --- The rules on their own -----------------------------------------------------

test('the delegator id is the contract\'s Coordinator id', () => {
  assert.equal(DELEGATOR_ID, COORDINATOR_ID)
})

test('depth is the setting clamped to 1…2; nonsense or a throw is 1', () => {
  assert.equal(depthLimit(() => 1), 1)
  assert.equal(depthLimit(() => 2), 2)
  assert.equal(depthLimit(() => 3), 2, 'hard ceiling 2')
  assert.equal(depthLimit(() => 99), 2)
  assert.equal(depthLimit(() => 0), 1)
  assert.equal(depthLimit(() => '2'), 1)
  assert.equal(depthLimit(() => { throw new Error('x') }), 1)
  assert.equal(depthLimit(2), 2)
})

test('only the Coordinator with a list, below the depth limit, may delegate', () => {
  assert.deepEqual(mayDelegate(coordinator(), { depth: 1, maxDepth: 2 }), { ok: true })
  assert.deepEqual(mayDelegate(coordinator(), { depth: 1, maxDepth: 1 }), { ok: false, reason: DELEGATION_REFUSALS.depthOff })
  assert.deepEqual(mayDelegate(coordinator(), { depth: 2, maxDepth: 2 }), { ok: false, reason: DELEGATION_REFUSALS.depth(2) })
  assert.deepEqual(mayDelegate(coordinator(), { depth: 2, maxDepth: 3 }), { ok: false, reason: DELEGATION_REFUSALS.depth(2) }, 'depth 3 never')
  assert.deepEqual(mayDelegate(coordinator({ delegate: [] }), { maxDepth: 2 }), { ok: false, reason: DELEGATION_REFUSALS.noList })
  assert.deepEqual(mayDelegate(def(), { maxDepth: 2 }), { ok: false, reason: DELEGATION_REFUSALS.notDelegator })
  // A definition that somehow carries a list but is not the Coordinator still may not.
  assert.equal(mayDelegate({ ...def(), delegate: ['writer'] }, { maxDepth: 2 }).ok, false)
  assert.equal(mayDelegate(null, { maxDepth: 2 }).ok, false)
})

test('a child\'s budget is never larger than its own or what its parent has left', () => {
  const left = remainingBudget({ maxToolCalls: 10, maxMinutes: 20, maxCostUsd: 1 }, { calls: 4, startedAt: 0, costUsd: 0.25, childCostUsd: 0.25 }, 5 * 60_000)
  assert.deepEqual(left, { maxToolCalls: 6, maxMinutes: 15, maxCostUsd: 0.5 })
  assert.deepEqual(shareBudget({ maxToolCalls: 40, maxMinutes: 5, maxCostUsd: 2 }, left), { maxToolCalls: 6, maxMinutes: 5, maxCostUsd: 0.5 })
  assert.deepEqual(shareBudget(null, left), left, 'no own budget: the parent\'s share')
  assert.deepEqual(shareBudget({ maxToolCalls: 3 }, null), { maxToolCalls: 3 }, 'a parent without a budget adds no limit')
  assert.equal(shareBudget(null, null), null)
  assert.equal(remainingBudget(null, {}), null)
  assert.equal(budgetSpent({ maxToolCalls: 0, maxMinutes: 3 }), true)
  assert.equal(budgetSpent({ maxToolCalls: 2 }), false)
  assert.equal(budgetSpent(null), false)
})

// --- The policy engine and the worker rules ---------------------------------

test('the policy refuses the delegation tools to every session but the Coordinator\'s', () => {
  const policy = createPolicy({ allowWrites: true })
  for (const name of DELEGATE_TOOLS) {
    assert.equal(policy.decideTool(name), false, `voice and plain workers: ${name}`)
    assert.equal(policy.forAgent('researcher').decideTool(name), false, `a worker agent: ${name}`)
    assert.equal(policy.forAgent('coordinator').decideTool(name), true, `the Coordinator: ${name}`)
    assert.equal(policy.forAgent('researcher').decide({ kind: 'tool', name }).rule, 'delegate-coordinator-only')
  }
  assert.equal(policy.forAgent('coordinator').decideTool('mcp__jarvis_delegate__delete_agent'), false, 'only the listed tools')
  assert.equal(createToolGate({ allowWrites: true })('mcp__jarvis_delegate__start_agent'), false, 'the bare gate knows no agent')
  const frozen = createPolicy({ allowWrites: true, isFrozen: () => true })
  assert.equal(frozen.forAgent('coordinator').decideTool(DELEGATE_TOOLS[0]), false, 'the kill switch still wins')
})

test('a worker that calls the delegation tool is refused by the policy and audited with its id', async () => {
  const audit = []
  const policy = createPolicy({ allowWrites: true, audit: (e) => audit.push(e) })
  const r = await policy.forAgent('researcher').authorize({ name: DELEGATE_TOOLS[0], input: { agent: 'writer', goal: 'x' }, actor: 'worker', log: silent })
  assert.notEqual(r.refusal, null)
  assert.equal(audit.at(-1).agentId, 'researcher')
  assert.equal(audit.at(-1).decision.rule, 'delegate-coordinator-only')
  const ok = await policy.forAgent('coordinator').authorize({ name: DELEGATE_TOOLS[0], input: {}, actor: 'worker', log: silent })
  assert.equal(ok.refusal, null)
})

test('a file can never list the delegation tools; the guard refuses them unless the runtime adds them', async () => {
  const policy = createPolicy({ allowWrites: true })
  const plan = agentToolPlan(def({ tools: ['Read', ...DELEGATE_TOOLS] }), { decideTool: policy.forAgent('researcher').decideTool })
  assert.deepEqual(plan.allowed, ['Read'])
  assert.deepEqual(plan.dropped.map((d) => d.reason), ['start-agents', 'start-agents'])
  const coordPlan = agentToolPlan(coordinator({ tools: ['Read', DELEGATE_TOOLS[0]] }), { decideTool: policy.forAgent('coordinator').decideTool })
  assert.deepEqual(coordPlan.allowed, ['Read'], 'not even the Coordinator\'s own file grants them')
  const guard = agentGuard({ allowed: plan.allowed })
  assert.notEqual(await guard(DELEGATE_TOOLS[0], {}), null)
})

test('a delegation brief is scanned for links on the way out, like a spawned task', () => {
  assert.equal(outboundKind('mcp__jarvis_delegate__start_agent', { goal: 'x' }), 'scan')
  assert.equal(outboundKind('mcp__jarvis_delegate__check_agent', { id: 't1' }), 'none')
})

// --- The task manager -----------------------------------------------------------

test('at the default depth 1 the Coordinator gets no delegation and a start is refused', async () => {
  const { m, runs } = manager({ maxDepth: () => 1 })
  const { task } = m.spawn({ goal: 'plan a trip', agentId: 'coordinator' })
  await tick()
  assert.equal(runs[0].ctx.delegation, undefined)
  assert.deepEqual(m.delegate(task.id, { agent: 'researcher', goal: 'find flights' }), { ok: false, reason: DELEGATION_REFUSALS.depthOff })
  const unset = manager({ maxDepth: undefined })
  const r = unset.m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  assert.equal(unset.runs[0].ctx.delegation, undefined, 'no setting means depth 1')
  assert.equal(unset.m.delegate(r.task.id, { agent: 'researcher', goal: 'y' }).ok, false)
})

test('at depth 2 the Coordinator starts an agent on its list; the child is nested, runs and reports back', async () => {
  const { m, runs, runOf, complete } = manager()
  const frames = []
  m.subscribe((f) => frames.push(f))
  const { task: parent } = m.spawn({ title: 'Trip', goal: 'plan a trip', agentId: 'coordinator' })
  await tick()
  const d = runs[0].ctx.delegation
  assert.ok(d, 'the Coordinator\'s run is handed delegation')
  assert.equal(runs[0].ctx.depth, 1)
  assert.deepEqual(d.agents(), [{ id: 'researcher', name: 'Researcher' }, { id: 'writer', name: 'Writer' }])
  const r = d.start({ agent: 'the researcher', goal: 'find three flights', title: 'Flights' })
  assert.equal(r.ok, true)
  assert.equal(r.task.parentId, parent.id)
  assert.equal(r.task.depth, 2)
  assert.equal(r.task.agentId, 'researcher')
  await tick()
  const childRun = runOf(r.task.id)
  assert.ok(childRun)
  assert.equal(childRun.ctx.delegation, undefined, 'a child is a worker: it may not delegate')
  assert.equal(childRun.ctx.depth, 2)
  assert.ok(m.get(parent.id).log.some((l) => l.kind === 'delegate' && l.text === 'started Researcher'))
  assert.ok(frames.some((f) => f.type === 'task' && f.task.id === r.task.id && f.task.parentId === parent.id), 'the board hears the nesting')
  // The parent waits for the child and then sees its result.
  const waiting = d.check({ id: r.task.id, wait: 60_000 })
  complete(r.task.id, 'three flights found')
  const seen = await waiting
  assert.deepEqual(seen, { ok: true, task: { id: r.task.id, agent: 'Researcher', status: 'done', percent: 100, note: '', result: 'three flights found' } })
  assert.equal('depth' in m.get(parent.id), false, 'a top-level task carries no depth field')
})

test('agents off the list, unknown or switched off are refused; nothing is queued', async () => {
  const agents = roster()
  const { m, runs } = manager({ agents })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const before = m.list().length
  assert.deepEqual(m.delegate(task.id, { agent: 'coder', goal: 'fix it' }), { ok: false, reason: DELEGATION_REFUSALS.offList(['Researcher', 'Writer']) })
  assert.equal(m.delegate(task.id, { agent: 'plumber', goal: 'fix it' }).ok, false)
  assert.equal(m.delegate(task.id, { agent: 'coordinator', goal: 'again' }).ok, false, 'not itself')
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: '  ' }), { ok: false, reason: DELEGATION_REFUSALS.noGoal })
  agents.off.add('writer')
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: 'draft' }), { ok: false, reason: 'The Writer agent is not switched on.' })
  assert.equal(m.list().length, before)
  assert.equal(runs.length, 1)
})

test('depth 3 is refused: a Coordinator run already at depth 2 cannot delegate, even with the setting at 3', async () => {
  const { m, runs } = manager({ maxDepth: () => 3 })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator', depth: 2 })
  await tick()
  assert.equal(m.get(task.id).depth, 2)
  assert.equal(runs[0].ctx.delegation, undefined)
  assert.deepEqual(m.delegate(task.id, { agent: 'researcher', goal: 'y' }), { ok: false, reason: DELEGATION_REFUSALS.depth(2) })
  const deep = m.spawn({ goal: 'x', agentId: 'researcher', depth: 7 })
  assert.equal(deep.task.depth, 2, 'no task is ever deeper than the ceiling')
})

test('a worker agent cannot start an agent, through the manager or otherwise', async () => {
  const { m, runs } = manager()
  const { task } = m.spawn({ goal: 'x', agentId: 'researcher' })
  const plain = m.spawn({ goal: 'y' })
  await tick()
  assert.equal(runs[0].ctx.delegation, undefined)
  assert.equal(runs[1].ctx.delegation, undefined)
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: 'z' }), { ok: false, reason: DELEGATION_REFUSALS.notDelegator })
  assert.deepEqual(m.delegate(plain.task.id, { agent: 'writer', goal: 'z' }), { ok: false, reason: DELEGATION_REFUSALS.notDelegator })
  assert.deepEqual(m.delegate('t-missing', { agent: 'writer', goal: 'z' }), { ok: false, reason: DELEGATION_REFUSALS.ended })
})

test('the children cap holds per run, counting children that already finished', async () => {
  const { m, runs, complete } = manager({ maxChildren: 2, concurrency: 8 })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const a = m.delegate(task.id, { agent: 'researcher', goal: 'one' })
  await tick()
  complete(a.task.id)
  await settle()
  assert.equal(m.get(a.task.id).status, 'done')
  assert.equal(m.delegate(task.id, { agent: 'writer', goal: 'two' }).ok, true)
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: 'three' }), { ok: false, reason: DELEGATION_REFUSALS.children(2) })
  assert.equal(runs.length, 3)
  assert.equal(MAX_CHILDREN, 5)
  const dflt = manager({ concurrency: 8 })
  const r = dflt.m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  for (let i = 0; i < MAX_CHILDREN; i++) assert.equal(dflt.m.delegate(r.task.id, { agent: 'writer', goal: `n${i}` }).ok, true)
  assert.equal(dflt.m.delegate(r.task.id, { agent: 'writer', goal: 'one more' }).ok, false)
})

test('with room for only one agent at once, delegation is refused rather than deadlocked', async () => {
  const { m } = manager({ concurrency: 1 })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: 'y' }), { ok: false, reason: DELEGATION_REFUSALS.cap })
})

test('pause refuses new children and stops running ones', async () => {
  let paused = null
  const { m } = manager({ paused: () => paused })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const c = m.delegate(task.id, { agent: 'writer', goal: 'y' })
  await tick()
  paused = 'All agents are paused.'
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: 'z' }), { ok: false, reason: 'All agents are paused.' })
  m.refresh()
  assert.equal(m.get(c.task.id).status, 'cancelled')
})

test('a child runs within its parent\'s budget share; its tool calls are charged to the parent', async () => {
  const agents = roster({ coord: coordinator({ budget: { maxToolCalls: 5, maxMinutes: 30, maxCostUsd: 1 } }) })
  const { m, runOf } = manager({ agents, defaultBudget: () => ({ maxToolCalls: 40, maxMinutes: 20, maxCostUsd: 2 }) })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const parentRun = runOf(task.id)
  assert.equal(parentRun.ctx.budget.toolCall('Read'), null)
  assert.equal(parentRun.ctx.budget.toolCall('Read'), null)
  const c = m.delegate(task.id, { agent: 'researcher', goal: 'y' })
  await tick()
  const childRun = runOf(c.task.id)
  // 5 - 2 = 3 calls left to share: the child's own 40 is cut to 3.
  assert.equal(childRun.ctx.budget.toolCall('WebSearch'), null)
  assert.equal(childRun.ctx.budget.toolCall('WebSearch'), null)
  assert.equal(childRun.ctx.budget.toolCall('WebSearch'), null)
  assert.notEqual(childRun.ctx.budget.toolCall('WebSearch'), null, 'the fourth is over the share')
  await settle()
  assert.equal(m.get(c.task.id).status, 'failed')
  // The parent's pool is used up too: its next call stops it.
  assert.notEqual(parentRun.ctx.budget.toolCall('Read'), null)
  await settle()
  assert.equal(m.get(task.id).status, 'failed')
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: 'z' }), { ok: false, reason: DELEGATION_REFUSALS.ended })
})

test('siblings share one pool, and a parent with nothing left cannot start or run a child', async () => {
  const agents = roster({ coord: coordinator({ budget: { maxToolCalls: 2, maxMinutes: 30, maxCostUsd: 1 } }) })
  const { m, runOf } = manager({ agents, concurrency: 8 })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const a = m.delegate(task.id, { agent: 'researcher', goal: 'a' })
  const b = m.delegate(task.id, { agent: 'writer', goal: 'b' })
  await tick()
  assert.equal(runOf(a.task.id).ctx.budget.toolCall('Read'), null)
  assert.equal(runOf(b.task.id).ctx.budget.toolCall('Read'), null)
  assert.notEqual(runOf(a.task.id).ctx.budget.toolCall('Read'), null, 'the pool of 2 is spent across both')
  await settle()
  assert.equal(m.get(a.task.id).error, DELEGATION_STOPS.parentBudget)
  assert.deepEqual(m.delegate(task.id, { agent: 'writer', goal: 'c' }), { ok: false, reason: DELEGATION_REFUSALS.noBudget })
})

test('a child\'s cost counts against what its parent may still share', async () => {
  const agents = roster({ coord: coordinator({ budget: { maxToolCalls: 50, maxMinutes: 30, maxCostUsd: 1 } }) })
  const { m, runOf, complete } = manager({
    agents, concurrency: 8, costCounts: () => true, defaultBudget: () => ({ maxToolCalls: 40, maxMinutes: 20, maxCostUsd: 2 }),
  })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const a = m.delegate(task.id, { agent: 'researcher', goal: 'a' })
  await tick()
  complete(a.task.id, 'done', 0.75)
  await settle()
  const b = m.delegate(task.id, { agent: 'writer', goal: 'b' })
  await tick()
  // The writer's own $2 is cut to the $0.25 its parent has left.
  runOf(b.task.id).push({ t: 'usage', inTokens: 1, outTokens: 1, costUsd: 0.3 })
  await settle()
  assert.equal(m.get(b.task.id).status, 'failed')
  assert.equal(m.get(b.task.id).error, BUDGET_STOPS.cost(0.25))
})

test('when the parent ends, its running and queued children are cancelled', async () => {
  const { m, complete } = manager({ concurrency: 2 })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const a = m.delegate(task.id, { agent: 'researcher', goal: 'a' })
  const b = m.delegate(task.id, { agent: 'writer', goal: 'b' })
  await tick()
  assert.equal(m.get(a.task.id).status, 'running')
  assert.equal(m.get(b.task.id).status, 'queued')
  complete(task.id)
  await settle()
  assert.equal(m.get(task.id).status, 'done')
  for (const id of [a.task.id, b.task.id]) {
    assert.equal(m.get(id).status, 'cancelled')
    assert.match(m.get(id).error, /agent that started it has ended/)
  }
})

test('check only sees the run\'s own children, and a wait ends when the parent ends', async () => {
  const { m } = manager({ concurrency: 8 })
  const one = m.spawn({ goal: 'x', agentId: 'coordinator' })
  const two = m.spawn({ goal: 'y', agentId: 'coordinator' })
  await tick()
  const c = m.delegate(one.task.id, { agent: 'writer', goal: 'z' })
  assert.deepEqual(await m.child(two.task.id, { id: c.task.id }), { ok: false, reason: DELEGATION_REFUSALS.notChild })
  assert.deepEqual(await m.child(one.task.id, { id: one.task.id }), { ok: false, reason: DELEGATION_REFUSALS.notChild })
  const waiting = m.child(one.task.id, { id: c.task.id, wait: 60_000 })
  m.cancel(one.task.id)
  const seen = await waiting
  assert.equal(seen.task.status, 'cancelled')
})

test('the store keeps the nesting across a restart', async () => {
  const saved = new Map()
  const store = { save: (t) => saved.set(t.id, structuredClone(t)), load: () => [...saved.values()], remove: (id) => saved.delete(id) }
  const { m, runAgent } = manager({ store })
  const { task } = m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const c = m.delegate(task.id, { agent: 'writer', goal: 'y' })
  const again = createTaskManager({ runAgent, agents: roster(), store, log: silent })
  const back = again.get(c.task.id)
  assert.equal(back.parentId, task.id)
  assert.equal(back.depth, 2)
  assert.equal(back.status, 'interrupted')
})

// --- Wiring --------------------------------------------------------------------

test('the bridge offers the delegation server only for a run the manager lets delegate, and passes the depth setting', () => {
  const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(server, /const delegating = delegation \? DELEGATE_TOOLS\.filter\(\(n\) => policy\.decideTool\(n\)\) : \[\]/)
  assert.match(server, /if \(delegating\.length\) all\[DELEGATE_SERVER\] = delegateServer\(delegation\)/)
  assert.match(server, /maxDepth: agentSettings\.maxDepth,\n {2}costCounts/)
})

test('the delegation server starts and checks children through the handle it is given', async () => {
  const { delegateServer } = await import('./task-tools.mjs')
  const { TOOL_DEFS } = await import('./brains/sdk-tools.mjs')
  const { m, runs } = manager()
  m.spawn({ goal: 'x', agentId: 'coordinator' })
  await tick()
  const server = delegateServer(runs[0].ctx.delegation)
  const defs = Object.fromEntries(server[TOOL_DEFS].map((d) => [d.name, d]))
  assert.deepEqual(Object.keys(defs).sort(), ['check_agent', 'start_agent'])
  assert.match(defs.start_agent.description, /Researcher \(researcher\), Writer \(writer\)/)
  const read = (r) => JSON.parse(r.content[0].text)
  const started = read(await defs.start_agent.handler({ agent: 'researcher', goal: 'find flights' }))
  assert.equal(started.started, true)
  assert.equal(started.agent, 'Researcher')
  const refused = read(await defs.start_agent.handler({ agent: 'coder', goal: 'fix' }))
  assert.equal(refused.started, false)
  const status = read(await defs.check_agent.handler({ id: started.id }))
  assert.equal(status.status, 'running')
  assert.equal(read(await defs.check_agent.handler({ id: 'nope' })).found, false)
})
