import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_REFUSALS, BUDGET_STOPS, RUNTIME_TOOLS, WORKER_RULES, agentBrain, agentGuard, agentModel, agentPrompt,
  agentToolPlan, hiddenTools, narrowServers, narrowToolParams, workerRuleFor,
} from './agent-runtime.mjs'
import { checkAgentDefinition } from './agent-definition.mjs'
import { createPolicy } from './policy.mjs'
import { createBrainRegistry } from './brains/registry.mjs'
import { createTaskManager } from './tasks.mjs'
import { agentAuditSink, auditedApprove, normaliseEntry } from './audit.mjs'

const silent = { error() {}, log() {}, warn() {} }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }

/** A checked definition, as the registry hands it out. */
function def(over = {}) {
  const r = checkAgentDefinition({
    id: 'researcher', name: 'Researcher', description: 'Finds and cites sources.',
    tools: ['WebSearch', 'Read'], memory: 'read', createdBy: 'builtin', body: 'Cite every claim.', ...over,
  })
  assert.ok(r.ok, JSON.stringify(r.errors))
  return r.value
}

const none = () => false
const policyWith = ({ audit = null, frozen = () => false, allowWrites = false } = {}) => createPolicy({
  allowWrites,
  isMemoryTool: (n) => ['remember', 'list_memories', 'search_memory', 'update_memory', 'forget'].includes(n),
  isWorkflowTool: none,
  isTaskTool: (n) => ['spawn_task', 'list_tasks', 'task_status', 'cancel_task'].includes(n),
  isFrozen: frozen,
  connectorRule: (name) => ({ allow: name.includes('__read__'), rule: name.includes('__read__') ? 'connector-read' : 'connector-not-granted' }),
  ...(audit && { audit }),
})

// --- The tool plan ------------------------------------------------------------

test('the plan keeps only listed tools; worker rules drop starting agents, talking, memory writes, sending, scheduling, secrets and settings', () => {
  const policy = policyWith()
  const plan = agentToolPlan(def({
    tools: [
      'WebSearch', 'Read', 'Task', 'Agent', 'mcp__jarvis_tasks__spawn_task', 'mcp__jarvis_ui__ui_theme',
      'mcp__jarvis_memory__remember', 'mcp__jarvis_memory__search_memory', 'mcp__someones_server__send_email',
      'mcp__jarvis_workflows__create_workflow', 'mcp__someones_server__create_reminder', 'mcp__someones_server__read_secret',
      'mcp__someones_server__update_settings', 'mcp__jarvis_development__push_branch',
    ],
  }), { decideTool: policy.decideTool })
  assert.deepEqual(plan.allowed, ['Read', 'WebSearch', 'mcp__jarvis_memory__search_memory'])
  assert.deepEqual(Object.fromEntries(plan.dropped.map((d) => [d.tool, d.reason])), {
    Task: 'start-agents',
    Agent: 'start-agents',
    mcp__jarvis_tasks__spawn_task: 'start-agents',
    mcp__jarvis_ui__ui_theme: 'talk-to-user',
    mcp__jarvis_memory__remember: 'memory-write',
    mcp__someones_server__send_email: 'send-publish',
    mcp__jarvis_workflows__create_workflow: 'schedule',
    mcp__someones_server__create_reminder: 'schedule',
    mcp__someones_server__read_secret: 'secrets',
    mcp__someones_server__update_settings: 'settings',
    mcp__jarvis_development__push_branch: 'send-publish',
  })
})

test('every worker rule has an id and words, and reading tools break none of them', () => {
  for (const r of WORKER_RULES) assert.ok(r.id && r.text && typeof r.test === 'function')
  for (const n of ['Read', 'WebSearch', 'WebFetch', 'mcp__jarvis_workspace__read_file', 'mcp__jarvis_memory__search_memory',
    'mcp__jarvis_connectors__gmail__read__search_mail', 'mcp__jarvis_task__report_progress']) {
    assert.equal(workerRuleFor(n), null, n)
  }
})

test('memory none drops memory tools; connectors need a grant, and write tools a write grant', () => {
  const policy = policyWith()
  const decideTool = (n) => n.startsWith('mcp__jarvis_connectors__') || policy.decideTool(n)
  const plan = agentToolPlan(def({
    memory: 'none',
    tools: ['mcp__jarvis_memory__search_memory', 'mcp__jarvis_connectors__gmail__read__search_mail',
      'mcp__jarvis_connectors__notion__read__search', 'mcp__jarvis_connectors__gmail__write__archive'],
    connectors: { gmail: 'read' },
  }), { decideTool })
  assert.deepEqual(plan.allowed, ['mcp__jarvis_connectors__gmail__read__search_mail'])
  assert.deepEqual(plan.dropped.map((d) => d.reason), ['memory-scope', 'connector-not-granted', 'connector-read-only'])
})

test('a tool the policy denies is not offered, and a throwing policy counts as a denial', () => {
  const plan = agentToolPlan(def({ tools: ['Read', 'Bash'] }), { decideTool: policyWith().decideTool })
  assert.deepEqual(plan.allowed, ['Read'])
  assert.deepEqual(plan.dropped, [{ tool: 'Bash', reason: 'policy' }])
  assert.deepEqual(agentToolPlan(def(), { decideTool: () => { throw new Error('down') } }).allowed, [])
  assert.deepEqual(agentToolPlan(def({ tools: [] }), { decideTool: () => true }).allowed, [])
})

test('the runtime tools are always allowed and never come from the file', () => {
  const plan = agentToolPlan(def({ tools: [...RUNTIME_TOOLS] }), { decideTool: () => true })
  assert.deepEqual(plan, { allowed: [], dropped: [] })
})

// --- Guard, servers, hidden tools -----------------------------------------------

test('the guard refuses anything outside the list, spends the budget, then hands on', async () => {
  const spent = []
  const next = []
  const guard = agentGuard({
    allowed: ['Read'],
    budget: { toolCall: (n) => { spent.push(n); return spent.length > 1 ? 'over' : null } },
    next: async (n) => { next.push(n); return null },
  })
  assert.equal(await guard('Bash', {}), AGENT_REFUSALS.notAllowed)
  assert.equal(await guard(RUNTIME_TOOLS[0], {}), null)
  assert.equal(await guard('Read', {}), null)
  assert.equal(await guard('Read', {}), 'over')
  assert.deepEqual(spent, ['Read', 'Read'], 'progress reports are free')
  assert.deepEqual(next, [RUNTIME_TOOLS[0], 'Read'])
})

test('servers without an allowed tool are not started; unlisted tools are hidden', () => {
  const servers = { jarvis_task: 1, jarvis_workspace: 2, jarvis_development: 3, someones: 4 }
  assert.deepEqual(narrowServers(servers, ['Read', 'mcp__jarvis_workspace__read_file']), { jarvis_task: 1, jarvis_workspace: 2 })
  const hidden = hiddenTools(['Read', 'mcp__jarvis_workspace__read_file'], {
    builtins: ['Read', 'Bash', 'Task'], known: ['mcp__jarvis_workspace__read_file', 'mcp__jarvis_workspace__write_file', RUNTIME_TOOLS[0]],
  })
  assert.deepEqual(hidden, ['Bash', 'Task', 'mcp__jarvis_workspace__write_file'])
  const params = narrowToolParams({ tools: { a: 1, b: 2, [RUNTIME_TOOLS[1]]: 3 }, toolSpecs: { a: {}, b: {} } }, ['a'])
  assert.deepEqual(params, { tools: { a: 1, [RUNTIME_TOOLS[1]]: 3 }, toolSpecs: { a: {} } })
  assert.deepEqual(narrowToolParams({}, ['a']), {})
})

// --- Brain, model, prompt -----------------------------------------------------

test('brain: the named one if installed, else the default with a note; external agents do not run', () => {
  const brains = { has: (id) => id === 'claude' || id === 'mock', get: (id) => ({ id }), default: () => ({ id: 'claude' }) }
  assert.deepEqual(agentBrain(def({ brain: 'mock' }), brains), { ok: true, brain: { id: 'mock' } })
  const fallback = agentBrain(def({ brain: 'gemini' }), brains)
  assert.equal(fallback.brain.id, 'claude')
  assert.match(fallback.note, /gemini is not installed/)
  assert.equal(agentBrain(def({ brain: 'external:hermes' }), brains).ok, false)
  assert.equal(agentModel(def(), () => 'from-settings'), 'from-settings')
  assert.equal(agentModel(def({ model: 'claude-haiku-5-5' }), () => 'from-settings'), 'claude-haiku-5-5')
})

test('the prompt keeps the worker rules first and adds the role, memory scope and instructions', () => {
  const p = agentPrompt(def({ memory: 'propose' }), 'WORKER RULES')
  assert.ok(p.startsWith('WORKER RULES'))
  assert.match(p, /Your role: Researcher/)
  assert.match(p, /proposal; never save it yourself/)
  assert.ok(p.trimEnd().endsWith('Cite every claim.'))
})

// --- Audit tagging --------------------------------------------------------------

test('audit entries from an agent carry its id; a malformed id is dropped', async () => {
  const entries = []
  const sink = agentAuditSink((e) => entries.push(normaliseEntry(e)), 'researcher')
  const approve = auditedApprove(async () => true, sink, 'worker')
  await approve('Run it?', {})
  sink({ type: 'decision', actor: 'worker', stage: 'tool-bridge', request: { kind: 'tool', name: 'Read' }, decision: { verdict: 'allow', rule: 'read-only' } })
  assert.deepEqual(entries.map((e) => [e.type, e.agentId]), [['approval', 'researcher'], ['approval', 'researcher'], ['decision', 'researcher']])
  assert.equal(normaliseEntry({ type: 'result', actor: 'worker', agentId: 'Not An Id', request: { kind: 'tool', name: 'Read' } }).agentId, undefined)
  assert.equal(agentAuditSink(null, 'x'), null)
})

// --- End to end with a mocked brain -------------------------------------------------

/**
 * A tool-loop brain that offers what the bridge offers and then calls
 * `script` in order, one call per step, through the policy-gated tool bridge.
 */
function mockBrain(script, seen) {
  return {
    id: 'mock',
    label: 'Mock',
    capabilities: { tools: true, toolGate: 'loop' },
    status: () => ({ installed: true }),
    startSession: () => ({}),
    converse(params) {
      seen.offered = params.tools.offered()
      return {
        events: (async function* () {
          let i = 0
          for (const name of script) {
            i += 1
            const id = `c${i}`
            yield { t: 'tool_call', id, name, args: {} }
            yield await params.tools.run({ id, name, args: {} })
          }
          yield { t: 'text', delta: 'Found three desks.' }
          yield { t: 'done', reason: 'complete' }
        })(),
        cancel() {},
        close() {},
      }
    },
  }
}

/** The bridge's runNamedAgent, in miniature: the same pieces, wired the same way. */
function harness({ agent, script, frozen = () => false, costCounts = () => false }) {
  const audit = []
  const ran = []
  const seen = {}
  const brains = createBrainRegistry({ defaultId: 'mock', log: null })
  brains.register(mockBrain(script, seen))
  const handlers = Object.fromEntries(['Read', 'WebSearch', 'Bash', 'mcp__jarvis_task__report_progress'].map((n) => [n, async () => { ran.push(n); return 'ok' }]))
  const registry = { has: (id) => id === agent.id, get: () => agent, isActive: () => true }
  const runAgent = ({ agent: a, budget, signal }) => {
    const policy = policyWith({ audit: agentAuditSink((e) => audit.push(e), a.id), frozen })
    const { allowed } = agentToolPlan(a, { decideTool: policy.decideTool })
    const pick = agentBrain(a, brains)
    const controller = new AbortController()
    signal.addEventListener('abort', () => controller.abort(), { once: true })
    return pick.brain.converse({
      prompt: 'go', actor: 'worker', abortController: controller, policy,
      ...narrowToolParams({ tools: handlers }, allowed),
      guard: agentGuard({ allowed, budget }),
    }).events
  }
  const manager = createTaskManager({ runAgent, agents: registry, costCounts, log: silent })
  return { manager, audit, ran, seen }
}

test('a tool outside the allow-list is never offered and never run', async () => {
  const h = harness({ agent: def({ brain: 'mock', tools: ['Read', 'WebSearch'] }), script: ['Read', 'Bash'] })
  const { task } = h.manager.spawn({ title: 'Desks', goal: 'compare three desks', agentId: 'researcher' })
  await settle()
  assert.deepEqual(h.seen.offered.sort(), ['Read', 'WebSearch', 'mcp__jarvis_task__report_progress'])
  assert.deepEqual(h.ran, ['Read'])
  const t = h.manager.get(task.id)
  assert.equal(t.status, 'done')
  assert.equal(t.agentId, 'researcher')
  assert.equal(t.agentName, 'Researcher')
  assert.ok(h.audit.every((e) => e.agentId === 'researcher'))
})

test('a policy denial still denies a tool the definition allows', async () => {
  let frozen = false
  const h = harness({ agent: def({ brain: 'mock', tools: ['Read', 'WebSearch'] }), script: ['Read', 'WebSearch'], frozen: () => frozen })
  const realRun = h.ran.push.bind(h.ran)
  // Freeze everything (the kill switch) as soon as the first tool has run.
  h.ran.push = (n) => { frozen = true; return realRun(n) }
  h.manager.spawn({ title: 'Desks', goal: 'compare', agentId: 'researcher' })
  await settle()
  assert.deepEqual([...h.ran], ['Read'])
  const denied = h.audit.filter((e) => e.decision?.verdict === 'deny').map((e) => e.request.name)
  assert.deepEqual(denied, ['WebSearch'])
})

test('a budget of tool calls is a hard stop: the next call is refused and the task fails honestly', async () => {
  const h = harness({
    agent: def({ brain: 'mock', tools: ['Read', 'WebSearch'], budget: { maxToolCalls: 2, maxMinutes: 5, maxCostUsd: 1 } }),
    script: ['Read', 'WebSearch', 'Read', 'Read'],
  })
  const { task } = h.manager.spawn({ title: 'Desks', goal: 'compare', agentId: 'researcher' })
  await settle(10)
  assert.deepEqual(h.ran, ['Read', 'WebSearch'])
  const t = h.manager.get(task.id)
  assert.equal(t.status, 'failed')
  assert.equal(t.error, BUDGET_STOPS.toolCalls(2))
  assert.equal(t.result, '')
})

// --- The task manager's side ------------------------------------------------------

/** An agent whose BrainEvents the test feeds by hand. */
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
  return { runAgent, runs }
}

test('spawn refuses an unknown agent and one that is switched off; a plain task has no agent fields', async () => {
  const { runAgent, runs } = fakeRun()
  const agent = def()
  let on = false
  const agents = { has: (id) => id === 'researcher', get: () => agent, isActive: () => on }
  const m = createTaskManager({ runAgent, agents, log: silent })
  assert.deepEqual(m.spawn({ goal: 'x', agentId: 'nobody' }), { ok: false, reason: 'There is no agent by that name.' })
  assert.deepEqual(m.spawn({ goal: 'x', agentId: 'researcher' }), { ok: false, reason: 'The Researcher agent is not switched on.' })
  const noRegistry = createTaskManager({ runAgent, log: silent })
  assert.equal(noRegistry.spawn({ goal: 'x', agentId: 'researcher' }).ok, false)
  const plain = noRegistry.spawn({ goal: 'x' }).task
  assert.equal('agentId' in plain, false)
  await tick()
  assert.equal(runs.at(-1).ctx.agent, undefined, 'a plain task is run exactly as before')
  on = true
  const { task } = m.spawn({ goal: 'x', agentId: 'researcher' })
  await tick()
  assert.equal(runs.at(-1).ctx.agent, agent)
  assert.equal(task.agentName, 'Researcher')
})

test('an agent switched off while queued fails at start without running', async () => {
  const { runAgent, runs } = fakeRun()
  let on = true
  const agents = { has: () => true, get: () => def(), isActive: () => on }
  const m = createTaskManager({ runAgent, agents, concurrency: 1, log: silent })
  m.spawn({ goal: 'first' })
  const { task } = m.spawn({ goal: 'second', agentId: 'researcher' })
  await tick()
  on = false
  runs[0].push({ t: 'text', delta: 'ok' })
  runs[0].push({ t: 'done', reason: 'complete' })
  await settle()
  assert.equal(runs.length, 1)
  assert.equal(m.get(task.id).status, 'failed')
  assert.match(m.get(task.id).error, /not available/)
})

test('the time limit stops the run and fails it with the reason', async () => {
  const { runAgent, runs } = fakeRun()
  const agent = def({ budget: { maxToolCalls: 10, maxMinutes: 0.0005, maxCostUsd: 1 } })
  const m = createTaskManager({ runAgent, agents: { has: () => true, get: () => agent, isActive: () => true }, log: silent })
  const { task } = m.spawn({ goal: 'x', agentId: 'researcher' })
  await tick()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(runs[0].ctx.signal.aborted, true)
  assert.equal(m.get(task.id).status, 'failed')
  assert.equal(m.get(task.id).error, BUDGET_STOPS.minutes(0.0005))
})

test('the cost limit applies only when the run is billed per use', async () => {
  for (const billed of [false, true]) {
    const { runAgent, runs } = fakeRun()
    const agent = def({ budget: { maxToolCalls: 10, maxMinutes: 5, maxCostUsd: 0.1 } })
    const asked = []
    const m = createTaskManager({
      runAgent, agents: { has: () => true, get: () => agent, isActive: () => true },
      costCounts: (a) => { asked.push(a.id); return billed }, log: silent,
    })
    const { task } = m.spawn({ goal: 'x', agentId: 'researcher' })
    await tick()
    runs[0].push({ t: 'usage', inTokens: 1, outTokens: 1, costUsd: 0.25 })
    await settle()
    assert.deepEqual(asked, ['researcher'])
    assert.equal(m.get(task.id).status, billed ? 'failed' : 'running')
    if (billed) assert.equal(m.get(task.id).error, BUDGET_STOPS.cost(0.1))
    m.cancelAll()
  }
})

test('approval cards name the agent; the store keeps the agent id across a restart', async () => {
  const { runAgent, runs } = fakeRun()
  const saved = new Map()
  const store = { save: (t) => saved.set(t.id, structuredClone(t)), load: () => [...saved.values()], remove: (id) => saved.delete(id) }
  const agents = { has: () => true, get: () => def(), isActive: () => true }
  const m = createTaskManager({ runAgent, agents, store, log: silent })
  const { task } = m.spawn({ title: 'Desks', goal: 'x', agentId: 'researcher' })
  await tick()
  const titles = []
  await runs[0].ctx.wrapApprove(async (title) => { titles.push(title); return true })('Fetch a page', {})
  assert.deepEqual(titles, ['Task "Desks" (Researcher): Fetch a page'])
  assert.equal(saved.get(task.id).agentId, 'researcher')
  const again = createTaskManager({ runAgent, agents, store, log: silent })
  const back = again.get(task.id)
  assert.equal(back.status, 'paused')
  assert.equal(back.agentId, 'researcher')
  assert.equal(back.agentName, 'Researcher')
})
