import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createPolicy, GENERAL_WRITE_TOOLS, PRE_TOOL_USE_GUARD_TIMEOUT_S } from '../policy.mjs'
import { createClaudeBrain, claudeOptions, MAX_TURNS } from './claude.mjs'
import { createBrainRegistry } from './registry.mjs'

const none = () => false
const makePolicy = (allowWrites = false, audit = undefined) =>
  createPolicy({ allowWrites, isMemoryTool: none, isWorkflowTool: none, isTaskTool: none, audit })

/** A stand-in for the SDK's query(): records what it was given. */
function fakeQuery() {
  const calls = []
  const query = (args) => {
    calls.push(args)
    return { args, interrupt: async () => {}, close() {}, async *[Symbol.asyncIterator]() {} }
  }
  return { calls, query }
}

const base = (over = {}) => ({
  policy: makePolicy(),
  actor: 'voice',
  mcpServers: { jarvis: { name: 'hud' } },
  systemPrompt: 'You are JARVIS.',
  model: 'claude-test',
  effort: 'high',
  guard: async () => null,
  afterTool: { hooks: [async () => ({})] },
  ...over,
})

test('voice session options are pinned to what server.mjs used to build inline', () => {
  const p = base()
  const o = claudeOptions(p)
  assert.deepEqual(
    Object.keys(o),
    ['mcpServers', 'systemPrompt', 'cwd', 'settingSources', 'model', 'effort', 'maxTurns',
      'permissionMode', 'disallowedTools', 'hooks', 'includePartialMessages', 'canUseTool'],
  )
  assert.equal(o.mcpServers, p.mcpServers)
  assert.equal(o.systemPrompt, 'You are JARVIS.')
  assert.equal(o.cwd, homedir())
  // No filesystem settings: the bridge is the only permission authority.
  assert.deepEqual(o.settingSources, [])
  assert.equal(o.model, 'claude-test')
  assert.equal(o.effort, 'high')
  assert.equal(o.maxTurns, 24)
  assert.equal(o.permissionMode, 'default')
  assert.equal(o.includePartialMessages, true)
  assert.equal(o.hooks.PreToolUse.length, 1)
  assert.deepEqual(o.hooks.PostToolUse, [p.afterTool])
  assert.equal(typeof o.canUseTool, 'function')
  assert.equal('abortController' in o, false)
})

test('worker session options: 40 turns and its own abort controller', () => {
  const abortController = new AbortController()
  const o = claudeOptions(base({ actor: 'worker', abortController }))
  assert.equal(o.maxTurns, MAX_TURNS.worker)
  assert.equal(o.maxTurns, 40)
  assert.equal(o.abortController, abortController)
  assert.equal(Object.keys(o)[0], 'abortController')
})

test('disallowedTools follows the write switch', () => {
  assert.deepEqual(claudeOptions(base()).disallowedTools, [...GENERAL_WRITE_TOOLS])
  assert.deepEqual(claudeOptions(base({ policy: makePolicy(true) })).disallowedTools, [])
})

test('canUseTool asks the policy engine and audits as the right actor', async () => {
  for (const actor of ['voice', 'worker']) {
    const entries = []
    const policy = makePolicy(false, (e) => entries.push(e))
    const can = claudeOptions(base({ policy, actor, log: () => {} })).canUseTool
    assert.equal((await can('Bash', {})).behavior, 'deny')
    assert.equal((await can('Read', {})).behavior, 'allow')
    assert.ok(entries.length >= 2)
    assert.ok(entries.every((e) => e.actor === actor && e.stage === 'can-use-tool'))
  }
})

test('the voice log receives decisions; the worker has none', async () => {
  const lines = []
  const can = claudeOptions(base({ log: (l) => lines.push(l) })).canUseTool
  await can('Read', {})
  assert.deepEqual(lines, ['[jarvis] tool Read -> allow'])
})

test('PreToolUse runs the gate, then the guard, as the session actor', async () => {
  const entries = []
  const policy = makePolicy(false, (e) => entries.push(e))
  const guarded = []
  const guard = async (name) => {
    guarded.push(name)
    return name === 'WebFetch' ? 'Not to an unnamed site.' : null
  }
  const o = claudeOptions(base({ policy, actor: 'worker', guard }))
  const matcher = o.hooks.PreToolUse[0]
  assert.equal(matcher.timeout, PRE_TOOL_USE_GUARD_TIMEOUT_S)
  const [hook] = matcher.hooks

  // The gate refuses first; the guard is never asked about a refused tool.
  const bash = await hook({ tool_name: 'Bash', tool_input: {} })
  assert.equal(bash.hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(guarded, [])

  // An allowed tool goes on to the guard, which can still refuse.
  const fetch = await hook({ tool_name: 'WebFetch', tool_input: { url: 'https://x.test' } })
  assert.equal(fetch.hookSpecificOutput.permissionDecisionReason, 'Not to an unnamed site.')
  assert.deepEqual(await hook({ tool_name: 'Read', tool_input: {} }), {})
  assert.deepEqual(guarded, ['WebFetch', 'Read'])
  assert.ok(entries.every((e) => e.actor === 'worker' && e.stage === 'pre-tool-use'))
})

test('a guard that throws refuses the call', async () => {
  const guard = async () => { throw new Error('boom') }
  const o = claudeOptions(base({ guard }))
  // Silence the expected error line.
  const error = console.error
  console.error = () => {}
  try {
    const out = await o.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: {} })
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  } finally {
    console.error = error
  }
})

test('options refuse to build without a policy engine or with an unknown actor', () => {
  assert.throws(() => claudeOptions(base({ policy: undefined })), /policy/)
  assert.throws(() => claudeOptions(base({ actor: 'guest' })), /actor/)
})

test('startSession hands the prompt and the built options to the SDK', () => {
  const { calls, query } = fakeQuery()
  const brain = createClaudeBrain({ query, status: () => ({}), login() {} })
  const params = base()
  const session = brain.startSession({ prompt: 'hello', ...params })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, 'hello')
  assert.deepEqual(Object.keys(calls[0]), ['prompt', 'options'])
  assert.equal(calls[0].options.maxTurns, 24)
  assert.equal(calls[0].options.mcpServers, params.mcpServers)
  // The SDK's Query comes back untouched, so interrupt() and close() still work.
  assert.equal(typeof session.interrupt, 'function')
  assert.equal(typeof session.close, 'function')
})

test('the brain needs the SDK query()', () => {
  assert.throws(() => createClaudeBrain({}), /query/)
})

test('status reports the binary and the auth mode', () => {
  const status = () => ({ installed: true, version: '2.1.0 (Claude Code)', loggedIn: true })
  const sub = createClaudeBrain({ query: () => {}, status, env: {} }).status()
  assert.deepEqual(sub, {
    installed: true, version: '2.1.0 (Claude Code)', loggedIn: true, authenticated: true, authMode: 'subscription',
  })
  const key = createClaudeBrain({
    query: () => {}, status: () => ({ installed: true, version: 'x', loggedIn: false }), env: { ANTHROPIC_API_KEY: 'k' },
  }).status()
  assert.equal(key.loggedIn, false)
  assert.equal(key.authenticated, true)
  assert.equal(key.authMode, 'apikey')
  const missing = createClaudeBrain({ query: () => {}, status: () => ({ installed: false }), env: {} }).status()
  assert.deepEqual(missing, { installed: false, version: '', loggedIn: false, authenticated: false, authMode: 'subscription' })
})

test('login starts the vendor sign-in and nothing else', () => {
  let started = 0
  createClaudeBrain({ query: () => {}, login: () => { started++ } }).login()
  assert.equal(started, 1)
})

test('the Claude brain registers as the default brain', () => {
  const brains = createBrainRegistry()
  brains.register(createClaudeBrain({ query: () => {} }))
  assert.equal(brains.default().id, 'claude')
  assert.deepEqual(brains.list().map((b) => b.id), ['claude'])
})

test('server.mjs reaches the SDK only through the brain registry', () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  // query is imported once and handed to the brain, never called directly.
  assert.equal((src.match(/\bquery\(/g) ?? []).length, 0)
  assert.match(src, /createClaudeBrain\(\{ query \}\)/)
  assert.equal((src.match(/brain\.startSession\(/g) ?? []).length, 2)
  // Session options are built in one place only.
  assert.doesNotMatch(src, /(settingSources|includePartialMessages|permissionMode|canUseTool):/)
  assert.doesNotMatch(src, /claudeStatus|startClaudeLogin/)
})
