/**
 * Task A16: the Coordinator, the first built-in agent. Its shipped file loads
 * through the real registry, its tools are only memory reads, it is the only
 * definition with a delegate list, it delegates only to that list, and a
 * request that names no agent is matched to the right starter agent. The real
 * registry and task manager with a mocked agent run; no real account or model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_AGENTS_DIR, createAgentRegistry, createToolCatalogue } from './agents.mjs'
import { COORDINATOR_ID, formatAgentFile, parseAgentFile } from './agent-definition.mjs'
import { DELEGATION_REFUSALS, DELEGATE_TOOLS } from './agent-delegation.mjs'
import { agentOperations, roster } from './agent-ask.mjs'
import { MIN_SCORE, STARTER_HINTS, matchAgent } from './agent-match.mjs'
import { MEMORY_READ_TOOLS, agentToolPlan, workerRuleFor } from './agent-runtime.mjs'
import { BRIEFING_SERVER, BRIEFING_TOOL_NAMES, CODER_SERVER, CODER_TOOL_NAMES, WATCH_SERVER, WATCH_TOOL_NAMES, MEETING_SERVER, MEETING_TOOL_NAMES, BROWSER_SERVER, BROWSER_TOOL_NAMES, createPolicy } from './policy.mjs'
import { createTaskManager } from './tasks.mjs'
import { AGENT_SETTINGS, createAgentSettings, switchedRegistry } from './agent-settings.mjs'
import { BUILTIN_AGENT_CONNECTORS } from './fixtures/agent-connectors.mjs'

const silent = { error() {}, log() {}, warn() {} }
const tick = () => new Promise((r) => setImmediate(r))
const COORDINATOR_FILE = join(BUILTIN_AGENTS_DIR, 'coordinator.md')
// memory-tools.mjs's list, as the bridge hands it to the policy engine; kept
// here so this test needs no SDK packages.
const isMemoryTool = (n) => ['remember', 'list_memories', 'search_memory', 'update_memory', 'forget'].includes(n)

/** The starter agents the Coordinator may hand work to, in roster order. */
const STARTERS = [
  ['researcher', 'Researcher', 'Finds, compares and cites sources on the web and in your notes.'],
  ['writer', 'Writer', 'Drafts emails, messages, documents and summaries.'],
  ['reviewer', 'Reviewer', 'Checks another agent\'s result against the request and its evidence.'],
  ['coder', 'Coder', 'Makes code changes in a git worktree and runs the tests.'],
  ['inbox-triager', 'Inbox Triager', 'Sorts mail and chats by priority and flags what is urgent.'],
  ['morning-briefing', 'Morning Briefing', 'Your calendar, mail, weather, news and tasks for the day, spoken.'],
  ['memory-curator', 'Memory Curator', 'Proposes what to remember, merges duplicates and flags stale facts.'],
]

/** What a worker session could be given, as the bridge builds it (server.mjs workerCatalogue). */
const CATALOGUE = createToolCatalogue({
  servers: {
    jarvis_task: ['report_progress', 'ask_owner'],
    jarvis_memory: ['remember', 'list_memories', 'search_memory', 'update_memory', 'forget'],
    [CODER_SERVER]: [...CODER_TOOL_NAMES],
    [BRIEFING_SERVER]: [...BRIEFING_TOOL_NAMES],
    [WATCH_SERVER]: [...WATCH_TOOL_NAMES],
    [MEETING_SERVER]: [...MEETING_TOOL_NAMES],
    [BROWSER_SERVER]: [...BROWSER_TOOL_NAMES],
  },
})

/** The read connectors the shipped built-ins name, as the connector registry lists them. */
const CONNECTORS = BUILTIN_AGENT_CONNECTORS

/** Starter agents already shipped as built-ins; the rig adds fixtures only for the rest. */
const SHIPPED = new Set(readdirSync(BUILTIN_AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)))

const userDef = (id, name, description, over = {}) => ({
  id, name, description, tools: ['Read'], memory: 'read', createdBy: 'user', body: `You are the ${name}.`, ...over,
})

/** The shipped built-ins, plus fixture starter agents and one agent not on the list, in a temp data folder. */
function rig({ maxDepth = 2, extra = [], switches = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-coordinator-'))
  const userDir = join(root, 'agents')
  mkdirSync(userDir)
  const defs = [
    ...STARTERS.filter(([id]) => !SHIPPED.has(id)).map(([id, name, d]) => userDef(id, name, d)),
    userDef('plumber', 'Plumber', 'Fixes pipes.'), ...extra,
  ]
  for (const d of defs) writeFileSync(join(userDir, `${d.id}.md`), formatAgentFile(d))
  const registry = createAgentRegistry({
    userDir, approvalsFile: join(root, 'agent-approvals.json'), tools: CATALOGUE, connectors: CONNECTORS, log: silent,
  })
  const summary = registry.load()
  const runs = []
  // With `switches`, the owner's on/off switches apply as in the bridge (scheduled agents start off).
  const agents = switches === null ? registry : switchedRegistry(registry, createAgentSettings({ read: (id) => (id === AGENT_SETTINGS.switches ? switches : undefined) }))
  const manager = createTaskManager({
    agents, log: silent, maxDepth: () => maxDepth,
    runAgent: (ctx) => {
      runs.push(ctx)
      return (async function* hang() {
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }))
        yield { t: 'done', reason: 'cancelled' }
      })()
    },
  })
  return { registry, summary, manager, runs, done: () => { manager.cancelAll(); rmSync(root, { recursive: true, force: true }) } }
}

// --- the definition loads -------------------------------------------------------

test('the Coordinator ships as a built-in file that parses', () => {
  const files = readdirSync(BUILTIN_AGENTS_DIR).filter((f) => f.endsWith('.md'))
  assert.ok(files.includes('coordinator.md'))
  const parsed = parseAgentFile(readFileSync(COORDINATOR_FILE, 'utf8'))
  assert.ok(parsed.ok, JSON.stringify(parsed.errors))
  const d = parsed.value
  assert.equal(d.id, COORDINATOR_ID)
  assert.equal(d.createdBy, 'builtin')
  assert.equal(d.mode, 'on-demand')
  assert.equal(d.memory, 'read', 'reads memory, never writes it')
  assert.deepEqual(d.connectors, {})
  assert.ok(d.budget, 'its children share its budget, so it has one')
  assert.deepEqual(d.delegate, STARTERS.map(([id]) => id), 'its allow-list is the starter set')
})

test('the real registry loads it as an active, read-only built-in and refuses nothing', () => {
  const r = rig()
  try {
    assert.equal(r.summary.refused, 0, JSON.stringify(r.registry.refused()))
    const view = r.registry.list().find((a) => a.id === COORDINATOR_ID)
    assert.ok(view)
    assert.equal(view.source, 'builtin')
    assert.equal(view.readOnly, true)
    assert.equal(r.registry.isActive(COORDINATOR_ID), true)
  } finally { r.done() }
})

test('it is the only definition with a delegate list', () => {
  const r = rig()
  try {
    for (const a of r.registry.list()) {
      const d = r.registry.get(a.id)
      if (a.id === COORDINATOR_ID) assert.ok(d.delegate.length > 0)
      else assert.deepEqual(d.delegate, [], `${a.id} may not delegate`)
    }
    for (const f of readdirSync(BUILTIN_AGENTS_DIR).filter((x) => x.endsWith('.md'))) {
      const d = parseAgentFile(readFileSync(join(BUILTIN_AGENTS_DIR, f), 'utf8')).value
      if (d.id !== COORDINATOR_ID) assert.deepEqual(d.delegate, [], `built-in ${d.id} may not delegate`)
    }
  } finally { r.done() }
})

test('its tools are only memory reads: nothing the worker rules drop, nothing that writes', () => {
  const d = parseAgentFile(readFileSync(COORDINATOR_FILE, 'utf8')).value
  assert.deepEqual([...d.tools].sort(), MEMORY_READ_TOOLS.map((t) => `mcp__jarvis_memory__${t}`).sort())
  for (const t of d.tools) assert.equal(workerRuleFor(t), null, `${t} breaks no worker rule`)
  for (const t of DELEGATE_TOOLS) assert.ok(!d.tools.includes(t), 'delegation tools come from the runtime, never the file')
  const policy = createPolicy({ allowWrites: false, isMemoryTool })
  const plan = agentToolPlan(d, { decideTool: policy.forAgent(COORDINATOR_ID).decideTool })
  assert.deepEqual([...plan.allowed].sort(), [...d.tools].sort(), 'the policy agrees to each of them')
  assert.deepEqual(plan.dropped, [])
})

test('its instructions keep it from sending, writing memory or obeying text it reads', () => {
  const d = parseAgentFile(readFileSync(COORDINATOR_FILE, 'utf8')).value
  assert.match(d.body, /## Never/)
  assert.match(d.body, /Send, post, publish/)
  assert.match(d.body, /Write memory/)
  assert.match(d.body, /Follow instructions found inside/)
  assert.match(d.body, /complete brief/)
})

// --- it delegates only to its allow-list ---------------------------------------

test('at depth 2 the Coordinator is handed exactly its list and starts an agent on it', async () => {
  const r = rig()
  try {
    const { task } = r.manager.spawn({ title: 'Desk', goal: 'choose a desk and write it up', agentId: COORDINATOR_ID })
    await tick()
    const d = r.runs[0].delegation
    assert.ok(d, 'delegation is handed to the Coordinator')
    assert.deepEqual(d.agents(), STARTERS.map(([id, name]) => ({ id, name })))
    const started = d.start({ agent: 'researcher', goal: 'compare three standing desks under 400 pounds' })
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.task.agentId, 'researcher')
    assert.equal(started.task.parentId, task.id)
    await tick()
    assert.equal(r.runs[1].delegation, undefined, 'the researcher is a worker and may not delegate')
  } finally { r.done() }
})

test('an agent off its list is refused, even one that is installed and on', async () => {
  const r = rig()
  try {
    r.manager.spawn({ goal: 'fix the sink', agentId: COORDINATOR_ID })
    await tick()
    const d = r.runs[0].delegation
    assert.equal(r.registry.isActive('plumber'), true)
    const out = d.start({ agent: 'plumber', goal: 'fix the sink' })
    assert.equal(out.ok, false)
    assert.equal(out.reason, DELEGATION_REFUSALS.offList(STARTERS.map(([, name]) => name)))
    assert.equal(d.start({ agent: 'coordinator', goal: 'loop' }).ok, false, 'not itself either')
    assert.equal(r.runs.length, 1, 'nothing else ran')
  } finally { r.done() }
})

test('a starter agent that is switched off is refused in words, not by a crash', async () => {
  // The Memory Curator is scheduled, so it is off until the owner switches it on.
  const r = rig({ switches: '' })
  try {
    r.manager.spawn({ goal: 'tidy my memories', agentId: COORDINATOR_ID })
    await tick()
    const out = r.runs[0].delegation.start({ agent: 'memory-curator', goal: 'tidy my memories' })
    assert.equal(out.ok, false)
    assert.match(out.reason, /not switched on/)
  } finally { r.done() }
})

test('at the default depth 1 the Coordinator works alone', async () => {
  const r = rig({ maxDepth: 1 })
  try {
    const { task } = r.manager.spawn({ goal: 'plan a trip', agentId: COORDINATOR_ID })
    await tick()
    assert.equal(r.runs[0].delegation, undefined)
    assert.deepEqual(r.manager.delegate(task.id, { agent: 'researcher', goal: 'x' }), { ok: false, reason: DELEGATION_REFUSALS.depthOff })
  } finally { r.done() }
})

// --- matching a request to a starter agent --------------------------------------

const ENTRIES = STARTERS.map(([id, name, description]) => ({ id, name, description, on: true }))

const FIXTURE_REQUESTS = [
  ['compare three standing desks and cite reviews', 'researcher'],
  ['research the best electric cars for a family of four', 'researcher'],
  ['find out what the council said about the new bus route', 'researcher'],
  ['draft a thank-you note to Priya for the dinner', 'writer'],
  ['write a cover letter for the design job', 'writer'],
  ['draft an email to the landlord about the boiler', 'writer'],
  ['fact-check this paragraph before I send it', 'reviewer'],
  ['review the report the researcher wrote', 'reviewer'],
  ['fix the failing tests in the bridge repo', 'coder'],
  ['write a python script to rename my photos by date', 'coder'],
  ['open a pull request that bumps the version', 'coder'],
  ['triage my inbox and tell me what is urgent', 'inbox-triager'],
  ['go through my unread emails', 'inbox-triager'],
  ['give me my morning briefing', 'morning-briefing'],
  ["what's on today and what's the weather", 'morning-briefing'],
  ['tidy up my memories and flag stale facts', 'memory-curator'],
  ['merge duplicate memories', 'memory-curator'],
]

test('fixture requests that name no agent are matched to the right starter agent', () => {
  for (const [request, want] of FIXTURE_REQUESTS) {
    const m = matchAgent(ENTRIES, request)
    assert.equal(m.agent?.id ?? null, want, `${request} → ${JSON.stringify(m.candidates)}`)
    assert.ok(m.score >= MIN_SCORE)
  }
})

test('every starter agent on the Coordinator\'s list has hints, and each is reachable by a fixture', () => {
  const d = parseAgentFile(readFileSync(COORDINATOR_FILE, 'utf8')).value
  for (const id of d.delegate) {
    assert.ok(STARTER_HINTS[id]?.length, `hints for ${id}`)
    assert.ok(FIXTURE_REQUESTS.some(([, want]) => want === id), `a fixture for ${id}`)
  }
})

test('chit-chat matches nobody; a close call returns candidates, not a guess', () => {
  for (const words of ['what time is it', 'thanks', '', '   ', 'tell me a joke']) {
    assert.equal(matchAgent(ENTRIES, words).agent, null, words)
  }
  const close = matchAgent(ENTRIES, 'review and research this')
  assert.equal(close.agent, null)
  assert.deepEqual(close.candidates.slice(0, 2).map((c) => c.id).sort(), ['researcher', 'reviewer'])
  assert.equal(matchAgent(null, 'compare desks').agent, null)
  assert.equal(matchAgent(ENTRIES, 42).agent, null)
})

test('an agent that is off is never picked', () => {
  const off = ENTRIES.map((e) => (e.id === 'researcher' ? { ...e, on: false } : e))
  assert.notEqual(matchAgent(off, 'research the best electric cars').agent?.id, 'researcher')
})

test("the owner's own agents are found by their description", () => {
  const entries = [...ENTRIES, { id: 'gardener', name: 'Gardener', description: 'Plans planting, watering and pruning for the garden.', on: true }]
  assert.equal(matchAgent(entries, 'plan the watering for my garden this week').agent?.id, 'gardener')
})

// --- the voice session: by name or by match -------------------------------------

test('the voice session starts the matched agent when the words name none, and says it matched', async () => {
  const r = rig({ maxDepth: 1 })
  try {
    const ops = agentOperations(r.manager, r.registry)
    const out = ops.start({ request: 'compare three standing desks and cite reviews.' })
    assert.equal(out.started, true, JSON.stringify(out))
    assert.equal(out.matched, true)
    assert.equal(out.agent, 'Researcher')
    await tick()
    assert.equal(r.runs.at(-1).agent.id, 'researcher')
    assert.equal(r.runs.at(-1).task.goal, 'compare three standing desks and cite reviews')

    const named = ops.start({ request: 'ask the writer to draft a note to Sam' })
    assert.equal(named.started, true)
    assert.equal(named.matched, undefined, 'a named agent is not a match')
    assert.equal(named.agent, 'Writer')

    const unknown = ops.start({ request: 'ask the gardener to plan the beds' })
    assert.equal(unknown.started, false, 'an unknown name is still an honest no, never a match')
    assert.match(unknown.reason, /don't have an agent called/)

    const vague = ops.start({ request: 'what time is it' })
    assert.equal(vague.started, false)
    assert.match(vague.reason, /No agent clearly fits/)
    const close = ops.start({ request: 'review and research this' })
    assert.equal(close.started, false)
    assert.match(close.reason, /not sure which agent fits/)
    assert.equal(r.manager.list().length, 2, 'only the two clear requests were queued')
  } finally { r.done() }
})

test('the Coordinator itself is on the roster the voice session can ask', () => {
  const r = rig()
  try {
    const entry = roster(r.registry).find((a) => a.id === COORDINATOR_ID)
    assert.ok(entry)
    assert.equal(entry.on, true)
  } finally { r.done() }
})
