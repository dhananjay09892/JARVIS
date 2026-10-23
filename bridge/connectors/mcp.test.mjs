/**
 * The jarvis_connectors MCP server (task C02), with stand-ins for the SDK and
 * zod so the test needs no dependency.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectorsServer, paramsShape } from './mcp.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { openDocumentStore } from './store.mjs'
import { documentsConnector } from './documents.mjs'
import { paramProblems, toolProblems } from './interface.mjs'

/** A recording stand-in for zod: each call returns a chainable node that remembers what was asked. */
const zNode = (type) => {
  const n = { type, rules: [] }
  for (const k of ['min', 'max', 'describe']) n[k] = (v) => (n.rules.push([k, v]), n)
  n.optional = () => (n.isOptional = true, n)
  return n
}
const z = { string: () => zNode('string'), number: () => zNode('number'), boolean: () => zNode('boolean') }
const sdk = {
  z,
  tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
  createSdkMcpServer: (o) => o,
}

const NOW = Date.parse('2026-10-23T12:00:00Z')

function setup() {
  const registry = createConnectorRegistry({ log: { warn() {}, error() {} } })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  registry.register({ id: 'documents', create: () => documentsConnector({ store, isActive: () => true }) })
  store.save('notes', [registry.untrustedDocument('notes', { id: 'n1', text: 'Lisbon on Tuesday', updatedAt: NOW, sensitivity: 'personal' })])
  return { registry, store }
}

test('paramsShape turns a params spec into schema calls', () => {
  const shape = paramsShape({
    query: { type: 'string', min: 2, max: 200, description: 'Words' },
    limit: { type: 'number', min: 1, max: 20, optional: true },
    exact: { type: 'boolean', optional: true },
  }, z)
  assert.deepEqual(shape.query.rules, [['min', 2], ['max', 200], ['describe', 'Words']])
  assert.equal(shape.limit.isOptional, true)
  assert.equal(shape.exact.type, 'boolean')
  assert.deepEqual(shape.exact.rules, [])
})

test('the server lists granted connector tools by their registry names and calls through the registry', async () => {
  const { registry } = setup()
  const server = connectorsServer(registry, sdk)
  assert.equal(server.name, 'jarvis_connectors')
  assert.deepEqual(server.tools.map((t) => t.name), ['documents__read__search_documents', 'documents__read__read_document'])
  const res = await server.tools[0].handler({ query: 'lisbon' })
  assert.match(res.content[0].text, /^<untrusted_data source="connector:documents"/)
  assert.match(res.content[0].text, /"id":"n1"/)
})

test('no tools, no server; a frozen registry offers nothing', () => {
  assert.equal(connectorsServer(createConnectorRegistry({ log: { warn() {}, error() {} } }), sdk), null)
  const { registry } = setup()
  registry.grants.freezeAll()
  assert.equal(connectorsServer(registry, sdk), null)
})

test('a tool switched off after the server was built is refused at call time', async () => {
  const { registry } = setup()
  const server = connectorsServer(registry, sdk)
  registry.grants.disable('documents')
  const res = await server.tools[0].handler({ query: 'lisbon' })
  assert.equal(res.isError, true)
})

test('params specs are checked at registration', () => {
  assert.deepEqual(paramProblems({ q: { type: 'string', max: 10 } }), [])
  assert.match(paramProblems({ q: { type: 'string' } })[0], /needs a max/)
  assert.match(paramProblems({ q: { type: 'date' } })[0], /needs a type/)
  assert.match(paramProblems({ 'Bad Name': { type: 'number' } })[0], /bad param name/)
  assert.match(paramProblems([])[0], /must be an object/)
  const t = { name: 'search_x', capability: 'read', description: 'd', run() {}, params: { q: { type: 'string' } } }
  assert.match(toolProblems(t).join(), /needs a max/)
})
