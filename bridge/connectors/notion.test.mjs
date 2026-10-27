/**
 * Notion (task C11): the README's acceptance tests and the vetting test pack
 * (auth failure, revoked secret, injection fixture, rate limit, offline,
 * erase, no writes, kill switches), against a fake Notion API. No real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  notionConnector, NOTION_HOST, NOTION_VERSION, blockLine, propertyText, pageToDocument, parseNotionCursor,
} from './notion.mjs'
import { createConnectorRegistry, connectorToolName } from './registry.mjs'
import { createConnectorRoutes, syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { connectorTestPack, createFakeFetch, captureLog, INJECTION_TEXT, ATTACKER_HOST } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

/** Fixture secrets in Notion's shape; not real. */
const TOKEN = 'ntn_fixture0000000000000000000000000000000000abcd'
const WRONG = 'ntn_wrongfixture00000000000000000000000000000000wxyz'
const NOW = Date.parse('2026-10-27T12:00:00Z')

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
const iso = (min) => new Date(Date.parse('2026-10-20T08:00:00Z') + min * 60_000).toISOString()
const rt = (s) => [{ type: 'text', plain_text: s, text: { content: s } }]

function page(n, { title = `Page ${n}`, edited = n, row = false, trash = false } = {}) {
  return {
    object: 'page',
    id: uuid(n),
    created_time: iso(0),
    last_edited_time: iso(edited),
    in_trash: trash,
    url: `https://www.notion.so/Page-${n}-${uuid(n).replace(/-/g, '')}`,
    parent: row ? { type: 'data_source_id', data_source_id: uuid(900) } : { type: 'workspace', workspace: true },
    properties: row
      ? {
          Name: { type: 'title', title: rt(title) },
          Status: { type: 'status', status: { name: 'In progress' } },
          Due: { type: 'date', date: { start: '2026-11-01' } },
          Tags: { type: 'multi_select', multi_select: [{ name: 'q4' }, { name: 'plan' }] },
        }
      : { title: { type: 'title', title: rt(title) } },
  }
}

const block = (n, type, value, extra = {}) => ({ object: 'block', id: uuid(5000 + n), type, has_children: false, [type]: value, ...extra })

/**
 * A fake api.notion.com. `pages` are the shared pages; `blocks[id]` the
 * children of a page or block. Records every call.
 */
function fakeNotion({ pages = [page(1), page(2), page(3)], trash = [], blocks = {}, injection, pageSize = 100, token = TOKEN } = {}) {
  const seen = []
  const childrenOf = (id) => {
    if (blocks[id]) return blocks[id]
    const n = pages.findIndex((p) => p.id === id)
    if (n < 0) return []
    const text = injection && n === 0 ? injection : `Body of ${pages[n].properties.title?.title?.[0]?.plain_text ?? 'row'}`
    return [block(n * 10, 'paragraph', { rich_text: rt(text) })]
  }
  const respond = ({ url, init = {} }) => {
    const u = new URL(url)
    const headers = init.headers ?? {}
    seen.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : undefined, headers })
    if (u.hostname !== NOTION_HOST) return { status: 404, body: {} }
    if (headers.Authorization !== `Bearer ${token}`) {
      return { status: 401, body: { object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' } }
    }
    if (headers['Notion-Version'] !== NOTION_VERSION) return { status: 400, body: { code: 'missing_version' } }
    if (u.pathname === '/v1/users/me') {
      return { body: { object: 'user', id: uuid(777), type: 'bot', bot: { workspace_name: 'Fixture Workspace' } } }
    }
    if (u.pathname === '/v1/search' && init.method === 'POST') {
      const b = JSON.parse(init.body)
      let list = b.filter?.in_trash ? trash : pages
      if (b.query) list = list.filter((p) => JSON.stringify(p.properties).toLowerCase().includes(b.query.toLowerCase()))
      list = [...list].sort((a, z) => Date.parse(z.last_edited_time) - Date.parse(a.last_edited_time))
      const start = b.start_cursor ? Number(b.start_cursor.split(':')[1]) : 0
      const size = Math.min(b.page_size ?? 100, pageSize)
      const results = list.slice(start, start + size)
      const more = start + size < list.length
      return { body: { object: 'list', results, has_more: more, next_cursor: more ? `c:${start + size}` : null, type: 'page_or_data_source' } }
    }
    let m = /^\/v1\/pages\/([0-9a-f-]+)$/.exec(u.pathname)
    if (m) {
      const p = [...pages, ...trash].find((x) => x.id === m[1])
      return p ? { body: p } : { status: 404, body: { object: 'error', status: 404, code: 'object_not_found' } }
    }
    m = /^\/v1\/blocks\/([0-9a-f-]+)\/children$/.exec(u.pathname)
    if (m) {
      const all = childrenOf(m[1])
      const start = u.searchParams.get('start_cursor') ? Number(u.searchParams.get('start_cursor').split(':')[1]) : 0
      const size = Math.min(Number(u.searchParams.get('page_size') ?? 100), pageSize)
      const results = all.slice(start, start + size)
      const more = start + size < all.length
      return { body: { object: 'list', results, has_more: more, next_cursor: more ? `b:${start + size}` : null } }
    }
    return { status: 404, body: { object: 'error', status: 404, code: 'object_not_found' } }
  }
  return { respond, seen }
}

const factory = notionConnector({ minIntervalMs: 0 })

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'token', value: TOKEN },
  respond: ({ url, init, injection }) => fakeNotion({ injection }).respond({ url, init }),
  onlyHosts: [NOTION_HOST],
})) test(name, run)

function setup(fake = fakeNotion(), { connected = true, opts } = {}) {
  const credentials = createMemoryCredentialStore()
  if (connected) credentials.set('notion', 'token', TOKEN)
  const { fetch, calls } = createFakeFetch((url, init) => fake.respond({ url, init }))
  const { log, lines } = captureLog()
  const sleeps = []
  let clock = NOW
  const registry = createConnectorRegistry({
    credentials, fetch, log, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
  })
  assert.equal(registry.register(opts ? notionConnector({ minIntervalMs: 0, ...opts }) : factory).ok, true)
  return { registry, credentials, calls, lines, sleeps, seen: fake.seen }
}

test('notion: the card is a read-only paste-a-secret connector that explains sharing', () => {
  const { registry } = setup(fakeNotion(), { connected: false })
  const card = registry.list().find((c) => c.id === 'notion')
  assert.equal(card.pattern, 'token')
  assert.equal(card.risk, 'R1')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(setupProblems(card.setup), [])
  assert.ok(card.setup.sees.some((l) => /share with your JARVIS integration/.test(l)), 'the "0 pages" trap is explained')
  assert.ok(card.setup.steps.some((l) => /Connections/.test(l)))
  assert.equal(card.setup.accountLabel, undefined)
  assert.deepEqual(card.tools.map((t) => [t.name, t.capability]), [['search_pages', 'read']])
  assert.equal(card.status.state, 'disconnected')
})

test('notion: connect from Settings stores the secret only after a working test call', async () => {
  const { registry, credentials, lines } = setup(fakeNotion(), { connected: false })
  const routes = createConnectorRoutes({ registry, persist: () => {}, log: { warn() {}, error() {} } })
  const call = (body) => routes.handle({ method: 'POST', path: '/connectors/notion/connect', body })

  const junk = await call({ token: 'not-a-notion-secret-at-all' })
  assert.equal(junk.body.ok, false)
  assert.equal(junk.body.code, 'auth')

  const wrong = await call({ token: WRONG })
  assert.equal(wrong.body.ok, false)
  assert.equal(wrong.body.code, 'auth')
  assert.deepEqual(credentials.describe('notion').keys, [], 'a refused secret stores nothing')

  const ok = await call({ token: `  ${TOKEN} ` })
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body))
  assert.equal(ok.body.result.account, 'Fixture Workspace')
  assert.equal(credentials.get('notion', 'token'), TOKEN)
  assert.equal(ok.body.connector.status.state, 'ok')
  for (const t of [JSON.stringify(junk.body), JSON.stringify(wrong.body), JSON.stringify(ok.body), ...lines]) {
    assert.ok(!t.includes(TOKEN) && !t.includes(WRONG), 'no secret in replies or logs')
  }
})

test('notion: sync a fixture workspace with ids, timestamps, links and block text', async () => {
  const blocks = {
    [uuid(1)]: [
      block(1, 'heading_1', { rich_text: rt('Plan') }),
      block(2, 'bulleted_list_item', { rich_text: rt('First') }, { has_children: true }),
      block(3, 'to_do', { rich_text: rt('Ship it'), checked: true }),
      block(4, 'code', { rich_text: rt('npm test'), language: 'bash' }),
      block(5, 'image', { type: 'file', caption: rt('Diagram') }),
      block(6, 'child_page', { title: 'Sub page' }),
    ],
    [uuid(5002)]: [block(7, 'paragraph', { rich_text: rt('Nested detail') })],
  }
  const { registry, seen } = setup(fakeNotion({ pages: [page(1), page(2, { title: 'Tasks row', row: true })], blocks }))
  const r = await registry.sync('notion')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 2)
  const plan = r.documents.find((d) => d.id === uuid(1))
  assert.equal(plan.title, 'Page 1')
  assert.equal(plan.updatedAt, Date.parse(iso(1)))
  assert.equal(plan.createdAt, Date.parse(iso(0)))
  assert.equal(plan.url, `https://www.notion.so/Page-1-${uuid(1).replace(/-/g, '')}`)
  assert.equal(plan.sensitivity, 'personal')
  assert.equal(plan.untrusted, true)
  assert.ok(isWrapped(plan.text))
  for (const s of ['# Plan', '- First', '  Nested detail', '[x] Ship it', '```bash', '[image: Diagram (not opened)]', '[Page: Sub page]']) {
    assert.ok(plan.text.includes(s), `missing ${s}`)
  }
  const row = r.documents.find((d) => d.id === uuid(2))
  assert.equal(row.title, 'Tasks row')
  assert.match(row.text, /Status: In progress/)
  assert.match(row.text, /Due: 2026-11-01/)
  assert.match(row.text, /Tags: q4, plan/)
  assert.equal(row.meta.parent, 'database')
  // Only read endpoints, every one versioned.
  for (const c of seen) {
    assert.equal(c.headers['Notion-Version'], NOTION_VERSION)
    assert.ok(c.method === 'GET' || (c.method === 'POST' && c.path === '/v1/search'), `${c.method} ${c.path}`)
  }
  const search = seen.find((c) => c.path === '/v1/search')
  assert.deepEqual(search.body.filter, { property: 'object', value: 'page' })
  assert.deepEqual(search.body.sort, { timestamp: 'last_edited_time', direction: 'descending' })
})

test('notion: block pagination is followed and deep pages are bounded', async () => {
  const many = Array.from({ length: 230 }, (_, i) => block(100 + i, 'paragraph', { rich_text: rt(`Line ${i}`) }))
  const { registry } = setup(fakeNotion({ pages: [page(1)], blocks: { [uuid(1)]: many } }))
  const r = await registry.sync('notion')
  assert.equal(r.ok, true)
  assert.match(r.documents[0].text, /Line 0\b/)
  assert.match(r.documents[0].text, /Line 229\b/)

  const huge = Array.from({ length: 1500 }, (_, i) => block(2000 + i, 'paragraph', { rich_text: rt(`L${i}`) }))
  const big = setup(fakeNotion({ pages: [page(1)], blocks: { [uuid(1)]: huge } }))
  const r2 = await big.registry.sync('notion')
  assert.equal(r2.ok, true)
  assert.match(r2.documents[0].text, /page shortened/)
  assert.ok(!r2.documents[0].text.includes('L1200'))
})

test('notion: incremental sync through the store fetches only new or edited pages', async () => {
  const pages = [page(1), page(2), page(3)]
  const fake = fakeNotion({ pages })
  const { registry, seen } = setup(fake, { opts: { maxPerSync: 2 } })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.deepEqual(await syncConnectorInto(registry, store, 'notion'), { ok: true, saved: 2, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'notion'), { ok: true, saved: 1, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'notion'), { ok: true, saved: 0, removed: 0, skipped: 0 })
    // Page 2 edited later; page 4 added.
    pages[1] = page(2, { title: 'Page 2 edited', edited: 50 })
    pages.push(page(4, { edited: 40 }))
    const before = seen.length
    assert.deepEqual(await syncConnectorInto(registry, store, 'notion'), { ok: true, saved: 2, removed: 0, skipped: 0 })
    const fetched = seen.slice(before).filter((c) => c.path.startsWith('/v1/blocks/')).map((c) => c.path.split('/')[3])
    assert.deepEqual(fetched.sort(), [uuid(2), uuid(4)].sort())
    assert.deepEqual(await syncConnectorInto(registry, store, 'notion'), { ok: true, saved: 0, removed: 0, skipped: 0 })
  } finally {
    store.close?.()
  }
})

test('notion: pages trashed or unshared since the last sync leave the store', async () => {
  const pages = [page(1), page(2), page(3)]
  const trash = []
  const fake = fakeNotion({ pages, trash })
  const { registry } = setup(fake, { opts: { maxPerSync: 2 } })
  // First sync: pages 3 and 2; page 1 waits in the cursor.
  const first = await registry.sync('notion')
  assert.deepEqual(first.documents.map((d) => d.id), [uuid(3), uuid(2)])
  // Page 3 goes to the trash (edited later); page 1 is unshared (404).
  trash.push(page(3, { edited: 60, trash: true }))
  pages.splice(0, pages.length, page(2))
  const second = await registry.sync('notion', { cursor: first.cursor })
  assert.equal(second.ok, true, JSON.stringify(second.error))
  assert.deepEqual(second.deleted.map((d) => d.id).sort(), [uuid(1), uuid(3)].sort())
  assert.equal(second.documents.length, 0)
})

test('notion: first sync honours since and the initial cap; the cursor is ours alone', async () => {
  const pages = Array.from({ length: 8 }, (_, i) => page(i + 1, { edited: (i + 1) * 10 }))
  const { registry } = setup(fakeNotion({ pages, pageSize: 3 }), { opts: { maxPerSync: 50, maxInitial: 5 } })
  const r = await registry.sync('notion', { since: Date.parse(iso(35)) })
  assert.equal(r.ok, true)
  assert.deepEqual(r.documents.map((d) => d.id), [8, 7, 6, 5, 4].map(uuid))
  const capped = await setup(fakeNotion({ pages, pageSize: 3 }), { opts: { maxPerSync: 50, maxInitial: 2 } }).registry.sync('notion')
  assert.equal(capped.documents.length, 2)
  assert.equal(parseNotionCursor('{"v":2}'), null)
  assert.equal(parseNotionCursor('not json'), null)
  assert.deepEqual(parseNotionCursor(JSON.stringify({ v: 1, w: 5, e: ['../etc'], p: [uuid(1)] })), { w: 5, e: [], p: [uuid(1)] })
})

test('notion: requests are paced to about 3 a second', async () => {
  const { registry, sleeps } = setup(fakeNotion({ pages: [page(1), page(2)] }), { opts: { minIntervalMs: 340 } })
  const r = await registry.sync('notion')
  assert.equal(r.ok, true)
  // search + 2 block reads; the clock only moves when JARVIS waits.
  assert.deepEqual(sleeps, [340, 340])
})

test('notion: injection fixture in a page title and body is neutralised and changes nothing', async () => {
  const evil = page(1, { title: `Notes ${INJECTION_TEXT.slice(0, 60)}` })
  const fake = fakeNotion({ pages: [evil, page(2)], injection: INJECTION_TEXT })
  const { registry, calls } = setup(fake)
  const before = registry.grants.of('notion')
  const r = await registry.sync('notion')
  assert.equal(r.ok, true)
  const hit = r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.ok(hit)
  for (const d of r.documents) {
    assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
    assert.ok(!/<system>/i.test(d.text))
    assert.ok(!/<\/?(system|untrusted_data)/i.test(d.title))
  }
  assert.deepEqual(registry.grants.of('notion'), before)
  assert.ok(calls.every((c) => new URL(c.url).hostname === NOTION_HOST && new URL(c.url).hostname !== ATTACKER_HOST))
})

test('notion: a revoked secret gives a clear error, no crash, no secret leaked', async () => {
  const { registry, credentials, lines } = setup(fakeNotion())
  credentials.set('notion', 'token', WRONG) // what Notion answers once the integration is removed
  const r = await registry.sync('notion')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'auth')
  assert.match(r.error.message, /Settings/)
  assert.equal(registry.status('notion').state, 'attention')
  for (const t of [JSON.stringify(r), ...lines, JSON.stringify(registry.list())]) assert.ok(!t.includes(WRONG))
})

test('notion: disconnect forgets the secret; the next sync is not-connected', async () => {
  const erased = []
  const credentials = createMemoryCredentialStore()
  credentials.set('notion', 'token', TOKEN)
  const registry = createConnectorRegistry({ credentials, fetch: async () => { throw new Error('no network') }, log: { warn() {}, error() {} }, onErase: (id) => erased.push(id) })
  registry.register(factory)
  const r = await registry.disconnect('notion', { eraseData: true })
  assert.equal(r.ok, true)
  assert.deepEqual(erased, ['notion'])
  assert.deepEqual(credentials.describe('notion').keys, [])
  assert.equal(registry.status('notion').state, 'disconnected')
  assert.equal((await registry.sync('notion')).error.code, 'not-connected')
})

test('notion: the search_pages tool is read-only, bounded and wrapped', async () => {
  const fake = fakeNotion({ pages: [page(1, { title: 'Roadmap 2027' }), page(2, { title: 'Groceries' })] })
  const { registry, seen } = setup(fake)
  const name = connectorToolName('notion', 'read', 'search_pages')
  const tool = registry.tools().find((t) => t.name.endsWith(name))
  assert.ok(tool, 'offered once read is granted')
  assert.equal(tool.readOnly, true)
  const res = await registry.callTool(name, { query: 'roadmap', limit: 50 })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  const text = res.content[0].text
  assert.ok(isWrapped(text))
  assert.match(text, /Roadmap 2027/)
  assert.ok(!/Groceries/.test(text))
  const body = seen.at(-1).body
  assert.equal(body.query, 'roadmap')
  assert.equal(body.page_size, 10, 'limit is capped at 10')
})

test('notion: the Test button explains an integration with nothing shared', async () => {
  const empty = setup(fakeNotion({ pages: [] }))
  const r = await empty.registry.test('notion')
  assert.equal(r.ok, true)
  assert.match(r.detail, /no pages are shared/)
  const full = await setup(fakeNotion()).registry.test('notion')
  assert.match(full.detail, /read-only/)
})

test('notion: mapping helpers', () => {
  assert.equal(blockLine(block(1, 'quote', { rich_text: rt('Wise') })), '> Wise')
  assert.equal(blockLine(block(1, 'divider', {})), '---')
  assert.equal(blockLine(block(1, 'meeting_notes', { title: rt('Standup') })), '[Meeting notes: Standup]')
  assert.equal(blockLine(block(1, 'table_row', { cells: [rt('a'), rt('b')] })), '| a | b |')
  assert.equal(blockLine(block(1, 'column_list', {})), null)
  assert.equal(propertyText({ type: 'checkbox', checkbox: true }), 'yes')
  assert.equal(propertyText({ type: 'formula', formula: { type: 'number', number: 3 } }), '3')
  assert.equal(propertyText({ type: 'people', people: [{ name: 'Ada' }, { name: 'Bo' }] }), 'Ada, Bo')
  assert.equal(propertyText({ type: 'relation', relation: [] }), '')
  assert.equal(pageToDocument({ ...page(1), archived: true }), null, 'pre-2026 "archived" also means trashed')
  assert.equal(pageToDocument({ ...page(1), id: 'nope' }), null)
  assert.equal(pageToDocument(page(1)).text, 'Page 1', 'an empty page still has its title as text')
})
