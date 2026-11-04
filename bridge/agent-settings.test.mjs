import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_SETTINGS, AGENT_LIVE_SETTINGS, DEFAULT_BUDGET, PAUSE_REASONS,
  createAgentSettings, formatBudget, formatSwitches, onByDefault, parseBudget, parseSwitches, switchedRegistry,
} from './agent-settings.mjs'
import { REGISTRY, isValid, settingDef, settingsSchema } from './settings-registry.mjs'
import { checkAgentDefinition } from './agent-definition.mjs'
import { createTaskManager } from './tasks.mjs'
import { createKillSwitch } from './channels/kill-switch.mjs'

const silent = { error() {}, log() {}, warn() {} }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }

/** A settings store the test changes by hand, falling back to registry defaults like settings.mjs. */
function store(values = {}) {
  const v = { ...values }
  return {
    v,
    read: (id) => v[id] || settingDef(id)?.default || undefined,
  }
}

function def(over = {}) {
  const r = checkAgentDefinition({
    id: 'researcher', name: 'Researcher', description: 'Finds and cites sources.',
    tools: ['WebSearch'], memory: 'read', createdBy: 'builtin', body: 'Cite every claim.', ...over,
  })
  assert.ok(r.ok, JSON.stringify(r.errors))
  return r.value
}

/** Runs that stay open until the test ends them. */
function fakeRun() {
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
        yield m
      }
    })()
  }
  return { runAgent, runs }
}
const complete = (run) => { run.push({ t: 'text', delta: 'ok' }); run.push({ t: 'done', reason: 'complete' }) }

test('every agent setting is registered, live, in the Agents section, with a default that validates', () => {
  const schema = settingsSchema()
  assert.ok(schema.sections.some((s) => s.id === 'agents'))
  for (const id of Object.values(AGENT_SETTINGS)) {
    const d = settingDef(id)
    assert.ok(d, `${id} is registered`)
    assert.equal(d.section, 'agents', id)
    assert.equal(d.apply, 'live', id)
    assert.equal(isValid(d, d.default), true, id)
  }
  for (const id of AGENT_LIVE_SETTINGS) assert.ok(REGISTRY.some((d) => d.id === id))
})

test('defaults: 3 at once, depth 1, reviewer off, not paused, the default budget', () => {
  const a = createAgentSettings({ read: store().read })
  assert.equal(a.maxConcurrent(), 3)
  assert.equal(a.maxDepth(), 1)
  assert.equal(a.reviewerDefault(), false)
  assert.equal(a.paused(), null)
  assert.deepEqual(a.defaultBudget(), DEFAULT_BUDGET)
  assert.equal(settingDef(AGENT_SETTINGS.defaultBudget).default, formatBudget(DEFAULT_BUDGET))
})

test('the cap is 1 to 8 and the depth 1 to 2; the registry refuses anything else and bad values fall back', () => {
  const cap = settingDef(AGENT_SETTINGS.maxConcurrent)
  const depth = settingDef(AGENT_SETTINGS.maxDepth)
  for (const n of ['1', '8']) assert.equal(isValid(cap, n), true)
  for (const n of ['0', '9', '3.5', 'three']) assert.equal(isValid(cap, n), false)
  for (const n of ['1', '2']) assert.equal(isValid(depth, n), true)
  for (const n of ['0', '3']) assert.equal(isValid(depth, n), false)
  // An environment variable is not validated by the registry: it falls back.
  const s = store({ [AGENT_SETTINGS.maxConcurrent]: '50', [AGENT_SETTINGS.maxDepth]: '5' })
  const a = createAgentSettings({ read: s.read })
  assert.equal(a.maxConcurrent(), 3)
  assert.equal(a.maxDepth(), 1)
  s.v[AGENT_SETTINGS.maxConcurrent] = '6'
  s.v[AGENT_SETTINGS.maxDepth] = '2'
  assert.equal(a.maxConcurrent(), 6, 'read live')
  assert.equal(a.maxDepth(), 2)
})

test('the default budget parses with the same limits as an agent file', () => {
  const b = settingDef(AGENT_SETTINGS.defaultBudget)
  assert.deepEqual(parseBudget('10 calls, 5 min, $0.50'), { maxToolCalls: 10, maxMinutes: 5, maxCostUsd: 0.5 })
  assert.deepEqual(parseBudget('1 call, 1440 min, $100'), { maxToolCalls: 1, maxMinutes: 1440, maxCostUsd: 100 })
  for (const bad of ['0 calls, 5 min, $1', '1001 calls, 5 min, $1', '5 calls, 1441 min, $1', '5 calls, 5 min, $101', '5 calls', '', null]) {
    assert.equal(parseBudget(bad), null, String(bad))
  }
  for (const ok of ['10 calls, 5 min, $0.50', '1000 calls, 1440 min, $100.00', '40 calls, 20 min, $1.00']) assert.equal(isValid(b, ok), true, ok)
  for (const bad of ['0 calls, 5 min, $1', '1001 calls, 5 min, $1', '5 calls, 1441 min, $1', '5 calls, 5 min, $101']) assert.equal(isValid(b, bad), false, bad)
  const a = createAgentSettings({ read: store({ [AGENT_SETTINGS.defaultBudget]: 'nonsense' }).read })
  assert.deepEqual(a.defaultBudget(), DEFAULT_BUDGET)
})

test('pause: the setting and the kill switch both pause; a kill switch that cannot be read counts as frozen', () => {
  const s = store()
  let frozen = false
  const a = createAgentSettings({ read: s.read, frozen: () => frozen })
  assert.equal(a.paused(), null)
  s.v[AGENT_SETTINGS.paused] = '1'
  assert.equal(a.paused(), PAUSE_REASONS.paused)
  s.v[AGENT_SETTINGS.paused] = '0'
  frozen = true
  assert.equal(a.paused(), PAUSE_REASONS.frozen)
  const broken = createAgentSettings({ read: s.read, frozen: () => { throw new Error('x') } })
  assert.equal(broken.paused(), PAUSE_REASONS.frozen)
})

test('switches: on-demand agents are on until switched off, unattended ones off until switched on', () => {
  const s = store()
  const a = createAgentSettings({ read: s.read })
  const onDemand = def()
  const scheduled = def({ id: 'inbox', mode: 'scheduled', schedule: '*/30 * * * *', budget: { maxToolCalls: 5, maxMinutes: 5, maxCostUsd: 0.1 } })
  assert.equal(onByDefault(onDemand), true)
  assert.equal(onByDefault(scheduled), false)
  assert.equal(a.isSwitchedOn('researcher', onDemand), true)
  assert.equal(a.isSwitchedOn('inbox', scheduled), false)

  Object.assign(s.v, a.switchPatch('researcher', false))
  Object.assign(s.v, a.switchPatch('inbox', true))
  assert.equal(s.v[AGENT_SETTINGS.switches], 'inbox=on,researcher=off')
  assert.equal(isValid(settingDef(AGENT_SETTINGS.switches), s.v[AGENT_SETTINGS.switches]), true)
  assert.equal(a.isSwitchedOn('researcher', onDemand), false)
  assert.equal(a.isSwitchedOn('inbox', scheduled), true)
  assert.throws(() => a.switchPatch('Bad Id', true))
})

test('switch strings round-trip and ignore junk', () => {
  assert.equal(formatSwitches(new Map()), 'none')
  assert.deepEqual([...parseSwitches('none')], [])
  assert.deepEqual([...parseSwitches('b=on, a=off,BAD=on,c=maybe')], [['b', true], ['a', false]])
  assert.equal(formatSwitches(parseSwitches('b=on,a=off')), 'a=off,b=on')
  const d = settingDef(AGENT_SETTINGS.switches)
  assert.equal(isValid(d, 'none'), true)
  assert.equal(isValid(d, 'a=on,b-2=off'), true)
  for (const bad of ['a=yes', 'A=on', 'a=on,', '=on']) assert.equal(isValid(d, bad), false, bad)
})

test('switchedRegistry: active only when the registry says so and the switch is on', () => {
  const s = store()
  const a = createAgentSettings({ read: s.read })
  let approved = true
  const registry = { has: (id) => id === 'researcher', get: () => def(), isActive: () => approved }
  const r = switchedRegistry(registry, a)
  assert.equal(r.isActive('researcher'), true)
  Object.assign(s.v, a.switchPatch('researcher', false))
  assert.equal(r.isActive('researcher'), false)
  Object.assign(s.v, a.switchPatch('researcher', true))
  approved = false
  assert.equal(r.isActive('researcher'), false, 'a switch never makes an unapproved agent active')
})

// --- the task manager with live settings -----------------------------------

function manager(s, { frozen = () => false, agents } = {}) {
  const { runAgent, runs } = fakeRun()
  const a = createAgentSettings({ read: s.read, frozen })
  const m = createTaskManager({
    runAgent,
    agents,
    concurrency: a.maxConcurrent,
    paused: a.paused,
    defaultBudget: a.defaultBudget,
    log: silent,
  })
  return { m, runs, a }
}
const running = (m) => m.list().filter((t) => t.status === 'running').length
const queued = (m) => m.list().filter((t) => t.status === 'queued').length

test('changing the cap live changes how many run at once', async () => {
  const s = store({ [AGENT_SETTINGS.maxConcurrent]: '1' })
  const { m, runs } = manager(s)
  for (let i = 0; i < 5; i++) m.spawn({ goal: `job ${i}` })
  await tick()
  assert.equal(running(m), 1)
  assert.equal(queued(m), 4)

  s.v[AGENT_SETTINGS.maxConcurrent] = '3'
  m.refresh()
  await tick()
  assert.equal(running(m), 3, 'raising the cap starts queued tasks at once')
  assert.equal(runs.length, 3)

  s.v[AGENT_SETTINGS.maxConcurrent] = '2'
  m.refresh()
  await tick()
  assert.equal(running(m), 3, 'lowering the cap lets running tasks finish')
  complete(runs[0])
  await settle()
  assert.equal(running(m), 2, 'no new start while over the new cap')
  assert.equal(runs.length, 3)
  complete(runs[1])
  await settle()
  assert.equal(running(m), 2)
  assert.equal(runs.length, 4, 'a freed slot under the new cap starts the next one')
})

test('pause all stops queued and running tasks and blocks new ones; unpausing lets new work run', async () => {
  const s = store({ [AGENT_SETTINGS.maxConcurrent]: '1' })
  const { m, runs } = manager(s)
  const a = m.spawn({ goal: 'running one' }).task
  const b = m.spawn({ goal: 'queued one' }).task
  await tick()
  assert.equal(m.get(a.id).status, 'running')

  s.v[AGENT_SETTINGS.paused] = '1'
  const r = m.refresh()
  assert.deepEqual(r, { stopped: 2, paused: true })
  assert.equal(runs[0].ctx.signal.aborted, true, 'the running session is aborted')
  for (const id of [a.id, b.id]) {
    assert.equal(m.get(id).status, 'cancelled')
    assert.equal(m.get(id).error, PAUSE_REASONS.paused)
  }
  const refused = m.spawn({ goal: 'new one' })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, PAUSE_REASONS.paused)
  assert.equal(runs.length, 1, 'nothing else started')

  s.v[AGENT_SETTINGS.paused] = '0'
  m.refresh()
  const again = m.spawn({ goal: 'after' })
  assert.equal(again.ok, true)
  await tick()
  assert.equal(m.get(again.task.id).status, 'running')
})

test('a paused manager never starts a queued task, even when a slot frees', async () => {
  let paused = false
  const { runAgent, runs } = fakeRun()
  const m = createTaskManager({ runAgent, concurrency: 1, paused: () => (paused ? 'held' : null), log: silent })
  m.spawn({ goal: 'one' })
  const second = m.spawn({ goal: 'two' }).task
  await tick()
  paused = true // read at the next start, before any refresh
  complete(runs[0])
  await settle()
  assert.equal(runs.length, 1)
  assert.equal(m.get(second.id).status, 'queued')
})

test('the kill switch pauses all agents through its change listener', async () => {
  const s = store()
  const kill = createKillSwitch({ log: silent })
  const { m, runs } = manager(s, { frozen: kill.isFrozen })
  kill.onChange(() => m.refresh())
  const t = m.spawn({ goal: 'work' }).task
  await tick()
  assert.equal(kill.freeze('hud'), true)
  assert.equal(runs[0].ctx.signal.aborted, true)
  assert.equal(m.get(t.id).status, 'cancelled')
  assert.equal(m.get(t.id).error, PAUSE_REASONS.frozen)
  assert.equal(m.spawn({ goal: 'more' }).ok, false)
  kill.unfreeze('hud')
  assert.equal(m.spawn({ goal: 'more' }).ok, true)
})

test('switching an agent off stops its running task and refuses new ones; other tasks carry on', async () => {
  const s = store()
  const a0 = createAgentSettings({ read: s.read })
  const registry = { has: (id) => id === 'researcher', get: () => def(), isActive: () => true }
  const { m, runs } = manager(s, { agents: switchedRegistry(registry, a0) })
  const plain = m.spawn({ goal: 'plain' }).task
  const named = m.spawn({ goal: 'research', agentId: 'researcher' }).task
  await tick()
  assert.equal(runs.length, 2)

  Object.assign(s.v, a0.switchPatch('researcher', false))
  assert.deepEqual(m.refresh(), { stopped: 1, paused: false })
  assert.equal(m.get(named.id).status, 'cancelled')
  assert.match(m.get(named.id).error, /Researcher agent was switched off/)
  assert.equal(m.get(plain.id).status, 'running')
  const refused = m.spawn({ goal: 'again', agentId: 'researcher' })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /not switched on/)
})

test('an agent whose file sets no budget runs under the default budget; plain tasks get none', async () => {
  const s = store({ [AGENT_SETTINGS.defaultBudget]: '1 call, 5 min, $1.00' })
  const registry = { has: () => true, get: () => def(), isActive: () => true }
  const { m, runs } = manager(s, { agents: registry })
  const named = m.spawn({ goal: 'x', agentId: 'researcher' }).task
  m.spawn({ goal: 'plain' })
  await tick()
  const budget = runs[0].ctx.budget
  assert.ok(budget, 'the default budget is handed to the session guard')
  assert.equal(budget.toolCall(), null)
  assert.notEqual(budget.toolCall(), null, 'the second call is over the default of 1')
  assert.equal(m.get(named.id).status, 'failed')
  assert.equal(runs[1].ctx.budget, undefined, 'a plain task runs exactly as before')
})

test('an agent file with its own budget keeps it over the default', async () => {
  const s = store({ [AGENT_SETTINGS.defaultBudget]: '1 call, 5 min, $1.00' })
  const agent = def({ budget: { maxToolCalls: 3, maxMinutes: 5, maxCostUsd: 1 } })
  const { m, runs } = manager(s, { agents: { has: () => true, get: () => agent, isActive: () => true } })
  m.spawn({ goal: 'x', agentId: 'researcher' })
  await tick()
  const b = runs[0].ctx.budget
  assert.equal(b.toolCall(), null)
  assert.equal(b.toolCall(), null)
  assert.equal(b.toolCall(), null)
  assert.notEqual(b.toolCall(), null)
})

test('a getter that throws falls back safely: the cap to its default, a pause getter to paused', async () => {
  const { runAgent, runs } = fakeRun()
  const m = createTaskManager({ runAgent, concurrency: () => { throw new Error('x') }, log: silent })
  for (let i = 0; i < 5; i++) m.spawn({ goal: `j${i}` })
  await tick()
  assert.equal(runs.length, 3)
  const held = createTaskManager({ runAgent, paused: () => { throw new Error('x') }, log: silent })
  assert.equal(held.spawn({ goal: 'x' }).ok, false)
})

test('the kill switch tells listeners on freeze and unfreeze, and a failing listener harms nothing', () => {
  const kill = createKillSwitch({ log: silent })
  const seen = []
  kill.onChange(() => { throw new Error('boom') })
  const off = kill.onChange((st) => seen.push(st.frozen))
  kill.freeze('chat')
  kill.freeze('chat') // already frozen: no second event
  kill.unfreeze('hud')
  assert.deepEqual(seen, [true, false])
  off()
  kill.freeze('hud')
  assert.deepEqual(seen, [true, false])
})
