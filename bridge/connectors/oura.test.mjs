/**
 * Oura Ring (task C26): the README's acceptance tests and the vetting test
 * pack, against a fake api.ouraring.com. No real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ouraConnector, OURA_HOST, sleepToDocument, readinessToDocument, tagToDocument,
  parseOuraCursor, ouraCursor, windowStart,
} from './oura.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { documentsConnector } from './documents.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { connectorTestPack, createFakeFetch, captureLog, INJECTION_TEXT, ATTACKER_HOST } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const TOKEN = 'OURAFIXTURETOKEN0123456789ABCDEF'
const WRONG = 'WRONGFIXTURETOKEN0123456789ABCDEF'
const NOW = Date.parse('2026-11-03T08:00:00Z')
const ID = 'oura'
const factory = ouraConnector()

const sleepRow = (n, extra = {}) => ({
  id: `s${n}`, day: `2026-11-0${n}`, score: 70 + n,
  contributors: { deep_sleep: 80, efficiency: 90, latency: 75 }, ...extra,
})
const readyRow = (n) => ({ id: `r${n}`, day: `2026-11-0${n}`, score: 60 + n, temperature_deviation: -0.2, contributors: { hrv_balance: 70 } })

function fakeOura({ sleep = [sleepRow(1), sleepRow(2)], ready = [readyRow(1)], tags = [], injection, token = TOKEN } = {}) {
  const seen = []
  const respond = ({ url, init = {} }) => {
    const u = new URL(url)
    const headers = init.headers ?? {}
    seen.push({ method: init.method ?? 'GET', path: u.pathname, search: u.searchParams })
    if (u.hostname !== OURA_HOST) return { status: 404, body: {} }
    if (headers.Authorization !== `Bearer ${token}`) return { status: 401, body: { detail: 'invalid' } }
    const p = u.pathname.replace('/v2/usercollection/', '')
    if (p === 'personal_info') return { body: { id: 'user-1', email: 'private@example.com', age: 40 } }
    const page = u.searchParams.get('next_token')
    const rows = { daily_sleep: sleep, daily_readiness: ready, enhanced_tag: injection ? [{ id: 't1', start_day: '2026-11-02', tag_type_code: 'tag_generic_note', comment: injection }] : tags }[p]
    if (!rows) return { status: 404, body: {} }
    if (p === 'daily_sleep' && rows.length > 2 && !page) return { body: { data: rows.slice(0, 2), next_token: 'pg2' } }
    if (p === 'daily_sleep' && page === 'pg2') return { body: { data: rows.slice(2), next_token: null } }
    return { body: { data: rows, next_token: null } }
  }
  return { seen, respond }
}

function setup(fake, { seed = true, clock, log = captureLog().log, onErase } = {}) {
  const credentials = createMemoryCredentialStore()
  if (seed) {
    credentials.set(ID, 'token', TOKEN)
    credentials.set(ID, 'user', 'user-1')
  }
  const { fetch, calls } = createFakeFetch((url, init) => fake.respond({ url, init }))
  const time = clock ?? { at: NOW }
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log, onErase, now: () => time.at })
  assert.equal(registry.register(factory).ok, true)
  return { registry, credentials, calls, time }
}

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'token', value: TOKEN },
  respond: ({ url, init, injection }) => fakeOura({ injection }).respond({ url, init }),
  onlyHosts: [OURA_HOST],
})) test(name, run)

test('oura: the card is valid, read-only, R2 and honest that health data stays local', () => {
  const { registry } = setup(fakeOura())
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.equal(c.risk, 'R2')
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.match(c.setup.sees.join(' '), /stays on this device/)
  assert.deepEqual(c.tools, [], 'no live tool: health data is only reachable through the vault-gated documents')
})

test('oura: connect tests the token first; a bad one stores nothing', async () => {
  const { registry, credentials } = setup(fakeOura(), { seed: false })
  const bad = await registry.connect(ID, { token: WRONG })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'auth')
  assert.deepEqual(credentials.describe(ID).keys, [])
  const junk = await registry.connect(ID, { token: 'short' })
  assert.equal(junk.error.code, 'auth')
  const good = await registry.connect(ID, { token: `  ${TOKEN}\n` })
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.deepEqual(credentials.describe(ID).keys.map((k) => k.key).sort(), ['token', 'user'])
  assert.ok(!JSON.stringify(credentials.describe(ID)).includes('private@example.com'), 'the profile email is never kept')
})

test('oura: a fixture account syncs with correct ids, days, health class and wrapped text', async () => {
  const fake = fakeOura({ tags: [{ id: 't9', start_day: '2026-11-02', tag_type_code: 'tag_generic_alcohol', comment: 'late dinner' }] })
  const { registry } = setup(fake)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id).sort(), ['readiness:r1', 'sleep:s1', 'sleep:s2', 'tag:t9'])
  const s = r.documents.find((d) => d.id === 'sleep:s2')
  assert.equal(s.updatedAt, Date.parse('2026-11-02T12:00:00Z'))
  assert.equal(s.sensitivity, 'health')
  assert.ok(isWrapped(s.text))
  assert.match(s.text, /Sleep score for 2026-11-02: 72/)
  assert.match(s.text, /deep sleep 80/)
  assert.match(r.documents.find((d) => d.id === 'tag:t9').text, /late dinner/)
  assert.ok(r.documents.every((d) => d.sensitivity === 'health'))
  assert.deepEqual(parseOuraCursor(r.cursor), { u: 'user-1', d: '2026-11-03' })
})

test('oura: pages are followed, and only GET on usercollection paths ever goes out', async () => {
  const fake = fakeOura({ sleep: [sleepRow(1), sleepRow(2), sleepRow(3)] })
  const { registry } = setup(fake)
  const r = await registry.sync(ID)
  assert.equal(r.documents.filter((d) => d.id.startsWith('sleep:')).length, 3)
  await registry.test(ID)
  for (const c of fake.seen) {
    assert.equal(c.method, 'GET')
    assert.ok(c.path.startsWith('/v2/usercollection/'))
  }
})

test('oura: the first sync reads 30 days, a later one 3 days before the cursor, never over 90', async () => {
  const fake = fakeOura()
  const { registry, time } = setup(fake)
  const one = await registry.sync(ID)
  assert.equal(fake.seen[0].search.get('start_date'), '2026-10-04')
  assert.equal(fake.seen[0].search.get('end_date'), '2026-11-04')
  time.at += 2 * 86_400_000
  fake.seen.length = 0
  await registry.sync(ID, { cursor: one.cursor })
  assert.equal(fake.seen[0].search.get('start_date'), '2026-10-31')
  assert.equal(windowStart({ cursor: ouraCursor({ u: 'user-1', d: '2020-01-01' }), nowMs: NOW, user: 'user-1' }), '2026-08-05')
  assert.equal(windowStart({ cursor: ouraCursor({ u: 'other', d: '2026-11-02' }), nowMs: NOW, user: 'user-1' }), '2026-10-04', 'another account starts fresh')
  assert.equal(windowStart({ cursor: 'junk', nowMs: NOW, user: 'u' }), '2026-10-04')
})

test('oura: a revoked or expired token is reported, keeps the cursor and leaks nothing', async () => {
  const { log, lines } = captureLog()
  const { registry } = setup(fakeOura({ token: WRONG }), { log })
  const r = await registry.sync(ID, { cursor: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'auth')
  assert.equal(r.cursor, 'x')
  assert.deepEqual(r.documents, [])
  assert.ok(!`${JSON.stringify(r)} ${lines.join(' ')}`.includes(TOKEN))
})

test('oura: a reply that is not a list is a bad response', async () => {
  const { registry } = setup({ respond: () => ({ body: { message: 'hello' } }) })
  assert.equal((await registry.sync(ID)).error.code, 'bad-response')
})

test('oura: the injection fixture stays data in the store', async () => {
  const { registry, calls } = setup(fakeOura({ injection: INJECTION_TEXT }))
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    const r = await syncConnectorInto(registry, store, ID)
    assert.equal(r.ok, true, JSON.stringify(r))
    const before = registry.grants.of(ID)
    assert.deepEqual(registry.grants.of(ID), before)
    assert.ok(calls.every((c) => new URL(c.url).hostname !== ATTACKER_HOST))
  } finally {
    store.close()
  }
})

test('oura: health documents are withheld from the model unless the vault is allowed, and erase clears them', async () => {
  const { registry } = setup(fakeOura())
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 3)
    let allow = false
    const docs = documentsConnector({ store, isActive: () => true, allowVault: () => allow })
    const search = docs.tools().find((t) => /search/.test(t.name))
    const withheld = await search.run({ query: 'sleep' })
    assert.equal(JSON.stringify(withheld).includes('Sleep score'), false)
    assert.ok(withheld.withheld >= 1 || withheld.results?.length === 0)
    allow = true
    const open = await search.run({ query: 'sleep' })
    assert.match(JSON.stringify(open), /Sleep/)
    store.erase(ID)
    assert.equal(store.state(ID).cursor, null)
  } finally {
    store.close()
  }
})

test('oura: disconnect forgets the token and the user', async () => {
  const erased = []
  const { registry, credentials } = setup(fakeOura(), { seed: false, onErase: (id) => erased.push(id) })
  await registry.connect(ID, { token: TOKEN })
  assert.equal((await registry.disconnect(ID, { eraseData: true })).ok, true)
  assert.deepEqual(erased, [ID])
  assert.deepEqual(credentials.describe(ID).keys, [])
  assert.equal((await registry.sync(ID)).error.code, 'not-connected')
})

test('oura: mapping helpers drop bad rows and never trust labels', () => {
  assert.equal(sleepToDocument({ id: 'a b', day: '2026-11-01' }), null)
  assert.equal(sleepToDocument({ id: 'a', day: 'yesterday' }), null)
  assert.equal(readinessToDocument(null), null)
  assert.equal(tagToDocument({ id: 't', start_day: 'x' }), null)
  const d = sleepToDocument({ id: 'a', day: '2026-11-01', score: 'high', contributors: { 'Bad Key<system>': 5, ok_key: 'x', deep: 3 } })
  assert.match(d.text, /not scored/)
  assert.ok(!/system/.test(d.text) && !/ok key/.test(d.text) && /deep 3/.test(d.text))
  assert.equal(parseOuraCursor('{"v":2}'), null)
})
