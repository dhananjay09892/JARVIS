/**
 * The documents connector end to end (task C02): the fake connector syncs
 * fixture data through the registry into the store, a brain-side tool call
 * finds it through the policy engine, and kill switches, grants, the vault and
 * erase all hold.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnectorRegistry, connectorMcpName } from './registry.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createFakeFetch, INJECTION_TEXT } from './testpack.mjs'
import { fakeConnector, FAKE_HOST } from './fake.mjs'
import { openDocumentStore } from './store.mjs'
import { documentsConnector, DOCUMENTS_CONNECTOR_ID } from './documents.mjs'
import { createPolicy } from '../policy.mjs'
import { isWrapped } from '../untrusted.mjs'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const quiet = { warn() {}, error() {} }

function respond(url, { injection = false } = {}) {
  const u = new URL(url)
  if (u.hostname !== FAKE_HOST) throw new Error('unexpected host')
  if (u.pathname === '/v1/items') {
    return {
      body: {
        items: [
          { id: 1, title: 'Dentist', body: 'Appointment on Tuesday at 10.', author: 'Clinic', updated: '2026-10-20T09:00:00Z' },
          { id: 2, title: 'Invoice', body: injection ? INJECTION_TEXT : 'Invoice for October, due Tuesday.', updated: '2026-10-21T09:00:00Z' },
        ],
      },
    }
  }
  return { status: 404, body: {} }
}

function setup({ injection = false, allowVault = () => false } = {}) {
  const credentials = createMemoryCredentialStore()
  credentials.set('fake', 'api_token', 'fake-secret-token-123456')
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  const { fetch } = createFakeFetch((url) => respond(url, { injection }))
  const registry = createConnectorRegistry({
    credentials, fetch, log: quiet, now: () => NOW, sleep: async () => {},
    onErase: (id) => { store.erase(id) },
  })
  const isActive = (id) => registry.has(id) && !registry.grants.isFrozen()
    && !registry.grants.isDisabled(id) && registry.grants.has(id, 'read')
  assert.equal(registry.register(fakeConnector).ok, true)
  const r = registry.register({ id: DOCUMENTS_CONNECTOR_ID, create: () => documentsConnector({ store, isActive, allowVault }) })
  assert.equal(r.ok, true, r.error)
  const policy = createPolicy({ allowWrites: false, connectorRule: registry.policyRule })
  const search = (args) => registry.callTool(connectorMcpName('documents', 'read', 'search_documents'), args)
  const read = (args) => registry.callTool(connectorMcpName('documents', 'read', 'read_document'), args)
  const body = (res) => {
    assert.equal(res.isError, undefined, JSON.stringify(res))
    const t = res.content[0].text
    assert.ok(isWrapped(t), 'every result is wrapped as untrusted')
    return JSON.parse(t.replace(/^<untrusted_data[^>]*>\n/, '').replace(/\n<\/untrusted_data>$/, ''))
  }
  return { registry, store, policy, search, read, body }
}

const syncFake = async ({ registry, store }) => store.ingest('fake', await registry.sync('fake'))

test('registers as a read-only tool provider with two read tools', () => {
  const { registry } = setup()
  const d = registry.list().find((c) => c.id === 'documents')
  assert.deepEqual(d.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(d.tools.map((t) => t.name), ['search_documents', 'read_document'])
  const offered = registry.tools().filter((t) => t.name.includes('__documents__'))
  assert.ok(offered.every((t) => t.readOnly))
  assert.equal(offered[0].params.query.type, 'string')
})

test('synced fixture documents are searchable through the policy engine', async () => {
  const s = setup()
  assert.deepEqual(await syncFake(s), { saved: 2, skipped: 0, removed: 0, ok: true })
  const name = connectorMcpName('documents', 'read', 'search_documents')
  assert.equal(s.policy.decideTool(name), true, 'the policy engine allows the granted read')
  const out = s.body(await s.search({ query: 'tuesday' }))
  assert.deepEqual(out.results.map((r) => r.id).sort(), ['1', '2'])
  assert.equal(out.results[0].connector, 'fake')
  const full = s.body(await s.read({ connector: 'fake', id: '1' }))
  assert.equal(full.found, true)
  assert.equal(full.text, 'Appointment on Tuesday at 10.')
})

test('the documents connector cannot write and has no write tool to call', async () => {
  const s = setup()
  assert.throws(() => s.registry.grants.grant('documents', 'write'), /cannot write/)
  const res = await s.registry.callTool('documents__write__search_documents', { query: 'x' }, { allowWrites: true })
  assert.equal(res.isError, true)
})

test('injection fixture comes back as data inside one envelope', async () => {
  const s = setup({ injection: true })
  await syncFake(s)
  const res = await s.read({ connector: 'fake', id: '2' })
  const text = res.content[0].text
  assert.equal((text.match(/<\/untrusted_data>/g) ?? []).length, 1)
  assert.ok(!/<system>/i.test(text))
  assert.ok(text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.deepEqual(s.registry.grants.of('fake'), { read: true, write: false, subscribe: false }, 'nothing was granted')
})

test('turning a source off hides its documents at once, without erasing them', async () => {
  const s = setup()
  await syncFake(s)
  s.registry.grants.disable('fake')
  assert.deepEqual(s.body(await s.search({ query: 'tuesday' })).results, [])
  assert.equal(s.body(await s.read({ connector: 'fake', id: '1' })).found, false)
  assert.equal(s.store.stats().fake.total, 2)
  s.registry.grants.enable('fake')
  assert.equal(s.body(await s.search({ query: 'tuesday' })).results.length, 2)
  s.registry.grants.revoke('fake', 'read')
  assert.deepEqual(s.body(await s.search({ query: 'tuesday' })).results, [])
})

test('the global freeze and the documents kill switch stop the tool itself', async () => {
  const s = setup()
  await syncFake(s)
  s.registry.grants.freezeAll()
  assert.equal((await s.search({ query: 'tuesday' })).isError, true)
  assert.equal(s.policy.decideTool(connectorMcpName('documents', 'read', 'search_documents')), false)
  s.registry.grants.unfreezeAll()
  s.registry.grants.disable('documents')
  assert.equal((await s.search({ query: 'tuesday' })).isError, true)
})

test('health and finance documents stay out unless the owner allows it', async () => {
  for (const allowed of [false, true]) {
    const s = setup({ allowVault: () => allowed })
    s.store.save('fake', [s.registry.untrustedDocument('fake', { id: 'lab', text: 'Blood test on Tuesday', updatedAt: NOW, sensitivity: 'health' })])
    const out = s.body(await s.search({ query: 'blood tuesday' }))
    const read = s.body(await s.read({ connector: 'fake', id: 'lab' }))
    if (allowed) {
      assert.deepEqual(out.results.map((r) => r.id), ['lab'])
      assert.equal(read.found, true)
    } else {
      assert.deepEqual(out.results, [])
      assert.equal(out.withheld, 1)
      assert.match(out.note, /stay on this device/)
      assert.equal(read.found, false)
      assert.ok(!JSON.stringify(read).includes('Blood'))
    }
  }
})

test('Disconnect → Erase data erases the stored documents', async () => {
  const s = setup()
  await syncFake(s)
  const r = await s.registry.disconnect('fake', { eraseData: true })
  assert.equal(r.erased, true)
  assert.equal(s.store.stats().fake, undefined)
  assert.equal(s.store.state('fake').cursor, null)
})

test('documents from an unregistered connector are never returned', async () => {
  const s = setup()
  s.store.save('ghost', [s.registry.untrustedDocument('ghost', { id: 'g', text: 'Tuesday ghost', updatedAt: NOW, sensitivity: 'personal' })])
  assert.deepEqual(s.body(await s.search({ query: 'tuesday ghost' })).results, [])
  assert.equal(s.body(await s.read({ connector: 'ghost', id: 'g' })).found, false)
})

test('bad input is answered, not thrown', async () => {
  const s = setup()
  assert.match(s.body(await s.search({ query: ' ' })).note, /what to look for/)
  assert.match(s.body(await s.search({ query: 'tuesday' })).note, /No connected source/)
  assert.equal(s.body(await s.read({ connector: 'Bad Id', id: 'x' })).found, false)
  assert.equal(s.body(await s.read({})).found, false)
})

test('a throwing isActive hides everything rather than failing open', async () => {
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  const registry = createConnectorRegistry({ log: quiet })
  store.save('fake', [registry.untrustedDocument('fake', { id: '1', text: 'Tuesday', updatedAt: NOW, sensitivity: 'personal' })])
  registry.register({ id: 'documents', create: () => documentsConnector({ store, isActive: () => { throw new Error('boom') } }) })
  const res = await registry.callTool('documents__read__search_documents', { query: 'tuesday' })
  assert.ok(res.content[0].text.includes('"results":[]'))
})
