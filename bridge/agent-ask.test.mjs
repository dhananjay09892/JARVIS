/**
 * Task A06: asking a named agent from the voice session. Fixture agents in a
 * temporary data folder, the real registry, settings and task manager, and a
 * mocked agent run; no real account or model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentOperations, nameKey, parseAgentRequest, resolveAgent, roster } from './agent-ask.mjs'
import { createAgentRegistry, createToolCatalogue } from './agents.mjs'
import { createAgentSettings, switchedRegistry } from './agent-settings.mjs'
import { formatAgentFile } from './agent-definition.mjs'
import { settingDef } from './settings-registry.mjs'
import { createTaskManager } from './tasks.mjs'
import { agentToolPlan, workerRuleFor } from './agent-runtime.mjs'
import { createPolicy } from './policy.mjs'
import { outboundKind } from './taint.mjs'

const BUILTINS = fileURLToPath(new URL('../shared/fixtures/agents/ask/builtin/', import.meta.url))
const silent = { error() {}, log() {}, warn() {} }
const tick = () => new Promise((r) => setImmediate(r))

/** A run that never ends by itself, so a started task stays on the board. */
async function* hangs({ signal }) {
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
  yield { t: 'done', reason: 'cancelled' }
}

function rig({ values = {}, userAgents = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-ask-'))
  const userDir = join(root, 'agents')
  mkdirSync(userDir)
  for (const def of userAgents) writeFileSync(join(userDir, `${def.id}.md`), formatAgentFile(def))
  const registry = createAgentRegistry({
    builtinDir: BUILTINS, userDir, approvalsFile: join(root, 'agent-approvals.json'),
    tools: createToolCatalogue(), connectors: [], log: silent,
  })
  registry.load()
  const v = { ...values }
  const settings = createAgentSettings({ read: (id) => v[id] || settingDef(id)?.default || undefined })
  const agents = switchedRegistry(registry, settings)
  const runs = []
  const manager = createTaskManager({
    agents, log: silent, paused: settings.paused,
    runAgent: (ctx) => { runs.push(ctx); return hangs(ctx) },
  })
  const ops = agentOperations(manager, agents)
  return { v, settings, agents, manager, ops, runs, done: () => { manager.cancelAll(); rmSync(root, { recursive: true, force: true }) } }
}

// --- the done-when -------------------------------------------------------------

test('"ask the researcher to compare three desks" queues a task for the researcher with that goal', async () => {
  const r = rig()
  try {
    const out = r.ops.start({ request: 'ask the researcher to compare three desks' })
    assert.equal(out.started, true, JSON.stringify(out))
    assert.equal(out.agent, 'Researcher')
    const [task] = r.manager.list()
    assert.equal(task.agentId, 'researcher')
    assert.equal(task.agentName, 'Researcher')
    assert.equal(task.goal, 'compare three desks')
    await tick()
    assert.equal(r.runs.length, 1)
    assert.equal(r.runs[0].agent.id, 'researcher', 'the run gets the researcher definition')
    assert.equal(r.runs[0].task.goal, 'compare three desks')
  } finally { r.done() }
})

test('the model can name the agent and write the goal itself, by id or by name', () => {
  const r = rig()
  try {
    assert.equal(r.ops.start({ agent: 'writer', goal: 'Draft a thank-you note to Sam' }).agent, 'Writer')
    assert.equal(r.ops.start({ agent: 'the Inbox Triager agent', goal: "Sort today's mail", title: 'Mail' }).agent, 'Inbox Triager')
    const byAgent = Object.fromEntries(r.manager.list().map((t) => [t.agentId, t]))
    assert.equal(byAgent.writer.goal, 'Draft a thank-you note to Sam')
    assert.equal(byAgent['inbox-triager'].title, 'Mail')
  } finally { r.done() }
})

test('an unknown agent gets a clear spoken answer naming the agents there are, and nothing is queued', () => {
  const r = rig()
  try {
    const out = r.ops.start({ request: 'ask the plumber to fix the sink' })
    assert.equal(out.started, false)
    assert.match(out.reason, /I don't have an agent called "plumber"/)
    assert.equal(out.reason, 'I don\'t have an agent called "plumber". The agents I can ask are Inbox Triager, Researcher and Writer.')
    const named = r.ops.start({ agent: 'accountant', goal: 'do my taxes' })
    assert.equal(named.started, false)
    assert.match(named.reason, /"accountant"/)
    assert.equal(r.manager.list().length, 0)
  } finally { r.done() }
})

test('a switched-off agent says how to switch it on, and nothing is queued', () => {
  const r = rig()
  try {
    Object.assign(r.v, r.settings.switchPatch('writer', false))
    const out = r.ops.start({ request: 'get the writer to draft a note' })
    assert.equal(out.started, false)
    assert.equal(out.reason, 'The Writer agent is switched off. You can switch it on in Settings, under Agents.')
    assert.equal(r.manager.list().length, 0)
    assert.deepEqual(r.ops.list().agents.find((a) => a.id === 'writer'), {
      id: 'writer', name: 'Writer', description: 'Drafts emails, messages and documents. Ships only in test fixtures.', mode: 'on-demand', on: false, why: 'switched off',
    })
  } finally { r.done() }
})

test('an agent-made agent waiting for approval cannot be asked yet', () => {
  const r = rig({
    userAgents: [{
      id: 'desk-scout', name: 'Desk Scout', description: 'Finds desks.', mode: 'on-demand', tools: ['WebSearch'],
      memory: 'none', output: 'report', createdBy: 'agent', requestedBy: 'owner', body: 'Find desks.',
    }],
  })
  try {
    const out = r.ops.start({ agent: 'desk scout', goal: 'find a standing desk' })
    assert.equal(out.started, false)
    assert.match(out.reason, /Desk Scout agent is waiting for your approval/)
    assert.equal(r.manager.list().length, 0)
  } finally { r.done() }
})

test('with all agents paused the manager refuses and says why', () => {
  const r = rig({ values: { JARVIS_AGENTS_PAUSED: '1' } })
  try {
    const out = r.ops.start({ agent: 'researcher', goal: 'compare desks' })
    assert.equal(out.started, false)
    assert.match(out.reason, /paused/i)
  } finally { r.done() }
})

test('missing pieces are asked for, not guessed', () => {
  const r = rig()
  try {
    assert.equal(r.ops.start({}).reason, 'Say which agent to ask.')
    assert.equal(r.ops.start({ agent: 'researcher' }).reason, 'What should the Researcher agent do?')
    assert.match(r.ops.start({ request: 'what time is it' }).reason, /do not ask a named agent/)
    assert.equal(r.manager.list().length, 0)
  } finally { r.done() }
})

// --- parsing and matching -------------------------------------------------------

const ENTRIES = [
  { id: 'researcher', name: 'Researcher', on: true },
  { id: 'writer', name: 'Writer', on: true },
  { id: 'inbox-triager', name: 'Inbox Triager', on: true },
]

test('voice phrases split into the agent and the goal', () => {
  const cases = [
    ['ask the researcher to compare three desks', 'researcher', 'compare three desks'],
    ['Ask the Researcher to compare three desks.', 'researcher', 'compare three desks'],
    ['get the writer to draft a thank-you note', 'writer', 'draft a thank-you note'],
    ['have the inbox triager sort today\'s mail', 'inbox-triager', 'sort today\'s mail'],
    ['could you ask the researcher agent to find flights to Lisbon?', 'researcher', 'find flights to Lisbon'],
    ['jarvis, tell the writer to tidy my cover letter', 'writer', 'tidy my cover letter'],
    ['please get my writer to answer Sam', 'writer', 'answer Sam'],
  ]
  for (const [words, id, goal] of cases) {
    const p = parseAgentRequest(words, ENTRIES)
    assert.equal(p?.agent?.id, id, words)
    assert.equal(p.goal, goal, words)
  }
})

test('words that are not a request to an agent are not parsed as one', () => {
  for (const words of ['what time is it', 'ask me to stretch at four', 'remind them to call', 'researcher', '', 'tell him to wait']) {
    assert.equal(parseAgentRequest(words, ENTRIES), null, words)
  }
  assert.deepEqual(parseAgentRequest('ask the plumber to fix the sink', ENTRIES), { agent: null, query: 'plumber', goal: 'fix the sink' })
})

test('names match loosely but only to an agent in the roster', () => {
  assert.equal(resolveAgent(ENTRIES, 'researcher')?.id, 'researcher')
  assert.equal(resolveAgent(ENTRIES, 'The Researcher')?.id, 'researcher')
  assert.equal(resolveAgent(ENTRIES, 'inbox triager')?.id, 'inbox-triager')
  assert.equal(resolveAgent(ENTRIES, 'Inbox-Triager agent')?.id, 'inbox-triager')
  assert.equal(resolveAgent(ENTRIES, 'research'), null, 'no prefix guessing')
  assert.equal(resolveAgent(ENTRIES, ''), null)
  assert.equal(nameKey("the writer's"), 'writer')
})

test('an unknown name is cleaned before it is spoken back', () => {
  const ops = agentOperations({ spawn() { throw new Error('must not spawn') } }, { list: () => [], isActive: () => false })
  const out = ops.start({ agent: 'x<script>alert(1)</script>', goal: 'g' })
  assert.equal(out.started, false)
  assert.doesNotMatch(out.reason, /[<>()]/)
  assert.match(out.reason, /No agents are set up yet/)
})

test('the roster survives a registry that throws', () => {
  assert.deepEqual(roster({ list() { throw new Error('boom') }, isActive: () => true }), [])
  assert.deepEqual(roster(null), [])
})

// --- only the voice session can start an agent ---------------------------------

test('a worker agent can never be given the start-agent or list-agents tools', () => {
  for (const n of ['mcp__jarvis_tasks__start_agent', 'mcp__jarvis_tasks__list_agents']) {
    assert.equal(workerRuleFor(n)?.id, 'start-agents', n)
  }
  const policy = createPolicy({
    allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false,
    isTaskTool: (n) => ['spawn_task', 'list_tasks', 'task_status', 'cancel_task', 'start_agent', 'list_agents'].includes(n),
    audit() {},
  })
  const r = rig()
  try {
    const plan = agentToolPlan(
      { ...r.agents.get('researcher'), tools: ['WebSearch', 'mcp__jarvis_tasks__start_agent', 'mcp__jarvis_tasks__list_agents'] },
      { decideTool: policy.decideTool },
    )
    assert.deepEqual(plan.allowed, ['WebSearch'])
    assert.deepEqual(plan.dropped.map((d) => d.reason), ['start-agents', 'start-agents'])
  } finally { r.done() }
})

test('the voice session may call the new task tools, and a start brief is scanned for links like spawn_task', () => {
  const policy = createPolicy({
    allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false,
    isTaskTool: (n) => ['start_agent', 'list_agents'].includes(n), audit() {},
  })
  assert.equal(policy.decideTool('mcp__jarvis_tasks__start_agent'), true)
  assert.equal(policy.decideTool('mcp__jarvis_tasks__list_agents'), true)
  assert.equal(outboundKind('mcp__jarvis_tasks__start_agent', { goal: 'x' }), 'scan')
  assert.equal(outboundKind('mcp__jarvis_tasks__list_agents', {}), 'none')
})

test('the bridge builds the agent tools once, for the voice session, from the switched registry', async () => {
  const { readFileSync } = await import('node:fs')
  const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const calls = server.match(/taskServer\(/g) ?? []
  assert.equal(calls.length, 1, 'one jarvis_tasks server, in the voice session')
  assert.match(server, /jarvis_tasks: taskServer\(taskManager, \{ agents: switchedAgents \}\)/)
  const tools = readFileSync(new URL('./task-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /const ORCHESTRATOR_TOOLS = \[[^\]]*'start_agent', 'list_agents'\]/)
})
