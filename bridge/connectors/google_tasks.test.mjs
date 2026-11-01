/**
 * Google Tasks connector (task C19): the shared connector test pack plus
 * Tasks' own acceptance tests — full and incremental sync by updatedMin,
 * hidden and deleted tasks (deletion markers, task C96), old completions
 * skipped, the page budget carried in the cursor, the read-only tool, and
 * disconnect revoking. Google is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  googleTasksConnector, taskToDocument, taskListEntry, dueDate, parseTasksCursor, tasksCursor, GTASKS_HOST,
} from './google_tasks.mjs'
import { createGoogleClient, GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPES } from './google-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry, connectorToolName, connectorMcpName } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'
import { openDocumentStore } from './store.mjs'

const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com'
const REFRESH = '1//gtasks-refresh-token-abcdefghijklmnopqrstuvwxyz'
const ACCESS = 'ya29.gtasks-access-abcdefghijklmnop'
const NOW = Date.parse('2026-11-01T12:00:00Z')

function googleClient() {
  const c = createGoogleClient(createMemoryCredentialStore().scoped(GOOGLE_CLIENT_ID))
  c.save({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-gtasks-test-secret' })
  return c
}

function task(id, { title = `Task ${id}`, ...rest } = {}) {
  return {
    kind: 'tasks#task',
    id,
    title,
    updated: '2026-10-30T08:00:00.000Z',
    status: 'needsAction',
    webViewLink: `https://tasks.google.com/task/${id}`,
    ...rest,
  }
}

const LISTS = [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Shopping' }, { id: 'bad id', title: 'Nope' }]

/**
 * A fake Google Tasks. `pages[listId]` is the full listing as pages of tasks;
 * `changes[listId]` is the list of tasks returned when updatedMin is sent.
 */
function fakeTasks({
  lists = LISTS,
  pages = { L1: [[task('a1', { due: '2026-11-01T00:00:00.000Z' }), task('a2')]], L2: [[task('s1')]] },
  changes = {},
  injection,
  seen = { lists: [], revokes: 0, refreshes: 0 },
} = {}) {
  const respond = ({ url, init }) => {
    if (url === GOOGLE_TOKEN_URL) {
      seen.refreshes++
      return { body: { access_token: ACCESS, expires_in: 3599, scope: GOOGLE_SCOPES.google_tasks.join(' '), token_type: 'Bearer' } }
    }
    if (url === GOOGLE_REVOKE_URL) {
      seen.revokes++
      return { status: 200, body: '' }
    }
    const u = new URL(url)
    assert.equal(u.hostname, GTASKS_HOST)
    assert.equal(init.headers.authorization, `Bearer ${ACCESS}`)
    const path = u.pathname.replace('/tasks/v1', '')
    if (path === '/users/@me/lists') return { body: { kind: 'tasks#taskLists', items: lists } }
    const m = /^\/lists\/([^/]+)\/tasks$/.exec(path)
    if (m) {
      const list = decodeURIComponent(m[1])
      const q = Object.fromEntries(u.searchParams)
      seen.lists.push({ list, ...q })
      assert.equal(q.showHidden, 'true', 'tasks completed in Google apps are hidden')
      assert.ok(Number(q.maxResults) <= 100)
      if (q.updatedMin) {
        assert.equal(q.showDeleted, 'true')
        const items = changes[list] ?? []
        return { body: { items } }
      }
      const pl = pages[list] ?? [[]]
      const i = Number(q.pageToken ?? 0)
      let items = pl[i] ?? []
      if (injection && list === 'L1' && i === 0) {
        items = [task('inj', { title: `Do: ${injection.slice(0, 40)}`, notes: injection }), ...items]
      }
      return { body: { items, ...(i + 1 < pl.length ? { nextPageToken: String(i + 1) } : {}) } }
    }
    return { status: 404, body: { error: { code: 404 } } }
  }
  return { respond, seen }
}

const factory = googleTasksConnector({ googleClient: googleClient() })

// The shared pack: untrusted sync, injection, auth failure, revoked, rate limit, offline, erase, writes, kill switches.
for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeTasks({ injection }).respond({ url, init }),
  onlyHosts: [GTASKS_HOST, 'oauth2.googleapis.com'],
})) test(name, run)

function setup(fake = fakeTasks(), opts = {}, now = () => NOW) {
  const credentials = createMemoryCredentialStore()
  credentials.set('google_tasks', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => fake.respond({ url, init }))
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log, now })
  const f = googleTasksConnector({ googleClient: googleClient(), utcOffsetMinutes: () => 0, ...opts })
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, lines, seen: fake.seen }
}

const body = (res) => {
  const text = res.content[0].text
  assert.match(text, /^<untrusted_data/)
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
}

test('google_tasks: card is read-only Google sign-in with only tasks.readonly', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'google_tasks')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['https://www.googleapis.com/auth/tasks.readonly'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'list_tasks', capability: 'read' }])
  assert.throws(() => googleTasksConnector({}), /shared Google client/)
})

test('google_tasks: full sync maps tasks to documents with ids, due days and a per-list watermark', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('google_tasks')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['L1/a1', 'L1/a2', 'L2/s1'])
  const d = r.documents[0]
  assert.equal(d.title, 'Task a1')
  assert.equal(d.updatedAt, Date.parse('2026-10-30T08:00:00.000Z'))
  assert.equal(d.sensitivity, 'personal')
  assert.equal(d.url, 'https://tasks.google.com/task/a1')
  assert.match(d.text, /Status: to do/)
  assert.match(d.text, /Due: 2026-11-01 \(a day, no time\)/)
  assert.match(d.text, /List: My Tasks/)
  assert.equal(d.meta.due, '2026-11-01')
  // Full sync: no updatedMin, no deleted tasks, hidden ones included.
  const first = seen.lists.find((l) => l.list === 'L1')
  assert.equal(first.updatedMin, undefined)
  assert.equal(first.showDeleted, 'false')
  assert.equal(first.showCompleted, 'true')
  assert.equal(first.maxResults, '100')
  assert.deepEqual(parseTasksCursor(r.cursor).l, { L1: { u: NOW - 120_000 }, L2: { u: NOW - 120_000 } })
  assert.ok(!seen.lists.some((l) => l.list === 'bad id'), 'a list with an odd id is never read')
})

test('google_tasks: incremental sync sends updatedMin and turns deleted tasks into deletions', async () => {
  const changes = { L1: [task('a3', { title: 'New one' }), task('a1', { deleted: true })], L2: [] }
  const { registry, seen } = setup(fakeTasks({ changes }))
  const since = NOW - 3_600_000
  const r = await registry.sync('google_tasks', { cursor: tasksCursor({ l: { L1: { u: since }, L2: { u: since } } }) })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['L1/a3'])
  assert.deepEqual(r.deleted, [{ connectorId: 'google_tasks', id: 'L1/a1' }])
  assert.ok(seen.lists.every((l) => l.updatedMin === new Date(since).toISOString() && l.showDeleted === 'true'))
  assert.deepEqual(parseTasksCursor(r.cursor).l, { L1: { u: NOW - 120_000 }, L2: { u: NOW - 120_000 } })
})

test('google_tasks: a deleted task synced incrementally leaves the document store (C96)', async () => {
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  const full = await setup().registry.sync('google_tasks')
  assert.equal(full.ok, true, JSON.stringify(full.error))
  store.ingest('google_tasks', full)
  assert.ok(store.get('google_tasks', 'L1/a2'))
  const later = () => NOW + 3_600_000
  const inc = await setup(fakeTasks({ changes: { L1: [task('a2', { deleted: true })] } }), {}, later)
    .registry.sync('google_tasks', { cursor: store.state('google_tasks').cursor })
  assert.equal(inc.ok, true, JSON.stringify(inc.error))
  assert.equal(store.ingest('google_tasks', inc).removed, 1)
  assert.equal(store.get('google_tasks', 'L1/a2'), null)
  assert.ok(store.get('google_tasks', 'L1/a1'), 'other tasks stay')
  store.close()
})

test('google_tasks: completed tasks are kept for 90 days on a full sync, older ones are skipped', async () => {
  const pages = {
    L1: [[
      task('done-new', { status: 'completed', completed: '2026-10-20T10:00:00.000Z', hidden: true }),
      task('done-old', { status: 'completed', completed: '2026-03-01T10:00:00.000Z' }),
      task('done-nodate', { status: 'completed' }),
    ]],
  }
  const { registry } = setup(fakeTasks({ lists: [LISTS[0]], pages }))
  const r = await registry.sync('google_tasks')
  assert.deepEqual(r.documents.map((d) => d.id), ['L1/done-new'])
  assert.match(r.documents[0].text, /Status: done\nCompleted: 2026-10-20T10:00:00.000Z/)
  assert.equal(r.documents[0].meta.hidden, true)
})

test('google_tasks: a page budget stops the sync and the cursor resumes with the same updatedMin', async () => {
  const pages = { L1: [[task('p1')], [task('p2')], [task('p3')]], L2: [[task('s1')]] }
  const { registry, seen } = setup(fakeTasks({ pages }), { maxPagesPerSync: 2 })
  const r1 = await registry.sync('google_tasks')
  assert.deepEqual(r1.documents.map((d) => d.id), ['L1/p1', 'L1/p2'])
  assert.deepEqual(parseTasksCursor(r1.cursor).l, { L1: { p: '2', r: NOW - 120_000 }, L2: {} })
  const later = () => NOW + 60_000
  const second = setup(fakeTasks({ pages }), { maxPagesPerSync: 2 }, later)
  const r2 = await second.registry.sync('google_tasks', { cursor: r1.cursor })
  assert.deepEqual(r2.documents.map((d) => d.id), ['L1/p3', 'L2/s1'])
  // The resumed list keeps the first run's start as its watermark.
  assert.deepEqual(parseTasksCursor(r2.cursor).l, { L1: { u: NOW - 120_000 }, L2: { u: NOW + 60_000 - 120_000 } })
  assert.equal(second.seen.lists[0].pageToken, '2')
  assert.equal(second.seen.lists[0].updatedMin, undefined, 'a full listing in progress stays a full listing')
  assert.ok(seen.lists.length === 2)
})

test('google_tasks: lists that vanish or are removed drop out of the cursor', async () => {
  const fake = fakeTasks({ lists: [LISTS[0], LISTS[1]] })
  const respond = ({ url, init }) => (url.includes('/lists/L2/tasks') ? { status: 404, body: { error: { code: 404 } } } : fake.respond({ url, init }))
  const { registry } = setup({ respond, seen: fake.seen })
  const r = await registry.sync('google_tasks', { cursor: tasksCursor({ l: { L9: { u: 1 } } }) })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(Object.keys(parseTasksCursor(r.cursor).l), ['L1'])
})

test('google_tasks: a cursor that is not ours means a fresh full sync', () => {
  for (const bad of [null, '', 'nope', '{"v":2,"l":{}}', '{"v":1,"l":{"a b":{"u":1}}}', JSON.stringify({ v: 1, l: { ok: { u: -5, p: 'x' } } })]) {
    const l = parseTasksCursor(bad).l
    assert.ok(Object.values(l).every((e) => e.u === undefined && e.p === undefined), String(bad))
  }
})

test('google_tasks: mapping keeps subtasks, links and notes; odd links, ids and URLs are dropped', () => {
  const list = { id: 'L1', name: 'My Tasks' }
  const doc = taskToDocument(task('c1', {
    parent: 'a1',
    notes: 'Buy milk\r\nand eggs',
    links: [
      { type: 'email', description: 'From Ann', link: 'https://mail.google.com/mail/#all/123' },
      { type: 'generic', link: 'javascript:alert(1)' },
    ],
    assignmentInfo: { surfaceType: 'DOCUMENT', linkToTask: 'https://docs.google.com/x' },
    due: '2026-11-05T00:00:00.000Z',
  }), list)
  assert.match(doc.text, /Subtask of another task/)
  assert.match(doc.text, /Assigned to you from: DOCUMENT/)
  assert.match(doc.text, /Links \(not opened\): From Ann https:\/\/mail.google.com/)
  assert.ok(!doc.text.includes('javascript:'))
  assert.match(doc.text, /\n\nBuy milk\nand eggs$/)
  assert.equal(doc.meta.parent, 'a1')
  assert.equal(taskToDocument(task('x', { webViewLink: 'https://evil.example/x' }), list).url, undefined)
  assert.equal(taskToDocument({ id: 'bad id' }, list), null)
  assert.equal(taskToDocument(task('e', { title: '   ' }), list).title, '(no title)')
  assert.equal(dueDate('2026-11-05T00:00:00.000Z'), '2026-11-05')
  assert.equal(dueDate('tomorrow'), null)
  assert.equal(taskListEntry({ id: 'L/1' }), null)
})

test('google_tasks: list_tasks answers due today, overdue, upcoming and recently completed', async () => {
  const pages = {
    L1: [[
      task('today', { due: '2026-11-01T00:00:00.000Z' }),
      task('late', { due: '2026-10-28T00:00:00.000Z' }),
      task('soon', { due: '2026-11-04T00:00:00.000Z' }),
      task('far', { due: '2026-12-20T00:00:00.000Z' }),
      task('nodue'),
      task('done', { status: 'completed', completed: '2026-10-31T09:00:00.000Z', due: '2026-11-01T00:00:00.000Z' }),
      task('gone', { deleted: true, due: '2026-11-01T00:00:00.000Z' }),
    ]],
    L2: [[task('milk', { due: '2026-11-01T00:00:00.000Z', notes: 'semi-skimmed' })]],
  }
  const { registry } = setup(fakeTasks({ pages }))
  const call = async (args) => body(await registry.callTool(connectorToolName('google_tasks', 'read', 'list_tasks'), args))
  const today = await call({})
  assert.equal(today.view, 'due_today')
  assert.equal(today.today, '2026-11-01')
  assert.deepEqual(today.tasks.map((t) => t.title), ['Task today', 'Task milk'])
  assert.equal(today.tasks[1].list, 'Shopping')
  assert.equal(today.tasks[1].notes, 'semi-skimmed')
  assert.deepEqual((await call({ view: 'overdue' })).tasks.map((t) => t.title), ['Task late'])
  assert.deepEqual((await call({ view: 'upcoming' })).tasks.map((t) => t.title), ['Task today', 'Task milk', 'Task soon'])
  assert.deepEqual((await call({ view: 'open', limit: 2 })).tasks.length, 2)
  assert.equal((await call({ view: 'open' })).count, 6)
  assert.deepEqual((await call({ view: 'recently_completed' })).tasks.map((t) => t.title), ['Task done'])
  assert.equal((await call({ view: 'drop table' })).view, 'due_today', 'unknown views fall back')
})

test('google_tasks: "today" follows the owner\'s time zone', async () => {
  const pages = { L1: [[task('t', { due: '2026-11-02T00:00:00.000Z' })]] }
  const late = () => Date.parse('2026-11-01T23:30:00Z')
  const { registry } = setup(fakeTasks({ lists: [LISTS[0]], pages }), { utcOffsetMinutes: () => 60 }, late)
  const res = body(await registry.callTool(connectorToolName('google_tasks', 'read', 'list_tasks'), {}))
  assert.equal(res.today, '2026-11-02')
  assert.deepEqual(res.tasks.map((t) => t.title), ['Task t'])
})

test('google_tasks: the read tool is offered as read-only and passes the policy engine', () => {
  const { registry } = setup()
  const tools = registry.tools().filter((t) => t.name.includes('google_tasks'))
  assert.deepEqual(tools.map((t) => t.name), [connectorMcpName('google_tasks', 'read', 'list_tasks')])
  assert.ok(tools.every((t) => t.readOnly))
  assert.equal(registry.policyRule(connectorToolName('google_tasks', 'read', 'list_tasks')).allow, true)
})

test('google_tasks: test() counts the lists it reads; disconnect revokes and forgets the tokens', async () => {
  const { registry, credentials, seen, lines } = setup()
  const t = await registry.test('google_tasks')
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.match(t.detail, /2 task lists/)
  const d = await registry.disconnect('google_tasks')
  assert.equal(d.ok, true)
  assert.equal(seen.revokes, 1)
  assert.deepEqual(credentials.describe('google_tasks').keys, [])
  assert.equal(registry.status('google_tasks').state, 'disconnected')
  for (const l of lines) assert.ok(!l.includes(REFRESH) && !l.includes(ACCESS))
})
