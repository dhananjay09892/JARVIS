/**
 * GitHub notifications (task C23): the README's acceptance tests and the
 * vetting test pack (auth failure, revoked token, injection fixture, rate
 * limit, offline, erase, no writes, kill switches), against a fake GitHub API.
 * No real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  githubNotificationsConnector, GITHUB_HOST, GITHUB_API_VERSION, threadToDocument, threadUrl,
  parseGithubCursor, githubCursor, pollSeconds, parseScopes,
} from './github_notifications.mjs'
import { createConnectorRegistry, connectorToolName } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { connectorTestPack, createFakeFetch, captureLog, INJECTION_TEXT, ATTACKER_HOST } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

/** Fixture tokens in GitHub's shape; not real. */
const TOKEN = `ghp_${'f'.repeat(36)}`
const WRONG = `ghp_${'0'.repeat(36)}`
const NOW = Date.parse('2026-11-02T12:00:00Z')
const LAST_MOD = 'Mon, 02 Nov 2026 11:00:00 GMT'
const iso = (min) => new Date(Date.parse('2026-11-01T08:00:00Z') + min * 60_000).toISOString().replace('.000Z', 'Z')
const ID = 'github_notifications'
const factory = githubNotificationsConnector()

function thread(n, { title = `Issue ${n}`, updated = n, reason = 'mention', type = 'Issue', repo = 'acme/app', priv = false, kind = 'issues' } = {}) {
  return {
    id: String(1000 + n),
    unread: true,
    reason,
    updated_at: iso(updated),
    last_read_at: null,
    subject: { title, type, url: `https://api.github.com/repos/${repo}/${kind}/${n}`, latest_comment_url: null },
    repository: { full_name: repo, private: priv },
    url: `https://api.github.com/notifications/threads/${1000 + n}`,
  }
}

/**
 * A fake api.github.com. `inbox` is the unread list, changed by tests; it
 * answers 304 when If-Modified-Since matches `modified`.
 */
function fakeGithub({ inbox = [thread(1), thread(2)], injection, scopes = 'notifications', pollInterval = '60', token = TOKEN } = {}) {
  const state = { inbox, modified: LAST_MOD, seen: [] }
  const respond = ({ url, init = {} }) => {
    const u = new URL(url)
    const headers = init.headers ?? {}
    state.seen.push({ method: init.method ?? 'GET', path: u.pathname, search: u.searchParams, headers })
    if (u.hostname !== GITHUB_HOST) return { status: 404, body: {} }
    if (headers.Authorization !== `Bearer ${token}`) return { status: 401, body: { message: 'Bad credentials' } }
    if (u.pathname === '/user') return { headers: { 'x-oauth-scopes': scopes }, body: { login: 'octo' } }
    if (u.pathname !== '/notifications') return { status: 404, body: {} }
    const base = { 'x-poll-interval': pollInterval, 'last-modified': state.modified }
    if (headers['If-Modified-Since'] === state.modified) return { status: 304, headers: base }
    const list = injection ? [thread(1, { title: injection })] : state.inbox
    const per = Number(u.searchParams.get('per_page'))
    const page = Number(u.searchParams.get('page') ?? 1)
    return { headers: base, body: list.slice((page - 1) * per, page * per) }
  }
  return { ...state, state, respond }
}

function setup(fake, { seed = true, clock, log = captureLog().log, onErase } = {}) {
  const credentials = createMemoryCredentialStore()
  if (seed) credentials.set(ID, 'token', TOKEN)
  const { fetch, calls } = createFakeFetch((url, init) => fake.respond({ url, init }))
  const sleeps = []
  const time = clock ?? { at: NOW }
  const registry = createConnectorRegistry({
    credentials, fetch, sleep: async (ms) => { sleeps.push(ms) }, log, onErase, now: () => time.at,
  })
  const reg = registry.register(factory)
  assert.equal(reg.ok, true, reg.error)
  return { registry, credentials, calls, sleeps, time }
}

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'token', value: TOKEN },
  respond: ({ url, init, injection }) => fakeGithub({ injection }).respond({ url, init }),
  onlyHosts: [GITHUB_HOST],
})) test(name, run)

test('github: the card is valid and honest about the token', () => {
  const { registry } = setup(fakeGithub())
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.match(c.setup.steps[0], /Fine-grained tokens do not work/)
  assert.match(c.setup.sees.join(' '), /never marks anything read/)
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.equal(c.risk, 'R1')
})

test('github: connect checks the token first and stores only a notifications-scoped one', async () => {
  const { registry, credentials } = setup(fakeGithub(), { seed: false })
  const bad = await registry.connect(ID, { token: WRONG })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'auth')
  assert.deepEqual(credentials.describe(ID).keys, [], 'a refused token stores nothing')

  const good = await registry.connect(ID, { token: `  ${TOKEN}\n` })
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.deepEqual(credentials.describe(ID).keys.map((k) => k.key).sort(), ['login', 'token'])
  assert.equal(registry.status(ID).state, 'ok')
})

test('github: over-broad, scope-less, fine-grained and malformed tokens are refused without storing', async () => {
  for (const scopes of ['repo', 'notifications, repo', 'notifications, read:user', '']) {
    const { registry, credentials } = setup(fakeGithub({ scopes }), { seed: false })
    const r = await registry.connect(ID, { token: TOKEN })
    assert.equal(r.ok, false, `scopes "${scopes}"`)
    assert.equal(r.error.code, 'setup-needed')
    assert.deepEqual(credentials.describe(ID).keys, [])
  }
  const fine = setup(fakeGithub(), { seed: false })
  const r = await fine.registry.connect(ID, { token: `github_pat_${'a'.repeat(60)}` })
  assert.equal(r.error.code, 'setup-needed')
  assert.equal(fine.calls.length, 0, 'known not to work: not even sent')
  const junk = setup(fakeGithub(), { seed: false })
  assert.equal((await junk.registry.connect(ID, { token: 'hello' })).error.code, 'auth')
  assert.equal(junk.calls.length, 0)
})

test('github: documents have correct ids, timestamps, links and labels', async () => {
  const fake = fakeGithub({ inbox: [thread(7, { title: 'Fix login', reason: 'review_requested', type: 'PullRequest', kind: 'pulls', priv: true })] })
  const { registry } = setup(fake)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const [d] = r.documents
  assert.equal(d.id, '1007')
  assert.equal(d.title, 'Fix login')
  assert.equal(d.updatedAt, Date.parse(iso(7)))
  assert.equal(d.url, 'https://github.com/acme/app/pull/7')
  assert.equal(d.sensitivity, 'work')
  assert.deepEqual(d.meta, { repo: 'acme/app', type: 'PullRequest', reason: 'review_requested', private: true })
  assert.ok(isWrapped(d.text))
  assert.match(d.text, /PullRequest in acme\/app: Fix login/)
  assert.match(d.text, /your review was requested/)
})

test('github: only GET, the right headers, and no call that could change anything', async () => {
  const fake = fakeGithub()
  const { registry } = setup(fake)
  await registry.test(ID)
  await registry.sync(ID)
  await registry.callTool(connectorToolName(ID, 'read', 'list_unread'), {})
  assert.ok(fake.seen.length >= 3)
  for (const c of fake.seen) {
    assert.equal(c.method, 'GET')
    assert.equal(c.path, '/notifications')
    assert.equal(c.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION)
    assert.match(c.headers['User-Agent'], /JARVIS/)
    assert.equal(c.search.has('all'), false, 'unread only')
  }
})

test('github: polling sends Last-Modified back, a 304 changes nothing, and X-Poll-Interval is obeyed', async () => {
  const fake = fakeGithub({ pollInterval: '120' })
  const { registry, time } = setup(fake)
  const one = await registry.sync(ID)
  assert.equal(one.documents.length, 2)
  assert.equal(parseGithubCursor(one.cursor).m, LAST_MOD)
  assert.equal(parseGithubCursor(one.cursor).n, NOW + 120_000)

  // Inside the interval: no request at all, and the cursor stays.
  time.at += 119_000
  const early = await registry.sync(ID, { cursor: one.cursor })
  assert.equal(early.ok, true)
  assert.equal(fake.seen.length, 1, 'no request inside the poll interval')
  assert.equal(early.cursor, one.cursor)

  time.at += 1000
  const two = await registry.sync(ID, { cursor: one.cursor })
  assert.equal(fake.seen.length, 2)
  assert.equal(fake.seen[1].headers['If-Modified-Since'], LAST_MOD)
  assert.deepEqual(two.documents, [])
  assert.deepEqual(two.deleted, [])
  assert.equal(parseGithubCursor(two.cursor).n, time.at + 120_000, 'a 304 pushes the next poll out too')
  assert.deepEqual(parseGithubCursor(two.cursor).s, parseGithubCursor(one.cursor).s)
})

test('github: an incremental sync returns only new or updated threads, and read ones leave', async () => {
  const fake = fakeGithub({ inbox: [thread(1), thread(2), thread(3)] })
  const { registry, time } = setup(fake)
  const one = await registry.sync(ID)
  assert.equal(one.documents.length, 3)

  fake.state.modified = 'Mon, 02 Nov 2026 12:00:30 GMT'
  fake.state.inbox = [thread(4), thread(2, { updated: 90, title: 'Issue 2 again' }), thread(3)]
  time.at += 61_000
  const two = await registry.sync(ID, { cursor: one.cursor })
  assert.deepEqual(two.documents.map((d) => d.id).sort(), ['1002', '1004'])
  assert.deepEqual(two.deleted.map((d) => d.id), ['1001'], 'thread 1 was read on GitHub')
})

test('github: a list past the page cap deletes nothing and is still remembered', async () => {
  const many = Array.from({ length: 60 }, (_, i) => thread(i + 1))
  const fake = fakeGithub({ inbox: many })
  const connector = githubNotificationsConnector({ maxPages: 1 })
  const credentials = createMemoryCredentialStore()
  credentials.set(ID, 'token', TOKEN)
  const { fetch } = createFakeFetch((url, init) => fake.respond({ url, init }))
  const time = { at: NOW }
  const registry = createConnectorRegistry({ credentials, fetch, log: captureLog().log, now: () => time.at })
  registry.register(connector)
  const one = await registry.sync(ID)
  assert.equal(one.documents.length, 50)

  fake.state.modified = 'later'
  fake.state.inbox = many.slice(1) // the first page's thread 1 was read
  time.at += 61_000
  const two = await registry.sync(ID, { cursor: one.cursor })
  assert.deepEqual(two.deleted, [], 'an incomplete list proves nothing')
  assert.ok(two.documents.length <= 1)
})

test('github: every page of a long list is read', async () => {
  const fake = fakeGithub({ inbox: Array.from({ length: 120 }, (_, i) => thread(i + 1)) })
  const { registry } = setup(fake)
  const r = await registry.sync(ID)
  assert.equal(r.documents.length, 120)
  assert.deepEqual(fake.seen.map((c) => c.search.get('page')), ['1', '2', '3'])
  assert.equal(fake.seen[1].headers['If-Modified-Since'], undefined)
})

test('github: a token for another account gets no 304 meant for the old one', async () => {
  const fake = fakeGithub()
  const { registry, credentials, time } = setup(fake)
  const one = await registry.sync(ID)
  credentials.set(ID, 'login', 'someone-else')
  fake.state.inbox = [thread(9)]
  time.at += 1000 // inside the old poll interval: it belonged to the old account
  const two = await registry.sync(ID, { cursor: one.cursor })
  assert.equal(fake.seen.at(-1).headers['If-Modified-Since'], undefined)
  assert.deepEqual(two.documents.map((d) => d.id), ['1009'])
  assert.deepEqual(two.deleted.map((d) => d.id).sort(), ['1001', '1002'])
})

test('github: a bad or revoked token is reported, keeps the cursor and leaks nothing', async () => {
  const { log, lines } = captureLog()
  const { registry } = setup(fakeGithub({ token: WRONG }), { log })
  const r = await registry.sync(ID, { cursor: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'auth')
  assert.equal(r.cursor, 'x')
  assert.deepEqual(r.documents, [])
  assert.equal(registry.status(ID).state, 'attention')
  assert.ok(!`${JSON.stringify(r)} ${lines.join(' ')}`.includes(TOKEN))
})

test('github: a primary rate limit is not called an auth problem, and JARVIS stops calling until reset', async () => {
  const reset = Math.floor(NOW / 1000) + 1800
  const fake = fakeGithub()
  let limited = true
  const respond = fake.respond
  fake.respond = (r) => {
    fake.state.seen.push({ path: 'limit' })
    return limited
      ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: { message: 'API rate limit exceeded' } }
      : respond(r)
  }
  const { registry, sleeps, time } = setup(fake)
  const r = await registry.sync(ID)
  assert.equal(r.error.code, 'rate-limit')
  assert.deepEqual(sleeps, [], 'half an hour is too long to wait in a sync')
  const calls = fake.state.seen.length

  limited = false
  time.at += 60_000
  assert.equal((await registry.sync(ID)).error.code, 'rate-limit')
  assert.equal(fake.state.seen.length, calls, 'no call while limited')

  time.at = reset * 1000 + 1
  assert.equal((await registry.sync(ID)).ok, true)
})

test('github: "the endpoint has been spammed" backs off', async () => {
  const fake = { respond: () => ({ status: 422, body: { message: 'Validation Failed' } }) }
  const { registry, calls } = setup(fake)
  assert.equal((await registry.sync(ID)).error.code, 'rate-limit')
  const n = calls.length
  assert.equal((await registry.sync(ID)).error.code, 'rate-limit')
  assert.equal(calls.length, n)
})

test('github: a reply that is not a list is a bad response', async () => {
  const { registry } = setup({ respond: () => ({ body: { message: 'hello' } }) })
  assert.equal((await registry.sync(ID)).error.code, 'bad-response')
})

test('github: the injection fixture stays data through the store and the tool', async () => {
  const fake = fakeGithub({ injection: INJECTION_TEXT })
  const { registry, calls } = setup(fake)
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    const r = await syncConnectorInto(registry, store, ID)
    assert.equal(r.ok, true, JSON.stringify(r))
    const before = registry.grants.of(ID)
    const tool = await registry.callTool(connectorToolName(ID, 'read', 'list_unread'), {})
    assert.ok(isWrapped(tool.content[0].text))
    assert.deepEqual(registry.grants.of(ID), before)
    assert.ok(calls.every((c) => new URL(c.url).hostname !== ATTACKER_HOST))
  } finally {
    store.close()
  }
})

test('github: the tool is read-only, bounded and can narrow to participating threads', async () => {
  const fake = fakeGithub({ inbox: Array.from({ length: 40 }, (_, i) => thread(i + 1)) })
  const { registry } = setup(fake)
  const name = connectorToolName(ID, 'read', 'list_unread')
  const tool = registry.tools().find((t) => t.name.endsWith(name))
  assert.ok(tool, 'offered once read is granted')
  assert.equal(tool.readOnly, true)
  const res = await registry.callTool(name, { limit: 99, participating: true })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  assert.equal(fake.seen.at(-1).search.get('per_page'), '25')
  assert.equal(fake.seen.at(-1).search.get('participating'), 'true')
  assert.ok(isWrapped(res.content[0].text))
})

test('github: Sync now keeps documents, read threads leave the store, and erase clears it all', async () => {
  const fake = fakeGithub()
  const { registry, time } = setup(fake)
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {

    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 2)
    fake.state.modified = 'later'
    fake.state.inbox = [thread(2)]
    time.at += 61_000
    const r = await syncConnectorInto(registry, store, ID)
    assert.equal(r.saved, 0)
    assert.equal(r.removed, 1)
    assert.ok(store.state(ID).cursor)
    store.erase(ID)
    assert.equal(store.state(ID).cursor, null)
  } finally {
    store.close()
  }
})

test('github: disconnect forgets the token and the login', async () => {
  const erased = []
  const { registry, credentials } = setup(fakeGithub(), { seed: false, onErase: (id) => erased.push(id) })
  await registry.connect(ID, { token: TOKEN })
  const r = await registry.disconnect(ID, { eraseData: true })
  assert.equal(r.ok, true)
  assert.deepEqual(erased, [ID])
  assert.deepEqual(credentials.describe(ID).keys, [])
  assert.equal(registry.status(ID).state, 'disconnected')
  assert.equal((await registry.sync(ID)).error.code, 'not-connected')
})

test('github: mapping helpers', () => {
  assert.equal(threadUrl(thread(5)), 'https://github.com/acme/app/issues/5')
  assert.equal(threadUrl(thread(5, { kind: 'pulls' })), 'https://github.com/acme/app/pull/5')
  assert.equal(threadUrl({ repository: { full_name: 'a/b' }, subject: { url: 'https://api.github.com/repos/a/b/commits/abc123' } }), 'https://github.com/a/b/commit/abc123')
  assert.equal(threadUrl({ repository: { full_name: 'a/b' }, subject: { url: null } }), 'https://github.com/a/b', 'CI threads have no subject url')
  assert.equal(threadUrl({ repository: { full_name: 'a/b' }, subject: { url: 'https://api.github.com/repos/a/b/releases/1' } }), 'https://github.com/a/b')
  assert.equal(threadUrl({ repository: { full_name: 'a/b' }, subject: { url: `https://${ATTACKER_HOST}/repos/a/b/issues/1` } }), 'https://github.com/a/b', 'never another host')
  assert.equal(threadUrl({ repository: { full_name: 'a/b' }, subject: { url: 'https://api.github.com/repos/c/d/issues/1' } }), 'https://github.com/a/b', 'never another repository')
  assert.equal(threadUrl({ repository: { full_name: 'a b/../c' } }), '')
  assert.equal(threadToDocument({ ...thread(1), id: 'nope' }), null)
  assert.equal(threadToDocument({ ...thread(1), updated_at: 'never' }), null)
  assert.equal(threadToDocument(thread(1, { reason: 'something_new' })).meta.reason, 'other')
  assert.equal(threadToDocument(thread(1, { reason: 'constructor' })).meta.reason, 'other')
  assert.equal(pollSeconds('300'), 300)
  assert.equal(pollSeconds(null), 60)
  assert.equal(pollSeconds('soon'), 60)
  assert.equal(pollSeconds('999999'), 3600)
  assert.deepEqual(parseScopes(' notifications, repo '), ['notifications', 'repo'])
  assert.deepEqual(parseScopes(null), [])
  assert.equal(parseGithubCursor('nonsense'), null)
  assert.equal(parseGithubCursor('{"v":2,"s":{}}'), null)
  assert.deepEqual(parseGithubCursor(githubCursor({ u: 'a', m: 'b', n: 3, s: { 12: 4, bad: 5 } })), { u: 'a', m: 'b', n: 3, s: { 12: 4 } })
  const big = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [String(i + 1), i]))
  const kept = parseGithubCursor(githubCursor({ s: big })).s
  assert.equal(Object.keys(kept).length, 2000)
  assert.ok('2500' in kept && !('1' in kept), 'the newest are kept')
})
