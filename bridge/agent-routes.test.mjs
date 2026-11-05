/**
 * Task A09: the Agents API and run history. Every route against a temporary
 * data folder, the fixture built-in, a fake tool catalogue and an in-memory
 * settings table. No network, no model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentRegistry, createToolCatalogue } from './agents.mjs'
import { AGENT_SETTINGS, createAgentSettings } from './agent-settings.mjs'
import { createAgentRoutes, agentRunStats, agentFileText, MAX_RUNS } from './agent-routes.mjs'
import { formatAgentFile, parseAgentFile, REVIEW_SET } from './agent-definition.mjs'

const FIXTURE_BUILTINS = fileURLToPath(new URL('../shared/fixtures/agents/registry/builtin/', import.meta.url))
const quiet = { warn() {}, log() {}, error() {} }
const TOOLS = createToolCatalogue({ servers: { jarvis_tasks: ['task_status'], jarvis_memory: ['memory_search'] } })
const CONNECTORS = [
  { id: 'fake', capabilities: { read: true, write: false } },
  { id: 'notion', capabilities: { read: true, write: true } },
]
const BUDGET = { maxToolCalls: 10, maxMinutes: 5, maxCostUsd: 0.5 }

function setup({ tasks = [], frozen = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-agent-routes-'))
  const userDir = join(root, 'agents')
  mkdirSync(userDir)
  const registry = createAgentRegistry({
    builtinDir: FIXTURE_BUILTINS, userDir, approvalsFile: join(root, 'agent-approvals.json'), tools: TOOLS, connectors: CONNECTORS, log: quiet,
  })
  registry.load()
  const values = {}
  const state = { frozen, changed: 0, saves: [] }
  const settings = createAgentSettings({ read: (k) => values[k], frozen: () => state.frozen })
  const saveSettings = (patch) => { state.saves.push(patch); Object.assign(values, patch) }
  const routes = createAgentRoutes({
    registry,
    settings,
    saveSettings,
    tasks: { list: () => tasks },
    gate: () => (state.frozen ? 'JARVIS is frozen.' : null),
    changed: () => { state.changed++ },
    log: quiet,
  })
  const call = (method, path, body) => routes.handle({ method, path, body })
  return { root, userDir, registry, settings, values, state, routes, call, done: () => rmSync(root, { recursive: true, force: true }) }
}

const def = (over = {}) => ({ id: 'helper', name: 'Helper', description: 'Helps.', tools: ['Read'], body: 'Help with the goal.', ...over })
const userFiles = (s) => (existsSync(s.userDir) ? readdirSync(s.userDir).sort() : [])

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('GET /agents lists the roster with switches, run numbers, refused files and limits', () => {
  const s = setup({ tasks: [
    { id: 't1', title: 'one', agentId: 'echo', status: 'done', createdAt: 1, startedAt: 60_000, endedAt: 180_000, costUsd: 0.02 },
  ] })
  try {
    writeFileSync(join(s.userDir, 'broken.md'), '---\nid: broken\n---\n')
    s.registry.reload()
    const out = s.call('GET', '/agents')
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.deepEqual(out.body.agents.map((a) => [a.id, a.source, a.readOnly, a.switchedOn]), [['echo', 'builtin', true, true]])
    const echo = out.body.agents[0]
    assert.equal(echo.icon, 'repeat')
    assert.equal(echo.tools, 2)
    assert.equal(echo.connectors, 1)
    assert.equal(echo.runsUnasked, false)
    assert.deepEqual(
      { runs: echo.stats.runs, done: echo.stats.done, successRate: echo.stats.successRate, minutes: echo.stats.minutes, costUsd: echo.stats.costUsd },
      { runs: 1, done: 1, successRate: 1, minutes: 2, costUsd: 0.02 },
    )
    assert.equal(out.body.refused.length, 1)
    assert.equal(out.body.refused[0].file, 'broken.md')
    assert.ok(out.body.refused[0].reasons.length > 0)
    assert.deepEqual(out.body.limits, { maxConcurrent: 3, maxDepth: 1, paused: null })
  } finally { s.done() }
})

test('GET /agents/:id returns the whole definition, its file text and its runs', () => {
  const s = setup()
  try {
    const out = s.call('GET', '/agents/echo')
    assert.equal(out.status, 200)
    assert.equal(out.body.definition.id, 'echo')
    assert.deepEqual(out.body.definition.tools, ['Read', 'mcp__jarvis_tasks__task_status'])
    assert.deepEqual(out.body.definition.connectors, { fake: 'read' })
    assert.equal(parseAgentFile(out.body.file).ok, true)
    assert.deepEqual(out.body.runs, [])
    assert.equal(s.call('GET', '/agents/nobody').status, 404)
    assert.equal(s.call('GET', '/agents/Not_An_Id').status, 404)
    assert.equal(s.call('GET', '/agents/echo/runs').body.stats.runs, 0)
    assert.equal(s.call('GET', '/agents/nobody/runs').status, 404)
  } finally { s.done() }
})

test('paths that are not ours are left alone; wrong methods are refused', () => {
  const s = setup()
  try {
    assert.equal(s.call('GET', '/agentsx'), null)
    assert.equal(s.call('GET', '/settings'), null)
    assert.equal(s.call('DELETE', '/agents').status, 405)
    assert.equal(s.call('GET', '/agents/echo/delete').status, 405)
    assert.equal(s.call('POST', '/agents/echo').status, 405)
    assert.equal(s.call('POST', '/agents/echo/explode', {}).status, 404)
    assert.equal(s.call('GET', '/agents/echo/runs/extra').status, 404)
  } finally { s.done() }
})

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

test('run numbers: success rate leaves out cancelled runs; minutes, cost and the last run add up', () => {
  const runs = [
    { id: 'a', title: 'A', agentId: 'r', status: 'done', createdAt: 10, startedAt: 0, endedAt: 120_000, costUsd: 0.1 },
    { id: 'b', title: 'B', agentId: 'r', status: 'failed', createdAt: 20, startedAt: 200_000, endedAt: 260_000, error: 'Budget used up.' },
    { id: 'c', title: 'C', agentId: 'r', status: 'cancelled', createdAt: 30, startedAt: 300_000, endedAt: 330_000 },
    { id: 'd', title: 'D', agentId: 'r', status: 'interrupted', createdAt: 40, startedAt: 400_000, endedAt: 400_000 },
    { id: 'e', title: 'E', agentId: 'r', status: 'running', createdAt: 50, startedAt: 500_000, endedAt: null, costUsd: 0.05 },
    { id: 'f', title: 'F', agentId: 'other', status: 'done', createdAt: 60, startedAt: 0, endedAt: 60_000 },
    { id: 'g', title: 'G', status: 'done', createdAt: 70 },
  ]
  const { stats, runs: list } = agentRunStats(runs, 'r')
  assert.deepEqual(stats, {
    runs: 5, done: 1, failed: 2, cancelled: 1, active: 1, successRate: 0.333, minutes: 3.5, costUsd: 0.15, lastRunAt: 500_000,
  })
  assert.deepEqual(list.map((r) => r.id), ['e', 'd', 'c', 'b', 'a'])
  assert.equal(list.find((r) => r.id === 'b').error, 'Budget used up.')
  assert.equal(list.find((r) => r.id === 'a').minutes, 2)
  assert.equal(list.find((r) => r.id === 'a').error, undefined)
  assert.equal(agentRunStats([], 'r').stats.successRate, null)
  assert.equal(agentRunStats(null, 'r').stats.runs, 0)
})

test('run history is capped to the most recent runs', () => {
  const runs = Array.from({ length: MAX_RUNS + 5 }, (_, i) => ({ id: `t${i}`, title: 'x', agentId: 'r', status: 'done', createdAt: i }))
  const { stats, runs: list } = agentRunStats(runs, 'r')
  assert.equal(stats.runs, MAX_RUNS + 5)
  assert.equal(list.length, MAX_RUNS)
  assert.equal(list[0].id, `t${MAX_RUNS + 4}`)
})

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test('POST /agents creates a user agent from a definition; it loads and is listed', () => {
  const s = setup()
  try {
    const out = s.call('POST', '/agents', { definition: def() })
    assert.equal(out.status, 201)
    assert.equal(out.body.agent.id, 'helper')
    assert.equal(out.body.agent.source, 'user')
    assert.deepEqual(userFiles(s), ['helper.md'])
    assert.equal(s.registry.isActive('helper'), true)
    assert.equal(s.state.changed, 1)
    // No `review` in the request: the file leaves it out so the owner's default applies.
    const text = readFileSync(join(s.userDir, 'helper.md'), 'utf8')
    assert.doesNotMatch(text, /^review:/m)
    assert.equal(s.registry.get('helper')[REVIEW_SET], undefined)
    assert.deepEqual(s.call('GET', '/agents').body.agents.map((a) => a.id), ['echo', 'helper'])
  } finally { s.done() }
})

test('POST /agents accepts the file text and keeps it as written', () => {
  const s = setup()
  try {
    const file = '---\r\nid: notes\r\nname: Notes\r\ndescription: Keeps notes.\r\ntools: [Read]  # just reading\r\nreview: true\r\n---\r\n\r\nTake notes.\r\n'
    const out = s.call('POST', '/agents', { file })
    assert.equal(out.status, 201)
    assert.equal(readFileSync(join(s.userDir, 'notes.md'), 'utf8'), file.replace(/\r\n/g, '\n'))
    assert.equal(s.registry.get('notes').review, true)
  } finally { s.done() }
})

test('invalid definitions are refused with reasons and nothing is written', () => {
  const s = setup()
  try {
    const cases = [
      [{ definition: def({ id: 'Bad Id' }) }, 400],
      [{ definition: def({ memory: 'write' }) }, 400],
      [{ definition: def({ mode: 'scheduled', schedule: '0 7 * * *' }) }, 400], // no budget
      [{ definition: def({ delegate: ['echo'] }) }, 400], // only the coordinator
      [{ definition: def({ tools: ['NoSuchTool'] }) }, 422],
      [{ definition: def({ connectors: { gmail: 'read' } }) }, 422],
      [{ definition: def({ connectors: { fake: 'write' } }) }, 422],
      [{ definition: def({ createdBy: 'builtin' }) }, 422],
      [{ file: 'no header' }, 400],
      [{ file: 'x'.repeat(70_000) }, 400],
      [{}, 400],
      [null, 400],
    ]
    for (const [body, status] of cases) {
      const out = s.call('POST', '/agents', body)
      assert.equal(out.status, status, JSON.stringify(body)?.slice(0, 80))
      assert.equal(out.body.ok, false)
      if (body && (body.definition || body.file)) assert.ok(Array.isArray(out.body.reasons) && out.body.reasons.length > 0)
    }
    assert.deepEqual(userFiles(s), [])
    assert.equal(s.state.changed, 0)
  } finally { s.done() }
})

test('a reason never echoes what was sent', () => {
  const s = setup()
  try {
    const out = s.call('POST', '/agents', { definition: def({ tools: ['IGNORE_ALL_PREVIOUS'] }) })
    assert.doesNotMatch(JSON.stringify(out.body), /IGNORE_ALL_PREVIOUS/)
  } finally { s.done() }
})

test('a new agent cannot take a built-in id or an existing id, and the page cannot make agent-made definitions', () => {
  const s = setup()
  try {
    assert.equal(s.call('POST', '/agents', { definition: def({ id: 'echo' }) }).status, 409)
    assert.equal(s.call('POST', '/agents', { definition: def() }).status, 201)
    assert.equal(s.call('POST', '/agents', { definition: def() }).status, 409)
    const agentMade = s.call('POST', '/agents', { definition: def({ id: 'sneaky', createdBy: 'agent', requestedBy: 'coordinator' }) })
    assert.equal(agentMade.status, 400)
    assert.deepEqual(userFiles(s), ['helper.md'])
  } finally { s.done() }
})

test('an unattended agent made from the page starts off, even if an old switch for that id said on', () => {
  const s = setup()
  try {
    s.values[AGENT_SETTINGS.switches] = 'watch=on'
    const out = s.call('POST', '/agents', { definition: def({ id: 'watch', mode: 'continuous', budget: BUDGET }) })
    assert.equal(out.status, 201)
    assert.equal(out.body.agent.switchedOn, false)
    assert.equal(s.settings.hasSwitch('watch'), false)
  } finally { s.done() }
})

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

test('POST /agents/:id/update replaces a user agent; the id comes from the path', () => {
  const s = setup()
  try {
    s.call('POST', '/agents', { definition: def() })
    const { id: _id, ...rest } = def({ description: 'Helps better.' })
    const out = s.call('POST', '/agents/helper/update', { definition: rest })
    assert.equal(out.status, 200)
    assert.equal(s.registry.get('helper').description, 'Helps better.')
    assert.equal(s.call('POST', '/agents/helper/update', { definition: def({ id: 'other' }) }).status, 400)
    assert.equal(s.call('POST', '/agents/nobody/update', { definition: def() }).status, 404)
  } finally { s.done() }
})

test('an invalid edit is refused with reasons and the old file stays', () => {
  const s = setup()
  try {
    s.call('POST', '/agents', { definition: def() })
    const before = readFileSync(join(s.userDir, 'helper.md'), 'utf8')
    const changes = s.state.changed
    for (const over of [{ tools: ['NoSuchTool'] }, { memory: 'write' }, { mode: 'triggered', trigger: 'meeting.ended' }, { name: '' }]) {
      const out = s.call('POST', '/agents/helper/update', { definition: def(over) })
      assert.equal(out.body.ok, false)
      assert.ok(out.body.reasons.length > 0)
    }
    assert.equal(readFileSync(join(s.userDir, 'helper.md'), 'utf8'), before)
    assert.equal(s.state.changed, changes)
  } finally { s.done() }
})

test('a built-in cannot be changed or deleted, and its file is untouched', () => {
  const s = setup()
  try {
    const before = readFileSync(join(FIXTURE_BUILTINS, 'echo.md'), 'utf8')
    const edit = s.call('POST', '/agents/echo/update', { definition: def({ id: 'echo' }) })
    assert.equal(edit.status, 403)
    const del = s.call('POST', '/agents/echo/delete', { confirm: true })
    assert.equal(del.status, 403)
    assert.equal(readFileSync(join(FIXTURE_BUILTINS, 'echo.md'), 'utf8'), before)
    assert.equal(s.registry.entry('echo').source, 'builtin')
    assert.deepEqual(userFiles(s), [])
  } finally { s.done() }
})

test('an agent-made definition stays agent-made after an edit and needs approval again', () => {
  const s = setup()
  try {
    writeFileSync(join(s.userDir, 'drafted.md'), formatAgentFile(def({ id: 'drafted', createdBy: 'agent', requestedBy: 'coordinator' })))
    s.registry.reload()
    assert.equal(s.registry.approve('drafted').ok, true)
    assert.equal(s.registry.isActive('drafted'), true)
    const asUser = s.call('POST', '/agents/drafted/update', { definition: def({ id: 'drafted', description: 'Changed.' }) })
    assert.equal(asUser.status, 400)
    const out = s.call('POST', '/agents/drafted/update', {
      definition: def({ id: 'drafted', description: 'Changed.', createdBy: 'agent', requestedBy: 'coordinator' }),
    })
    assert.equal(out.status, 200)
    assert.equal(s.registry.isActive('drafted'), false)
    assert.equal(s.registry.list().find((a) => a.id === 'drafted').inactiveReason, 'needs-approval')
    // And a user agent cannot be relabelled agent-made.
    s.call('POST', '/agents', { definition: def() })
    assert.equal(s.call('POST', '/agents/helper/update', { definition: def({ createdBy: 'agent', requestedBy: 'coordinator' }) }).status, 400)
  } finally { s.done() }
})

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('POST /agents/:id/copy copies a built-in to a new user agent', () => {
  const s = setup()
  try {
    const out = s.call('POST', '/agents/echo/copy', { id: 'my-echo' })
    assert.equal(out.status, 201)
    const copy = s.registry.get('my-echo')
    assert.equal(copy.name, 'Echo (copy)')
    assert.equal(copy.createdBy, 'user')
    assert.deepEqual(copy.tools, s.registry.get('echo').tools)
    assert.equal(s.registry.entry('my-echo').source, 'user')
    // The built-in said `review: false` itself, so the copy does too.
    assert.match(readFileSync(join(s.userDir, 'my-echo.md'), 'utf8'), /^review: false$/m)
    const named = s.call('POST', '/agents/my-echo/copy', { id: 'echo-two', name: 'Echo Two' })
    assert.equal(named.status, 201)
    assert.equal(s.registry.get('echo-two').name, 'Echo Two')
  } finally { s.done() }
})

test('a copy needs a free, valid id', () => {
  const s = setup()
  try {
    assert.equal(s.call('POST', '/agents/echo/copy', { id: 'echo' }).status, 409)
    assert.equal(s.call('POST', '/agents/echo/copy', { id: 'Bad Id' }).status, 400)
    assert.equal(s.call('POST', '/agents/echo/copy', {}).status, 400)
    assert.equal(s.call('POST', '/agents/echo/copy', { id: 'x', name: 5 }).status, 400)
    assert.equal(s.call('POST', '/agents/nobody/copy', { id: 'x' }).status, 404)
    assert.deepEqual(userFiles(s), [])
  } finally { s.done() }
})

test('a copy never keeps delegation and drops who asked for an agent-made original', () => {
  const s = setup()
  try {
    writeFileSync(join(s.userDir, 'drafted.md'), formatAgentFile(def({ id: 'drafted', createdBy: 'agent', requestedBy: 'coordinator' })))
    s.registry.reload()
    const out = s.call('POST', '/agents/drafted/copy', { id: 'mine' })
    assert.equal(out.status, 201)
    const copy = s.registry.get('mine')
    assert.equal(copy.createdBy, 'user')
    assert.equal(copy.requestedBy, undefined)
    assert.deepEqual(copy.delegate, [])
  } finally { s.done() }
})

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

test('POST /agents/:id/enabled switches an agent; built-ins can be switched too', () => {
  const s = setup()
  try {
    const off = s.call('POST', '/agents/echo/enabled', { enabled: false })
    assert.equal(off.status, 200)
    assert.equal(off.body.switchedOn, false)
    assert.equal(s.values[AGENT_SETTINGS.switches], 'echo=off')
    assert.equal(s.state.changed, 1)
    const on = s.call('POST', '/agents/echo/enabled', { enabled: true })
    assert.equal(on.body.switchedOn, true)
    assert.equal(s.call('POST', '/agents/echo/enabled', { enabled: 'yes' }).status, 400)
    assert.equal(s.call('POST', '/agents/nobody/enabled', { enabled: true }).status, 404)
  } finally { s.done() }
})

test('switching on an agent that runs unasked needs confirm; switching it off does not', () => {
  const s = setup()
  try {
    s.call('POST', '/agents', { definition: def({ id: 'morning', mode: 'scheduled', schedule: '0 7 * * *', budget: BUDGET }) })
    const asked = s.call('POST', '/agents/morning/enabled', { enabled: true })
    assert.equal(asked.status, 400)
    assert.equal(asked.body.needsConfirm, true)
    assert.equal(s.settings.isSwitchedOn('morning', s.registry.get('morning')), false)
    const on = s.call('POST', '/agents/morning/enabled', { enabled: true, confirm: true })
    assert.equal(on.body.switchedOn, true)
    const off = s.call('POST', '/agents/morning/enabled', { enabled: false })
    assert.equal(off.body.switchedOn, false)
  } finally { s.done() }
})

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

test('POST /agents/:id/delete needs confirm, removes the file and forgets the switch', () => {
  const s = setup()
  try {
    s.call('POST', '/agents', { definition: def({ id: 'watch', mode: 'continuous', budget: BUDGET }) })
    s.call('POST', '/agents/watch/enabled', { enabled: true, confirm: true })
    assert.equal(s.settings.hasSwitch('watch'), true)
    const asked = s.call('POST', '/agents/watch/delete', {})
    assert.equal(asked.status, 400)
    assert.equal(asked.body.needsConfirm, true)
    assert.deepEqual(userFiles(s), ['watch.md'])
    const out = s.call('POST', '/agents/watch/delete', { confirm: true })
    assert.equal(out.status, 200)
    assert.deepEqual(userFiles(s), [])
    assert.equal(s.registry.has('watch'), false)
    assert.equal(s.settings.hasSwitch('watch'), false)
    assert.equal(s.call('POST', '/agents/watch/delete', { confirm: true }).status, 404)
  } finally { s.done() }
})

// ---------------------------------------------------------------------------
// The gate (kill switch) and reload
// ---------------------------------------------------------------------------

test('while frozen nothing is written or switched on, but switching off still works', () => {
  const s = setup()
  try {
    s.call('POST', '/agents', { definition: def() })
    s.state.frozen = true
    const before = readFileSync(join(s.userDir, 'helper.md'), 'utf8')
    assert.equal(s.call('POST', '/agents', { definition: def({ id: 'other' }) }).status, 409)
    assert.equal(s.call('POST', '/agents/helper/update', { definition: def({ description: 'x' }) }).status, 409)
    assert.equal(s.call('POST', '/agents/echo/copy', { id: 'copy' }).status, 409)
    assert.equal(s.call('POST', '/agents/helper/delete', { confirm: true }).status, 409)
    assert.equal(s.call('POST', '/agents/echo/enabled', { enabled: true }).status, 409)
    assert.equal(s.call('POST', '/agents/echo/enabled', { enabled: false }).status, 200)
    assert.deepEqual(userFiles(s), ['helper.md'])
    assert.equal(readFileSync(join(s.userDir, 'helper.md'), 'utf8'), before)
  } finally { s.done() }
})

test('a gate that throws refuses the write', () => {
  const s = setup()
  try {
    const routes = createAgentRoutes({
      registry: s.registry, settings: s.settings, saveSettings: () => {}, gate: () => { throw new Error('boom') }, log: quiet,
    })
    const out = routes.handle({ method: 'POST', path: '/agents', body: { definition: def() } })
    assert.equal(out.status, 409)
    assert.deepEqual(userFiles(s), [])
  } finally { s.done() }
})

test('POST /agents/reload picks up files changed on disk', () => {
  const s = setup()
  try {
    writeFileSync(join(s.userDir, 'helper.md'), formatAgentFile(def()))
    assert.equal(s.registry.has('helper'), false)
    const out = s.call('POST', '/agents/reload')
    assert.equal(out.status, 200)
    assert.deepEqual(out.body.summary, { loaded: 2, active: 2, refused: 0 })
    assert.equal(s.registry.has('helper'), true)
    assert.equal(s.call('GET', '/agents/reload').status, 405)
  } finally { s.done() }
})

test('the routes need a registry, settings and a way to save them', () => {
  assert.throws(() => createAgentRoutes({}))
  const s = setup()
  try {
    assert.throws(() => createAgentRoutes({ registry: s.registry }))
    assert.throws(() => createAgentRoutes({ registry: s.registry, settings: s.settings }))
  } finally { s.done() }
})

test('agentFileText leaves review out unless the file set it', () => {
  const parsed = parseAgentFile(formatAgentFile(def({ review: true })))
  assert.match(agentFileText(parsed.value), /^review: true$/m)
  const unset = parseAgentFile(agentFileText(parseAgentFile('---\nid: a\nname: A\ndescription: d\n---\nGo.\n').value))
  assert.equal(unset.ok, true)
  assert.equal(unset.value[REVIEW_SET], undefined)
})

test('the first agent creates the owner\'s agents folder', () => {
  const s = setup()
  try {
    rmSync(s.userDir, { recursive: true, force: true })
    s.registry.reload()
    assert.equal(s.call('POST', '/agents', { definition: def() }).status, 201)
    assert.deepEqual(userFiles(s), ['helper.md'])
  } finally { s.done() }
})

test('switchPatch(id, null) forgets a switch so the mode default applies again', () => {
  const values = { [AGENT_SETTINGS.switches]: 'a=on,b=off' }
  const settings = createAgentSettings({ read: (k) => values[k] })
  assert.equal(settings.hasSwitch('a'), true)
  Object.assign(values, settings.switchPatch('a', null))
  assert.equal(values[AGENT_SETTINGS.switches], 'b=off')
  assert.equal(settings.hasSwitch('a'), false)
  assert.equal(settings.isSwitchedOn('a', { mode: 'scheduled' }), false)
  Object.assign(values, settings.switchPatch('b', null))
  assert.equal(values[AGENT_SETTINGS.switches], 'none')
})

test('registry.check runs the load-time checks on a definition about to be written', () => {
  const s = setup()
  try {
    const ok = parseAgentFile(formatAgentFile(def())).value
    assert.deepEqual(s.registry.check(ok), [])
    assert.ok(s.registry.check({ ...ok, id: 'echo' }).some((r) => r.startsWith('id:')))
    assert.ok(s.registry.check({ ...ok, tools: ['Nope'] }).some((r) => r.startsWith('tools.0')))
    s.call('POST', '/agents', { definition: def() })
    assert.ok(s.registry.check(ok).some((r) => r.startsWith('id:')))
    assert.deepEqual(s.registry.check(ok, { replacing: 'helper' }), [])
    assert.deepEqual(s.registry.entry('helper').source, 'user')
    assert.equal(s.registry.entry('nobody'), null)
  } finally { s.done() }
})
