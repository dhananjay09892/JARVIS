import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkflows, validateWorkflow, describeWorkflow, isDue, createApprovalHub, createEngine } from './workflows.mjs'
import { workflowOperations } from './workflow-tools.mjs'
import { createBus, checkBusEvent } from './bus.mjs'

const silent = { error() {} }
const recipe = (extra = {}) => ({
  name: 'Morning check',
  scheduleTime: '08:30',
  steps: [
    { type: 'list_files', path: 'Repo' },
    { type: 'run_command', cwd: 'Repo', command: 'npm test' },
  ],
  ...extra,
})
const saved = (store, extra) => {
  const v = validateWorkflow(recipe(extra))
  assert.equal(v.ok, true)
  store.create(v.value)
  return store.get(v.value.name)
}

test('validation rejects malformed recipes and marks action steps on the card', () => {
  for (const bad of [
    { name: '' }, recipe({ scheduleTime: '25:00' }), recipe({ steps: [] }), recipe({ steps: [{ type: 'write_file' }] }),
    recipe({ steps: [{ type: 'run_command', cwd: 'Repo' }] }),
    recipe({ steps: [{ type: 'push_branch', cwd: 'Repo', remote: 'origin; rm x', branch: 'main' }] }),
    recipe({ steps: Array(21).fill({ type: 'list_files', path: '.' }) }),
  ]) assert.equal(validateWorkflow(bad).ok, false)
  const card = describeWorkflow(validateWorkflow(recipe()).value)
  assert.match(card, /\[read only\] list folder Repo/)
  assert.match(card, /\[ACTION — asks every run\] in Repo: npm test/)
  assert.match(card, /ask for its own approval each time/)
})

test('a daily workflow is due once per day after its time, and only if enabled', () => {
  const w = { enabled: true, scheduleTime: '08:30' }
  const at = (h, m) => new Date(2026, 9, 15, h, m)
  assert.equal(isDue(w, null, at(8, 29)), false)
  assert.equal(isDue(w, null, at(8, 30)), true)
  assert.equal(isDue(w, '2026-10-15', at(9, 0)), false)
  assert.equal(isDue(w, '2026-10-14', at(9, 0)), true)
  assert.equal(isDue({ ...w, enabled: false }, null, at(9, 0)), false)
  assert.equal(isDue({ enabled: true, scheduleTime: null }, null, at(9, 0)), false)
})

test('the approval hub holds requests until a browser connects, once, and fails closed', async () => {
  const hub = createApprovalHub({ ttlMs: 50 })
  const first = hub.request('Run', 'cmd')
  const sent = []
  const detach = hub.attach((f) => sent.push(f))
  assert.equal(sent[0].type, 'approval', 'a browser connecting later is shown the pending request')
  assert.equal(hub.reply(sent[0].id, 'true'), true, 'only a real boolean true approves')
  assert.equal(await first, false)
  assert.equal(hub.reply(sent[0].id, true), false, 'ids are single-use')
  const second = hub.request('Run', 'cmd')
  assert.equal(await second, false, 'expiry rejects')
  assert.equal(sent.at(-1).type, 'approval_closed')
  const third = hub.request('Run', 'cmd')
  hub.reply(sent.findLast((f) => f.type === 'approval').id, true)
  assert.equal(await third, true)
  detach()
})

test('runs: read steps go freely, action steps ask every time, rejection stops the run', async () => {
  const store = openWorkflows({ file: ':memory:' })
  const w = saved(store)
  const asked = []
  let executed = 0
  const files = { list: async () => [1, 2, 3], read: async () => ({ content: 'x', sha256: 'a'.repeat(64) }), directory: async () => 'C:\\Repo' }
  const execute = (_exe, _args, _opts, cb) => { executed++; cb(null, 'ok', '') }
  const env = { SystemRoot: 'C:\\Windows' }
  const make = (answer) => createEngine({
    store, files, execute, log: silent,
    approve: async (title, details) => { asked.push({ title, details }); return answer },
  })

  // Rejected: nothing executes, and the run says so.
  let r = await make(false).run(w, 'schedule')
  await r.done
  let run = store.runs(w.id)[0]
  assert.equal(run.status, 'failed')
  assert.deepEqual(run.steps.map((s) => s.status), ['completed', 'rejected'])
  assert.equal(executed, 0)
  assert.match(asked[0].details, /npm test/)
  assert.match(asked[0].details, /scheduled run/)

  // Approved: the command runs, but the next run asks again (nothing remembered).
  const approved = createEngine({ store, files, execute, log: silent, approve: async (t, d) => { asked.push({ t, d }); return true } })
  process.env.SystemRoot ??= env.SystemRoot
  r = await approved.run(w, 'manual')
  await r.done
  run = store.runs(w.id)[0]
  assert.deepEqual(run.steps.map((s) => s.status), ['completed', 'completed'])
  assert.equal(executed, 1)
  const before = asked.length
  r = await approved.run(w, 'manual')
  await r.done
  assert.equal(asked.length, before + 1, 'every run asks again')
})

test('a scheduled run waits for approval, is recorded as waiting, and is not repeated that day', async () => {
  const store = openWorkflows({ file: ':memory:' })
  const w = saved(store)
  let release
  const gate = new Promise((r) => { release = r })
  const files = { list: async () => [], directory: async () => 'C:\\Repo' }
  const engine = createEngine({
    store, files, log: silent, execute: (_e, _a, _o, cb) => cb(null, 'done', ''),
    approve: () => gate,
    clock: () => new Date(2026, 9, 15, 9, 0),
  })
  assert.equal(engine.tick(), 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(store.runs(w.id)[0].status, 'waiting_approval')
  assert.equal(engine.tick(), 0, 'not started twice while waiting')
  release(false)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(store.runs(w.id)[0].status, 'failed')
  assert.equal(engine.tick(), 0, 'not retried the same day after a rejection')
})

test('a run cannot survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-workflow-test-'))
  try {
    let store = openWorkflows({ dir })
    const w = saved(store)
    const { id, steps } = store.startRun(w, 'manual')
    store.saveRun(id, 'waiting_approval', steps)
    store.close()
    store = openWorkflows({ dir })
    assert.equal(store.runs(w.id)[0].status, 'interrupted')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the model cannot save, change or delete a workflow without approval', async () => {
  const store = openWorkflows({ file: ':memory:' })
  const engine = createEngine({ store, files: {}, approve: async () => false, log: silent })
  let answer = false
  const cards = []
  const ops = workflowOperations({ store, engine, approve: async (t, d) => { cards.push([t, d]); return answer } })

  assert.equal((await ops.create(recipe())).saved, false)
  assert.equal(store.list().length, 0)
  assert.match(cards[0][1], /\[ACTION/)

  answer = true
  assert.equal((await ops.create(recipe())).saved, true)
  assert.equal((await ops.create(recipe())).saved, false, 'duplicate name')

  answer = false
  assert.equal((await ops.update({ name: 'Morning check', scheduleTime: '' })).saved, false)
  assert.equal(store.get('Morning check').scheduleTime, '08:30')
  assert.equal((await ops.remove({ name: 'Morning check' })).deleted, false)
  assert.equal(store.list().length, 1)

  answer = true
  assert.equal((await ops.update({ name: 'Morning check', scheduleTime: '', enabled: false })).saved, true)
  assert.equal(store.get('Morning check').scheduleTime, null)
  assert.match(cards.at(-1)[1], /BEFORE[\s\S]*AFTER/)
  assert.equal((await ops.remove({ name: 'Morning check' })).deleted, true)
  assert.equal((await ops.create({ ...recipe(), steps: [{ type: 'run_command', cwd: 'Repo' }] })).saved, false)
})

test('the scheduler publishes workflow.started and workflow.finished, with counts and no step details', async () => {
  const store = openWorkflows({ file: ':memory:' })
  const w = saved(store)
  const bus = createBus({ log: silent })
  const events = []
  bus.subscribe('workflow.*', (e) => events.push(e))
  const files = { list: async () => [1], directory: async () => 'C:\\Repo' }
  const engine = createEngine({
    store, files, bus, log: silent, approve: async () => false,
    clock: () => new Date(2026, 9, 15, 9, 0),
  })
  assert.equal(engine.tick(), 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(events.map((e) => e.topic), ['workflow.started', 'workflow.finished'])
  for (const e of events) assert.deepEqual(checkBusEvent(e), { ok: true })
  const [start, end] = events.map((e) => e.payload)
  assert.equal(start.runId, end.runId)
  assert.equal(start.runId, store.runs(w.id)[0].id)
  assert.deepEqual(
    { ...start },
    { runId: start.runId, workflowId: w.id, name: 'Morning check', trigger: 'schedule', status: 'running', stepsTotal: 2, stepsCompleted: 0, startedAt: start.startedAt },
  )
  assert.equal(end.status, 'failed', 'the action step was not approved')
  assert.equal(end.stepsCompleted, 1)
  assert.ok(end.finishedAt >= end.startedAt)
  assert.ok(!JSON.stringify(events).includes('npm test'), 'no command in the events')
})

test('a manual run that completes publishes completed', async () => {
  const store = openWorkflows({ file: ':memory:' })
  const v = validateWorkflow({ name: 'Look', steps: [{ type: 'list_files', path: 'Repo' }] })
  store.create(v.value)
  const w = store.get('Look')
  const bus = createBus({ log: silent })
  const events = []
  bus.subscribe('workflow.finished', (e) => events.push(e))
  const engine = createEngine({ store, files: { list: async () => [] }, bus, log: silent, approve: async () => true })
  const r = await engine.run(w, 'manual')
  await r.done
  await new Promise((res) => setImmediate(res))
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.status, 'completed')
  assert.equal(events[0].payload.trigger, 'manual')
  assert.equal(events[0].payload.stepsCompleted, 1)
})

