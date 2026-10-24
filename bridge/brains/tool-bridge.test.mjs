import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPolicy } from '../policy.mjs'
import { createToolBridge } from './tool-bridge.mjs'
import { checkBrainEvent } from './events.mjs'

const none = () => false
const setup = ({ allowWrites = false, guard = null, tools } = {}) => {
  const audit = []
  const ran = []
  const policy = createPolicy({ allowWrites, isMemoryTool: none, isWorkflowTool: none, isTaskTool: none, audit: (e) => audit.push(e) })
  const bridge = createToolBridge({
    policy,
    actor: 'voice',
    guard,
    log: null,
    tainted: (name) => name.startsWith('mcp__calendar__'),
    tools: tools ?? {
      Read: async (args) => { ran.push(['Read', args]); return 'line one\nline two' },
      Bash: async (args) => { ran.push(['Bash', args]); return 'ran' },
      mcp__calendar__list_events: async () => { ran.push(['calendar']); return [{ type: 'text', text: '2 events' }] },
      mcp__bank__transfer_money: async () => { ran.push(['bank']); return 'paid' },
      Broken: async () => { throw new Error('disk on fire') },
    },
  })
  return { bridge, audit, ran }
}

test('offered() lists only the tools the policy allows right now', () => {
  assert.deepEqual(setup().bridge.offered(), ['Read', 'mcp__calendar__list_events'])
  // Writes on: Bash is offered, the never-list still is not.
  assert.deepEqual(setup({ allowWrites: true }).bridge.offered(), ['Read', 'Bash', 'mcp__calendar__list_events', 'Broken'])
})

test('an allowed call runs once and comes back as a valid tool_result', async () => {
  const { bridge, audit, ran } = setup()
  const r = await bridge.run({ id: 'c1', name: 'Read', args: { file_path: '/x' } })
  assert.deepEqual(r, { t: 'tool_result', id: 'c1', ok: true, summary: 'line one', tainted: false, detail: 'line one\nline two' })
  assert.ok(checkBrainEvent(r).ok)
  assert.deepEqual(ran, [['Read', { file_path: '/x' }]])
  assert.deepEqual(audit.map((e) => [e.type, e.actor, e.stage, e.request.name, e.decision.verdict]), [['decision', 'voice', 'tool-bridge', 'Read', 'allow']])
  assert.equal(bridge.outcome('c1'), true)
  assert.equal(bridge.outcome('never'), undefined)
})

test('a refused call never reaches its handler', async () => {
  const { bridge, audit, ran } = setup()
  for (const [id, name, rule] of [['c1', 'Bash', 'write-builtin'], ['c2', 'mcp__bank__transfer_money', 'never-move-money']]) {
    const r = await bridge.run({ id, name, args: {} })
    assert.equal(r.ok, false)
    assert.equal(r.tainted, false)
    assert.equal(bridge.outcome(id), false)
    assert.equal(audit.at(-1).decision.rule, rule)
  }
  assert.deepEqual(ran, [])
})

test('the guard runs after the gate, and a guard that refuses or throws stops the call', async () => {
  const asked = []
  const refusing = setup({ guard: async (name, args) => { asked.push([name, args]); return 'Held: not a destination you named.' } })
  const r = await refusing.bridge.run({ id: 'c1', name: 'Read', args: { file_path: '/y' } })
  assert.equal(r.ok, false)
  assert.equal(r.summary, 'Held: not a destination you named.')
  assert.deepEqual(asked, [['Read', { file_path: '/y' }]])
  assert.deepEqual(refusing.ran, [])
  assert.equal(refusing.audit.at(-1).decision.rule, 'guard-refused')
  // The gate refuses first, so the guard is not asked about Bash.
  await refusing.bridge.run({ id: 'c2', name: 'Bash', args: {} })
  assert.equal(asked.length, 1)

  const throwing = setup({ guard: async () => { throw new Error('boom') } })
  const t = await throwing.bridge.run({ id: 'c1', name: 'Read', args: {} })
  assert.equal(t.ok, false)
  assert.deepEqual(throwing.ran, [])
  assert.equal(throwing.audit.at(-1).decision.rule, 'guard-failed')
})

test('unknown tools, failing handlers and repeated ids come back failed', async () => {
  const { bridge, ran } = setup()
  // Allowed by name (a read verb), but this session has no such tool.
  const unknown = await bridge.run({ id: 'c1', name: 'mcp__notes__get_note', args: {} })
  assert.equal(unknown.ok, false)
  assert.match(unknown.summary, /No such tool/)
  const writes = setup({ allowWrites: true })
  const broken = await writes.bridge.run({ id: 'c1', name: 'Broken', args: {} })
  assert.equal(broken.ok, false)
  assert.equal(broken.summary, 'disk on fire')
  await bridge.run({ id: 'c2', name: 'Read', args: {} })
  const again = await bridge.run({ id: 'c2', name: 'Read', args: {} })
  assert.equal(again.ok, false)
  assert.equal(ran.length, 1, 'a repeated id never runs twice')
  await assert.rejects(bridge.run({ name: 'Read' }), /needs an id/)
})

test('private output is marked tainted, and non-text output is stringified', async () => {
  const { bridge } = setup()
  const r = await bridge.run({ id: 'c1', name: 'mcp__calendar__list_events', args: 'not an object' })
  assert.equal(r.ok, true)
  assert.equal(r.tainted, true)
  assert.equal(r.summary, '2 events')
  const json = setup({ tools: { Read: async () => ({ size: 3 }), Glob: async () => undefined } })
  assert.equal((await json.bridge.run({ id: 'a', name: 'Read' })).summary, '{"size":3}')
  assert.equal((await json.bridge.run({ id: 'b', name: 'Glob' })).summary, '')
})

test('the bridge needs the policy engine, a known actor and handler functions', () => {
  const policy = createPolicy({ allowWrites: false, isMemoryTool: none, isWorkflowTool: none, isTaskTool: none })
  assert.throws(() => createToolBridge({ actor: 'voice' }), /policy engine/)
  assert.throws(() => createToolBridge({ policy: { decide() {} }, actor: 'voice' }), /policy engine/)
  assert.throws(() => createToolBridge({ policy, actor: 'stranger' }), /Unknown actor/)
  assert.throws(() => createToolBridge({ policy, actor: 'voice', tools: { Read: 'yes' } }), /handler/)
  assert.throws(() => createToolBridge({ policy, actor: 'voice', tools: [] }), /object/)
})
