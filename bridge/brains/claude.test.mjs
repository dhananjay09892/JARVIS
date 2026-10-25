import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createPolicy, GENERAL_WRITE_TOOLS, PRE_TOOL_USE_GUARD_TIMEOUT_S } from '../policy.mjs'
import {
  createClaudeBrain, claudeOptions, claudeEventMapper, claudeAuthEnv, resolveClaudeAuth, AUTH_MODES, MAX_TURNS, NO_KEY_MESSAGE,
} from './claude.mjs'
import { createBrainRegistry } from './registry.mjs'
import { checkBrainEvent } from './events.mjs'

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
    installed: true, version: '2.1.0 (Claude Code)', loggedIn: true, authenticated: true, authMode: 'subscription', apiKeySet: false,
  })
  const loggedOut = () => ({ installed: true, version: 'x', loggedIn: false })
  const key = createClaudeBrain({
    query: () => {}, status: loggedOut, env: { JARVIS_CLAUDE_AUTH: 'apikey', ANTHROPIC_API_KEY: 'sk-ant-test-value' },
  }).status()
  assert.equal(key.loggedIn, false)
  assert.equal(key.authenticated, true)
  assert.equal(key.authMode, 'apikey')
  assert.equal(key.apiKeySet, true)
  assert.equal(JSON.stringify(key).includes('sk-ant-test-value'), false, 'status never carries the key')
  const missing = createClaudeBrain({ query: () => {}, status: () => ({ installed: false }), env: {} }).status()
  assert.deepEqual(missing, {
    installed: false, version: '', loggedIn: false, authenticated: false, authMode: 'subscription', apiKeySet: false,
  })
})

test('auth: subscription is the default; a key in the shell alone does not switch modes', () => {
  assert.equal(AUTH_MODES[0], 'subscription')
  for (const choice of [null, undefined, {}, { mode: '' }, { mode: 'Claude.ai' }, { mode: 'apikey ' }]) {
    assert.equal(resolveClaudeAuth(choice).mode, 'subscription')
  }
  const shellKey = createClaudeBrain({
    query: () => {}, status: () => ({ installed: true, loggedIn: true }), env: { ANTHROPIC_API_KEY: 'sk-ant-from-shell' },
  }).status()
  assert.equal(shellKey.authMode, 'subscription')
  assert.equal(shellKey.authenticated, true)
})

test('auth: API-key mode without a key is not authenticated, even when signed in', () => {
  const s = createClaudeBrain({
    query: () => {}, status: () => ({ installed: true, loggedIn: true }), auth: () => ({ mode: 'apikey', apiKey: '  ' }),
  }).status()
  assert.equal(s.authMode, 'apikey')
  assert.equal(s.authenticated, false)
  assert.equal(s.apiKeySet, false)
})

test('auth env: subscription strips any key; API-key mode sets the saved one; nothing else changes', () => {
  const base = { PATH: '/bin', HOME: '/home/a', ANTHROPIC_API_KEY: 'sk-ant-from-shell' }
  const sub = claudeAuthEnv(base, { mode: 'subscription', apiKey: 'sk-ant-saved' })
  assert.deepEqual(sub, { PATH: '/bin', HOME: '/home/a' })
  assert.equal('ANTHROPIC_API_KEY' in sub, false)
  const key = claudeAuthEnv(base, { mode: 'apikey', apiKey: ' sk-ant-saved ' })
  assert.deepEqual(key, { PATH: '/bin', HOME: '/home/a', ANTHROPIC_API_KEY: 'sk-ant-saved' })
  assert.equal(base.ANTHROPIC_API_KEY, 'sk-ant-from-shell', 'the base environment is not modified')
  assert.equal('ANTHROPIC_API_KEY' in claudeAuthEnv(base, { mode: 'apikey', apiKey: '' }), false)
})

test('sessions start the binary with the environment for the chosen mode, read per session', () => {
  const { calls, query } = fakeQuery()
  let choice = { mode: 'subscription', apiKey: 'sk-ant-saved' }
  const brain = createClaudeBrain({
    query, status: () => ({}), login() {}, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-from-shell' }, auth: () => choice,
  })
  brain.startSession({ prompt: 'one', ...base() })
  assert.deepEqual(calls[0].options.env, { PATH: '/bin' })
  // Switched in Settings: the next session uses the key, the first is untouched.
  choice = { mode: 'apikey', apiKey: 'sk-ant-saved' }
  brain.converse({ prompt: 'two', ...base() })
  assert.deepEqual(calls[1].options.env, { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-saved' })
  assert.deepEqual(calls[0].options.env, { PATH: '/bin' })
})

test('API-key mode without a key ends the turn with an auth error and never starts the binary', async () => {
  const { calls, query } = fakeQuery()
  const brain = createClaudeBrain({ query, status: () => ({}), login() {}, env: {}, auth: () => ({ mode: 'apikey' }) })
  const run = brain.converse({ prompt: 'hi', ...base() })
  const events = []
  for await (const e of run.events) events.push(e)
  assert.equal(calls.length, 0)
  assert.deepEqual(events, [
    { t: 'error', code: 'auth', retryable: false, message: NO_KEY_MESSAGE },
    { t: 'done', reason: 'error' },
  ])
  for (const e of events) assert.equal(checkBrainEvent(e).ok, true)
  await run.cancel()
  run.close()
  assert.throws(() => brain.startSession({ prompt: 'hi', ...base() }), /API key/)
  assert.throws(() => brain.converse({ ...base() }), /prompt/)
})

test('an auth() that throws falls back to the subscription', () => {
  const { calls, query } = fakeQuery()
  const brain = createClaudeBrain({
    query, status: () => ({ loggedIn: true }), login() {}, env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
    auth: () => { throw new Error('keychain locked') },
  })
  assert.equal(brain.status().authMode, 'subscription')
  brain.startSession({ prompt: 'hi', ...base() })
  assert.equal('ANTHROPIC_API_KEY' in calls[0].options.env, false)
  assert.throws(() => createClaudeBrain({ query, auth: 'apikey' }), /auth/)
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

test('server.mjs takes the Claude auth choice from Settings and the keychain, never from Claude.ai files', () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(src, /mode: setting\('JARVIS_CLAUDE_AUTH'\) \?\? settingDefault\('JARVIS_CLAUDE_AUTH'\)/)
  assert.match(src, /apiKey: setting\('ANTHROPIC_API_KEY'\) \?\? ''/)
  assert.match(src, /createClaudeBrain\(\{ query, auth: claudeAuth \}\)/)
  // /setup/status reports the mode and readiness, and nothing that could carry the key.
  const route = src.slice(src.indexOf("requestUrl.pathname === '/setup/status'"))
  assert.match(route.slice(0, 700), /claudeAuthMode: c\.authMode, claudeAuthenticated: c\.authenticated/)
  assert.doesNotMatch(route.slice(0, 700), /apiKey|ANTHROPIC_API_KEY/)
  // JARVIS never reads the binary's own sign-in (Claude.ai credentials).
  const brain = readFileSync(new URL('./claude.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src + brain, /\.credentials\.json|oauthAccount|claudeAiOauth/)
})

test('server.mjs reaches the SDK only through the brain registry', () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  // query is imported once and handed to the brain, never called directly.
  assert.equal((src.match(/\bquery\(/g) ?? []).length, 0)
  assert.match(src, /createClaudeBrain\(\{ query(, auth: claudeAuth)? \}\)/)
  // Both sessions (voice and task worker) are read as BrainEvents.
  assert.equal((src.match(/brain\.converse\(/g) ?? []).length, 2)
  assert.equal((src.match(/\.startSession\(/g) ?? []).length, 0)
  // Session options are built in one place only.
  assert.doesNotMatch(src, /(settingSources|includePartialMessages|permissionMode|canUseTool):/)
  assert.doesNotMatch(src, /claudeStatus|startClaudeLogin/)
})

test('neither server.mjs nor tasks.mjs reads an SDK message type (plan 21 phase 2)', () => {
  for (const file of ['../server.mjs', '../tasks.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      // Comments may name SDK shapes when explaining history; code may not.
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const shape of [/stream_event/, /content_block/, /text_delta/, /tool_use/, /tool_use_id/, /is_error/, /total_cost_usd/, /\.subtype\b/, /mcp_servers/, /\bcase 'assistant'/, /\bcase 'result'/, /\bcase 'system'/]) {
      assert.doesNotMatch(src, shape, `${file} reads an SDK shape: ${shape}`)
    }
  }
})

// ---------------------------------------------------------------------------
// SDK messages → BrainEvents (plan 21 phase 2). The conformance suite plays
// whole scenarios; these pin the edge cases one message at a time.

const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id, text, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError && { is_error: true }) }] },
})

test('mapper: deltas are text; a repeated tool_use block is one tool_call', () => {
  const m = claudeEventMapper()
  assert.deepEqual(m.map(delta('Hi')), [{ t: 'text', delta: 'Hi' }])
  const call = toolUse('c1', 'Read', { file_path: '/x' })
  assert.deepEqual(m.map(call), [{ t: 'tool_call', id: 'c1', name: 'Read', args: { file_path: '/x' } }])
  assert.deepEqual(m.map(call), [])
  // Streamed text is not repeated from the whole assistant message.
  assert.deepEqual(m.map({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }), [])
})

test('mapper: init lists the usable servers; a tool_use block start is one early tool_start', () => {
  const m = claudeEventMapper()
  assert.deepEqual(m.map({ type: 'system', subtype: 'init' }), [{ t: 'ready', servers: [] }])
  assert.deepEqual(m.map({
    type: 'system', subtype: 'init',
    mcp_servers: [{ name: 'gmail', status: 'pending' }, { name: 'drive', status: 'needs-auth' }, { name: 'x', status: 'failed' }, { name: 'jarvis', status: 'connected' }],
  }), [{ t: 'ready', servers: ['gmail', 'jarvis'] }])
  assert.deepEqual(m.map({ type: 'system', subtype: 'status' }), [])
  const start = { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'Read', input: {} } } }
  assert.deepEqual(m.map(start), [{ t: 'tool_start', id: 'c1', name: 'Read' }])
  assert.deepEqual(m.map(start), [])
  assert.equal(m.open, true)
  // The whole message still brings the tool_call, with its arguments.
  assert.deepEqual(m.map(toolUse('c1', 'Read', { file_path: '/x' })), [{ t: 'tool_call', id: 'c1', name: 'Read', args: { file_path: '/x' } }])
  // A text block start is not a tool.
  assert.deepEqual(m.map({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } }), [])
})

test('mapper: without partial messages, whole assistant text is used', () => {
  const m = claudeEventMapper()
  assert.deepEqual(m.map({ type: 'assistant', message: { content: [{ type: 'text', text: 'Whole.' }] } }), [{ t: 'text', delta: 'Whole.' }])
})

test('mapper: a tool_use with no object input still gets args', () => {
  const m = claudeEventMapper()
  assert.deepEqual(m.map(toolUse('c1', 'Read', 'oops'))[0].args, {})
})

test('mapper: tool results carry ok, a one-line summary and taint', () => {
  const m = claudeEventMapper({ tainted: (name) => name === 'mcp__gmail__read_email' })
  m.map(toolUse('c1', 'mcp__gmail__read_email', {}))
  m.map(toolUse('c2', 'mcp__gmail__read_email', {}))
  assert.deepEqual(m.map(toolResult('c1', 'Subject: hello\nsecret body')), [
    { t: 'tool_result', id: 'c1', ok: true, summary: 'Subject: hello', tainted: true, detail: 'Subject: hello\nsecret body' },
  ])
  // A refusal is a failure, and nothing private was read.
  assert.deepEqual(m.map(toolResult('c2', 'Blocked.', true)), [
    { t: 'tool_result', id: 'c2', ok: false, summary: 'Blocked.', tainted: false, detail: 'Blocked.' },
  ])
  // The detail is bounded.
  m.map(toolUse('c3', 'Read', {}))
  const [long] = m.map(toolResult('c3', [{ type: 'text', text: 'x'.repeat(5000) }]))
  assert.equal(long.detail.length, 2000)
  assert.ok(checkBrainEvent(long).ok)
})

test('mapper: a successful result is usage then done', () => {
  const m = claudeEventMapper()
  m.begin()
  const out = m.map({
    type: 'result', subtype: 'success', total_cost_usd: 0.004,
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 7 },
  })
  assert.deepEqual(out, [
    { t: 'usage', inTokens: 1015, outTokens: 7, costUsd: 0.004 },
    { t: 'done', reason: 'complete' },
  ])
  assert.equal(m.open, false)
})

test('mapper: failed results say why, and limits end as limit', () => {
  const cases = [
    ['error_max_turns', { t: 'error', code: 'max_turns', retryable: false }, 'limit'],
    ['error_max_budget_usd', { t: 'error', code: 'budget', retryable: false }, 'limit'],
    ['error_during_execution', { t: 'error', code: 'execution', retryable: true }, 'error'],
    ['something_new', { t: 'error', code: 'something_new', retryable: false }, 'error'],
  ]
  for (const [subtype, error, reason] of cases) {
    const m = claudeEventMapper()
    assert.deepEqual(m.map({ type: 'result', subtype }), [error, { t: 'done', reason }])
  }
})

test('mapper: cancel drops text in flight and ends the turn cancelled', () => {
  const m = claudeEventMapper()
  assert.equal(m.cancel(), false, 'nothing to cancel before a turn starts')
  m.begin()
  assert.equal(m.cancel(), true)
  assert.deepEqual(m.map(delta('tail')), [])
  assert.deepEqual(m.map({ type: 'result', subtype: 'error_during_execution' }), [{ t: 'done', reason: 'cancelled' }])
  // The next turn is not cancelled.
  m.begin()
  assert.deepEqual(m.map(delta('next')), [{ t: 'text', delta: 'next' }])
})

test('mapper: the SDK may read the next prompt before this turn ends', () => {
  const m = claudeEventMapper()
  m.begin()
  m.begin()
  m.map({ type: 'result', subtype: 'success' })
  // The second turn is in progress, so it can still be cancelled.
  assert.equal(m.open, true)
  assert.equal(m.cancel(), true)
})

test('mapper: a stream that ends or throws mid-turn still ends the turn', () => {
  const ended = claudeEventMapper()
  assert.deepEqual(ended.end(), [], 'nothing open, nothing to end')
  ended.begin()
  assert.deepEqual(ended.end().map((e) => e.t + ':' + (e.code ?? e.reason)), ['error:ended', 'done:error'])

  const cancelled = claudeEventMapper()
  cancelled.begin()
  cancelled.cancel()
  assert.deepEqual(cancelled.end(), [{ t: 'done', reason: 'cancelled' }])

  const thrown = claudeEventMapper()
  thrown.begin()
  assert.deepEqual(thrown.fail(new Error('socket closed')), [
    { t: 'error', code: 'session_error', retryable: true, message: 'socket closed' },
    { t: 'done', reason: 'error' },
  ])
})

test('converse: turns strings into SDK user messages and passes options through', async () => {
  const { calls, query } = fakeQuery()
  const brain = createClaudeBrain({ query, status: () => ({}), login() {} })
  const run = brain.converse({ prompt: ['one', 'two'], ...base(), tainted: () => true })
  assert.equal(calls[0].options.maxTurns, 24)
  assert.equal('tainted' in calls[0].options, false)
  const sent = []
  for await (const m of calls[0].prompt) sent.push(m)
  assert.deepEqual(sent.map((m) => [m.type, m.message.content, m.parent_tool_use_id]), [['user', 'one', null], ['user', 'two', null]])
  // The fake session is empty: the stream ends with turns still open, so they end in an error.
  const events = []
  for await (const e of run.events) events.push(e)
  assert.deepEqual(events.map((e) => e.t), ['error', 'done'])
  assert.throws(() => brain.converse({ ...base() }), /prompt/)
})

test('converse: a session that throws ends with an error and done', async () => {
  const query = () => ({
    async *[Symbol.asyncIterator]() { throw new Error('boom') },
    interrupt: async () => {}, close() {},
  })
  const run = createClaudeBrain({ query, status: () => ({}), login() {} }).converse({ prompt: 'hi', ...base() })
  const events = []
  for await (const e of run.events) events.push(e)
  assert.deepEqual(events, [
    { t: 'error', code: 'session_error', retryable: true, message: 'boom' },
    { t: 'done', reason: 'error' },
  ])
})
