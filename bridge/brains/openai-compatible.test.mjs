import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPolicy } from '../policy.mjs'
import { createBrainRegistry, POLICY_BYPASS } from './registry.mjs'
import { SCENARIOS, runScenario, runConformance } from './conformance.mjs'
import {
  createOpenAICompatibleBrain, PROFILES, checkBaseUrl, scrub, httpError, sseData, toolDefinitions, TOOL_OUTPUT_MAX,
} from './openai-compatible.mjs'

const KEY = 'sk-test-0123456789abcdef'
const servers = []
after(() => Promise.all(servers.map((s) => new Promise((resolve) => {
  s.closeAllConnections?.()
  s.close(() => resolve())
}))))

/**
 * A stand-in for the OpenAI Chat Completions endpoint that plays a
 * conformance script, over real HTTP and server-sent events, the way the API
 * streams: text in small `delta.content` pieces; tool calls as
 * `delta.tool_calls` with the arguments split across chunks and
 * `finish_reason: 'tool_calls'` (consecutive tool steps become one parallel
 * call); the turn's usage in a last chunk with no choices; then `[DONE]`.
 *
 * A new turn starts whenever the last message is the user's; a request whose
 * last message is a tool result continues the turn where it left off. A
 * `stall` holds the response open until the client goes away.
 *
 * `reply(req, body)` may answer a request itself (for error cases).
 */
async function mockServer(script = [], { reply = null } = {}) {
  const requests = []
  let turn = -1
  let step = 0
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = JSON.parse(raw || '{}')
    requests.push({ url: req.url, auth: req.headers.authorization, body })
    if (reply && (await reply(req, res, body))) return
    if (body.messages?.at(-1)?.role === 'user') {
      turn++
      step = 0
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    const chunk = (delta, finish = null) => send({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })
    const steps = script[turn] ?? []
    let usage = null
    while (step < steps.length) {
      const s = steps[step]
      if (s.say !== undefined) {
        for (const piece of s.say.match(/\S+\s*|\s+/g) ?? []) chunk({ content: piece })
        step++
      } else if (s.tool) {
        const group = []
        while (steps[step]?.tool) group.push(steps[step++].tool)
        group.forEach((t, index) => {
          const args = JSON.stringify(t.args)
          const half = Math.floor(args.length / 2)
          chunk({ tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.name, arguments: '' } }] })
          chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, half) } }] })
          chunk({ tool_calls: [{ index, function: { arguments: args.slice(half) } }] })
        })
        chunk({}, 'tool_calls')
        res.end('data: [DONE]\n\n')
        return
      } else if (s.stall) {
        step = steps.length // the rest of the turn is never sent
        await new Promise((resolve) => res.on('close', resolve))
        return
      } else {
        usage = s.usage
        step++
      }
    }
    chunk({}, 'stop')
    if (usage) send({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: usage.inTokens, completion_tokens: usage.outTokens } })
    res.end('data: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

const openaiBrain = (url, extra = {}) => createOpenAICompatibleBrain({
  profile: PROFILES.openai, overrides: { baseUrl: url }, getKey: () => KEY, hasKey: () => true, log: null, ...extra,
})

/** Tool handlers for a script: each records that it ran, then returns its output or fails. */
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

/** The conformance harness: the brain as the registry hands it out, against the mock server. */
function openaiHarness(state = {}) {
  return async ({ script, policy }) => {
    const mock = await mockServer(script)
    state.mock = mock
    const executed = []
    const brain = createBrainRegistry({ log: null }).register(openaiBrain(mock.url))
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

for (const scenario of SCENARIOS) {
  test(`OpenAI-compatible brain · ${scenario.title}`, async () => {
    await runScenario(scenario, openaiHarness())
  })
}

test('the OpenAI-compatible brain passes the whole suite against the mock server', async () => {
  const rows = await runConformance(openaiHarness(), { capabilities: openaiBrain('http://127.0.0.1:1/v1').capabilities })
  assert.deepEqual(rows.filter((r) => !r.ok), [])
  assert.equal(rows.filter((r) => r.skipped).length, 0, 'a tool brain skips nothing')
})

test('it is a tool-loop brain: tools only through the bridge', () => {
  const b = createBrainRegistry({ log: null }).register(openaiBrain('http://127.0.0.1:1/v1'))
  assert.equal(b.toolMode, 'tool-loop')
  assert.equal(b.capabilities.toolGate, 'loop')
})

test('requests carry the key, the persona, the model and only the tools the policy offers', async () => {
  const state = {}
  const scenario = SCENARIOS.find((s) => s.id === 'write-tools-refused')
  await runScenario(scenario, openaiHarness(state))
  const [first, second] = state.mock.requests
  assert.equal(first.url, '/v1/chat/completions')
  assert.equal(first.auth, `Bearer ${KEY}`)
  assert.equal(first.body.model, 'gpt-test')
  assert.equal(first.body.stream, true)
  assert.deepEqual(first.body.messages[0], { role: 'system', content: 'You are JARVIS.' })
  // With writes off, write and never-list tools are never even offered.
  assert.equal(first.body.tools, undefined)
  // The refusals go back to the model, one tool message per call, ids matching.
  const assistant = second.body.messages.find((m) => m.role === 'assistant')
  const toolMsgs = second.body.messages.filter((m) => m.role === 'tool')
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), assistant.tool_calls.map((c) => c.id))
  assert.ok(toolMsgs.every((m) => m.content.startsWith('Error: ')))
})

test('an allowed tool is offered with its spec', async () => {
  const mock = await mockServer([[{ say: 'ok' }]])
  const brain = createBrainRegistry({ log: null }).register(openaiBrain(mock.url))
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false, audit() {} })
  const run = brain.converse({
    prompt: 'hi', actor: 'voice', policy, tools: { Read: async () => 'x', Bash: async () => 'y' },
    toolSpecs: { Read: { description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
  })
  for await (const e of run.events) if (e.t === 'done') break
  run.close()
  const tools = mock.requests[0].body.tools
  assert.deepEqual(tools.map((t) => t.function.name), ['Read'])
  assert.equal(tools[0].function.description, 'Read a file')
})

test('setModel changes the model from the next turn, never mid-turn (plan 06 phase 2, Q26)', async () => {
  const mock = await mockServer([[{ say: 'one' }], [{ say: 'two' }]])
  const brain = createBrainRegistry({ log: null }).register(openaiBrain(mock.url))
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false, audit() {} })
  const run = brain.converse({ prompt: ['first', 'second'], actor: 'voice', model: 'gpt-deep', policy, tools: {} })
  let dones = 0
  for await (const e of run.events) {
    if (e.t !== 'done') continue
    if (++dones === 1) assert.equal(await run.setModel('gpt-fast'), true)
    else break
  }
  run.close()
  assert.deepEqual(mock.requests.map((r) => r.body.model), ['gpt-deep', 'gpt-fast'])
  assert.equal(await run.setModel(''), false)
})

test('the model gets the whole tool output, the events only the bounded summary', async () => {
  const big = `line one\n${'x'.repeat(5000)}`
  const script = [[{ tool: { id: 'call_1', name: 'Read', args: { file_path: '/a' }, output: big } }, { say: 'Done.' }]]
  const state = {}
  const harness = openaiHarness(state)
  const audit = []
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false, audit: (e) => audit.push(e) })
  const h = await harness({ script, policy })
  const run = h.brain.converse({ prompt: 'read it', ...h.params })
  const events = []
  for await (const e of run.events) {
    events.push(e)
    if (e.t === 'done') break
  }
  run.close()
  const result = events.find((e) => e.t === 'tool_result')
  assert.equal(result.summary, 'line one')
  assert.ok(result.detail.length <= 2000)
  assert.equal(Object.keys(result).includes('content'), false, 'the full output never rides on the event')
  const toolMsg = state.mock.requests[1].body.messages.find((m) => m.role === 'tool')
  assert.equal(toolMsg.content, big)
  assert.ok(big.length < TOOL_OUTPUT_MAX)
})

test('usage is summed over every request in a turn and sent once', async () => {
  let n = 0
  const mock = await mockServer([], {
    reply: async (_req, res) => {
      n++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\r\n\r\n`)
      if (n === 1) {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
      } else {
        send({ choices: [{ index: 0, delta: { content: 'fine' }, finish_reason: 'stop' }] })
      }
      send({ choices: [], usage: { prompt_tokens: 100 * n, completion_tokens: 10 * n } })
      res.end('data: [DONE]\r\n\r\n')
      return true
    },
  })
  const events = await collect(openaiBrain(mock.url), { tools: { Read: async () => 'r' } })
  assert.deepEqual(events.filter((e) => e.t === 'usage').map((e) => [e.inTokens, e.outTokens]), [[300, 30]])
  assert.equal(events.at(-1).reason, 'complete')
})

/** Run one prompt through the brain under the registry, with the real policy (writes off). */
async function collect(rawBrain, { tools = {}, prompt = 'hi', ...params } = {}) {
  const brain = createBrainRegistry({ log: null }).register(rawBrain)
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false, audit() {} })
  const run = brain.converse({ prompt, actor: 'voice', policy, tools, ...params })
  const events = []
  for await (const e of run.events) {
    events.push(e)
    if (e.t === 'done') break
  }
  run.close()
  return events
}

test('a tool loop that never ends stops at the step limit', async () => {
  let n = 0
  const mock = await mockServer([], {
    reply: async (_req, res) => {
      n++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return true
    },
  })
  const events = await collect(openaiBrain(mock.url), { tools: { Read: async () => 'again' }, maxSteps: 3 })
  assert.equal(n, 3)
  assert.equal(events.find((e) => e.t === 'error')?.code, 'max_steps')
  assert.equal(events.at(-1).reason, 'limit')
})

test('a call with arguments that are not JSON is not run, and the model is told', async () => {
  let n = 0
  const ran = []
  const mock = await mockServer([], {
    reply: async (_req, res) => {
      n++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = n === 1
        ? { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'Read', arguments: '{"file_path": ' } }] }
        : { content: 'Sorry.' }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: n === 1 ? 'tool_calls' : 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return true
    },
  })
  const events = await collect(openaiBrain(mock.url), { tools: { Read: async () => { ran.push('Read'); return 'x' } } })
  assert.deepEqual(ran, [])
  assert.equal(events.some((e) => e.t === 'tool_call' || e.t === 'tool_result'), false)
  assert.match(mock.requests[1].body.messages.at(-1).content, /not valid JSON/)
  assert.equal(events.at(-1).reason, 'complete')
})

test('missing or repeated provider call ids are replaced with unique ones', async () => {
  let n = 0
  const mock = await mockServer([], {
    reply: async (_req, res) => {
      n++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = n <= 2
        ? { tool_calls: [{ index: 0, id: 'call_0', function: { name: 'Read', arguments: '{}' } }, { index: 1, function: { name: 'Glob', arguments: '{}' } }] }
        : { content: 'ok' }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: n <= 2 ? 'tool_calls' : 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return true
    },
  })
  const events = await collect(openaiBrain(mock.url), { tools: { Read: async () => 'r', Glob: async () => 'g' } })
  const ids = events.filter((e) => e.t === 'tool_call').map((e) => e.id)
  assert.equal(ids.length, 4)
  assert.equal(new Set(ids).size, 4)
  assert.equal(events.some((e) => e.t === 'error'), false, 'every result was the bridge\'s own')
  assert.equal(events.at(-1).reason, 'complete')
})

test('HTTP errors end the turn with a code, and the key never appears', async () => {
  for (const [status, code, retryable] of [[401, 'auth', false], [429, 'rate_limit', true], [500, 'provider', true], [400, 'request', false]]) {
    const mock = await mockServer([], {
      reply: async (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }))
        return true
      },
    })
    const events = await collect(openaiBrain(mock.url))
    const err = events.find((e) => e.t === 'error')
    assert.equal(err.code, code)
    assert.equal(err.retryable, retryable)
    assert.equal(events.at(-1).reason, 'error')
    assert.doesNotMatch(JSON.stringify(events), /sk-test/)
  }
})

test('no stored key: the turn fails with auth and nothing is sent', async () => {
  const mock = await mockServer([[{ say: 'hi' }]])
  const events = await collect(openaiBrain(mock.url, { getKey: () => null, hasKey: () => false }))
  assert.equal(events.find((e) => e.t === 'error')?.code, 'auth')
  assert.equal(mock.requests.length, 0)
  assert.equal(openaiBrain(mock.url, { hasKey: () => false }).status().authenticated, false)
})

test('a provider that goes quiet times out', async () => {
  const mock = await mockServer([[{ say: 'Hmm' }, { stall: true }]])
  const events = await collect(openaiBrain(mock.url, { timeoutMs: 100 }))
  assert.equal(events.find((e) => e.t === 'error')?.code, 'timeout')
  assert.equal(events.at(-1).reason, 'error')
})

test('a read-only session sends no tools, and a tool the model asks for anyway stops the turn', async () => {
  const mock = await mockServer([[{ tool: { id: 'call_1', name: 'Bash', args: {} } }, { say: 'x' }]])
  const raw = createOpenAICompatibleBrain({
    profile: { ...PROFILES.openai, capabilities: { tools: false } }, overrides: { baseUrl: mock.url }, getKey: () => KEY, log: null,
  })
  const brain = createBrainRegistry({ log: null }).register(raw)
  assert.equal(brain.toolMode, 'read-only')
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false, audit() {} })
  const run = brain.converse({ prompt: 'hi', actor: 'voice', policy, tools: { Bash: async () => 'ran' } })
  const events = []
  for await (const e of run.events) {
    events.push(e)
    if (e.t === 'done') break
  }
  run.close()
  assert.equal(mock.requests[0].body.tools, undefined)
  assert.equal(events.find((e) => e.t === 'error')?.code, POLICY_BYPASS)
})

test('a key is never sent in the clear', () => {
  assert.equal(checkBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  assert.equal(checkBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
  assert.equal(checkBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1')
  assert.throws(() => checkBaseUrl('http://api.example.com/v1'), /https/)
  assert.throws(() => checkBaseUrl('not a url'), /valid URL/)
  assert.throws(() => openaiBrain('http://10.0.0.5/v1'), /https/)
})

test('scrub takes keys out of provider messages', () => {
  assert.equal(scrub(`bad key ${KEY}`, KEY), 'bad key [key]')
  assert.equal(scrub('Incorrect API key provided: sk-proj-abc*****wxyz'), 'Incorrect API key provided: [key]')
})

test('httpError maps statuses', () => {
  assert.deepEqual(httpError(403), { code: 'auth', retryable: false })
  assert.deepEqual(httpError(503), { code: 'provider', retryable: true })
  assert.deepEqual(httpError(404), { code: 'request', retryable: false })
})

test('sseData copes with split chunks, CRLF, comments and junk', async () => {
  const enc = new TextEncoder()
  const body = (async function* () {
    yield enc.encode(': keep-alive\r\n\r\ndata: {"a"')
    yield enc.encode(':1}\r\n\r\ndata: not json\n\ndata: {"b":2}\n')
    yield enc.encode('\ndata: [DONE]\n\ndata: {"c":3}\n\n')
  })()
  const out = []
  for await (const d of sseData(body)) out.push(d)
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }])
})

test('toolDefinitions leaves out names the API would reject', () => {
  const defs = toolDefinitions(['Read', 'mcp__calendar__list_events', 'bad name', 'x'.repeat(65)])
  assert.deepEqual(defs.map((d) => d.function.name), ['Read', 'mcp__calendar__list_events'])
  assert.deepEqual(defs[0].function.parameters, { type: 'object', properties: {} })
})

test('status reports configuration without the key', () => {
  const s = openaiBrain('https://api.openai.com/v1').status()
  assert.deepEqual(s, { installed: true, version: '', authenticated: true, authMode: 'apikey', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' })
  assert.doesNotMatch(JSON.stringify(s), /sk-/)
})
