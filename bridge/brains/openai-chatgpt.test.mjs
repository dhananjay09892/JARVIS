/**
 * The OpenAI profile paid by Sign in with ChatGPT (task Q43): the Responses
 * API wire format, the plan token per request, background consent, and the
 * plan-usage errors. siwc.test.mjs covers the sign-in itself; here a stand-in
 * client hands out tokens so the adapter can be driven end to end.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPolicy } from '../policy.mjs'
import { createBrainRegistry } from './registry.mjs'
import { SCENARIOS, runScenario, runConformance } from './conformance.mjs'
import {
  createOpenAICompatibleBrain, PROFILES, responsesInput, responsesToolDefinitions, responsesError, RESPONSES_ERRORS,
} from './openai-compatible.mjs'
import { SiwcError, MANAGE_USAGE_URL } from './siwc.mjs'

const servers = []
after(() => Promise.all(servers.map((s) => new Promise((resolve) => {
  s.closeAllConnections?.()
  s.close(() => resolve())
}))))

/** A stand-in for the SIWC client: tokens, consent and status, no network. */
function fakeSiwc({ consent = false, signedIn = true, failWith = null } = {}) {
  const calls = []
  let n = 0
  return {
    calls,
    async accessToken({ background = false, force = false } = {}) {
      calls.push({ background, force })
      if (failWith) throw new SiwcError(failWith)
      if (!signedIn) throw new SiwcError('not_signed_in')
      if (background && !consent) throw new SiwcError('consent_needed')
      if (force) n++
      return `plan-token-${n}`
    },
    status: () => ({ signedIn, planUsage: signedIn, backgroundConsent: consent, account: signedIn ? 'tony@example.com' : null }),
  }
}

/**
 * A stand-in for `POST /v1/responses` that plays a conformance script the way
 * the Responses API streams: `response.created`, text as
 * `response.output_text.delta`, each tool call as a `function_call` output
 * item with its arguments in two `response.function_call_arguments.delta`
 * pieces (consecutive tool steps become one response with several calls),
 * then `response.completed` with the usage. A request whose last input item
 * is the user's starts a new turn.
 */
async function mockResponses(script = [], { reply = null } = {}) {
  const requests = []
  let turn = -1
  let step = 0
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = JSON.parse(raw || '{}')
    requests.push({ url: req.url, auth: req.headers.authorization, body })
    if (reply && (await reply(req, res, body, requests.length))) return
    if (body.input?.at(-1)?.role === 'user') {
      turn++
      step = 0
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`)
    send({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } })
    const steps = script[turn] ?? []
    let usage = null
    let index = 0
    const completed = () => send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', ...(usage && { usage: { input_tokens: usage.inTokens, output_tokens: usage.outTokens, total_tokens: usage.inTokens + usage.outTokens } }) } })
    while (step < steps.length) {
      const s = steps[step]
      if (s.say !== undefined) {
        send({ type: 'response.output_item.added', output_index: index, item: { type: 'message', id: `msg_${index}`, role: 'assistant', content: [] } })
        for (const piece of s.say.match(/\S+\s*|\s+/g) ?? []) send({ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: piece })
        index++
        step++
      } else if (s.tool) {
        while (steps[step]?.tool) {
          const t = steps[step++].tool
          const args = JSON.stringify(t.args)
          const half = Math.floor(args.length / 2)
          send({ type: 'response.output_item.added', output_index: index, item: { type: 'function_call', id: `fc_${index}`, call_id: t.id, name: t.name, arguments: '' } })
          send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: `fc_${index}`, delta: args.slice(0, half) })
          send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: `fc_${index}`, delta: args.slice(half) })
          send({ type: 'response.function_call_arguments.done', output_index: index, item_id: `fc_${index}`, arguments: args })
          send({ type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id: `fc_${index}`, call_id: t.id, name: t.name, arguments: args } })
          index++
        }
        completed()
        res.end()
        return
      } else if (s.stall) {
        step = steps.length
        await new Promise((resolve) => res.on('close', resolve))
        return
      } else {
        usage = s.usage
        step++
      }
    }
    completed()
    res.end()
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

const chatgptBrain = (url, siwc = fakeSiwc(), extra = {}) => createOpenAICompatibleBrain({
  profile: PROFILES.openai, auth: 'chatgpt', siwc, overrides: { baseUrl: url }, log: null, ...extra,
})

function handlersFor(script, executed) {
  const tools = {}
  for (const steps of script) {
    for (const s of steps) {
      if (!s.tool) continue
      tools[s.tool.name] = async () => {
        executed.push(s.tool.name)
        if (s.tool.error) throw new Error(s.tool.error)
        return s.tool.output ?? ''
      }
    }
  }
  return tools
}

function chatgptHarness(state = {}) {
  return async ({ script, policy }) => {
    const mock = await mockResponses(script)
    state.mock = mock
    const executed = []
    const brain = createBrainRegistry({ log: null }).register(chatgptBrain(mock.url))
    return {
      brain,
      executed,
      params: {
        actor: 'voice',
        systemPrompt: 'You are JARVIS.',
        model: 'gpt-test',
        policy,
        tools: handlersFor(script, executed),
        guard: async () => null,
        tainted: (name) => name.startsWith('mcp__calendar__'),
      },
    }
  }
}

async function collect(rawBrain, { tools = {}, prompt = 'hi', actor = 'voice', ...params } = {}) {
  const brain = createBrainRegistry({ log: null }).register(rawBrain)
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false, audit() {} })
  const run = brain.converse({ prompt, actor, policy, tools, ...params })
  const events = []
  for await (const e of run.events) {
    events.push(e)
    if (e.t === 'done') break
  }
  run.close()
  return events
}

for (const scenario of SCENARIOS) {
  test(`OpenAI via Sign in with ChatGPT · ${scenario.title}`, async () => {
    await runScenario(scenario, chatgptHarness())
  })
}

test('the ChatGPT-plan brain passes the whole conformance suite against the mock', async () => {
  const rows = await runConformance(chatgptHarness(), { capabilities: chatgptBrain('http://127.0.0.1:1/v1').capabilities })
  assert.deepEqual(rows.filter((r) => !r.ok), [])
  assert.equal(rows.filter((r) => r.skipped).length, 0)
})

test('it is the OpenAI profile, a tool-loop brain, with authMode chatgpt', () => {
  const b = createBrainRegistry({ log: null }).register(chatgptBrain('http://127.0.0.1:1/v1'))
  assert.equal(b.id, 'openai')
  assert.equal(b.toolMode, 'tool-loop')
  const s = b.status()
  assert.equal(s.authMode, 'chatgpt')
  assert.equal(s.authenticated, true)
  assert.equal(s.account, 'tony@example.com')
  assert.equal(s.manageUsageUrl, MANAGE_USAGE_URL)
  assert.doesNotMatch(JSON.stringify(s), /plan-token/)
  assert.equal(chatgptBrain('http://127.0.0.1:1/v1', fakeSiwc({ signedIn: false })).status().authenticated, false)
})

test('requests go to /v1/responses with the plan token, store false, streamed, and the persona as instructions', async () => {
  const state = {}
  await runScenario(SCENARIOS.find((s) => s.id === 'one-tool-call'), chatgptHarness(state))
  const [first, second] = state.mock.requests
  assert.equal(first.url, '/v1/responses')
  assert.equal(first.auth, 'Bearer plan-token-0')
  assert.equal(first.body.store, false)
  assert.equal(first.body.stream, true)
  assert.equal(first.body.model, 'gpt-test')
  assert.equal(first.body.instructions, 'You are JARVIS.')
  assert.equal(first.body.messages, undefined)
  assert.equal(first.body.input.at(-1).role, 'user')
  // The tool round goes back whole (store: false keeps nothing at OpenAI),
  // call and output paired by call id.
  const call = second.body.input.find((i) => i.type === 'function_call')
  const out = second.body.input.find((i) => i.type === 'function_call_output')
  assert.equal(call.call_id, 'call-1')
  assert.equal(out.call_id, 'call-1')
  assert.equal(second.body.instructions, 'You are JARVIS.')
})

test('the API-key mode is untouched: chat completions and the key', async () => {
  const b = createOpenAICompatibleBrain({ profile: PROFILES.openai, getKey: () => 'sk-x', hasKey: () => true, log: null })
  assert.equal(b.status().authMode, 'apikey')
  assert.equal(b.label, 'OpenAI (API key)')
})

test('tools are offered flat, non-strict, and only those the policy offers', async () => {
  const mock = await mockResponses([[{ say: 'ok' }]])
  await collect(chatgptBrain(mock.url), {
    tools: { Read: async () => 'x', Bash: async () => 'y' },
    toolSpecs: { Read: { description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
  })
  const tools = mock.requests[0].body.tools
  assert.deepEqual(tools, [{ type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } }, strict: false }])
  assert.deepEqual(responsesToolDefinitions(['bad name']), [])
})

test('responsesInput maps the history', () => {
  const out = responsesInput([
    { role: 'system', content: 'Persona' },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file text' },
    { role: 'assistant', content: 'Done.' },
  ])
  assert.deepEqual(out, {
    instructions: 'Persona',
    input: [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: 'Looking.' },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file text' },
      { role: 'assistant', content: 'Done.' },
    ],
  })
  assert.equal(responsesInput([{ role: 'user', content: 'x' }]).instructions, undefined)
})

test('a background (worker) turn needs consent; the voice turn does not', async () => {
  const mock = await mockResponses([[{ say: 'ok' }]])
  const siwc = fakeSiwc({ consent: false })
  const events = await collect(chatgptBrain(mock.url, siwc), { actor: 'worker' })
  const err = events.find((e) => e.t === 'error')
  assert.equal(err.code, 'consent_needed')
  assert.equal(mock.requests.length, 0, 'nothing is sent without consent')
  assert.deepEqual(siwc.calls[0], { background: true, force: false })

  const ok = await collect(chatgptBrain(mock.url, fakeSiwc({ consent: true })), { actor: 'worker' })
  assert.equal(ok.at(-1).reason, 'complete')
  const voice = await collect(chatgptBrain(mock.url, fakeSiwc({ consent: false })), { actor: 'voice' })
  assert.equal(voice.at(-1).reason, 'complete')
})

test('not signed in: the turn fails with auth and nothing is sent', async () => {
  const mock = await mockResponses([[{ say: 'hi' }]])
  const events = await collect(chatgptBrain(mock.url, fakeSiwc({ signedIn: false })))
  assert.equal(events.find((e) => e.t === 'error').code, 'auth')
  assert.match(events.find((e) => e.t === 'error').message, /Sign in/)
  assert.equal(mock.requests.length, 0)
})

test('a 401 refreshes the token once and retries once', async () => {
  const mock = await mockResponses([[{ say: 'Back again.' }]], {
    reply: async (_req, res, _body, n) => {
      if (n !== 1) return false
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'token expired' }))
      return true
    },
  })
  const siwc = fakeSiwc()
  const events = await collect(chatgptBrain(mock.url, siwc))
  assert.equal(events.at(-1).reason, 'complete')
  assert.deepEqual(mock.requests.map((r) => r.auth), ['Bearer plan-token-0', 'Bearer plan-token-1'])
  assert.equal(siwc.calls.filter((c) => c.force).length, 1)
})

test('a second 401 ends the turn with auth, no loop', async () => {
  const mock = await mockResponses([], {
    reply: async (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'subscription_sharing_invalid_user', message: 'no' } }))
      return true
    },
  })
  const events = await collect(chatgptBrain(mock.url))
  assert.equal(mock.requests.length, 2)
  assert.equal(events.find((e) => e.t === 'error').code, 'auth')
})

test('plan-usage errors before the stream map to their own codes and never fall back', async () => {
  const cases = [
    [429, 'subscription_sharing_usage_limit_exceeded', 'usage_limit', false],
    [403, 'subscription_sharing_user_not_eligible', 'not_eligible', false],
    [503, 'subscription_sharing_usage_unavailable', 'provider', true],
    [400, 'subscription_sharing_unsupported_capability', 'request', false],
    [403, 'chatpass_v2_scope_not_authorized', 'auth', false],
  ]
  for (const [status, code, want, retryable] of cases) {
    const mock = await mockResponses([], {
      reply: async (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code, message: 'x', param: 'tools[0].web_search' } }))
        return true
      },
    })
    const events = await collect(chatgptBrain(mock.url))
    const err = events.find((e) => e.t === 'error')
    assert.equal(err.code, want, code)
    assert.equal(err.retryable, retryable, code)
    assert.equal(mock.requests.length, 1, `${code}: one request, no retry and no other billing path`)
    assert.equal(events.at(-1).reason, 'error')
  }
})

test('the usage-limit message points at the manage-usage link', () => {
  const e = responsesError({ code: 'subscription_sharing_usage_limit_exceeded' }, 429)
  assert.equal(e.code, 'usage_limit')
  assert.ok(e.message.includes(MANAGE_USAGE_URL))
  assert.match(responsesError({ code: 'subscription_sharing_unsupported_capability', param: 'model' }, 400).message, /: model\.$/)
  assert.deepEqual(responsesError({ detail: 'Direct routing unavailable' }, 503), { code: 'provider', retryable: true, message: 'Direct routing unavailable' })
  assert.ok(Object.keys(RESPONSES_ERRORS).length >= 8)
})

test('a usage limit that arrives mid-stream as response.failed ends the turn', async () => {
  const mock = await mockResponses([], {
    reply: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
      send({ type: 'response.output_text.delta', output_index: 0, delta: 'Let me ' })
      send({ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } })
      res.end()
      return true
    },
  })
  const events = await collect(chatgptBrain(mock.url))
  assert.equal(events.find((e) => e.t === 'error').code, 'usage_limit')
  assert.equal(events.at(-1).reason, 'error')
})

test('a stream that stops before response.completed is a failure', async () => {
  const mock = await mockResponses([], {
    reply: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'Half an' })}\n\n`)
      res.end()
      return true
    },
  })
  const events = await collect(chatgptBrain(mock.url))
  const err = events.find((e) => e.t === 'error')
  assert.equal(err.code, 'stream')
  assert.equal(err.retryable, true)
})

test('response.incomplete for max_output_tokens is a length limit', async () => {
  const mock = await mockResponses([], {
    reply: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'Long' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 9 } } })}\n\n`)
      res.end()
      return true
    },
  })
  const events = await collect(chatgptBrain(mock.url))
  assert.equal(events.find((e) => e.t === 'error').code, 'max_tokens')
  assert.deepEqual(events.filter((e) => e.t === 'usage').map((e) => [e.inTokens, e.outTokens]), [[5, 9]])
  assert.equal(events.at(-1).reason, 'limit')
})

test('the plan token is only ever sent to api.openai.com (or the tests\' loopback mock)', () => {
  assert.ok(createOpenAICompatibleBrain({ profile: PROFILES.openai, auth: 'chatgpt', siwc: fakeSiwc(), log: null }))
  assert.throws(() => chatgptBrain('https://openrouter.ai/api/v1'), /api\.openai\.com/)
  assert.throws(() => createOpenAICompatibleBrain({ profile: { ...PROFILES.openai, id: 'groq', siwc: false }, auth: 'chatgpt', siwc: fakeSiwc() }), /not offered/)
  assert.throws(() => createOpenAICompatibleBrain({ profile: PROFILES.openai, auth: 'chatgpt' }), /sign-in client/)
  assert.throws(() => createOpenAICompatibleBrain({ profile: PROFILES.openai, auth: 'cookie' }), /Unknown brain auth mode/)
})

test('a sign-in failure from the client becomes an auth error without a token in it', async () => {
  const mock = await mockResponses([[{ say: 'hi' }]])
  const events = await collect(chatgptBrain(mock.url, fakeSiwc({ failWith: 'reauth' })))
  const err = events.find((e) => e.t === 'error')
  assert.equal(err.code, 'auth')
  assert.match(err.message, /Sign in again/)
  assert.equal(mock.requests.length, 0)
})
