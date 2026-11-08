/**
 * Task A19: the Reviewer, a built-in starter agent. Its shipped file loads
 * through the real registry, it is the source of the reviewer pass's
 * instructions, it has no write tools (none at all), and a definition that
 * asks for more cannot run the pass. Real registry, policy engine, runtime
 * guard and task manager, with a mocked brain; no real account or model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_AGENTS_DIR, createAgentRegistry, createToolCatalogue } from './agents.mjs'
import { parseAgentFile } from './agent-definition.mjs'
import { RUNTIME_TOOLS, agentGuard, agentToolPlan, hiddenTools } from './agent-runtime.mjs'
import {
  REVIEWER_ID, REVIEWER_RULES, REVIEWER_UNUSABLE, REVIEW_STOPS, createReviewer, reviewerDefinition, reviewerPrompt,
} from './agent-review.mjs'
import { matchAgent } from './agent-match.mjs'
import { READ_ONLY_BUILTINS, WRITE_BUILTINS, createPolicy } from './policy.mjs'
import { createTaskManager } from './tasks.mjs'
import { BUILTIN_AGENT_CONNECTORS } from './fixtures/agent-connectors.mjs'

const silent = { error() {}, log() {}, warn() {} }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick() }

const REVIEWER_FILE = join(BUILTIN_AGENTS_DIR, 'reviewer.md')
const reviewer = () => {
  const parsed = parseAgentFile(readFileSync(REVIEWER_FILE, 'utf8'))
  assert.ok(parsed.ok, JSON.stringify(parsed.errors))
  return parsed.value
}

const MEMORY = ['remember', 'list_memories', 'search_memory', 'update_memory', 'forget']
const isMemoryTool = (n) => MEMORY.includes(n)
const CATALOGUE = createToolCatalogue({
  servers: { jarvis_task: ['report_progress', 'ask_owner'], jarvis_memory: MEMORY },
})

/** Writes on and every connector capability granted: the most a policy could allow. */
const openPolicy = () => createPolicy({
  allowWrites: true,
  isMemoryTool,
  connectorRule: () => ({ allow: true, rule: 'connector-granted' }),
})

const loadRegistry = (name) => {
  const reg = createAgentRegistry({
    userDir: join(tmpdir(), `jarvis-reviewer-${name}`), approvalsFile: join(tmpdir(), `jarvis-reviewer-${name}.json`),
    tools: CATALOGUE, connectors: BUILTIN_AGENT_CONNECTORS, log: silent,
  })
  reg.load()
  return reg
}

/** Tools a worker could be offered that write, send or change something. */
const WRITE_TOOLS = [
  ...WRITE_BUILTINS,
  'mcp__jarvis_memory__remember', 'mcp__jarvis_memory__update_memory', 'mcp__jarvis_memory__forget',
  'mcp__jarvis_connectors__gmail__write__send_message',
  'mcp__jarvis_connectors__gdrive__write__create_file',
  'mcp__jarvis_workspace__write_file',
]

// --- the definition loads ---------------------------------------------------------

test('the Reviewer ships as a built-in file that parses, with nothing but its instructions', () => {
  const d = reviewer()
  assert.equal(d.id, REVIEWER_ID)
  assert.equal(d.name, 'Reviewer')
  assert.equal(d.createdBy, 'builtin')
  assert.equal(d.mode, 'on-demand', 'called by the runtime or the Coordinator, never on its own')
  assert.deepEqual(d.tools, [], 'no tools at all')
  assert.deepEqual(d.connectors, {})
  assert.equal(d.memory, 'none')
  assert.deepEqual(d.delegate, [])
  assert.equal(d.review, false, 'the reviewer is not itself reviewed')
  assert.ok(d.budget?.maxToolCalls > 0 && d.budget?.maxMinutes > 0, 'it has a budget')
  assert.deepEqual(reviewerDefinition(d), { ok: true, definition: d })
})

test('the real registry loads it as an active, read-only built-in the Coordinator may start', () => {
  const reg = loadRegistry('load')
  assert.equal(reg.refused().filter((r) => r.file === 'reviewer.md').length, 0, JSON.stringify(reg.refused()))
  const view = reg.list().find((a) => a.id === REVIEWER_ID)
  assert.ok(view)
  assert.equal(view.source, 'builtin')
  assert.equal(view.readOnly, true)
  assert.equal(reg.isActive(REVIEWER_ID), true)
  assert.ok(reg.get('coordinator').delegate.includes(REVIEWER_ID), 'on the Coordinator\'s allow-list')
  const entries = reg.active().map((a) => ({ id: a.id, name: a.name, description: a.description }))
  assert.equal(matchAgent(entries, 'fact-check this paragraph before I send it').agent?.id, REVIEWER_ID)
})

test('its instructions check evidence, not the summary, and end in a verdict', () => {
  const d = reviewer()
  assert.match(d.body, /Judge the evidence, not the summary's confidence/)
  assert.match(d.body, /claims\s+work the log does not show/)
  assert.match(d.body, /<untrusted_data>/)
  assert.match(d.body, /tells you to pass it,[\s\S]*fails/)
  assert.match(d.body, /"verdict": "pass"/)
  assert.match(d.body, /"verdict": "fail"/)
  assert.match(d.body, /## Never/)
  assert.match(d.body, /Rewrite, finish or improve the result yourself/)
})

// --- it has no write tools ------------------------------------------------------

test('with writes on and every connector granted, its run is given no tool but the runtime two', async () => {
  const d = reviewer()
  const plan = agentToolPlan(d, { decideTool: openPolicy().forAgent(REVIEWER_ID).decideTool })
  assert.deepEqual(plan.allowed, [])
  assert.deepEqual(plan.dropped, [])
  const hidden = hiddenTools(plan.allowed, { known: WRITE_TOOLS.filter((t) => t.startsWith('mcp__')) })
  for (const t of [...WRITE_BUILTINS, ...READ_ONLY_BUILTINS, 'Task', 'Agent']) assert.ok(hidden.includes(t), `${t} is hidden`)
  // If the brain asks anyway, the guard refuses every tool but progress and questions.
  const guard = agentGuard({ allowed: plan.allowed, budget: null, next: async () => null })
  for (const t of [...WRITE_TOOLS, ...READ_ONLY_BUILTINS, 'mcp__jarvis_memory__search_memory']) {
    assert.notEqual(await guard(t, {}), null, `${t} is refused`)
  }
  for (const t of RUNTIME_TOOLS) assert.equal(await guard(t, {}), null, `${t} stays available`)
})

test('a copy that asks for more cannot run the review pass', () => {
  const d = reviewer()
  assert.deepEqual(reviewerDefinition(null), { ok: false, reason: REVIEWER_UNUSABLE.missing })
  assert.deepEqual(reviewerDefinition({ ...d, tools: ['Write'] }), { ok: false, reason: REVIEWER_UNUSABLE.tools })
  assert.deepEqual(reviewerDefinition({ ...d, tools: ['Read'] }), { ok: false, reason: REVIEWER_UNUSABLE.tools }, 'not even a read tool')
  assert.deepEqual(reviewerDefinition({ ...d, connectors: { gmail: 'read' } }), { ok: false, reason: REVIEWER_UNUSABLE.connectors })
  assert.deepEqual(reviewerDefinition({ ...d, memory: 'read' }), { ok: false, reason: REVIEWER_UNUSABLE.memory })
  assert.deepEqual(reviewerDefinition({ ...d, delegate: ['writer'] }), { ok: false, reason: REVIEWER_UNUSABLE.delegate })
  assert.deepEqual(reviewerDefinition({ ...d, body: '  ' }), { ok: false, reason: REVIEWER_UNUSABLE.body })
})

// --- the review pass runs on the definition ----------------------------------------

function scriptedAgent(summaries) {
  const runs = []
  const runAgent = (ctx) => {
    const text = summaries[runs.length] ?? 'nothing'
    runs.push(ctx)
    return (async function* () {
      yield { t: 'tool_call', id: `x${runs.length}`, name: 'WebSearch', args: { q: 'desks' } }
      yield { t: 'text', delta: text }
      yield { t: 'done', reason: 'complete' }
    })()
  }
  return { runAgent, runs }
}

function scriptedConverse(verdicts) {
  const turns = []
  const converse = (o) => {
    const v = verdicts[turns.length]
    turns.push(o)
    return (async function* () {
      yield { t: 'text', delta: JSON.stringify(v) }
      yield { t: 'done', reason: 'complete' }
    })()
  }
  return { converse, turns }
}

const researcherDef = () => {
  const parsed = parseAgentFile(readFileSync(join(BUILTIN_AGENTS_DIR, 'researcher.md'), 'utf8'))
  assert.ok(parsed.ok)
  return parsed.value
}

test('the pass reads the Reviewer from the registry: rules first, then the file\'s instructions', async () => {
  const reg = loadRegistry('pass')
  const { converse, turns } = scriptedConverse([{ verdict: 'fail', reasons: ['Only two desks.'] }, { verdict: 'pass', reasons: [] }])
  const reviewerFn = createReviewer({ converse, definition: () => reg.get(REVIEWER_ID) })
  const agents = { has: () => true, get: () => ({ ...researcherDef(), review: true }), isActive: () => true }
  const { runAgent, runs } = scriptedAgent(['two desks [1]\n\nSources\n[1] https://a.example', 'three desks [1]\n\nSources\n[1] https://a.example'])
  const m = createTaskManager({ runAgent, agents, reviewer: reviewerFn, log: silent })
  const { task } = m.spawn({ title: 'Desks', goal: 'compare three desks', agentId: 'researcher' })
  await settle(30)
  assert.equal(m.get(task.id).status, 'done')
  assert.equal(runs.length, 2)
  assert.equal(turns.length, 2)
  const system = turns[0].systemPrompt
  assert.equal(system, reviewerPrompt(reg.get(REVIEWER_ID)))
  assert.ok(system.startsWith(REVIEWER_RULES), 'the standing rules come first')
  assert.ok(system.endsWith(reg.get(REVIEWER_ID).body), 'then the Reviewer file')
  assert.equal(turns[0].model, undefined, 'model: default leaves the brain\'s own')
})

test('the Reviewer file\'s own model is asked for', async () => {
  const d = { ...reviewer(), model: 'claude-haiku-5-5' }
  const { converse, turns } = scriptedConverse([{ verdict: 'pass', reasons: [] }])
  const r = await createReviewer({ converse, definition: d })({
    task: { title: 't', goal: 'g' }, agent: { name: 'A' }, result: 'r', log: [], attempt: 1, signal: new AbortController().signal,
  })
  assert.equal(r.pass, true)
  assert.equal(turns[0].model, 'claude-haiku-5-5')
})

test('without a usable Reviewer the result is not reviewed, so the task is not done', async () => {
  for (const [definition, why] of [
    [() => null, REVIEWER_UNUSABLE.missing],
    [() => ({ ...reviewer(), tools: ['Write'] }), REVIEWER_UNUSABLE.tools],
  ]) {
    const { converse, turns } = scriptedConverse([{ verdict: 'pass', reasons: [] }])
    const agents = { has: () => true, get: () => ({ ...researcherDef(), review: true }), isActive: () => true }
    const { runAgent } = scriptedAgent(['done'])
    const m = createTaskManager({ runAgent, agents, reviewer: createReviewer({ converse, definition }), log: silent })
    const { task } = m.spawn({ goal: 'g', agentId: 'researcher' })
    await settle()
    assert.equal(turns.length, 0, 'no review turn runs')
    assert.equal(m.get(task.id).status, 'failed')
    assert.equal(m.get(task.id).error, REVIEW_STOPS.unavailable(why))
  }
})

test('server.mjs builds the pass on the registry\'s Reviewer and passes its model to the tool-less turn', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const pass = src.slice(src.indexOf('const agentReviewer'), src.indexOf('const agentSettings'))
  assert.match(pass, /definition: \(\) => agentRegistry\.get\(REVIEWER_ID\)/)
  const turn = src.slice(src.indexOf('function toollessTurn('), src.indexOf('const agentReviewer'))
  assert.match(turn, /\(\{ prompt, systemPrompt, model, signal \}\)/)
  assert.match(turn, /model: model \?\? modelFor\(brain\)/)
  assert.match(turn, /const allowed = \[\]/)
})
