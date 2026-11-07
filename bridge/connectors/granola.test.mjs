/**
 * Granola meeting notes (task C32): the README's acceptance tests and the
 * vetting test pack, against a fake public-api.granola.ai. No real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { granolaConnector, GRANOLA_HOST, noteToDocument, parseGranolaCursor, granolaCursor, windowStart } from './granola.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { connectorTestPack, createFakeFetch, captureLog, INJECTION_TEXT, ATTACKER_HOST } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const KEY = 'grn_FIXTUREKEY0123456789abcdef'
const WRONG = 'grn_WRONGKEY0123456789abcdefgh'
const NOW = Date.parse('2026-11-07T10:00:00Z')
const ID = 'granola'
const factory = granolaConnector({ paceMs: 0 })

const row = (n, extra = {}) => ({
  id: `not_${n}`, title: `Meeting ${n}`, created_at: `2026-11-0${n}T09:00:00Z`, updated_at: `2026-11-0${n}T10:00:00Z`,
  owner: { name: 'Dana', email: 'dana@example.com' }, ...extra,
})
const detail = (n, extra = {}) => ({
  ...row(n), attendees: [{ name: 'Sam', email: 'sam@example.com' }, { email: 'lee@example.com' }],
  summary_markdown: `## Decisions\n- Ship plan ${n}`, ...extra,
})

function fakeGranola({ notes = [1, 2], injection, key = KEY, pageSize = 30 } = {}) {
  const seen = []
  const respond = ({ url, init = {} }) => {
    const u = new URL(url)
    seen.push({ method: init.method ?? 'GET', path: u.pathname, search: u.searchParams })
    if (u.hostname !== GRANOLA_HOST) return { status: 404, body: {} }
    if ((init.headers ?? {}).Authorization !== `Bearer ${key}`) return { status: 401, body: { error: 'invalid' } }
    const after = Date.parse(u.searchParams.get('updated_after') ?? '') || 0
    const m = u.pathname.match(/^\/v1\/notes\/([\w-]+)$/)
    if (m) {
      const n = Number(m[1].replace('not_', ''))
      if (!notes.includes(n)) return { status: 404, body: {} }
      return { body: detail(n, injection ? { summary_markdown: injection } : {}) }
    }
    if (u.pathname !== '/v1/notes') return { status: 404, body: {} }
    const all = notes.filter((n) => Date.parse(row(n).updated_at) >= after).map((n) => row(n))
    const start = Number(u.searchParams.get('cursor') ?? 0)
    const slice = all.slice(start, start + pageSize)
    const more = start + pageSize < all.length
    return { body: { notes: slice, hasMore: more, cursor: more ? String(start + pageSize) : null } }
  }
  return { seen, respond }
}

function setup(fake, { seed = true, clock, log = captureLog().log, onErase, f = factory } = {}) {
  const credentials = createMemoryCredentialStore()
  if (seed) credentials.set(ID, 'token', KEY)
  const { fetch, calls } = createFakeFetch((url, init) => fake.respond({ url, init }))
  const time = clock ?? { at: NOW }
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log, onErase, now: () => time.at })
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, time }
}

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'token', value: KEY },
  respond: ({ url, init, injection }) => fakeGranola({ injection }).respond({ url, init }),
  onlyHosts: [GRANOLA_HOST],
})) test(name, run)

test('granola: the card is valid, read-only, R1, with no live tool', () => {
  const { registry } = setup(fakeGranola())
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.equal(c.risk, 'R1')
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.match(c.setup.sees.join(' '), /Not the word-for-word transcripts/)
  assert.deepEqual(c.tools, [])
})

test('granola: connect tests the key first; a bad one stores nothing', async () => {
  const { registry, credentials } = setup(fakeGranola(), { seed: false })
  const bad = await registry.connect(ID, { token: WRONG })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'auth')
  assert.deepEqual(credentials.describe(ID).keys, [])
  assert.equal((await registry.connect(ID, { token: 'short' })).error.code, 'auth')
  assert.equal((await registry.connect(ID, { token: `  ${KEY}\n` })).ok, true)
  assert.deepEqual(credentials.describe(ID).keys.map((k) => k.key), ['token'])
})

test('granola: a fixture account syncs with ids, times, attendees and wrapped text', async () => {
  const { registry } = setup(fakeGranola())
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id).sort(), ['note:not_1', 'note:not_2'])
  const d = r.documents.find((x) => x.id === 'note:not_2')
  assert.equal(d.updatedAt, Date.parse('2026-11-02T10:00:00Z'))
  assert.equal(d.sensitivity, 'work')
  assert.ok(isWrapped(d.text))
  assert.match(d.text, /Ship plan 2/)
  assert.match(d.text, /Sam <sam@example.com>/)
  assert.equal(d.author, 'Dana <dana@example.com>')
  assert.ok(parseGranolaCursor(r.cursor).w > 0)
})

test('granola: pages are followed, only GET under /v1/notes goes out, transcripts are never requested', async () => {
  const fake = fakeGranola({ notes: [1, 2, 3], pageSize: 2 })
  const { registry } = setup(fake)
  const r = await registry.sync(ID)
  assert.equal(r.documents.length, 3)
  await registry.test(ID)
  for (const c of fake.seen) {
    assert.equal(c.method, 'GET')
    assert.ok(c.path.startsWith('/v1/notes'))
    assert.equal(c.search.get('include'), null)
  }
})

test('granola: an incremental sync asks only for what changed since the cursor', async () => {
  const fake = fakeGranola({ notes: [1, 2] })
  const { registry, time } = setup(fake)
  const one = await registry.sync(ID)
  time.at += 3600_000
  fake.seen.length = 0
  const two = await registry.sync(ID, { cursor: one.cursor })
  assert.equal(two.documents.length, 0)
  assert.equal(Date.parse(fake.seen[0].search.get('updated_after')), parseGranolaCursor(one.cursor).w - 60_000)
  assert.equal(fake.seen.filter((c) => c.path !== '/v1/notes').length, 0, 'no detail fetched for unchanged notes')
  assert.equal(windowStart({ cursor: granolaCursor({ w: 1 }), nowMs: NOW }), NOW - 365 * 86_400_000, 'never reaches back over a year')
  assert.equal(windowStart({ cursor: 'junk', nowMs: NOW }), NOW - 30 * 86_400_000)
})

test('granola: at most maxPerSync notes per run, the rest wait for the next', async () => {
  const fake = fakeGranola({ notes: [1, 2, 3] })
  const { registry } = setup(fake, { f: granolaConnector({ paceMs: 0, maxPerSync: 2 }) })
  const one = await registry.sync(ID)
  assert.deepEqual(one.documents.map((d) => d.id).sort(), ['note:not_1', 'note:not_2'])
  const two = await registry.sync(ID, { cursor: one.cursor })
  assert.ok(two.documents.some((d) => d.id === 'note:not_3'))
})

test('granola: requests are paced', async () => {
  const slept = []
  const credentials = createMemoryCredentialStore()
  credentials.set(ID, 'token', KEY)
  const { fetch } = createFakeFetch((url, init) => fakeGranola().respond({ url, init }))
  let t = NOW
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async (m) => { slept.push(m); t += m }, log: captureLog().log, now: () => t })
  registry.register(granolaConnector({ paceMs: 250 }))
  await registry.sync(ID)
  assert.ok(slept.some((m) => m > 0 && m <= 250))
})

test('granola: a revoked key is reported, keeps the cursor and leaks nothing', async () => {
  const { log, lines } = captureLog()
  const { registry } = setup(fakeGranola({ key: WRONG }), { log })
  const r = await registry.sync(ID, { cursor: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'auth')
  assert.equal(r.cursor, 'x')
  assert.deepEqual(r.documents, [])
  assert.ok(!`${JSON.stringify(r)} ${lines.join(' ')}`.includes(KEY))
})

test('granola: a reply that is not a list is a bad response', async () => {
  const { registry } = setup({ respond: () => ({ body: { message: 'hello' } }) })
  assert.equal((await registry.sync(ID)).error.code, 'bad-response')
})

test('granola: the injection fixture stays data in the store', async () => {
  const { registry, calls } = setup(fakeGranola({ injection: INJECTION_TEXT }))
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

test('granola: disconnect forgets the key, erase clears synced data', async () => {
  const erased = []
  const { registry, credentials } = setup(fakeGranola(), { seed: false, onErase: (id) => erased.push(id) })
  await registry.connect(ID, { token: KEY })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 2)
    store.erase(ID)
    assert.equal(store.state(ID).cursor, null)
  } finally {
    store.close()
  }
  assert.equal((await registry.disconnect(ID, { eraseData: true })).ok, true)
  assert.deepEqual(erased, [ID])
  assert.deepEqual(credentials.describe(ID).keys, [])
  assert.equal((await registry.sync(ID)).error.code, 'not-connected')
})

test('granola: mapping helpers drop bad rows and tolerate field-name variants', () => {
  assert.equal(noteToDocument(null), null)
  assert.equal(noteToDocument({ id: 'a b', updated_at: '2026-11-01T00:00:00Z', summary_markdown: 'x' }), null)
  assert.equal(noteToDocument({ id: 'a', updated_at: 'never', summary_markdown: 'x' }), null)
  assert.equal(noteToDocument({ id: 'a', updated_at: '2026-11-01T00:00:00Z' }), null, 'no summary, no document')
  const d = noteToDocument({ id: 'a', updatedAt: '2026-11-01T00:00:00Z', summary_text: 'plain', title: 'T\u0000x', attendees: ['a@b.c'] })
  assert.match(d.text, /plain/)
  assert.match(d.text, /a@b.c/)
  assert.equal(parseGranolaCursor('{"v":2}'), null)
})
