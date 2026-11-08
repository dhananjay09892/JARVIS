/**
 * Hacker News (task C33): the README's acceptance tests and the vetting pack
 * against a fake API. No network, no account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hackerNewsConnector, HN_HOST, MAX_STORIES, COMMENTS_PER_STORY, parseItem, parseIds, parseCursor } from './hackernews.mjs'
import { createConnectorRegistry, connectorToolName } from './registry.mjs'
import { setupProblems } from './interface.mjs'
import { connectorTestPack, createFakeFetch, captureLog, INJECTION_TEXT, offlineError } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const NOW = Date.parse('2026-11-08T09:00:00Z')
const T = Date.parse('2026-11-08T06:00:00Z') / 1000

function world({ injection, score = 10, stories = [1, 2] } = {}) {
  const items = {}
  for (const id of stories) {
    items[id] = {
      id, type: 'story', by: `user${id}`, time: T + id, title: id === 1 && injection ? injection : `Story ${id}`,
      url: `https://example.com/${id}`, score, descendants: 5, kids: [id * 100 + 1, id * 100 + 2, id * 100 + 3, id * 100 + 4],
    }
    for (const k of items[id].kids) {
      items[k] = { id: k, type: 'comment', by: 'c', time: T + k, parent: id, text: `Nice <i>one</i> &#x27;${k}&#x27;<p>${id === 1 && injection ? injection : 'more'}` }
    }
  }
  items[900] = { id: 900, type: 'story', dead: true, time: T, title: 'dead' }
  return { items, stories }
}

function responder(w) {
  return ({ url }) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/topstories.json') || u.pathname.endsWith('/beststories.json') || u.pathname.endsWith('/newstories.json')) return { body: [...w.stories, 900] }
    const m = /\/item\/(\d+)\.json$/.exec(u.pathname)
    if (m) return { body: w.items[m[1]] ?? null }
    return { status: 404, body: {} }
  }
}

const packFactory = { id: 'hackernews', create: (ctx) => hackerNewsConnector().create(ctx) }
for (const [name, run] of connectorTestPack({
  factory: packFactory,
  respond: ({ url, init, injection }) => responder(world({ injection }))({ url, init }),
  onlyHosts: [HN_HOST],
})) test(name, run)

function setup(w = world(), handler = null) {
  const { fetch, calls } = createFakeFetch(handler ?? ((url, init) => responder(w)({ url, init })))
  const { log } = captureLog()
  const registry = createConnectorRegistry({ fetch, log, sleep: async () => {}, now: () => NOW })
  assert.equal(registry.register(packFactory).ok, true)
  return { registry, calls, w }
}

test('hackernews: registers as a keyless, read-only R0 data connector with a valid card', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'hackernews')
  assert.equal(card.risk, 'R0')
  assert.equal(card.auth, 'none')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'get_stories', capability: 'read' }])
})

test('hackernews: sync yields stories and top comments with correct ids, times and public sensitivity; dead items skipped', async () => {
  const { registry } = setup()
  const r = await registry.sync('hackernews')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 2 + 2 * COMMENTS_PER_STORY)
  const s = r.documents.find((d) => d.id === 'story:1')
  assert.equal(s.title, 'Story 1')
  assert.equal(s.updatedAt, (T + 1) * 1000)
  assert.equal(s.url, 'https://news.ycombinator.com/item?id=1')
  assert.equal(s.sensitivity, 'public')
  assert.ok(isWrapped(s.text))
  assert.ok(!r.documents.some((d) => d.title === 'dead'))
  const c = r.documents.find((d) => d.id === 'comment:101')
  assert.match(c.text, /Nice one '101'/, 'HTML and entities become plain text')
  assert.ok(!r.documents.some((d) => d.id === 'comment:104'), 'only the top-ranked comments')
})

test('hackernews: incremental sync returns only new or edited items, not score changes', async () => {
  const w = world()
  const { registry } = setup(w)
  const one = await registry.sync('hackernews')
  w.items[1].score = 999
  w.items[1].descendants = 77
  const two = await registry.sync('hackernews', { cursor: one.cursor })
  assert.equal(two.documents.length, 0)
  w.items[2].title = 'Story 2 (edited)'
  w.stories.push(3)
  Object.assign(w.items, { 3: { id: 3, type: 'story', by: 'n', time: T, title: 'Story 3', score: 1, kids: [] } })
  const three = await registry.sync('hackernews', { cursor: two.cursor })
  // Comments carry their story's title, so a retitled story refreshes them too.
  assert.deepEqual(three.documents.map((d) => d.id).sort(), ['comment:201', 'comment:202', 'comment:203', 'story:2', 'story:3'])
})

test('hackernews: a garbled or foreign cursor means a fresh sync', async () => {
  assert.deepEqual(parseCursor('{nope').s, {})
  assert.deepEqual(parseCursor(JSON.stringify({ v: 9, s: { 'story:1': 'x' } })).s, {})
  assert.deepEqual(parseCursor(JSON.stringify({ v: 1, s: { evil: 'x', 'story:1': 'abc' } })).s, { 'story:1': 'abc' })
  const { registry } = setup()
  const r = await registry.sync('hackernews', { cursor: '{"v":1,"s":"no"}' })
  assert.equal(r.documents.length, 2 + 2 * COMMENTS_PER_STORY)
})

test('hackernews: parsing is strict about shape and links', () => {
  assert.equal(parseItem({ id: 1, type: 'story', time: 1, title: 'x', url: 'javascript:alert(1)' }).url, null)
  assert.equal(parseItem({ id: 1, type: 'job', time: 1, title: 'x' }), null)
  assert.equal(parseItem({ id: 1, type: 'story', time: 1, title: 'x', deleted: true }), null)
  assert.equal(parseItem({ id: 1, type: 'story', title: 'no time' }), null)
  assert.equal(parseItem(null), null)
  assert.deepEqual(parseIds([1, 'x', -2, 3.5, 4], 10), [1, 4])
  assert.throws(() => parseIds({ nope: 1 }, 5), (e) => e.code === 'bad-response')
})

test('hackernews: it stays within the story cap', async () => {
  const many = Array.from({ length: MAX_STORIES + 20 }, (_, i) => i + 1)
  const w = world({ stories: many })
  const { registry } = setup(w)
  const r = await registry.sync('hackernews')
  assert.equal(r.documents.filter((d) => d.id.startsWith('story:')).length, MAX_STORIES)
})

test('hackernews: a bad list reply fails readably, and offline is reported', async () => {
  const bad = setup(world(), () => ({ body: { not: 'a list' } }))
  assert.equal((await bad.registry.sync('hackernews')).error.code, 'bad-response')
  const off = setup(world(), () => { throw offlineError() })
  assert.equal((await off.registry.sync('hackernews')).error.code, 'offline')
})

test('hackernews: get_stories reads live, wraps what it returns, and picks the list', async () => {
  const { registry, calls } = setup()
  const name = connectorToolName('hackernews', 'read', 'get_stories')
  const r = await registry.callTool(name, { limit: 2, list: 'best' })
  assert.equal(r.isError, undefined, JSON.stringify(r))
  assert.match(JSON.stringify(r), /Story 1/)
  assert.ok(calls.some((c) => c.url.endsWith('/beststories.json')))
  assert.ok(calls.every((c) => c.method === 'GET' && new URL(c.url).hostname === HN_HOST))
  const odd = await registry.callTool(name, { list: '../../user' })
  assert.ok(calls.some((c) => c.url.endsWith('/topstories.json')), 'an unknown list falls back to top')
  assert.equal(odd.isError, undefined)
})

test('hackernews: injected text cannot reach the tool result unwrapped', async () => {
  const { registry } = setup(world({ injection: INJECTION_TEXT }))
  const r = await registry.callTool(connectorToolName('hackernews', 'read', 'get_stories'), {})
  assert.ok(JSON.stringify(r).includes('untrusted_data'))
})
