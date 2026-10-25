import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { TOOL_DEFS, recordingServerFactory, toolsFromServers } from './sdk-tools.mjs'

// A stand-in for the SDK: `tool()` returns its arguments as a definition and
// `createSdkMcpServer()` an opaque config object, as the real ones do.
const tool = (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler })
const fakeCreate = (options) => ({ type: 'sdk', name: options.name, instance: { opaque: true } })
const create = recordingServerFactory(fakeCreate)

// A stand-in for the zod adapter: a "shape" here is { field: 'string' | 'number' }.
const schema = {
  toJson: (shape) => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: Object.fromEntries(Object.entries(shape).map(([k, t]) => [k, { type: t }])),
    required: Object.keys(shape),
  }),
  parse: (shape, args) => {
    for (const [k, t] of Object.entries(shape)) if (typeof args[k] !== t) throw new Error(`${k}: expected ${t}`)
    return Object.fromEntries(Object.keys(shape).map((k) => [k, args[k]]))
  },
}

test('a recorded server is the SDK server plus its tools, which the SDK never sees', () => {
  const t = tool('greet', 'Say hello.', { who: 'string' }, async () => ({ content: [] }))
  const server = create({ name: 'demo', version: '1.0.0', tools: [t] })
  assert.deepEqual(server, { type: 'sdk', name: 'demo', instance: { opaque: true } })
  assert.deepEqual(Object.keys(server), ['type', 'name', 'instance'])
  assert.deepEqual(server[TOOL_DEFS], [t])
  assert.ok(Object.isFrozen(server[TOOL_DEFS]))
  assert.deepEqual(create({ name: 'empty' })[TOOL_DEFS], [])
  assert.throws(() => recordingServerFactory(null), /needs createSdkMcpServer/)
})

test('tools get the names the Claude brain sees, a JSON Schema and a description', () => {
  const servers = {
    jarvis_tasks: create({ name: 'tasks', tools: [tool('task_status', 'Detail for one task.', { id: 'string' }, async () => ({ content: [] }))] }),
    jarvis_ui: create({ name: 'ui', tools: [tool('ui_reset', 'Back to normal.', {}, async () => ({ content: [] }))] }),
  }
  const { handlers, specs, skipped } = toolsFromServers(servers, { schema, log: null })
  assert.deepEqual(Object.keys(handlers).sort(), ['mcp__jarvis_tasks__task_status', 'mcp__jarvis_ui__ui_reset'])
  assert.deepEqual(specs.mcp__jarvis_tasks__task_status, {
    description: 'Detail for one task.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  })
  assert.deepEqual(skipped, [])
})

test('servers run outside the bridge, and tools with names the API would refuse, are not offered', () => {
  const servers = {
    elevenlabs: { type: 'stdio', command: 'npx', args: ['elevenlabs-mcp'] },
    'bad key!': create({ name: 'x', tools: [tool('t', '', {}, async () => '')] }),
    jarvis: create({
      name: 'hud',
      tools: [
        tool('display', 'Draw a panel.', {}, async () => ''),
        tool('has space', '', {}, async () => ''),
        tool('no_handler', '', {}, null),
        tool('x'.repeat(60), '', {}, async () => ''), // the full name would pass 64 characters
      ],
    }),
  }
  const { handlers, skipped } = toolsFromServers(servers, { schema, log: null })
  assert.deepEqual(Object.keys(handlers), ['mcp__jarvis__display'])
  assert.deepEqual(skipped, ['elevenlabs', 'bad key!'])
  assert.deepEqual(toolsFromServers(undefined).handlers, {})
})

test('a handler checks its arguments first, then returns the content blocks', async () => {
  const calls = []
  const servers = {
    jarvis_tasks: create({
      name: 'tasks',
      tools: [tool('task_status', 'Detail.', { id: 'string' }, async (args, extra) => {
        calls.push([args, extra])
        return { content: [{ type: 'text', text: `task ${args.id}` }] }
      })],
    }),
  }
  const run = toolsFromServers(servers, { schema, log: null }).handlers.mcp__jarvis_tasks__task_status
  assert.deepEqual(await run({ id: 't1', extra: 'dropped' }), [{ type: 'text', text: 'task t1' }])
  assert.deepEqual(calls, [[{ id: 't1' }, {}]])
  await assert.rejects(run({ id: 7 }), /Invalid arguments for task_status: id: expected string/)
  await assert.rejects(run('not an object'), /Invalid arguments/)
  assert.equal(calls.length, 1, 'invalid arguments never reach the handler')
})

test('an error result fails the call, and other returns pass through', async () => {
  const servers = {
    s: create({
      name: 's',
      tools: [
        tool('fails', '', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'Refused: not allowed.' }] })),
        tool('silent_fail', '', {}, async () => ({ isError: true, content: [] })),
        tool('plain', '', {}, async () => 'just text'),
      ],
    }),
  }
  const { handlers } = toolsFromServers(servers, { log: null })
  await assert.rejects(handlers.mcp__s__fails({}), /^Error: Refused: not allowed\.$/)
  await assert.rejects(handlers.mcp__s__silent_fail({}), /silent_fail failed/)
  assert.equal(await handlers.mcp__s__plain({}), 'just text')
})

test('a schema that cannot be converted is offered as a permissive object, and still checked', async () => {
  const warned = []
  const broken = { toJson: () => { throw new Error('unrepresentable') }, parse: schema.parse }
  const servers = { s: create({ name: 's', tools: [tool('t', 'd', { n: 'number' }, async () => 'ok')] }) }
  const { specs, handlers } = toolsFromServers(servers, { schema: broken, log: { warn: (m) => warned.push(m) } })
  assert.deepEqual(specs.mcp__s__t.parameters, { type: 'object', properties: {} })
  assert.match(warned[0], /mcp__s__t: input schema not convertible/)
  await assert.rejects(handlers.mcp__s__t({ n: 'one' }), /Invalid arguments/)
  // No adapter at all: permissive schema, no checking.
  assert.deepEqual(toolsFromServers(servers, { log: null }).specs.mcp__s__t.parameters, { type: 'object', properties: {} })
})

test('every bridge module builds its MCP server through the recording factory', () => {
  const dir = new URL('../', import.meta.url)
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
    const src = readFileSync(new URL(file, dir), 'utf8')
    if (file === 'sdk-server.mjs') continue
    assert.doesNotMatch(src, /import \{[^}]*createSdkMcpServer[^}]*\} from '@anthropic-ai\/claude-agent-sdk'/, `${file} imports the SDK's createSdkMcpServer directly`)
  }
  const shim = readFileSync(new URL('../sdk-server.mjs', import.meta.url), 'utf8')
  assert.match(shim, /export const createSdkMcpServer = recordingServerFactory\(sdkCreateServer\)/)
})
