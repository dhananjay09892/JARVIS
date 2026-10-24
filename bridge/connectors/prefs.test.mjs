/**
 * Task C95: the vault switch and retention controls on Settings → Connectors.
 * They survive a restart (connectors.json beside settings, no secrets), and
 * take effect in the document store and the documents tools. Plus the plan 16
 * connector-health metric. Fixtures only; no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectorRegistry, connectorMcpName } from './registry.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createFakeFetch } from './testpack.mjs'
import { fakeConnector } from './fake.mjs'
import { openDocumentStore, DEFAULT_RETENTION_DAYS } from './store.mjs'
import { documentsConnector, DOCUMENTS_CONNECTOR_ID } from './documents.mjs'
import { createDocumentPrefs, normaliseDocumentPrefs } from './prefs.mjs'
import { createConnectorRoutes, createGrantsFile, connectorHealth } from './routes.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-24T12:00:00Z')
const quiet = { warn() {}, error() {} }
const TOKEN = 'fake-secret-token-123456'

/**
 * One bridge "run" over a directory: the store file, connectors.json, the
 * registry with the fake and documents connectors, and the routes — wired the
 * way server.mjs wires them. Calling it twice on one dir is a restart.
 */
function boot(dir, { now = () => NOW } = {}) {
  const file = createGrantsFile(join(dir, 'connectors.json'))
  const saved = normaliseDocumentPrefs(file.loadDocuments())
  const store = openDocumentStore({ dir, now, retentionDays: saved.classes })
  const prefs = createDocumentPrefs({ store, initial: saved, persist: file.saveDocuments, log: quiet })
  const credentials = createMemoryCredentialStore()
  credentials.set('fake', 'api_token', TOKEN)
  const { fetch } = createFakeFetch(() => ({ status: 404, body: {} }))
  const registry = createConnectorRegistry({ credentials, fetch, log: quiet, now, onErase: (id) => { store.erase(id) } })
  assert.equal(registry.register(fakeConnector).ok, true)
  const isActive = (id) => registry.has(id) && !registry.grants.isFrozen()
    && !registry.grants.isDisabled(id) && registry.grants.has(id, 'read')
  assert.equal(registry.register({
    id: DOCUMENTS_CONNECTOR_ID,
    create: () => documentsConnector({ store, isActive, allowVault: () => prefs.allowVault() }),
  }).ok, true)
  registry.grants.restore(file.load())
  const routes = createConnectorRoutes({ registry, persist: file.save, documents: prefs, log: quiet })
  const call = (method, path, body) => routes.handle({ method, path, body })
  const tool = async (name, args) => {
    const res = await registry.callTool(connectorMcpName('documents', 'read', name), args)
    assert.equal(res.isError, undefined, JSON.stringify(res))
    return JSON.parse(res.content[0].text.replace(/^<untrusted_data[^>]*>\n/, '').replace(/\n<\/untrusted_data>$/, ''))
  }
  const put = (raw) => store.save('fake', [registry.untrustedDocument('fake', { sensitivity: 'personal', updatedAt: NOW, ...raw })])
  return { file, store, prefs, registry, routes, call, tool, put, close: () => store.close() }
}

function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-c95-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('saved preferences are cleaned: nothing a hand-edited file says can widen by accident', () => {
  assert.deepEqual(normaliseDocumentPrefs(null), { allowVault: false, classes: {}, connectors: {} })
  assert.deepEqual(
    normaliseDocumentPrefs({
      allowVault: 'yes',
      classes: { personal: 30, nonsense: 5, health: 0, work: 1.5, messages: 99999 },
      connectors: { fake: 7, 'Bad Id!': 7, notion: -1 },
    }),
    { allowVault: false, classes: { personal: 30 }, connectors: { fake: 7 } },
  )
})

test('the card shows the vault switch (off), retention per class and a document count', withDir(async (dir) => {
  const b = boot(dir)
  b.put({ id: 'a', text: 'alpha' })
  b.put({ id: 'b', text: 'beta', sensitivity: 'health' })
  const r = await b.call('GET', '/connectors')
  assert.equal(r.body.documents.available, true)
  assert.equal(r.body.documents.allowVault, false)
  assert.deepEqual(r.body.documents.retention.classes, { ...DEFAULT_RETENTION_DAYS })
  const fake = r.body.connectors.find((c) => c.id === 'fake')
  assert.deepEqual(fake.documents, { count: 2, classes: { personal: 1, health: 1 }, retentionDays: null })
  assert.equal(r.body.connectors.find((c) => c.id === 'documents').documents, null, 'the documents connector keeps none of its own')
  b.close()
}))

test('the vault switch needs confirmation, reaches the documents tools at once, and survives a restart', withDir(async (dir) => {
  const first = boot(dir)
  first.put({ id: 'lab', text: 'Blood test on Tuesday', sensitivity: 'health' })
  assert.equal((await first.tool('search_documents', { query: 'blood tuesday' })).withheld, 1)

  const refused = await first.call('POST', '/connectors/vault', { allow: true })
  assert.equal(refused.status, 400)
  assert.equal(first.prefs.allowVault(), false)
  assert.equal((await first.call('POST', '/connectors/vault', { allow: 'yes', confirm: true })).status, 400)

  const on = await first.call('POST', '/connectors/vault', { allow: true, confirm: true })
  assert.equal(on.body.ok, true)
  assert.equal(on.body.documents.allowVault, true)
  assert.deepEqual((await first.tool('search_documents', { query: 'blood tuesday' })).results.map((x) => x.id), ['lab'])
  assert.equal((await first.tool('read_document', { connector: 'fake', id: 'lab' })).found, true)
  first.close()

  const second = boot(dir)
  assert.equal(second.prefs.allowVault(), true, 'kept across a restart')
  assert.equal((await second.tool('read_document', { connector: 'fake', id: 'lab' })).found, true)

  // Turning it off never needs confirmation, and is kept too.
  assert.equal((await second.call('POST', '/connectors/vault', { allow: false })).body.ok, true)
  assert.equal((await second.tool('read_document', { connector: 'fake', id: 'lab' })).found, false)
  second.close()
  const third = boot(dir)
  assert.equal(third.prefs.allowVault(), false)
  third.close()
}))

test('a shorter class retention asks first, prunes the store at once, and survives a restart', withDir(async (dir) => {
  const first = boot(dir)
  first.put({ id: 'old', text: 'old note', updatedAt: NOW - 40 * DAY })
  first.put({ id: 'new', text: 'new note', updatedAt: NOW - 2 * DAY })

  assert.equal((await first.call('POST', '/connectors/retention', { class: 'personal', days: 30 })).status, 400)
  assert.ok(first.store.get('fake', 'old'), 'nothing deleted without confirmation')
  assert.equal((await first.call('POST', '/connectors/retention', { class: 'nonsense', days: 30, confirm: true })).status, 400)
  assert.equal((await first.call('POST', '/connectors/retention', { class: 'personal', days: 0, confirm: true })).status, 400)

  const r = await first.call('POST', '/connectors/retention', { class: 'personal', days: 30, confirm: true })
  assert.equal(r.body.ok, true)
  assert.equal(r.body.removed, 1)
  assert.equal(r.body.documents.retention.classes.personal, 30)
  assert.equal(first.store.get('fake', 'old'), null)
  assert.ok(first.store.get('fake', 'new'))
  // A longer time does not need confirmation.
  assert.equal((await first.call('POST', '/connectors/retention', { class: 'messages', days: 365 })).body.ok, true)
  first.close()

  // After a restart the shorter time still holds: a document that slipped in
  // (say, from a sync) older than 30 days is pruned on open.
  const second = boot(dir)
  assert.equal(second.prefs.classDays('personal'), 30)
  assert.equal(second.store.retention().classes.personal, 30)
  assert.equal(second.store.retention().classes.messages, 365)
  second.put({ id: 'stale', text: 'stale', updatedAt: NOW - 31 * DAY })
  second.store.prune()
  assert.equal(second.store.get('fake', 'stale'), null)

  // Going back to the default (longer) needs no confirmation.
  assert.equal((await second.call('POST', '/connectors/retention', { class: 'personal', days: null })).body.ok, true)
  assert.equal(second.store.retention().classes.personal, DEFAULT_RETENTION_DAYS.personal)
  second.close()
  const third = boot(dir)
  assert.equal(third.prefs.classDays('personal'), DEFAULT_RETENTION_DAYS.personal)
  third.close()
}))

test('a longer class retention set by the owner is honoured by the first prune after a restart', withDir(async (dir) => {
  const first = boot(dir)
  assert.equal((await first.call('POST', '/connectors/retention', { class: 'personal', days: 730 })).body.ok, true)
  first.put({ id: 'keep', text: 'two-year-old note', updatedAt: NOW - 500 * DAY })
  first.close()
  const second = boot(dir)
  assert.ok(second.store.get('fake', 'keep'), 'not pruned by the 365-day default on open')
  second.close()
}))

test('per-connector retention asks before deleting, survives erase and restart, and can go back to the classes', withDir(async (dir) => {
  const first = boot(dir)
  first.put({ id: 'old', text: 'old', updatedAt: NOW - 10 * DAY })
  first.put({ id: 'new', text: 'new', updatedAt: NOW - DAY })

  assert.equal((await first.call('POST', '/connectors/fake/retention', { days: 7 })).status, 400)
  assert.equal((await first.call('POST', '/connectors/fake/retention', { days: 'week', confirm: true })).status, 400)
  assert.equal((await first.call('POST', '/connectors/documents/retention', { days: 7, confirm: true })).status, 400, 'the documents connector keeps none')

  const r = await first.call('POST', '/connectors/fake/retention', { days: 7, confirm: true })
  assert.equal(r.body.ok, true)
  assert.equal(r.body.removed, 1)
  assert.equal(r.body.connector.documents.retentionDays, 7)
  assert.deepEqual(r.body.connector.documents.classes, { personal: 1 })
  // Longer than the current own time: no confirmation needed.
  assert.equal((await first.call('POST', '/connectors/fake/retention', { days: 14 })).body.ok, true)

  // Erase data deletes documents, not the owner's retention choice.
  assert.equal((await first.call('POST', '/connectors/fake/erase', { confirm: true })).body.ok, true)
  assert.equal(first.store.retention().connectors.fake, 14)
  first.close()

  const second = boot(dir)
  assert.equal(second.prefs.connectorDays('fake'), 14)
  assert.equal(second.store.retention().connectors.fake, 14)
  const card = (await second.call('GET', '/connectors')).body.connectors.find((c) => c.id === 'fake')
  assert.deepEqual(card.documents, { count: 0, classes: {}, retentionDays: 14 })
  // Going back to the class defaults may delete, so it asks too.
  assert.equal((await second.call('POST', '/connectors/fake/retention', { days: null })).status, 400)
  assert.equal((await second.call('POST', '/connectors/fake/retention', { days: null, confirm: true })).body.ok, true)
  assert.deepEqual(second.store.retention().connectors, {})
  second.close()
  const third = boot(dir)
  assert.equal(third.prefs.connectorDays('fake'), null)
  third.close()
}))

test('grants and document preferences share connectors.json without overwriting each other, and hold no secret', withDir(async (dir) => {
  const b = boot(dir)
  await b.call('POST', '/connectors/vault', { allow: true, confirm: true })
  await b.call('POST', '/connectors/fake/connect', { token: TOKEN })
  await b.call('POST', '/connectors/fake/enabled', { enabled: false })
  await b.call('POST', '/connectors/retention', { class: 'work', days: 730 })
  const saved = JSON.parse(readFileSync(b.file.file, 'utf8'))
  assert.equal(saved.v, 1)
  assert.equal(saved.documents.allowVault, true)
  assert.equal(saved.documents.classes.work, 730)
  assert.equal(saved.grants.connectors.fake.disabled, true)
  assert.ok(!readFileSync(b.file.file, 'utf8').includes(TOKEN))
  b.close()
  const again = boot(dir)
  assert.equal(again.registry.grants.isDisabled('fake'), true)
  assert.equal(again.prefs.allowVault(), true)
  again.close()
}))

test('without a document store the controls say so and change nothing', async () => {
  const registry = createConnectorRegistry({ log: quiet })
  const prefs = createDocumentPrefs({ store: null, log: quiet })
  const routes = createConnectorRoutes({ registry, documents: prefs, log: quiet })
  const list = await routes.handle({ method: 'GET', path: '/connectors' })
  assert.equal(list.body.documents.available, false)
  for (const [path, body] of [['/connectors/vault', { allow: true, confirm: true }], ['/connectors/retention', { class: 'personal', days: 7, confirm: true }]]) {
    const r = await routes.handle({ method: 'POST', path, body })
    assert.equal(r.status, 409)
  }
  assert.equal(prefs.allowVault(), false)
  // And with no prefs object at all (older wiring) GET still works.
  const bare = await createConnectorRoutes({ registry, log: quiet }).handle({ method: 'GET', path: '/connectors' })
  assert.equal(bare.body.documents, null)
})

test('plan 16 connector health counts cards in attention or error', withDir(async (dir) => {
  assert.deepEqual(connectorHealth([
    { id: 'a', status: { state: 'ok' } },
    { id: 'b', status: { state: 'attention' } },
    { id: 'c', status: { state: 'error' }, disabled: true },
    { id: 'd', status: { state: 'disconnected' } },
  ], { frozen: true }), {
    total: 4, ok: 1, attention: 1, error: 1, disconnected: 1, off: 1, needsAttention: 2, ids: ['b', 'c'], frozen: true,
  })
  assert.equal(connectorHealth([]).needsAttention, 0)

  const b = boot(dir)
  const h = (await b.call('GET', '/connectors')).body.health
  assert.equal(h.total, 2)
  assert.equal(h.needsAttention, 0)
  assert.equal(h.frozen, false)
  b.close()
}))
