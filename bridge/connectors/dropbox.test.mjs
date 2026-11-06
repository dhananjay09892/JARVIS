/**
 * Dropbox (task C31): the shared connector test pack plus Dropbox's own
 * acceptance tests — cursor sync, incremental changes, deletions, text-only
 * and size limits, a stale cursor, the per-sync cap, the PKCE sign-in through
 * the loopback listener, refresh, revoke on disconnect, and the read-only
 * search tool. Dropbox is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dropboxConnector, isTextFile, fileToDocument, parseDropboxCursor, dropboxCursor,
  API, CONTENT, DROPBOX_CONTENT_HOST, MAX_FILE_BYTES,
} from './dropbox.mjs'
import {
  createDropboxClient, DROPBOX_CLIENT_ID, DROPBOX_TOKEN_URL, DROPBOX_REVOKE_URL, DROPBOX_API_HOST, DROPBOX_SCOPES,
} from './dropbox-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'

const APP_KEY = 'abcd1234efgh567'
const REFRESH = 'dbx-refresh-abcdefghijklmnopqrstuvwxyz0123456789'
const ACCESS = 'sl.dbx-access-abcdefghijklmnop'
const NOW = 1_800_000_000_000

function dropboxClient() {
  const c = createDropboxClient(createMemoryCredentialStore().scoped(DROPBOX_CLIENT_ID))
  c.save({ clientId: APP_KEY })
  return c
}

const file = (n, { name = `note${n}.md`, size = 40, downloadable = true, at = '2026-10-01T10:00:00Z' } = {}) => ({
  '.tag': 'file', name, id: `id:F${n}`, path_lower: `/docs/${name.toLowerCase()}`, path_display: `/Docs/${name}`,
  client_modified: at, server_modified: at, rev: `rev${n}`, size, is_downloadable: downloadable,
})
const gone = (name) => ({ '.tag': 'deleted', name, path_lower: `/docs/${name.toLowerCase()}`, path_display: `/Docs/${name}` })

/** A fake Dropbox: `pages` is the first listing; `later[cursor]` the changes after it. */
function fakeDropbox({ pages = [[file(1), file(2), file(3)]], later = {}, contents = {}, injection, seen = { calls: [], downloads: [], refreshes: 0, revoked: 0 } } = {}) {
  const sessions = new Map()
  let n = 0
  const reply = (list, pageNo) => {
    const entries = list[pageNo] ?? []
    const last = pageNo >= list.length - 1
    const cursor = `cur${++n}`
    sessions.set(cursor, { list, next: pageNo + 1 })
    return { entries, cursor, has_more: !last }
  }
  const respond = ({ url, init }) => {
    seen.calls.push(url)
    if (url === DROPBOX_TOKEN_URL) {
      seen.refreshes++
      return { body: { access_token: ACCESS, token_type: 'bearer', expires_in: 14400, scope: DROPBOX_SCOPES.join(' ') } }
    }
    if (url === DROPBOX_REVOKE_URL) {
      seen.revoked++
      return { body: {} }
    }
    if (url === `${API}/files/list_folder`) {
      const args = JSON.parse(init.body)
      seen.first = args
      return { body: reply(pages, 0) }
    }
    if (url === `${API}/files/list_folder/continue`) {
      const { cursor } = JSON.parse(init.body)
      if (later[cursor] === 'reset') return { status: 409, body: { error_summary: 'reset/..', error: { '.tag': 'reset' } } }
      if (later[cursor]) return { body: reply([later[cursor]], 0) }
      const s = sessions.get(cursor)
      if (s) return { body: reply(s.list, s.next) }
      return { body: { entries: [], cursor, has_more: false } }
    }
    if (url === `${CONTENT}/files/download`) {
      const arg = JSON.parse(init.headers['dropbox-api-arg'])
      seen.downloads.push(arg.path)
      if (contents[arg.path] === 409) return { status: 409, body: { error_summary: 'path/not_found/..' } }
      const text = contents[arg.path] ?? `Text of ${arg.path}`
      return { body: injection && arg.path === 'id:F1' ? `${text}\n${injection}` : text }
    }
    if (url === `${API}/files/search_v2`) {
      seen.search = JSON.parse(init.body)
      return { body: { matches: [{ metadata: { '.tag': 'metadata', metadata: file(1) } }, { metadata: { '.tag': 'metadata', metadata: { '.tag': 'folder', name: 'x' } } }] } }
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = dropboxConnector({ dropboxClient: dropboxClient() })

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeDropbox({ injection }).respond({ url, init }),
  onlyHosts: [DROPBOX_API_HOST, DROPBOX_CONTENT_HOST],
})) test(name, run)

function setup(box = fakeDropbox(), { maxPerSync, connected = true } = {}) {
  const credentials = createMemoryCredentialStore()
  if (connected) credentials.set('dropbox', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => box.respond({ url, init }))
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log, now: () => NOW })
  const f = maxPerSync ? dropboxConnector({ dropboxClient: dropboxClient(), maxPerSync }) : factory
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, lines, seen: box.seen }
}

test('dropbox: card is a read-only sign-in with the two read scopes only', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'dropbox')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['files.metadata.read', 'files.content.read'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'search_files', capability: 'read' }])
  assert.throws(() => dropboxConnector({}), /shared Dropbox client/)
})

test('dropbox: first sync lists recursively, downloads text files and keeps the cursor', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('dropbox')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['/docs/note1.md', '/docs/note2.md', '/docs/note3.md'])
  const d = r.documents[0]
  assert.equal(d.title, 'note1.md')
  assert.equal(d.sensitivity, 'personal')
  assert.equal(d.updatedAt, Date.parse('2026-10-01T10:00:00Z'))
  assert.match(d.text, /Text of id:F1/)
  assert.deepEqual(seen.first, { path: '', recursive: true, include_deleted: true, include_non_downloadable_files: false, limit: 50 })
  assert.equal(parseDropboxCursor(r.cursor), 'cur1')
  assert.ok(!r.documents.some((x) => x.text.includes(ACCESS)))
})

test('dropbox: incremental sync reads changes and turns deleted entries into deletion markers', async () => {
  const box = fakeDropbox({ later: { cur1: [file(4), gone('note2.md')] } })
  const { registry, seen } = setup(box)
  const first = await registry.sync('dropbox')
  const r = await registry.sync('dropbox', { cursor: first.cursor })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['/docs/note4.md'])
  assert.deepEqual(r.deleted.map((x) => x.id), ['/docs/note2.md'])
  assert.deepEqual(seen.downloads, ['id:F1', 'id:F2', 'id:F3', 'id:F4'], 'only the new file was fetched again')
})

test('dropbox: only text files within the size limit are downloaded', async () => {
  const entries = [
    file(1), file(2, { name: 'photo.jpg' }), file(3, { name: 'big.txt', size: MAX_FILE_BYTES + 1 }),
    file(4, { name: 'locked.txt', downloadable: false }), { '.tag': 'folder', name: 'sub', id: 'id:D1', path_lower: '/docs/sub' },
    file(6, { name: 'bin.txt' }),
  ]
  const box = fakeDropbox({ pages: [entries], contents: { 'id:F6': 'abc\u0000def' } })
  const { registry, seen } = setup(box)
  const r = await registry.sync('dropbox')
  assert.deepEqual(r.documents.map((d) => d.id), ['/docs/note1.md'])
  assert.deepEqual(seen.downloads, ['id:F1', 'id:F6'], 'images, big, locked and folders are never downloaded')
})

test('dropbox: a file that vanished before download is skipped, the sync goes on', async () => {
  const box = fakeDropbox({ contents: { 'id:F2': 409 } })
  const { registry } = setup(box)
  const r = await registry.sync('dropbox')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['/docs/note1.md', '/docs/note3.md'])
})

test('dropbox: a reset cursor starts a fresh listing', async () => {
  const box = fakeDropbox({ later: { cur1: 'reset' } })
  const { registry, seen } = setup(box)
  const first = await registry.sync('dropbox')
  const r = await registry.sync('dropbox', { cursor: first.cursor })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 3)
  assert.equal(seen.calls.filter((u) => u === `${API}/files/list_folder`).length, 2)
})

test('dropbox: the per-sync cap leaves the rest for the next run through the cursor', async () => {
  const box = fakeDropbox({ pages: [[file(1), file(2)], [file(3), file(4)], [file(5)]] })
  const { registry } = setup(box, { maxPerSync: 2 })
  const a = await registry.sync('dropbox')
  assert.deepEqual(a.documents.map((d) => d.id), ['/docs/note1.md', '/docs/note2.md'])
  const b = await registry.sync('dropbox', { cursor: a.cursor })
  assert.deepEqual(b.documents.map((d) => d.id), ['/docs/note3.md', '/docs/note4.md'])
  const c = await registry.sync('dropbox', { cursor: b.cursor })
  assert.deepEqual(c.documents.map((d) => d.id), ['/docs/note5.md'])
})

test('dropbox: a garbled or foreign cursor is ignored, not trusted', () => {
  assert.equal(parseDropboxCursor('nope'), null)
  assert.equal(parseDropboxCursor(JSON.stringify({ v: 2, c: 'x' })), null)
  assert.equal(parseDropboxCursor(JSON.stringify({ v: 1, c: 'https://evil.example/' })), null)
  assert.equal(parseDropboxCursor(dropboxCursor('AbC-_123')), 'AbC-_123')
})

test('dropbox: helpers refuse non-text and unreadable entries', () => {
  assert.equal(isTextFile(file(1)), true)
  assert.equal(isTextFile({ ...file(1), size: undefined }), false)
  assert.equal(fileToDocument(file(1), 'a\u0000b'), null)
  assert.equal(fileToDocument({ ...file(1), server_modified: 'x', client_modified: 'y' }, 'ok'), null)
})

test('dropbox: search tool is read-only and returns files only', async () => {
  const { registry, seen } = setup()
  const tool = registry.tools().find((t) => t.name.endsWith('search_files'))
  assert.ok(tool?.readOnly)
  const res = await registry.callTool(tool.name, { query: 'trip plans', limit: 3 }, {})
  assert.notEqual(res.isError, true, JSON.stringify(res))
  assert.deepEqual(seen.search, { query: 'trip plans', options: { max_results: 3, file_status: 'active' } })
  assert.match(JSON.stringify(res), /note1\.md/)
  assert.ok(!/"x"/.test(JSON.stringify(res)), 'folders are left out')
})

test('dropbox: the access token is refreshed with the app key and no secret, then reused', async () => {
  const bodies = []
  const box = fakeDropbox()
  const inner = box.respond
  box.respond = (a) => {
    if (a.url === DROPBOX_TOKEN_URL) bodies.push(new URLSearchParams(a.init.body))
    return inner(a)
  }
  const { registry, seen } = setup(box)
  await registry.sync('dropbox')
  await registry.sync('dropbox')
  assert.equal(seen.refreshes, 1)
  assert.equal(bodies[0].get('grant_type'), 'refresh_token')
  assert.equal(bodies[0].get('client_id'), APP_KEY)
  assert.equal(bodies[0].get('client_secret'), null)
})

test('dropbox: a 401 on a call refreshes once and retries', async () => {
  const box = fakeDropbox()
  const inner = box.respond
  let first = true
  box.respond = (a) => {
    if (a.url === `${API}/files/list_folder` && first) {
      first = false
      return { status: 401, body: { error: { '.tag': 'expired_access_token' } } }
    }
    return inner(a)
  }
  const { registry, seen } = setup(box)
  const r = await registry.sync('dropbox')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(seen.refreshes, 2)
})

test('dropbox: not connected asks the owner to connect; nothing is called', async () => {
  const { registry, calls } = setup(fakeDropbox(), { connected: false })
  const r = await registry.sync('dropbox')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'not-connected')
  assert.equal(calls.length, 0)
})

test('dropbox: disconnect revokes at Dropbox and forgets every token', async () => {
  const { registry, credentials, seen } = setup()
  const r = await registry.disconnect('dropbox', { eraseData: false })
  assert.equal(r.ok, true)
  assert.equal(seen.revoked, 1)
  assert.deepEqual(credentials.describe('dropbox').keys, [])
})

test('dropbox: disconnect still forgets tokens when Dropbox cannot be reached', async () => {
  const box = fakeDropbox()
  box.respond = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  const { registry, credentials } = setup(box)
  const r = await registry.disconnect('dropbox', { eraseData: false })
  assert.equal(r.ok, true)
  assert.deepEqual(credentials.describe('dropbox').keys, [])
})

test('dropbox: sign-in uses PKCE, offline access, read scopes, a checked state, and stores the tokens', async () => {
  const credentials = createMemoryCredentialStore()
  const box = fakeDropbox()
  const bodies = []
  const { fetch } = createFakeFetch((url, init) => {
    if (url === DROPBOX_TOKEN_URL) {
      bodies.push(new URLSearchParams(init.body))
      return { body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 14400, scope: DROPBOX_SCOPES.join(' ') } }
    }
    return box.respond({ url, init })
  })
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log: captureLog().log, now: () => NOW })
  assert.equal(registry.register(dropboxConnector({ dropboxClient: dropboxClient(), port: 0 })).ok, true)
  const started = await registry.connect('dropbox', {})
  assert.equal(started.ok, true, JSON.stringify(started))
  const u = new URL(started.result.url)
  assert.equal(u.origin + u.pathname, 'https://www.dropbox.com/oauth2/authorize')
  assert.equal(u.searchParams.get('client_id'), APP_KEY)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('token_access_type'), 'offline')
  assert.equal(u.searchParams.get('scope'), 'files.metadata.read files.content.read')
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  assert.equal(redirect.hostname, '127.0.0.1')
  // A reply with the wrong state is ignored.
  const bad = await globalThis.fetch(`${redirect.origin}/?code=x&state=wrong`)
  assert.equal(bad.status, 400)
  const ok = await globalThis.fetch(`${redirect.origin}/?code=thecode&state=${u.searchParams.get('state')}`)
  assert.equal(ok.status, 200)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(bodies[0].get('grant_type'), 'authorization_code')
  assert.equal(bodies[0].get('code'), 'thecode')
  assert.ok(bodies[0].get('code_verifier').length >= 43)
  assert.equal(bodies[0].get('client_secret'), null)
  assert.equal(credentials.get('dropbox', 'refresh_token'), REFRESH)
})

test('dropbox: a sign-in that did not grant both read scopes keeps nothing', async () => {
  const credentials = createMemoryCredentialStore()
  const { fetch } = createFakeFetch((url) => (url === DROPBOX_TOKEN_URL
    ? { body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 14400, scope: 'files.metadata.read' } }
    : { status: 404, body: {} }))
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log: captureLog().log, now: () => NOW })
  registry.register(dropboxConnector({ dropboxClient: dropboxClient(), port: 0 }))
  const started = await registry.connect('dropbox', {})
  const u = new URL(started.result.url)
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  await globalThis.fetch(`${redirect.origin}/?code=c&state=${u.searchParams.get('state')}`)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(credentials.get('dropbox', 'refresh_token'), null)
  assert.equal(registry.status('dropbox').state, 'attention')
})

test('dropbox: the app key must look like one and takes no secret', () => {
  const c = createDropboxClient(createMemoryCredentialStore().scoped(DROPBOX_CLIENT_ID))
  assert.throws(() => c.save({ clientId: 'not a key!' }), /Finish the setup/)
  assert.throws(() => c.save({ clientId: APP_KEY, clientSecret: 'shh' }), /Finish the setup/)
  c.save({ clientId: APP_KEY })
  assert.deepEqual(c.describe(), { set: true, clientId: APP_KEY, hasSecret: false })
})
