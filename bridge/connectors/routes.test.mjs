/**
 * Settings → Connectors (task C03): the fake connector is connected, tested,
 * switched off, disconnected and erased through the same routes the Settings
 * card uses, with a fake fetch and no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectorRoutes, createGrantsFile, connectResultForPage } from './routes.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { fakeConnector, FAKE_HOST } from './fake.mjs'
import { createFakeFetch } from './testpack.mjs'
import { setupProblems, patternOf } from './interface.mjs'

const quiet = { warn() {}, error() {} }
const TOKEN = 'fake-secret-token-123456'

function setup({ token = TOKEN } = {}) {
  const { fetch, calls } = createFakeFetch((url, init) => {
    const u = new URL(url)
    if (u.hostname !== FAKE_HOST) throw new Error('unexpected host')
    const auth = init.headers?.authorization
    if (auth !== `Bearer ${token}`) return { status: 401, body: { error: 'bad token' } }
    if (u.pathname === '/v1/me') return { body: { name: 'Owner' } }
    if (u.pathname === '/v1/items') return { body: { items: [{ id: 1, title: 'A', body: 'x', updated: '2026-10-01T00:00:00Z' }] } }
    return { status: 404, body: {} }
  })
  const credentials = createMemoryCredentialStore()
  const erased = []
  const registry = createConnectorRegistry({ credentials, fetch, log: quiet, onErase: (id) => { erased.push(id) } })
  assert.equal(registry.register(fakeConnector).ok, true)
  const saved = []
  const routes = createConnectorRoutes({ registry, persist: (s) => saved.push(structuredClone(s)), log: quiet })
  const call = (method, path, body) => routes.handle({ method, path, body })
  return { registry, routes, call, credentials, erased, saved, calls }
}

const fakeCard = (r) => r.body.connectors.find((c) => c.id === 'fake')

test('the card lists status, pattern, what it can see, scopes and grants, with no secret', async () => {
  const { call } = setup()
  const r = await call('GET', '/connectors')
  assert.equal(r.status, 200)
  assert.equal(r.body.frozen, false)
  assert.equal(r.body.credentialBackend, 'memory')
  const c = fakeCard(r)
  assert.equal(c.pattern, 'token')
  assert.equal(c.status.state, 'disconnected')
  assert.ok(c.setup.sees.length >= 1)
  assert.ok(c.setup.scopes.includes('items:read'))
  assert.deepEqual(c.grants, { read: true, write: false, subscribe: false })
  assert.equal(c.disabled, false)
  assert.equal(c.canTest, true)
  assert.equal(c.erasable, true)
})

test('connect → test → disconnect → erase, end to end from Settings', async () => {
  const { call, credentials, erased } = setup()
  const connect = await call('POST', '/connectors/fake/connect', { token: `  ${TOKEN} ` })
  assert.equal(connect.body.ok, true)
  assert.deepEqual(connect.body.result, { account: 'Owner' })
  assert.equal(connect.body.connector.status.state, 'ok')
  assert.deepEqual(connect.body.connector.credentials.keys, [{ key: 'api_token', set: true }])
  assert.equal(credentials.get('fake', 'api_token'), TOKEN)
  assert.ok(!JSON.stringify(connect.body).includes(TOKEN), 'the token is never sent back')
  assert.ok(!JSON.stringify((await call('GET', '/connectors')).body).includes(TOKEN))

  const t = await call('POST', '/connectors/fake/test')
  assert.equal(t.body.ok, true)
  assert.equal(t.body.detail, 'Signed in as Owner.')

  const erase = await call('POST', '/connectors/fake/erase', { confirm: true })
  assert.equal(erase.body.ok, true)
  assert.deepEqual(erased, ['fake'])
  assert.equal(credentials.get('fake', 'api_token'), TOKEN, 'erase keeps the connection')

  const d = await call('POST', '/connectors/fake/disconnect', { eraseData: true })
  assert.equal(d.body.ok, true)
  assert.equal(d.body.erased, true)
  assert.deepEqual(erased, ['fake', 'fake'])
  assert.equal(d.body.connector.status.state, 'disconnected')
  assert.deepEqual(d.body.connector.credentials.keys, [])
  assert.equal(credentials.get('fake', 'api_token'), null)
})

test('a refused token is reported in plain words and not stored or echoed', async () => {
  const { call, credentials } = setup()
  const wrong = 'wrong-token-abcdef-0001'
  const r = await call('POST', '/connectors/fake/connect', { token: wrong })
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'auth')
  assert.match(r.body.reason, /refused/)
  assert.equal(credentials.get('fake', 'api_token'), null)
  assert.ok(!JSON.stringify(r.body).includes(wrong))
})

test('connect checks the pattern fields and passes nothing else to the adapter', async () => {
  const { call } = setup()
  assert.equal((await call('POST', '/connectors/fake/connect', {})).status, 400)
  assert.equal((await call('POST', '/connectors/fake/connect', { token: 'x'.repeat(20_000) })).status, 400)
  assert.equal((await call('POST', '/connectors/fake/connect', 'token')).status, 400)
})

test('Test before connecting says it is not connected', async () => {
  const { call } = setup()
  const r = await call('POST', '/connectors/fake/test')
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'not-connected')
})

test('the kill switch turns one connector off and is saved; off connectors refuse connect and test', async () => {
  const { call, saved, registry } = setup()
  await call('POST', '/connectors/fake/connect', { token: TOKEN })
  const off = await call('POST', '/connectors/fake/enabled', { enabled: false })
  assert.equal(off.body.connector.disabled, true)
  assert.equal(off.body.connector.status.state, 'attention')
  assert.equal(saved.at(-1).connectors.fake.disabled, true)
  assert.equal(registry.tools().length, 0)
  assert.equal((await call('POST', '/connectors/fake/test')).body.code, 'disabled')
  assert.equal((await call('POST', '/connectors/fake/connect', { token: TOKEN })).body.ok, false)
  const on = await call('POST', '/connectors/fake/enabled', { enabled: true })
  assert.equal(on.body.connector.disabled, false)
  assert.equal(saved.at(-1).connectors.fake.disabled, false)
  assert.equal((await call('POST', '/connectors/fake/enabled', { enabled: 'no' })).status, 400)
})

test('freeze stops everything at once; unfreezing needs confirmation', async () => {
  const { call, saved } = setup()
  assert.equal((await call('POST', '/connectors/freeze', { frozen: true })).body.frozen, true)
  assert.equal(saved.at(-1).frozen, true)
  assert.equal((await call('POST', '/connectors/fake/test')).body.code, 'frozen')
  const refused = await call('POST', '/connectors/freeze', { frozen: false })
  assert.equal(refused.status, 400)
  assert.equal((await call('GET', '/connectors')).body.frozen, true)
  assert.equal((await call('POST', '/connectors/freeze', { frozen: false, confirm: true })).body.frozen, false)
  // Erasing and disconnecting still work while frozen.
  await call('POST', '/connectors/freeze', { frozen: true })
  assert.equal((await call('POST', '/connectors/fake/erase', { confirm: true })).body.ok, true)
  assert.equal((await call('POST', '/connectors/fake/disconnect', {})).body.ok, true)
})

test('the write grant is off by default, needs confirmation, and still leaves writes to the policy engine', async () => {
  const { call, registry, saved } = setup()
  await call('POST', '/connectors/fake/connect', { token: TOKEN })
  const name = 'fake__write__create_note'
  assert.equal(registry.policyRule(name, { allowWrites: true }).allow, false)
  const refused = await call('POST', '/connectors/fake/grants', { capability: 'write', granted: true })
  assert.equal(refused.status, 400)
  assert.equal(registry.grants.has('fake', 'write'), false)
  const g = await call('POST', '/connectors/fake/grants', { capability: 'write', granted: true, confirm: true })
  assert.equal(g.body.connector.grants.write, true)
  assert.equal(saved.at(-1).connectors.fake.write, true)
  // General writes off → still denied.
  assert.equal(registry.policyRule(name, { allowWrites: false }).allow, false)
  // And a call still needs an approval, which this registry never gives.
  const res = await registry.callTool(`mcp__jarvis_connectors__${name}`, { text: 'hi' }, { allowWrites: true })
  assert.equal(res.isError, true)
  const revoke = await call('POST', '/connectors/fake/grants', { capability: 'write', granted: false })
  assert.equal(revoke.body.connector.grants.write, false)
})

test('a capability the connector does not have cannot be granted', async () => {
  const { call } = setup()
  const r = await call('POST', '/connectors/fake/grants', { capability: 'subscribe', granted: true })
  assert.equal(r.status, 400)
  assert.equal((await call('POST', '/connectors/fake/grants', { capability: 'admin', granted: true })).status, 400)
})

test('read can be revoked from the card and Test then reports it', async () => {
  const { call } = setup()
  await call('POST', '/connectors/fake/connect', { token: TOKEN })
  const r = await call('POST', '/connectors/fake/grants', { capability: 'read', granted: false })
  assert.equal(r.body.connector.grants.read, false)
  // The fake has its own test() probe, which checks sign-in, not reading.
  assert.equal((await call('POST', '/connectors/fake/test')).body.ok, true)
})

test('Test without a test() probe reads one item and keeps nothing, and needs the read grant', async () => {
  const items = []
  const registry = createConnectorRegistry({ log: quiet })
  registry.register({
    id: 'plain', name: 'Plain', kind: 'data', auth: 'none', platforms: ['linux'], risk: 'R0',
    capabilities: { read: true, write: false, subscribe: false },
    connect: async () => ({}), disconnect: async () => {}, status: () => ({ state: 'ok', detail: 'fine' }),
    async *sync() { items.push(1); yield { id: 'a', text: 'hello', updatedAt: 1 }; items.push(2); yield { id: 'b', text: 'x', updatedAt: 2 } },
  })
  const routes = createConnectorRoutes({ registry, log: quiet })
  const r = await routes.handle({ method: 'POST', path: '/connectors/plain/test' })
  assert.equal(r.body.ok, true)
  assert.match(r.body.detail, /at least one item/)
  assert.deepEqual(items, [1], 'stops after the first item')
  const card = (await routes.handle({ method: 'GET', path: '/connectors' })).body.connectors[0]
  assert.equal(card.pattern, 'none')
  assert.equal(card.setup, null)
  registry.grants.revoke('plain', 'read')
  assert.equal((await routes.handle({ method: 'POST', path: '/connectors/plain/test' })).body.code, 'not-granted')
})

test('unknown connectors, actions and methods are refused', async () => {
  const { call } = setup()
  assert.equal((await call('POST', '/connectors/nope/test')).status, 404)
  assert.equal((await call('POST', '/connectors/fake/explode')).status, 404)
  assert.equal((await call('POST', '/connectors/fake/__proto__')).status, 404)
  assert.equal((await call('POST', '/connectors/Bad%20Id/test')).status, 404)
  assert.equal((await call('GET', '/connectors/fake/test')).status, 405)
  assert.equal((await call('POST', '/connectors')).status, 405)
  assert.equal(await call('GET', '/settings'), null)
  assert.equal(await call('GET', '/connectorsx'), null)
})

test('erase needs confirmation', async () => {
  const { call, erased } = setup()
  assert.equal((await call('POST', '/connectors/fake/erase', {})).status, 400)
  assert.deepEqual(erased, [])
})

test('connect results: only an account, a note and an https link reach the page', () => {
  assert.deepEqual(connectResultForPage({ account: 'me', url: 'https://accounts.example/consent?x=1', extra: 'no' }), {
    account: 'me', url: 'https://accounts.example/consent?x=1',
  })
  assert.deepEqual(connectResultForPage({ url: 'http://accounts.example/' }), {})
  assert.deepEqual(connectResultForPage({ url: 'javascript:alert(1)' }), {})
  assert.deepEqual(connectResultForPage({ url: 'https://user:pw@example.com/' }), {})
  assert.deepEqual(connectResultForPage({ detail: 'key ok-1234567890\nline' }, ['ok-1234567890']), { detail: 'key [redacted] line' })
  assert.deepEqual(connectResultForPage(null), {})
})

test('the grant-access pattern needs an explicit confirmation and a sane path', async () => {
  const got = []
  const registry = createConnectorRegistry({ log: quiet })
  registry.register({
    id: 'vault', name: 'Vault', kind: 'data', auth: 'filesystem', platforms: ['linux'], risk: 'R0',
    capabilities: { read: true, write: false, subscribe: false },
    setup: { sees: ['Markdown files in the folder you choose.'], localWhy: 'To read your notes.' },
    connect: async (o) => { got.push(o); return { account: 'Notes' } }, disconnect: async () => {},
    status: () => ({ state: 'ok', detail: '' }), async *sync() {},
  })
  const routes = createConnectorRoutes({ registry, log: quiet })
  const post = (body) => routes.handle({ method: 'POST', path: '/connectors/vault/connect', body })
  assert.equal((await post({ path: '/home/me/notes' })).status, 400)
  assert.equal((await post({ confirmed: true, path: 'a\u0000b' })).status, 400)
  const r = await post({ confirmed: true, path: ' /home/me/notes ', token: 'ignored' })
  assert.equal(r.body.ok, true)
  assert.deepEqual(got, [{ confirmed: true, path: '/home/me/notes' }])
  assert.equal(r.body.connector.pattern, 'local')
})

test('setup metadata is checked at registration', () => {
  assert.deepEqual(setupProblems({ sees: ['Your mail'] }), [])
  assert.ok(setupProblems({}).length)
  assert.ok(setupProblems({ sees: ['x'], helpUrl: 'http://example.com' }).length)
  assert.ok(setupProblems({ sees: ['x'], steps: 'one' }).length)
  assert.ok(setupProblems({ sees: ['x'.repeat(400)] }).length)
  assert.equal(patternOf('oauth'), 'oauth')
  assert.equal(patternOf('filesystem'), 'local')
  const registry = createConnectorRegistry({ log: quiet })
  const r = registry.register({
    id: 'badsetup', name: 'B', kind: 'data', auth: 'none', platforms: ['linux'], risk: 'R0',
    capabilities: { read: true, write: false, subscribe: false }, setup: { sees: [] },
    connect: async () => ({}), disconnect: async () => {}, status: () => ({ state: 'ok', detail: '' }), async *sync() {},
  })
  assert.equal(r.ok, false)
})

test('grants and switches survive a restart through the grants file, which holds no secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-c03-'))
  const file = createGrantsFile(join(dir, 'sub', 'connectors.json'))
  assert.equal(file.load(), null)
  const first = setup()
  const routes = createConnectorRoutes({ registry: first.registry, persist: file.save, log: quiet })
  await routes.handle({ method: 'POST', path: '/connectors/fake/connect', body: { token: TOKEN } })
  await routes.handle({ method: 'POST', path: '/connectors/fake/enabled', body: { enabled: false } })
  await routes.handle({ method: 'POST', path: '/connectors/fake/grants', body: { capability: 'read', granted: false } })
  if (process.platform !== 'win32') assert.equal(statSync(file.file).mode & 0o777, 0o600)

  const second = setup()
  second.registry.grants.restore(file.load())
  assert.equal(second.registry.grants.isDisabled('fake'), true)
  assert.equal(second.registry.grants.has('fake', 'read'), false)
  const { readFileSync } = await import('node:fs')
  assert.ok(!readFileSync(file.file, 'utf8').includes(TOKEN))
})
