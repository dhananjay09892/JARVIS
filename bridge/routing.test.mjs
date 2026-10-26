import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PATHS, PATH_REASONS, createRouter, createTurnRouter, routeTurn } from './routing.mjs'
import { createClaudeBrain } from './brains/claude.mjs'
import { createBrainRegistry } from './brains/registry.mjs'
import { createPolicy } from './policy.mjs'

const path = (text, o) => routeTurn(text, o).path

test('small talk goes fast', () => {
  for (const said of [
    'thanks',
    'Thank you so much!',
    'thank you for the help Jarvis',
    'ok',
    'okay cool',
    'got it',
    'hello',
    'good morning',
    'good night Jarvis',
    'how are you',
    'how are you today?',
    "what's your name",
    'who are you',
    'tell me a joke',
    'make me laugh',
    'yes',
    'no thanks',
    'never mind',
    "I'm back",
    'bye',
    'nice one',
    "what's the capital of France",
    'who wrote Hamlet',
  ]) {
    assert.deepEqual(routeTurn(said), { path: 'fast', reason: 'chat' }, said)
  }
})

test('anything that may need a tool goes deep', () => {
  for (const said of [
    'open my email',
    'what is on my calendar tomorrow',
    "what's the weather",
    'search for flights to Delhi',
    'remind me to call mum at six',
    'send a message to Priya',
    'stop my subscription',
    'turn the lights down',
    'what did I say earlier about the trip',
    'what is on my screen',
    'summarise this page',
    'play some music',
    'find the invoice from March',
    'any news today?',
    'look at this',
    'check https://example.com for me',
    'what about example.com',
    'open C:/Users/me/notes',
  ]) {
    assert.deepEqual(routeTurn(said), { path: 'deep', reason: 'tools' }, said)
  }
})

test('questions that need thought go deep', () => {
  for (const said of [
    'why is the sky blue',
    'explain quantum entanglement',
    'how does a transformer work',
    'how much is 17 times 23',
    'what is 17 * 23',
    'compare these two options',
    'should I take the job',
    'what if it rains',
  ]) {
    assert.deepEqual(routeTurn(said), { path: 'deep', reason: 'reasoning' }, said)
  }
})

test('long turns go deep', () => {
  const said = 'so I was thinking about the garden and whether we ought to move the roses to the other side where they would get a bit more sun in the afternoon'
  assert.deepEqual(routeTurn(said), { path: 'deep', reason: 'long' })
})

test('unclear medium-length turns take the safe deep path', () => {
  assert.deepEqual(routeTurn('my sister and her husband are coming over with the kids for dinner'), { path: 'deep', reason: 'default' })
  assert.deepEqual(routeTurn(''), { path: 'deep', reason: 'default' })
  assert.deepEqual(routeTurn('   ?!  '), { path: 'deep', reason: 'default' })
  assert.deepEqual(routeTurn(undefined), { path: 'deep', reason: 'default' })
})

test('a short reply after a tool turn carries the task on, on the deep path', () => {
  assert.deepEqual(routeTurn('yes', { afterTools: true }), { path: 'deep', reason: 'follow-up' })
  assert.deepEqual(routeTurn('the second one', { afterTools: true }), { path: 'deep', reason: 'follow-up' })
  assert.deepEqual(routeTurn('thanks', { afterTools: true }), { path: 'deep', reason: 'follow-up' })
  // Without a tool turn before, the same words are small talk.
  assert.equal(path('yes'), 'fast')
  assert.equal(path('the second one'), 'fast')
})

test('turned off, every turn is deep', () => {
  assert.deepEqual(routeTurn('thanks', { enabled: false }), { path: 'deep', reason: 'off' })
  assert.deepEqual(routeTurn('open my email', { enabled: false }), { path: 'deep', reason: 'off' })
})

test('every result is a known path and reason, never the words', () => {
  for (const said of ['thanks', 'open my mail', 'why', 'hmm', 'x'.repeat(500), 'a '.repeat(40)]) {
    for (const afterTools of [false, true]) {
      for (const enabled of [false, true]) {
        const r = routeTurn(said, { afterTools, enabled })
        assert.ok(PATHS.includes(r.path), said)
        assert.ok(PATH_REASONS.includes(r.reason), said)
        assert.deepEqual(Object.keys(r).sort(), ['path', 'reason'])
      }
    }
  }
})

test('the router remembers whether the last turn used a tool', () => {
  const router = createRouter()
  assert.equal(router.decide('yes').path, 'fast')
  router.turnEnded({ usedTools: true })
  assert.deepEqual(router.decide('yes'), { path: 'deep', reason: 'follow-up' })
  router.turnEnded({ usedTools: false })
  assert.equal(router.decide('yes').path, 'fast')
  assert.deepEqual(router.decide('yes', { enabled: false }), { path: 'deep', reason: 'off' })
})

// -- one live conversation (createTurnRouter) ---------------------------------

const turnRouter = (over = {}) => {
  const switched = []
  let on = true
  let fast = 'claude-sonnet-5'
  const router = createTurnRouter({
    deepModel: 'claude-opus-5',
    fastModel: () => fast,
    enabled: () => on,
    setModel: async (m) => {
      switched.push(m)
      return true
    },
    ...over,
  })
  return { router, switched, turnOff: () => (on = false), setFast: (m) => (fast = m) }
}

test('each turn is routed and the session switches model only when the path changes', async () => {
  const { router, switched, turnOff, setFast } = turnRouter()
  assert.deepEqual(await router.route('thanks'), { path: 'fast', reason: 'chat', model: 'claude-sonnet-5' })
  assert.deepEqual(await router.route('hello'), { path: 'fast', reason: 'chat', model: 'claude-sonnet-5' })
  assert.deepEqual(await router.route('open my email'), { path: 'deep', reason: 'tools', model: 'claude-opus-5' })
  router.turnEnded({ usedTools: true })
  assert.deepEqual(await router.route('yes'), { path: 'deep', reason: 'follow-up', model: 'claude-opus-5' })
  router.turnEnded({ usedTools: false })
  // The fast model is read per turn, so a change in Settings applies at once.
  setFast('claude-haiku-5')
  assert.deepEqual(await router.route('cheers'), { path: 'fast', reason: 'chat', model: 'claude-haiku-5' })
  turnOff()
  assert.deepEqual(await router.route('cheers'), { path: 'deep', reason: 'off', model: 'claude-opus-5' })
  assert.deepEqual(switched, ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5', 'claude-opus-5'])
  assert.equal(router.model, 'claude-opus-5')
})

test('a session that cannot switch keeps its model, and the trace says deep', async () => {
  const logs = []
  const { router } = turnRouter({ setModel: async () => false, log: (m) => logs.push(m) })
  assert.deepEqual(await router.route('thanks'), { path: 'deep', reason: 'default', model: 'claude-opus-5' })
  const throwing = turnRouter({ setModel: async () => { throw new Error('control request failed') }, log: (m) => logs.push(m) })
  assert.deepEqual(await throwing.router.route('thanks'), { path: 'deep', reason: 'default', model: 'claude-opus-5' })
  assert.match(logs.join('\n'), /could not switch to claude-sonnet-5: control request failed/)
})

test('stuck on the fast model, a deep turn is reported as fast rather than lying', async () => {
  let calls = 0
  const { router } = turnRouter({ setModel: async () => ++calls === 1 })
  assert.equal((await router.route('thanks')).model, 'claude-sonnet-5')
  assert.deepEqual(await router.route('open my email'), { path: 'fast', reason: 'default', model: 'claude-sonnet-5' })
})

test('against a mocked Claude session: the fast model answers small talk, the main model the rest', async () => {
  // The SDK session stand-in records setModel calls and which model each user turn reached.
  const reached = []
  let model = null
  const queue = []
  let wake = null
  const brain = createClaudeBrain({
    status: () => ({}),
    login() {},
    query: ({ prompt, options }) => {
      model = options.model
      ;(async () => {
        for await (const m of prompt) reached.push([m.message.content, model])
      })()
      return {
        interrupt: async () => {},
        close() {},
        async setModel(m) { model = m },
        async *[Symbol.asyncIterator]() {},
      }
    },
  })
  const policy = createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false, audit() {} })
  const session = createBrainRegistry({ log: null }).register(brain).converse({
    prompt: (async function* () {
      for (;;) {
        const next = queue.shift() ?? (await new Promise((r) => (wake = r)))
        if (next == null) return
        yield next
      }
    })(),
    actor: 'voice', policy, mcpServers: {}, systemPrompt: 'You are JARVIS.', model: 'claude-opus-5', effort: 'high',
    guard: async () => null, afterTool: async () => ({}),
  })
  const router = createTurnRouter({
    deepModel: 'claude-opus-5', fastModel: () => 'claude-sonnet-5', enabled: () => true,
    setModel: (m) => session.setModel(m),
  })
  const say = async (text) => {
    const r = await router.route(text)
    if (wake) { const w = wake; wake = null; w(text) } else queue.push(text)
    await new Promise((r) => setImmediate(r))
    return r.path
  }
  assert.equal(await say('thanks'), 'fast')
  assert.equal(await say('what is on my calendar today'), 'deep')
  assert.equal(await say('good night'), 'fast')
  wake?.(null)
  assert.deepEqual(reached, [
    ['thanks', 'claude-sonnet-5'],
    ['what is on my calendar today', 'claude-opus-5'],
    ['good night', 'claude-sonnet-5'],
  ])
})

test('the bridge routes on the owner’s own words and tells the page', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(src, /handOver\(id, msg\.text, text\)/, 'routed on msg.text, not the memory-laden prompt')
  assert.match(src, /send\(\{ type: 'route', path, reason, model, ask: id \}\)/)
  assert.match(src, /router\.turnEnded\(\{ usedTools: turnUsedTools \}\)/)
})
