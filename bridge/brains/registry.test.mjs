import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrainRegistry, toolModeOf, POLICY_BYPASS } from './registry.mjs'
import { createPolicy } from '../policy.mjs'

const brain = (over = {}) => ({
  id: 'claude',
  label: 'Claude',
  capabilities: { tools: true, streaming: true },
  status: () => ({ installed: true }),
  startSession: () => ({}),
  converse: () => ({}),
  ...over,
})

test('register, get, list and default', () => {
  const brains = createBrainRegistry({ log: null })
  const claude = brains.register(brain())
  const other = brains.register(brain({ id: 'mock-brain', label: 'Mock' }))
  assert.equal(brains.get('claude'), claude)
  assert.equal(brains.get('mock-brain'), other)
  assert.equal(brains.default(), claude)
  assert.equal(brains.has('claude'), true)
  assert.equal(brains.has('gemini'), false)
  assert.deepEqual(brains.list(), [
    { id: 'claude', label: 'Claude', capabilities: { tools: true, streaming: true }, toolMode: 'read-only' },
    { id: 'mock-brain', label: 'Mock', capabilities: { tools: true, streaming: true }, toolMode: 'read-only' },
  ])
})

test('unknown ids throw instead of falling back to another brain', () => {
  const brains = createBrainRegistry({ log: null })
  assert.throws(() => brains.get('claude'), /No brain called claude/)
  assert.throws(() => brains.default(), /No brain called claude/)
  const custom = createBrainRegistry({ defaultId: 'mock' })
  custom.register(brain())
  assert.throws(() => custom.default(), /No brain called mock/)
})

test('duplicates and malformed brains are rejected', () => {
  const brains = createBrainRegistry({ log: null })
  brains.register(brain())
  assert.throws(() => brains.register(brain()), /already registered/)
  assert.throws(() => brains.register(null), /object/)
  assert.throws(() => brains.register(brain({ id: 'Bad Id' })), /Bad brain id/)
  assert.throws(() => brains.register(brain({ id: 'x', label: '' })), /label/)
  assert.throws(() => brains.register(brain({ id: 'y', capabilities: null })), /capabilities/)
  assert.throws(() => brains.register(brain({ id: 'z', status: undefined })), /status\(\)/)
  assert.throws(() => brains.register(brain({ id: 'w', startSession: 'no' })), /startSession\(\)/)
  assert.throws(() => brains.register(brain({ id: 'v', converse: undefined })), /converse\(\)/)
  assert.deepEqual(brains.list().map((b) => b.id), ['claude'])
})

// The policy contract (plan 21, phase 3).

const none = () => false
const policyWith = (audit = []) => createPolicy({
  allowWrites: false, isMemoryTool: none, isWorkflowTool: none, isTaskTool: none, audit: (e) => audit.push(e),
})

/** A brain that plays `script` (a list of events, or a function of params) as its session. */
const scripted = (gate, script, seen = {}) => brain({
  id: `b-${gate ?? 'none'}`,
  capabilities: { tools: true, ...(gate && { toolGate: gate }) },
  converse(params) {
    seen.params = params
    seen.cancelled = 0
    return {
      events: (async function* () {
        yield* typeof script === 'function' ? await script(params) : script
      })(),
      cancel() {
        seen.cancelled++
      },
      close() {
        seen.closed = true
      },
    }
  },
})

const collect = async (run) => {
  const out = []
  for await (const e of run.events) out.push(e)
  return out
}

const call = (id, name) => [{ t: 'tool_start', id, name }, { t: 'tool_call', id, name, args: {} }]
const result = (id, ok = true) => ({ t: 'tool_result', id, ok, summary: '', tainted: false })
const done = (reason = 'complete') => ({ t: 'done', reason })

test('tool modes come from capabilities.toolGate; anything else is read-only', () => {
  assert.equal(toolModeOf({ toolGate: 'hook' }), 'agent')
  assert.equal(toolModeOf({ toolGate: 'loop' }), 'tool-loop')
  assert.equal(toolModeOf({ tools: true }), 'read-only')
  assert.equal(toolModeOf(undefined), 'read-only')
  const brains = createBrainRegistry({ log: null })
  assert.throws(() => brains.register(brain({ capabilities: { tools: true, toolGate: 'trust-me' } })), /unknown toolGate/)
  assert.equal(brains.register(brain({ capabilities: { toolGate: 'hook' } })).toolMode, 'agent')
})

test('the registry hands out converse() only, never the raw provider session', () => {
  const b = createBrainRegistry({ log: null }).register(brain({ login() {} }))
  assert.equal(b.startSession, undefined)
  assert.equal(typeof b.converse, 'function')
  assert.equal(typeof b.login, 'function')
  assert.ok(Object.isFrozen(b))
})

test('no brain conversation starts without the policy engine', () => {
  const brains = createBrainRegistry({ log: null })
  for (const gate of ['hook', 'loop', undefined]) {
    const b = brains.register(scripted(gate, [done()]))
    assert.throws(() => b.converse({ prompt: 'hi', actor: 'voice' }), /needs the policy engine/)
    assert.throws(() => b.converse({ prompt: 'hi', actor: 'voice', policy: { decide() {} } }), /needs the policy engine/)
  }
})

test('read-only mode: no tools reach the brain, and a tool it uses anyway stops the turn', async () => {
  const seen = {}
  const b = createBrainRegistry({ log: null }).register(scripted(undefined, [
    { t: 'text', delta: 'Let me just ' }, ...call('c1', 'Bash'), result('c1'), { t: 'text', delta: 'tail' }, done(),
    { t: 'text', delta: 'next turn' }, done(),
  ], seen))
  const events = await collect(b.converse({
    prompt: 'hi', actor: 'voice', policy: policyWith(), mcpServers: { a: {} }, tools: { Bash() {} }, guard() {}, afterTool: {}, model: 'm',
  }))
  assert.deepEqual(Object.keys(seen.params).sort(), ['actor', 'model', 'prompt', 'readOnly'])
  assert.equal(seen.params.readOnly, true)
  assert.deepEqual(events.map((e) => e.t), ['text', 'error', 'done', 'text', 'done'])
  assert.equal(events[1].code, POLICY_BYPASS)
  assert.equal(events[1].retryable, false)
  assert.equal(events[2].reason, 'error', 'a stopped turn is reported, not passed off as a barge-in')
  assert.equal(seen.cancelled, 1)
  assert.equal(events[3].delta, 'next turn', 'the next turn is not affected')
})

test('tool-loop mode: tools run only through the bridge, which asks the policy engine', async () => {
  const audit = []
  const ran = []
  const b = createBrainRegistry({ log: null }).register(scripted('loop', async function* ({ tools }) {
    yield* call('c1', 'Read')
    yield await tools.run({ id: 'c1', name: 'Read', args: { file_path: '/x' } })
    yield* call('c2', 'Bash')
    yield await tools.run({ id: 'c2', name: 'Bash', args: { command: 'rm -rf /' } })
    yield done()
  }))
  const events = await collect(b.converse({
    prompt: 'hi', actor: 'worker', policy: policyWith(audit),
    tools: { Read: async () => { ran.push('Read'); return 'contents' }, Bash: async () => { ran.push('Bash'); return 'gone' } },
  }))
  assert.deepEqual(ran, ['Read'])
  assert.deepEqual(events.filter((e) => e.t === 'tool_result').map((e) => [e.id, e.ok]), [['c1', true], ['c2', false]])
  assert.equal(events.some((e) => e.t === 'error'), false)
  assert.deepEqual(audit.map((e) => [e.actor, e.stage, e.request.name, e.decision.verdict]), [
    ['worker', 'tool-bridge', 'Read', 'allow'], ['worker', 'tool-bridge', 'Bash', 'deny'],
  ])
})

test('tool-loop mode: a result the bridge never produced, or a refusal reported as success, stops the turn', async () => {
  const brains = createBrainRegistry({ log: null })
  const forged = brains.register(scripted('loop', [...call('c1', 'Bash'), result('c1'), done()]))
  const a = await collect(forged.converse({ prompt: 'hi', actor: 'voice', policy: policyWith() }))
  assert.deepEqual(a.map((e) => e.t), ['tool_start', 'tool_call', 'error', 'done'])
  assert.equal(a[2].code, POLICY_BYPASS)

  const liar = scripted('loop', async function* ({ tools }) {
    yield* call('c1', 'Bash')
    const r = await tools.run({ id: 'c1', name: 'Bash', args: {} })
    yield { ...r, ok: true }
    yield done()
  })
  const b = await collect(brains.register({ ...liar, id: 'liar' }).converse({ prompt: 'hi', actor: 'voice', policy: policyWith(), tools: { Bash: async () => 'x' } }))
  assert.equal(b.find((e) => e.t === 'error')?.code, POLICY_BYPASS)
  assert.equal(b.some((e) => e.t === 'tool_result'), false)
})

test('agent mode: a tool the hook allowed passes; one that ran without an allow stops the turn', async () => {
  const brains = createBrainRegistry({ log: null })
  // A provider that asks the hook for c1 only, and runs c2 regardless.
  const b = brains.register(scripted('hook', async function* ({ policy }) {
    const [hook] = policy.preToolUse({ actor: 'voice', log: null }).hooks
    yield* call('c1', 'Read')
    await hook({ tool_name: 'Read', tool_input: {} })
    yield result('c1')
    yield* call('c2', 'Glob')
    yield result('c2')
    yield { t: 'text', delta: 'tail' }
    yield done()
  }))
  const audit = []
  const events = await collect(b.converse({ prompt: 'hi', actor: 'voice', policy: policyWith(audit) }))
  assert.deepEqual(events.filter((e) => e.t === 'tool_result').map((e) => e.id), ['c1'])
  assert.equal(events.find((e) => e.t === 'error')?.code, POLICY_BYPASS)
  assert.equal(events.at(-1).reason, 'error')
  assert.equal(events.some((e) => e.t === 'text'), false)
  // Deciding is unchanged: the hook's decision is on the audit trail as before.
  assert.deepEqual(audit.map((e) => [e.stage, e.request.name, e.decision.verdict]), [['pre-tool-use', 'Read', 'allow']])
})

test('agent mode: a refusal from the hook is not an allow, and an allow is used once', async () => {
  const brains = createBrainRegistry({ log: null })
  const refused = brains.register(scripted('hook', async function* ({ policy }) {
    const [hook] = policy.preToolUse({ actor: 'voice', log: null }).hooks
    yield* call('c1', 'Bash')
    await hook({ tool_name: 'Bash', tool_input: {} })
    yield result('c1') // ran anyway
    yield done()
  }))
  assert.equal((await collect(refused.converse({ prompt: 'x', actor: 'voice', policy: policyWith() }))).find((e) => e.t === 'error')?.code, POLICY_BYPASS)

  const twice = scripted('hook', async function* ({ policy }) {
    const ask = policy.canUseTool('voice')
    yield* call('c1', 'Read')
    await ask('Read', {})
    yield result('c1')
    yield* call('c2', 'Read')
    yield result('c2') // second run, no second allow
    yield done()
  })
  const events = await collect(brains.register({ ...twice, id: 'twice' }).converse({ prompt: 'x', actor: 'voice', policy: policyWith() }))
  assert.deepEqual(events.filter((e) => e.t === 'tool_result').map((e) => e.id), ['c1'])
  assert.equal(events.find((e) => e.t === 'error')?.code, POLICY_BYPASS)
})

test('agent mode: a failed tool result is not a bypass', async () => {
  const brains = createBrainRegistry({ log: null })
  const b = brains.register(scripted('hook', [...call('c1', 'Bash'), result('c1', false), done()]))
  const events = await collect(b.converse({ prompt: 'x', actor: 'voice', policy: policyWith() }))
  assert.deepEqual(events.map((e) => e.t), ['tool_start', 'tool_call', 'tool_result', 'done'])
})
