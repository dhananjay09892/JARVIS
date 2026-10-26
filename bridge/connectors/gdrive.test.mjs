/**
 * Google Drive connector (task C08): the shared connector test pack plus
 * Drive's own acceptance tests — full sync with the start token taken first,
 * Docs/Sheets exported and other files listed by name only, incremental sync
 * by change token with deletions (task C96), the page budget carried in the
 * cursor, stale tokens, the read-only tools and disconnect revoking.
 * Google is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gdriveConnector, fileToDocument, parseDriveCursor, driveCursor, driveQueryLiteral, exportType, MIME, GDRIVE_HOST,
} from './gdrive.mjs'
import { createGoogleClient, GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPES } from './google-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry, connectorToolName, connectorMcpName } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'
import { openDocumentStore } from './store.mjs'

const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com'
const REFRESH = '1//gdrive-refresh-token-abcdefghijklmnopqrstuvwxyz'
const ACCESS = 'ya29.gdrive-access-abcdefghijklmnop'
const NOW = Date.parse('2026-10-26T12:00:00Z')

function googleClient() {
  const c = createGoogleClient(createMemoryCredentialStore().scoped(GOOGLE_CLIENT_ID))
  c.save({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-gdrive-test-secret' })
  return c
}

function file(id, { name = `File ${id}`, mimeType = MIME.doc, ...rest } = {}) {
  return {
    id,
    name,
    mimeType,
    createdTime: '2026-09-01T08:00:00.000Z',
    modifiedTime: '2026-10-20T08:00:00.000Z',
    webViewLink: `https://docs.google.com/document/d/${id}/edit`,
    owners: [{ displayName: 'Me', emailAddress: 'me@example.com' }],
    lastModifyingUser: { displayName: 'Ann', emailAddress: 'ann@example.com' },
    trashed: false,
    ...rest,
  }
}

const DEFAULT_PAGES = [[
  file('doc000001', { name: 'Budget notes' }),
  file('sheet00001', { name: 'Expenses', mimeType: MIME.sheet }),
  file('pdf000001', { name: 'Contract.pdf', mimeType: 'application/pdf', size: '2516582' }),
  file('folder0001', { name: 'Projects', mimeType: MIME.folder }),
]]

const DEFAULT_EXPORTS = {
  doc000001: '﻿The budget for Q4 is 12,000.\r\nKeep it lean.',
  sheet00001: 'item,cost\r\ncoffee,4\r\n',
}

/**
 * A fake Drive. `pages` is the full-sync files.list pages; `changes[token]` is
 * a changes.list page `{ changes, nextPageToken?, newStartPageToken? }`, or
 * 'bad' for a 400. `exports[id]` is the export body, or { status } to refuse.
 */
function fakeDrive({
  pages = DEFAULT_PAGES,
  changes = {},
  exports = DEFAULT_EXPORTS,
  search = [],
  files = {},
  injection,
  startToken = 'start-1',
  seen = { lists: [], changes: [], exports: [], starts: 0, revokes: 0, gets: [] },
} = {}) {
  const respond = ({ url, init }) => {
    if (url === GOOGLE_TOKEN_URL) {
      return { body: { access_token: ACCESS, expires_in: 3599, scope: GOOGLE_SCOPES.gdrive.join(' '), token_type: 'Bearer' } }
    }
    if (url === GOOGLE_REVOKE_URL) {
      seen.revokes++
      return { status: 200, body: '' }
    }
    const u = new URL(url)
    assert.equal(u.hostname, GDRIVE_HOST)
    assert.equal(init.headers.authorization, `Bearer ${ACCESS}`)
    assert.ok(!init.method || init.method === 'GET', 'read-only: GET only')
    const path = u.pathname.replace('/drive/v3', '')
    const q = Object.fromEntries(u.searchParams)
    if (path === '/about') return { body: { user: { displayName: 'Me', emailAddress: 'me@example.com' } } }
    if (path === '/changes/startPageToken') {
      seen.starts++
      return { body: { startPageToken: startToken } }
    }
    if (path === '/changes') {
      seen.changes.push(q)
      const c = changes[q.pageToken]
      if (!c || c === 'bad') return { status: 400, body: { error: { code: 400, message: 'Invalid Value', errors: [{ reason: 'invalid' }] } } }
      return { body: c }
    }
    if (path === '/files') {
      seen.lists.push(q)
      if (q.q?.startsWith('fullText')) return { body: { files: search } }
      const i = Number(q.pageToken ?? 0)
      let items = pages[i] ?? []
      if (injection && i === 0) items = [file('inject0001', { name: `Plan ${injection.slice(0, 40)}`, description: injection }), ...items]
      return { body: { files: items, ...(i + 1 < pages.length ? { nextPageToken: String(i + 1) } : {}) } }
    }
    const ex = /^\/files\/([^/]+)\/export$/.exec(path)
    if (ex) {
      const id = decodeURIComponent(ex[1])
      seen.exports.push({ id, mimeType: q.mimeType })
      if (injection && id === 'inject0001') return { body: injection, headers: { 'content-type': 'text/plain' } }
      const e = exports[id]
      if (e === undefined) return { status: 404, body: { error: { code: 404 } } }
      if (typeof e === 'object') return e
      return { body: e, headers: { 'content-type': q.mimeType } }
    }
    const one = /^\/files\/([^/]+)$/.exec(path)
    if (one) {
      const id = decodeURIComponent(one[1])
      seen.gets.push(id)
      return files[id] ? { body: files[id] } : { status: 404, body: {} }
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = gdriveConnector({ googleClient: googleClient() })

// The shared pack: untrusted sync, injection, auth failure, revoked, rate limit, offline, erase, writes, kill switches.
for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeDrive({ injection }).respond({ url, init }),
  onlyHosts: [GDRIVE_HOST, 'oauth2.googleapis.com'],
})) test(name, run)

function setup(drive = fakeDrive(), opts = {}) {
  const credentials = createMemoryCredentialStore()
  credentials.set('gdrive', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => drive.respond({ url, init }))
  const { log, lines } = captureLog()
  const sleeps = []
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async (ms) => { sleeps.push(ms) }, log, now: () => NOW })
  const f = Object.keys(opts).length ? gdriveConnector({ googleClient: googleClient(), ...opts }) : factory
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, lines, sleeps, seen: drive.seen }
}

const body = (res) => {
  const text = res.content[0].text
  assert.match(text, /^<untrusted_data/)
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
}

test('gdrive: card is read-only Google sign-in with only drive.readonly', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'gdrive')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['https://www.googleapis.com/auth/drive.readonly'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'search_files', capability: 'read' }, { name: 'read_file', capability: 'read' }])
  assert.throws(() => gdriveConnector({}), /shared Google client/)
})

test('gdrive: full sync takes the start token first, exports Docs and Sheets, lists other files by name only', async () => {
  const { registry, seen, calls } = setup()
  const r = await registry.sync('gdrive')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['doc000001', 'sheet00001', 'pdf000001'], 'folders are not documents')
  const [doc, sheet, pdf] = r.documents
  assert.equal(doc.title, 'Budget notes')
  assert.equal(doc.author, 'Me <me@example.com>')
  assert.equal(doc.createdAt, Date.parse('2026-09-01T08:00:00.000Z'))
  assert.equal(doc.updatedAt, Date.parse('2026-10-20T08:00:00.000Z'))
  assert.equal(doc.sensitivity, 'personal')
  assert.equal(doc.url, 'https://docs.google.com/document/d/doc000001/edit')
  assert.match(doc.text, /Type: Google Doc/)
  assert.match(doc.text, /Last edited by: Ann <ann@example.com>/)
  assert.match(doc.text, /The budget for Q4 is 12,000\.\nKeep it lean\./)
  assert.match(sheet.text, /Content: first sheet, as CSV/)
  assert.match(sheet.text, /item,cost\ncoffee,4/)
  assert.match(pdf.text, /Type: PDF/)
  assert.match(pdf.text, /Size: 2\.4 MB/)
  assert.match(pdf.text, /Content: not read/)
  // Only the Doc and the Sheet were exported, each in its text format; nothing was downloaded.
  assert.deepEqual(seen.exports, [{ id: 'doc000001', mimeType: 'text/plain' }, { id: 'sheet00001', mimeType: 'text/csv' }])
  assert.ok(!calls.some((c) => /alt=media/.test(c.url)), 'no file is downloaded')
  // The start token came before the listing.
  const firstList = calls.findIndex((c) => new URL(c.url).pathname.endsWith('/files'))
  const start = calls.findIndex((c) => c.url.includes('/changes/startPageToken'))
  assert.ok(start >= 0 && start < firstList)
  const list = seen.lists[0]
  assert.match(list.q, /^trashed = false and mimeType != 'application\/vnd\.google-apps\.folder' and modifiedTime > '2025-10-26T12:00:00\.000Z'$/)
  assert.equal(list.orderBy, 'modifiedTime desc')
  assert.match(list.fields, /^nextPageToken,files\(/)
  assert.deepEqual(parseDriveCursor(r.cursor), { s: 'start-1' })
})

test('gdrive: incremental sync returns only changes; removed and trashed files become deletions', async () => {
  const changes = {
    s1: {
      changes: [
        { changeType: 'file', fileId: 'doc000002', file: file('doc000002', { name: 'New doc' }) },
        { changeType: 'file', fileId: 'doc000001', removed: true },
        { changeType: 'file', fileId: 'sheet00001', file: file('sheet00001', { mimeType: MIME.sheet, trashed: true }) },
        { changeType: 'drive', driveId: 'x' },
        { changeType: 'file', fileId: 'folder0002', file: file('folder0002', { mimeType: MIME.folder }) },
      ],
      newStartPageToken: 's2',
    },
  }
  const { registry, seen } = setup(fakeDrive({ changes, exports: { doc000002: 'hello' } }))
  const r = await registry.sync('gdrive', { cursor: driveCursor({ s: 's1' }) })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['doc000002'])
  assert.deepEqual(r.deleted, [{ connectorId: 'gdrive', id: 'doc000001' }, { connectorId: 'gdrive', id: 'sheet00001' }])
  assert.deepEqual(parseDriveCursor(r.cursor), { s: 's2' })
  assert.equal(seen.starts, 0, 'no new start token in an incremental sync')
  assert.equal(seen.lists.length, 0, 'no full listing')
  assert.equal(seen.changes[0].includeRemoved, 'true')
  assert.equal(seen.changes[0].spaces, 'drive')
})

test('gdrive: a file deleted at the source leaves the document store (C96)', async () => {
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  const full = await setup().registry.sync('gdrive')
  store.ingest('gdrive', full)
  assert.ok(store.get('gdrive', 'doc000001'))
  const changes = { 'start-1': { changes: [{ changeType: 'file', fileId: 'doc000001', removed: true }], newStartPageToken: 's2' } }
  const inc = await setup(fakeDrive({ changes })).registry.sync('gdrive', { cursor: store.state('gdrive').cursor })
  assert.equal(inc.ok, true, JSON.stringify(inc.error))
  assert.equal(store.ingest('gdrive', inc).removed, 1)
  assert.equal(store.get('gdrive', 'doc000001'), null)
  assert.ok(store.get('gdrive', 'sheet00001'), 'other files stay')
  assert.deepEqual(store.search('lean'), [], 'nothing of the deleted doc is left to find')
  store.close()
})

test('gdrive: the page budget stops a full sync and the cursor resumes the listing', async () => {
  const pages = [[file('doc0000p1')], [file('doc0000p2')], [file('doc0000p3')]]
  const exports = { doc0000p1: 'one', doc0000p2: 'two', doc0000p3: 'three' }
  const { registry } = setup(fakeDrive({ pages, exports }), { maxPagesPerSync: 2 })
  const r1 = await registry.sync('gdrive')
  assert.deepEqual(r1.documents.map((d) => d.id), ['doc0000p1', 'doc0000p2'])
  assert.deepEqual(parseDriveCursor(r1.cursor), { st: 'start-1', f: '2' })
  const again = setup(fakeDrive({ pages, exports, startToken: 'start-2' }), { maxPagesPerSync: 2 })
  const r2 = await again.registry.sync('gdrive', { cursor: r1.cursor })
  assert.deepEqual(r2.documents.map((d) => d.id), ['doc0000p3'])
  assert.equal(again.seen.starts, 0, 'the first start token is kept, so nothing changed meanwhile is missed')
  assert.deepEqual(parseDriveCursor(r2.cursor), { s: 'start-1' })
})

test('gdrive: changes pages are followed and the budget leaves the next page in the cursor', async () => {
  const changes = {
    a: { changes: [{ fileId: 'doc00000a1', file: file('doc00000a1') }], nextPageToken: 'b' },
    b: { changes: [{ fileId: 'doc00000b1', file: file('doc00000b1') }], nextPageToken: 'c' },
    c: { changes: [], newStartPageToken: 'd' },
  }
  const exports = { doc00000a1: 'a', doc00000b1: 'b' }
  const r = await setup(fakeDrive({ changes, exports }), { maxPagesPerSync: 2 }).registry.sync('gdrive', { cursor: driveCursor({ s: 'a' }) })
  assert.deepEqual(r.documents.map((d) => d.id), ['doc00000a1', 'doc00000b1'])
  assert.deepEqual(parseDriveCursor(r.cursor), { s: 'c' })
  const r2 = await setup(fakeDrive({ changes, exports })).registry.sync('gdrive', { cursor: r.cursor })
  assert.deepEqual(parseDriveCursor(r2.cursor), { s: 'd' })
})

test('gdrive: a change token Google refuses starts one fresh full sync', async () => {
  const { registry, seen } = setup(fakeDrive({ changes: { old: 'bad' } }))
  const r = await registry.sync('gdrive', { cursor: driveCursor({ s: 'old' }) })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['doc000001', 'sheet00001', 'pdf000001'])
  assert.equal(seen.starts, 1)
  assert.deepEqual(parseDriveCursor(r.cursor), { s: 'start-1' })
})

test('gdrive: a file Google will not export is kept as details only; the sync carries on', async () => {
  const exports = {
    doc000001: { status: 403, body: { error: { code: 403, errors: [{ reason: 'exportSizeLimitExceeded' }] } } },
    sheet00001: 'a,b',
  }
  const r = await setup(fakeDrive({ exports })).registry.sync('gdrive')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const doc = r.documents.find((d) => d.id === 'doc000001')
  assert.match(doc.text, /Google would not export this file/)
  assert.equal(doc.meta.exported, false)
  assert.match(r.documents.find((d) => d.id === 'sheet00001').text, /a,b/)
})

test("gdrive: Drive's 403 rate limit is backed off and retried, not reported as a sign-in problem", async () => {
  const drive = fakeDrive()
  let first = true
  const respond = ({ url, init }) => {
    if (first && url.includes('/drive/v3/files') && !url.includes('/export')) {
      first = false
      return { status: 403, body: { error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded' }] } } }
    }
    return drive.respond({ url, init })
  }
  const { registry, sleeps } = setup({ respond, seen: drive.seen })
  const r = await registry.sync('gdrive')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(sleeps.length, 1)
})

test('gdrive: an export cut short keeps the first part; very long text is shortened', () => {
  const long = 'x'.repeat(200_000)
  const doc = fileToDocument(file('doc000009'), { content: long })
  assert.ok(doc.text.length < 151_000)
  assert.match(doc.text, /\[… shortened\]$/)
})

test('gdrive: odd ids, links and types are handled safely', () => {
  assert.equal(fileToDocument({ id: 'bad id!' }), null)
  assert.equal(fileToDocument(file('abc/def12')), null)
  const odd = fileToDocument(file('doc000010', { webViewLink: 'https://evil.example/x', name: '', owners: [] }))
  assert.equal(odd.url, undefined)
  assert.equal(odd.title, '(untitled)')
  assert.equal(odd.author, undefined)
  assert.equal(exportType(file('x', { mimeType: 'application/vnd.google-apps.presentation' })), null, 'Slides are not read')
  assert.equal(exportType(file('x', { mimeType: 'text/plain' })), null, 'binary and plain files are not downloaded')
})

test('gdrive: a cursor that is not ours means a fresh full sync', () => {
  for (const bad of [null, '', 'nope', '{"v":2,"s":"x"}', '{"v":1,"s":"has space"}', '{"v":1}', '{"v":1,"f":"only-a-page"}']) {
    assert.deepEqual(parseDriveCursor(bad), {}, String(bad))
  }
  assert.deepEqual(parseDriveCursor('{"v":1,"st":"a","f":"b"}'), { st: 'a', f: 'b' })
})

test('gdrive: search_files escapes the phrase so it cannot add query clauses', async () => {
  const search = [file('doc000001', { name: 'Budget notes' }), file('pdf000001', { name: 'Contract.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/pdf000001/view' }), file('folder0001', { mimeType: MIME.folder })]
  const { registry, seen } = setup(fakeDrive({ search }))
  const res = await registry.callTool(connectorToolName('gdrive', 'read', 'search_files'), { query: "budget' or name contains 'x", limit: 99 })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  const out = body(res)
  assert.deepEqual(out.files.map((f) => f.id), ['doc000001', 'pdf000001'])
  assert.equal(out.files[0].readable, true)
  assert.equal(out.files[1].readable, false)
  assert.equal(out.files[1].type, 'PDF')
  const q = seen.lists[0]
  assert.equal(q.q, "fullText contains 'budget\\' or name contains \\'x' and trashed = false and mimeType != 'application/vnd.google-apps.folder'")
  assert.equal(q.pageSize, '25')
  assert.equal(driveQueryLiteral('a\\b\u0000c'), "'a\\\\b c'")
})

test('gdrive: read_file returns a Doc\'s text, and only details for other files', async () => {
  const files = {
    doc000001: file('doc000001', { name: 'Budget notes' }),
    pdf000001: file('pdf000001', { name: 'Contract.pdf', mimeType: 'application/pdf' }),
  }
  const { registry, seen } = setup(fakeDrive({ files }))
  const name = connectorToolName('gdrive', 'read', 'read_file')
  const doc = body(await registry.callTool(name, { id: 'doc000001' }))
  assert.equal(doc.name, 'Budget notes')
  assert.equal(doc.content, 'The budget for Q4 is 12,000.\nKeep it lean.')
  const pdf = body(await registry.callTool(name, { id: 'pdf000001' }))
  assert.equal(pdf.content, undefined)
  assert.match(pdf.note, /does not open/)
  assert.deepEqual(seen.exports.map((e) => e.id), ['doc000001'])
  const bad = await registry.callTool(name, { id: '../../about?x=' })
  assert.equal(bad.isError, true)
  assert.ok(!seen.gets.some((g) => g.includes('about')))
})

test('gdrive: the read tools are offered as read-only and pass the policy engine', () => {
  const { registry } = setup()
  const names = registry.tools().map((t) => t.name)
  assert.ok(names.includes(connectorMcpName('gdrive', 'read', 'search_files')))
  assert.ok(names.includes(connectorMcpName('gdrive', 'read', 'read_file')))
  assert.ok(registry.tools().filter((t) => t.name.includes('gdrive')).every((t) => t.readOnly))
  for (const n of ['search_files', 'read_file']) assert.equal(registry.policyRule(connectorToolName('gdrive', 'read', n)).allow, true)
})

test('gdrive: test() names the account; disconnect revokes and forgets the tokens', async () => {
  const { registry, credentials, seen, lines } = setup()
  const t = await registry.test('gdrive')
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.match(t.detail, /Me <me@example.com>/)
  const d = await registry.disconnect('gdrive')
  assert.equal(d.ok, true)
  assert.equal(seen.revokes, 1)
  assert.deepEqual(credentials.describe('gdrive').keys, [])
  assert.equal(registry.status('gdrive').state, 'disconnected')
  for (const l of lines) assert.ok(!l.includes(REFRESH) && !l.includes(ACCESS))
})
