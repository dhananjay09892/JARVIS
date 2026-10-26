/**
 * A connector's own card settings (task C97): the options store, the
 * POST /connectors/:id/options route (confirm, erase, then save) and the
 * connectors.json part they are kept in. Uses the fake connector with a test
 * definition, and the real Google Drive definition; no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectorOptions } from './options.mjs'
import { createConnectorRoutes, createGrantsFile } from './routes.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { fakeConnector } from './fake.mjs'
import { createFakeFetch } from './testpack.mjs'
import { GDRIVE_OPTIONS } from './gdrive.mjs'

const quiet = { warn() {}, error() {} }
const LINK = 'https://drive.google.com/drive/folders/1AbCdEfGhIjK'

function setup({ initial = null, eraseFails = false } = {}) {
  const { fetch } = createFakeFetch(() => ({ status: 404, body: {} }))
  const erased = []
  const registry = createConnectorRegistry({
    credentials: createMemoryCredentialStore(), fetch, log: quiet,
    onErase: (id) => {
      if (eraseFails) throw new Error('disk full')
      erased.push(id)
    },
  })
  assert.equal(registry.register(fakeConnector).ok, true)
  const persisted = []
  // The fake connector borrows Drive's definition, so the route is tested with the real one.
  const options = createConnectorOptions({ definitions: { fake: GDRIVE_OPTIONS }, initial, persist: (s) => persisted.push(structuredClone(s)), log: quiet })
  const routes = createConnectorRoutes({ registry, options, log: quiet })
  const call = (method, path, body) => routes.handle({ method, path, body })
  return { registry, options, call, erased, persisted }
}

test('options: defaults, a saved file cleaned on load, and a copy every time', () => {
  const o = createConnectorOptions({ definitions: { gdrive: GDRIVE_OPTIONS }, initial: { gdrive: { folders: ['1AbCdEfGhIjK', 'bad id'], sharedDrives: true, extra: 'x' }, other: { a: 1 } } })
  assert.deepEqual(o.get('gdrive'), { folders: ['1AbCdEfGhIjK'], sharedDrives: true })
  assert.equal(o.get('other'), null, 'no definition: no settings')
  o.get('gdrive').folders.push('changed0001')
  assert.deepEqual(o.get('gdrive').folders, ['1AbCdEfGhIjK'], 'callers get a copy')
  assert.deepEqual(createConnectorOptions({ definitions: { gdrive: GDRIVE_OPTIONS } }).get('gdrive'), { folders: [], sharedDrives: false })
  assert.equal(o.view('gdrive').fields.length, 2)
  assert.equal(o.view('nope'), null)
})

test('options route: the card shows the fields and values; other connectors have none', async () => {
  const { call } = setup()
  const r = await call('GET', '/connectors')
  const card = r.body.connectors.find((c) => c.id === 'fake')
  assert.deepEqual(card.options.values, { folders: [], sharedDrives: false })
  assert.deepEqual(card.options.fields.map((f) => [f.key, f.type]), [['folders', 'list'], ['sharedDrives', 'boolean']])

  const bare = createConnectorRoutes({ registry: setup().registry, log: quiet })
  const none = await bare.handle({ method: 'POST', path: '/connectors/fake/options', body: { options: {}, confirm: true } })
  assert.equal(none.status, 400)
  assert.match(none.body.reason, /no settings/)
})

test('options route: a change needs confirm, then erases what the connector kept and saves', async () => {
  const { call, erased, persisted, options } = setup()
  const ask = await call('POST', '/connectors/fake/options', { options: { folders: [LINK] } })
  assert.equal(ask.status, 400)
  assert.match(ask.body.reason, /confirm/)
  assert.deepEqual(erased, [])
  assert.deepEqual(options.get('fake').folders, [], 'nothing changed without confirm')

  const r = await call('POST', '/connectors/fake/options', { options: { folders: [LINK], sharedDrives: true }, confirm: true })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.erased, true)
  assert.deepEqual(erased, ['fake'], 'stored documents and the cursor go, so the next sync starts fresh')
  assert.deepEqual(r.body.connector.options.values, { folders: ['1AbCdEfGhIjK'], sharedDrives: true })
  assert.deepEqual(persisted.at(-1), { fake: { folders: ['1AbCdEfGhIjK'], sharedDrives: true } })

  // The same values again change nothing and erase nothing.
  const same = await call('POST', '/connectors/fake/options', { options: { folders: ['1AbCdEfGhIjK'], sharedDrives: true } })
  assert.equal(same.status, 200)
  assert.equal(same.body.erased, false)
  assert.equal(erased.length, 1)
})

test('options route: bad input is refused in plain words; a failed erase keeps the old settings', async () => {
  const { call } = setup()
  for (const [options, reason] of [
    [{ folders: ['https://evil.example/drive/folders/1AbCdEfGhIjK'] }, /not a Drive folder/],
    [{ folders: 'abc' }, /must be a list/],
    [{ sharedDrives: 1 }, /true or false/],
    ['nope', /object/],
  ]) {
    const r = await call('POST', '/connectors/fake/options', { options, confirm: true })
    assert.equal(r.status, 400)
    assert.match(r.body.reason, reason)
  }
  const failing = setup({ eraseFails: true })
  const r = await failing.call('POST', '/connectors/fake/options', { options: { sharedDrives: true }, confirm: true })
  assert.equal(r.body.ok, false)
  assert.equal(failing.options.get('fake').sharedDrives, false)
})

test('options: connectors.json keeps settings beside grants and document preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-options-'))
  const file = createGrantsFile(join(dir, 'connectors.json'))
  file.save({ connectors: { fake: { read: true } } })
  file.saveDocuments({ allowVault: false })
  file.saveOptions({ gdrive: { folders: ['1AbCdEfGhIjK'], sharedDrives: false } })
  file.save({ connectors: { fake: { read: false } } })
  assert.deepEqual(file.loadOptions(), { gdrive: { folders: ['1AbCdEfGhIjK'], sharedDrives: false } })
  assert.deepEqual(file.loadDocuments(), { allowVault: false })
  assert.deepEqual(file.load(), { connectors: { fake: { read: false } } })
  const o = createConnectorOptions({ definitions: { gdrive: GDRIVE_OPTIONS }, initial: file.loadOptions() })
  assert.deepEqual(o.get('gdrive').folders, ['1AbCdEfGhIjK'])
})
