import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_CATCH_UP_MS, SCHEDULE_SKIPS, createAgentScheduler, createScheduleState, latestDue, parseCron, runNotification,
} from './agent-schedule.mjs'
import { checkAgentDefinition, parseAgentFile } from './agent-definition.mjs'
import { createAgentSettings, switchedRegistry, AGENT_SETTINGS } from './agent-settings.mjs'
import { settingDef } from './settings-registry.mjs'
import { createTaskManager } from './tasks.mjs'
import { createEngine, startTicker } from './workflows.mjs'

const silent = { error() {}, log() {}, warn() {} }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const MIN = 60_000

function scheduled(over = {}) {
  const r = checkAgentDefinition({
    id: 'briefer', name: 'Briefer', description: 'A short spoken day plan.',
    mode: 'scheduled', schedule: '0 7 * * *', tools: [], memory: 'read', createdBy: 'builtin',
    budget: { maxToolCalls: 5, maxMinutes: 5, maxCostUsd: 0.1 }, body: 'Say what matters today.', ...over,
  })
  assert.ok(r.ok, JSON.stringify(r.errors))
  return r.value
}

/** A registry with the given definitions, all loaded and active. */
function registry(defs) {
  const m = new Map(defs.map((d) => [d.id, d]))
  return {
    has: (id) => m.has(id),
    get: (id) => m.get(id) ?? null,
    isActive: (id) => m.has(id),
    list: () => [...m.values()].map((d) => ({ id: d.id, name: d.name, mode: d.mode, active: true })),
  }
}

function settingsStore(values = {}) {
  const v = { ...values }
  return { v, read: (id) => v[id] || settingDef(id)?.default || undefined }
}

/** Runs that stay open until the test ends them. */
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
const complete = (run, text = 'Three meetings today.') => { run.push({ t: 'text', delta: text }); run.push({ t: 'done', reason: 'complete' }) }

/** Everything wired as server.mjs wires it, on a fake clock. */
function setup({ defs = [scheduled()], switches = 'briefer=on', start = at(2026, 11, 5, 6, 0), state = createScheduleState(), cap } = {}) {
  let now = start
  const s = settingsStore({ [AGENT_SETTINGS.switches]: switches, ...(cap && { [AGENT_SETTINGS.maxConcurrent]: String(cap) }) })
  const settings = createAgentSettings({ read: s.read })
  const agents = switchedRegistry(registry(defs), settings)
  const { runAgent, runs } = fakeRun()
  const tasks = createTaskManager({
    runAgent, agents, concurrency: settings.maxConcurrent, paused: settings.paused,
    defaultBudget: settings.defaultBudget, now: () => now, log: silent,
  })
  const alerts = []
  const scheduler = createAgentScheduler({
    agents, tasks, paused: settings.paused, notifier: { submit: (n) => alerts.push(n) },
    state, clock: () => now, log: silent,
  })
  return { s, settings, tasks, runs, alerts, scheduler, state, set: (t) => { now = t }, get now() { return now } }
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

test('cron: numbers, lists, ranges, steps, names, Sunday as 0 or 7, and either day field', () => {
  const weekdays7 = parseCron('0 7 * * 1-5')
  assert.equal(weekdays7.matches(at(2026, 11, 5, 7, 0)), true, 'Thursday 07:00')
  assert.equal(weekdays7.matches(at(2026, 11, 5, 7, 1)), false)
  assert.equal(weekdays7.matches(at(2026, 11, 8, 7, 0)), false, 'Sunday')
  const every30 = parseCron('*/30 * * * *')
  assert.equal(every30.matches(at(2026, 11, 5, 9, 30)), true)
  assert.equal(every30.matches(at(2026, 11, 5, 9, 15)), false)
  assert.equal(parseCron('0 9 * * SUN').matches(at(2026, 11, 8, 9)), true)
  assert.equal(parseCron('0 9 * * 7').matches(at(2026, 11, 8, 9)), true)
  assert.equal(parseCron('0 9 * NOV mon,wed').matches(at(2026, 11, 4, 9)), true)
  assert.equal(parseCron('15,45 8-10/2 * * *').matches(at(2026, 11, 4, 10, 45)), true)
  assert.equal(parseCron('15,45 8-10/2 * * *').matches(at(2026, 11, 4, 9, 45)), false)
  assert.equal(parseCron('5/20 * * * *').matches(at(2026, 11, 4, 9, 45)), true)
  // Both day fields restricted: either matches (the 1st, or any Monday).
  const either = parseCron('0 6 1 * 1')
  assert.equal(either.matches(at(2026, 11, 1, 6)), true, 'the 1st (a Sunday)')
  assert.equal(either.matches(at(2026, 11, 2, 6)), true, 'a Monday')
  assert.equal(either.matches(at(2026, 11, 3, 6)), false)
})

test('cron: anything not understood is refused', () => {
  for (const bad of ['@daily', '0 7 * *', '0 7 * * * *', '60 7 * * *', '0 24 * * *', '0 7 0 * *', '0 7 * 13 *', '0 7 * * 8',
    '0 7 L * *', '0 7 * * 1#2', '0 7 ? * *', '*/0 * * * *', '5-1 * * * *', 'a b c d e', '', null, 42]) {
    assert.equal(parseCron(bad), null, String(bad))
  }
})

test('latestDue: the latest matching minute after the last one handled, looking back at most a week', () => {
  const daily = parseCron('0 7 * * *')
  assert.equal(latestDue(daily, at(2026, 11, 5, 6, 0), at(2026, 11, 5, 6, 59)), null)
  assert.equal(latestDue(daily, at(2026, 11, 5, 6, 0), at(2026, 11, 5, 7, 0, 30)), at(2026, 11, 5, 7))
  assert.equal(latestDue(daily, at(2026, 11, 5, 7), at(2026, 11, 5, 9)), null, 'already handled')
  // Three missed mornings: only the latest one.
  assert.equal(latestDue(daily, at(2026, 11, 2, 8), at(2026, 11, 5, 9)), at(2026, 11, 5, 7))
  // Longer ago than the catch-up window: nothing.
  const weekly = parseCron('0 7 1 1 *')
  const now = at(2026, 11, 5, 9)
  assert.equal(latestDue(weekly, now - 2 * MAX_CATCH_UP_MS, now), null)
})

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

test('a scheduled agent runs at its time with a fake clock, and once only', async () => {
  const x = setup()
  assert.deepEqual(x.scheduler.tick().started, [], 'first sight: nothing before now is made up')
  x.set(at(2026, 11, 5, 6, 59))
  assert.deepEqual(x.scheduler.tick().started, [])
  x.set(at(2026, 11, 5, 7, 0) + 20_000)
  const r = x.scheduler.tick()
  assert.equal(r.started.length, 1)
  assert.equal(r.started[0].at, at(2026, 11, 5, 7))
  const task = x.tasks.get(r.started[0].taskId)
  assert.equal(task.agentId, 'briefer')
  assert.match(task.goal, /Scheduled run of Briefer/)
  x.set(at(2026, 11, 5, 7, 0) + 50_000)
  assert.deepEqual(x.scheduler.tick().started, [], 'the same minute is not run twice')
  await settle()
  assert.equal(x.runs.length, 1)
  assert.equal(x.runs[0].ctx.agent.id, 'briefer', 'runs as the named agent, with its definition')
})

test('the result goes out through the notification policy; a cancelled run raises nothing', async () => {
  const x = setup()
  x.scheduler.tick()
  x.set(at(2026, 11, 5, 7, 0))
  const { taskId } = x.scheduler.tick().started[0]
  await settle()
  complete(x.runs[0])
  await settle()
  assert.equal(x.tasks.get(taskId).status, 'done')
  assert.equal(x.alerts.length, 1)
  const n = x.alerts[0]
  assert.equal(n.source, 'agent')
  assert.equal(n.privacy, 'private')
  assert.equal(n.urgency, 'normal')
  assert.match(n.title, /Briefer finished/)
  assert.equal(n.body, 'Three meetings today.')

  x.set(at(2026, 11, 6, 7, 0))
  const second = x.scheduler.tick().started[0]
  await settle()
  x.tasks.cancel(second.taskId)
  await settle()
  assert.equal(x.alerts.length, 1, 'cancelled by the owner: no alert')
})

test('a failed run is reported as such', () => {
  const n = runNotification({ id: 't1', status: 'failed', agentName: 'Briefer', error: 'Stopped: budget of 5 tool calls used up.' }, 1)
  assert.match(n.title, /could not finish/)
  assert.match(n.body, /budget/)
  assert.equal(runNotification({ id: 't1', status: 'running' }, 1), null)
  assert.equal(runNotification({ id: 't1', status: 'cancelled' }, 1), null)
})

test('off until switched on: due times while off are skipped, not saved up', async () => {
  const x = setup({ switches: 'none' })
  x.scheduler.tick()
  x.set(at(2026, 11, 5, 7, 0))
  const r = x.scheduler.tick()
  assert.deepEqual(r.started, [])
  assert.equal(r.skipped[0].reason, 'switched off')
  // Switched on at 08:00: the 07:00 run is not started late.
  x.s.v[AGENT_SETTINGS.switches] = 'briefer=on'
  x.set(at(2026, 11, 5, 8, 0))
  assert.deepEqual(x.scheduler.tick().started, [])
  x.set(at(2026, 11, 6, 7, 0))
  assert.equal(x.scheduler.tick().started.length, 1, 'next morning it runs')
  await settle()
})

test('while all agents are paused or JARVIS is frozen, due times are skipped', () => {
  const x = setup()
  x.scheduler.tick()
  x.s.v[AGENT_SETTINGS.paused] = '1'
  x.set(at(2026, 11, 5, 7, 0))
  const r = x.scheduler.tick()
  assert.deepEqual(r.started, [])
  assert.match(r.skipped[0].reason, /paused/)
  x.s.v[AGENT_SETTINGS.paused] = '0'
  x.set(at(2026, 11, 5, 7, 5))
  assert.deepEqual(x.scheduler.tick().started, [], 'unpausing does not start the skipped run')

  const frozen = true
  const s = settingsStore({ [AGENT_SETTINGS.switches]: 'briefer=on' })
  const settings = createAgentSettings({ read: s.read, frozen: () => frozen })
  let now = at(2026, 11, 5, 6)
  const agents = switchedRegistry(registry([scheduled()]), settings)
  const tasks = createTaskManager({ runAgent: fakeRun().runAgent, agents, paused: settings.paused, now: () => now, log: silent })
  const sch = createAgentScheduler({ agents, tasks, paused: settings.paused, clock: () => now, log: silent })
  sch.tick()
  now = at(2026, 11, 5, 7)
  assert.deepEqual(sch.tick().started, [], 'frozen: nothing starts')
})

test('missed runs while the PC was off run once, not once per missed time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sched-'))
  try {
    const file = join(dir, 'agent-schedule.json')
    const first = setup({ defs: [scheduled({ schedule: '0 * * * *' })], state: createScheduleState({ file, log: silent }) })
    first.scheduler.tick()
    first.set(at(2026, 11, 5, 7, 0))
    assert.equal(first.scheduler.tick().started.length, 1)
    await settle()
    complete(first.runs[0])
    await settle()
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.last.briefer, at(2026, 11, 5, 7))
    first.scheduler.stop()

    // The PC was off from 07:30 to 12:10; five hourly runs were missed.
    const second = setup({ defs: [scheduled({ schedule: '0 * * * *' })], state: createScheduleState({ file, log: silent }), start: at(2026, 11, 5, 12, 10) })
    const r = second.scheduler.tick()
    assert.equal(r.started.length, 1, 'one catch-up run')
    assert.equal(r.started[0].at, at(2026, 11, 5, 12))
    second.set(at(2026, 11, 5, 12, 11))
    assert.deepEqual(second.scheduler.tick().started, [])
    await settle()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runs do not pile up: a due time is skipped while the last run is still going', async () => {
  const x = setup({ defs: [scheduled({ schedule: '*/5 * * * *' })] })
  x.scheduler.tick()
  x.set(at(2026, 11, 5, 6, 5))
  const first = x.scheduler.tick().started[0]
  await settle()
  x.set(at(2026, 11, 5, 6, 10))
  const r = x.scheduler.tick()
  assert.deepEqual(r.started, [])
  assert.equal(r.skipped[0].reason, SCHEDULE_SKIPS.stillRunning)
  complete(x.runs[0])
  await settle()
  assert.equal(x.tasks.get(first.taskId).status, 'done')
  x.set(at(2026, 11, 5, 6, 15))
  assert.equal(x.scheduler.tick().started.length, 1, 'runs again once the last one ended')
  await settle()
})

test('a run that would exceed the concurrency cap waits in the queue', async () => {
  const defs = [scheduled({ id: 'one', name: 'One' }), scheduled({ id: 'two', name: 'Two' })]
  const x = setup({ defs, switches: 'one=on,two=on', cap: 1 })
  x.scheduler.tick()
  x.set(at(2026, 11, 5, 7, 0))
  const r = x.scheduler.tick()
  assert.equal(r.started.length, 2)
  await settle()
  assert.equal(x.runs.length, 1, 'only one runs at a time')
  assert.equal(x.tasks.get(r.started[1].taskId).status, 'queued')
  complete(x.runs[0])
  await settle()
  assert.equal(x.runs.length, 2, 'the second starts when the first ends')
  assert.equal(x.tasks.get(r.started[1].taskId).status, 'running')
})

test('only scheduled agents with a schedule it understands and a budget are run', async () => {
  const onDemand = checkAgentDefinition({ id: 'helper', name: 'Helper', description: 'On demand.', tools: [], memory: 'read', createdBy: 'builtin', body: 'Help.' }).value
  const odd = scheduled({ id: 'odd', name: 'Odd', schedule: '0 7 L * *' })
  const noBudget = { ...scheduled({ id: 'broke', name: 'Broke' }), budget: undefined }
  const warnings = []
  let now = at(2026, 11, 5, 6)
  const s = settingsStore({ [AGENT_SETTINGS.switches]: 'helper=on,odd=on,broke=on' })
  const settings = createAgentSettings({ read: s.read })
  const agents = switchedRegistry(registry([onDemand, odd, noBudget]), settings)
  const tasks = createTaskManager({ runAgent: fakeRun().runAgent, agents, now: () => now, log: silent })
  const sch = createAgentScheduler({ agents, tasks, clock: () => now, log: { ...silent, warn: (m) => warnings.push(m) } })
  sch.tick()
  now = at(2026, 11, 5, 7)
  const r = sch.tick()
  sch.tick()
  assert.deepEqual(r.started, [])
  assert.deepEqual(r.skipped.map((x) => [x.id, x.reason]), [['broke', SCHEDULE_SKIPS.noBudget]])
  assert.equal(warnings.filter((w) => /odd/.test(w)).length, 1, 'a schedule it cannot read is reported once')
  assert.equal(tasks.list().length, 0)
})

test('the fixture morning briefing agent runs on weekday mornings only', async () => {
  const text = readFileSync(new URL('../shared/fixtures/agents/valid/morning-briefing.md', import.meta.url), 'utf8')
  const parsed = parseAgentFile(text)
  assert.ok(parsed.ok)
  const x = setup({ defs: [parsed.value], switches: 'morning-briefing=on', start: at(2026, 11, 6, 6) })
  x.scheduler.tick()
  x.set(at(2026, 11, 6, 7)) // Friday
  assert.equal(x.scheduler.tick().started.length, 1)
  x.set(at(2026, 11, 7, 7)) // Saturday
  assert.deepEqual(x.scheduler.tick().started, [])
  await settle()
})

test('state: an unreadable file starts fresh and bad entries are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sched-'))
  try {
    const file = join(dir, 'agent-schedule.json')
    writeFileSync(file, '{ not json')
    assert.deepEqual(createScheduleState({ file, log: silent }).entries(), {})
    writeFileSync(file, JSON.stringify({ v: 1, last: { ok: 5, 'Bad Id': 5, neg: -1, str: 'x' } }))
    assert.deepEqual(createScheduleState({ file, log: silent }).entries(), { ok: 5 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// One scheduler
// ---------------------------------------------------------------------------

test('the workflow engine ticks added jobs; a failing job does not stop the others', () => {
  const store = { list: () => [], lastScheduledDay: () => null }
  const errors = []
  const engine = createEngine({ store, files: {}, approve: async () => false, log: { error: (m) => errors.push(m) } })
  let ticks = 0
  engine.addJob({ tick() { throw new Error('boom') } })
  const remove = engine.addJob({ tick() { ticks += 1 } })
  engine.tick()
  assert.equal(ticks, 1)
  assert.equal(errors.length, 1)
  remove()
  engine.tick()
  assert.equal(ticks, 1)
  assert.throws(() => engine.addJob({}), /tick/)
})

test('startTicker ticks after its first delay and stops cleanly', async () => {
  let n = 0
  const stop = startTicker(() => { n += 1 }, { intervalMs: 5, firstMs: 1, log: silent })
  await new Promise((r) => setTimeout(r, 30))
  stop()
  const seen = n
  assert.ok(seen >= 2)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(n, seen)
})

test('a tick that comes a little late still starts the run for the minute it was due', () => {
  const x = setup()
  x.scheduler.tick()
  x.set(at(2026, 11, 5, 7, 2) + 30_000)
  const r = x.scheduler.tick()
  assert.equal(r.started[0].at, at(2026, 11, 5, 7))
  assert.ok(x.now - r.started[0].at < 3 * MIN)
})
