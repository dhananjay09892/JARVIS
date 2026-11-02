/**
 * Outlook mail (task C21): the shared connector test pack plus Outlook's own
 * acceptance tests — first sync over Graph delta, incremental sync from the
 * deltaLink, deletions and moves out of the Inbox, drafts skipped, the
 * per-sync cap carried in the cursor (nextLink), an expired delta token,
 * foreign links refused, HTML to text, the read-only search tool, and
 * disconnect. Microsoft is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  outlookConnector, messageToDocument, parseOutlookCursor, outlookCursor, isOwnDeltaLink, recipient,
  GRAPH_HOST, GRAPH_API, INBOX_DELTA,
} from './outlook.mjs'
import { createMicrosoftClient, MICROSOFT_CLIENT_ID, MICROSOFT_TOKEN_URL, MICROSOFT_LOGIN_HOST } from './microsoft-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry, connectorToolName } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'

const CLIENT_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const REFRESH = 'M.C5-outlook-refresh-abcdefghijklmnopqrstuvwxyz'
const ACCESS = 'EwB-outlook-access-abcdefghijklmnop'
const NOW = 1_800_000_000_000
const ID = (n) => `AAMkAGI2THVSAAA${n}=`

function microsoftClient() {
  const c = createMicrosoftClient(createMemoryCredentialStore().scoped(MICROSOFT_CLIENT_ID))
  c.save({ clientId: CLIENT_ID })
  return c
}

function graphMessage(n, { subject = `Subject ${n}`, body = `Body of ${n}`, contentType = 'text', draft = false, at = NOW - 3_600_000, attachments = false } = {}) {
  return {
    id: ID(n),
    subject,
    from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Me', address: 'me@outlook.com' } }],
    ccRecipients: [],
    receivedDateTime: new Date(at).toISOString().replace('.000', ''),
    body: { contentType, content: body },
    bodyPreview: `preview ${n}`,
    hasAttachments: attachments,
    isDraft: draft,
    webLink: `https://outlook.live.com/owa/?ItemID=${encodeURIComponent(ID(n))}&exvsurl=1&viewmodel=ReadMessageItem`,
    conversationId: `conv${n}`,
  }
}

/**
 * A fake Graph. `inbox` is the first round's messages; pages of `pageSize`
 * (from the Prefer header). `rounds` maps a deltatoken to the next round's
 * entries (messages or { removed: n }) — absent tokens answer 410 Gone.
 */
function fakeGraph({ inbox = [graphMessage(1), graphMessage(2), graphMessage(3)], rounds = {}, injection, seen = { deltas: [], prefer: [], searches: [], refreshes: 0 } } = {}) {
  const first = injection ? [graphMessage(9, { subject: `Re: ${injection.slice(0, 40)}`, body: injection }), ...inbox] : inbox
  let token = 1
  const pages = (entries, size, nextToken) => {
    const out = []
    for (let i = 0; i < Math.max(1, entries.length); i += size) out.push(entries.slice(i, i + size))
    return out.map((value, i) => ({ value, last: i === out.length - 1, nextToken }))
  }
  const sessions = new Map() // skiptoken -> page
  const reply = (list) => {
    const [head, ...rest] = list
    let next
    if (rest.length) {
      next = `s${token++}`
      sessions.set(next, rest)
    }
    const value = head.value.map((e) => (e.removed !== undefined ? { '@odata.type': '#microsoft.graph.message', id: ID(e.removed), '@removed': { reason: 'deleted' } } : e))
    const body = { '@odata.context': 'x', value }
    if (next) body['@odata.nextLink'] = `${GRAPH_API}/me/mailFolders('inbox')/messages/delta?$skiptoken=${next}`
    else body['@odata.deltaLink'] = `${GRAPH_API}/me/mailFolders('inbox')/messages/delta?$deltatoken=${head.nextToken}`
    return { body }
  }
  const respond = ({ url, init }) => {
    if (url === MICROSOFT_TOKEN_URL) {
      seen.refreshes++
      return { body: { token_type: 'Bearer', scope: 'https://graph.microsoft.com/Mail.Read', expires_in: 3600, access_token: ACCESS, refresh_token: REFRESH } }
    }
    const u = new URL(url)
    assert.equal(u.hostname, GRAPH_HOST)
    assert.equal(init.headers.authorization, `Bearer ${ACCESS}`)
    if (u.pathname === '/v1.0/me/mailFolders/inbox') return { body: { displayName: 'Inbox', totalItemCount: 42 } }
    if (u.pathname === '/v1.0/me/mailFolders/inbox/messages') {
      seen.searches.push(Object.fromEntries(u.searchParams))
      return { body: { value: [{ id: ID(1), subject: 'Invoice', from: { emailAddress: { address: 'bank@example.com' } }, receivedDateTime: '2026-10-30T09:00:00Z', bodyPreview: 'Your invoice' }] } }
    }
    if (/\/messages\/delta$/.test(u.pathname)) {
      seen.deltas.push(Object.fromEntries(u.searchParams))
      seen.prefer.push(init.headers.prefer)
      const size = Number(/odata\.maxpagesize=(\d+)/.exec(init.headers.prefer ?? '')?.[1] ?? 10)
      const skip = u.searchParams.get('$skiptoken')
      if (skip) {
        const rest = sessions.get(skip)
        if (!rest) return { status: 410, body: { error: { code: 'SyncStateNotFound' } } }
        sessions.delete(skip)
        return reply(rest)
      }
      const dt = u.searchParams.get('$deltatoken')
      if (dt) {
        const r = rounds[dt]
        if (!r) return { status: 410, body: { error: { code: 'SyncStateNotFound' } } }
        return reply(pages(r.entries, size, r.next))
      }
      return reply(pages(first, size, 'd1'))
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = outlookConnector({ microsoftClient: microsoftClient() })

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeGraph({ injection }).respond({ url, init }),
  onlyHosts: [GRAPH_HOST, MICROSOFT_LOGIN_HOST],
})) test(name, run)

function setup(graph = fakeGraph(), { maxPerSync } = {}) {
  const credentials = createMemoryCredentialStore()
  credentials.set('outlook', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => graph.respond({ url, init }))
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log, now: () => NOW })
  const f = maxPerSync ? outlookConnector({ microsoftClient: microsoftClient(), maxPerSync }) : factory
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, lines, seen: graph.seen }
}

test('outlook: card is a read-only Microsoft sign-in with Mail.Read only', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'outlook')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['https://graph.microsoft.com/Mail.Read', 'offline_access'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'search_mail', capability: 'read' }])
  assert.throws(() => outlookConnector({}), /shared Microsoft client/)
})

test('outlook: first sync reads the Inbox delta from 30 days back and keeps the deltaLink', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('outlook')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), [ID(1), ID(2), ID(3)])
  const d = r.documents[0]
  assert.equal(d.title, 'Subject 1')
  assert.equal(d.author, 'Alice <alice@example.com>')
  assert.equal(d.sensitivity, 'messages')
  assert.equal(d.travel, 'private')
  assert.equal(d.updatedAt, NOW - 3_600_000)
  assert.match(d.text, /From: Alice <alice@example\.com>/)
  assert.match(d.text, /Body of 1/)
  assert.match(d.url, /^https:\/\/outlook\.live\.com\//)
  assert.equal(d.meta.folder, 'Inbox')
  const q = seen.deltas[0]
  assert.equal(q.$filter, `receivedDateTime ge ${new Date(NOW - 30 * 86_400_000).toISOString()}`)
  assert.match(q.$select, /\bbody\b/)
  assert.match(seen.prefer[0], /odata\.maxpagesize=50/)
  assert.match(seen.prefer[0], /outlook\.body-content-type="text"/)
  assert.ok(parseOutlookCursor(r.cursor).delta.endsWith('$deltatoken=d1'))
})

test('outlook: incremental sync yields only changes; deletions and moves out of the Inbox leave the store', async () => {
  const graph = fakeGraph({ rounds: { d1: { entries: [graphMessage(4), { removed: 2 }, graphMessage(5, { draft: true })], next: 'd2' }, d2: { entries: [], next: 'd2' } } })
  const { registry, seen } = setup(graph)
  const first = await registry.sync('outlook')
  const r = await registry.sync('outlook', { cursor: first.cursor })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), [ID(4)])
  assert.deepEqual(r.deleted.map((x) => x.id).sort(), [ID(2), ID(5)].sort(), 'removed and drafts have no stored copy')
  assert.equal(seen.deltas[1].$filter, undefined, 'later rounds are the deltaLink only')
  assert.ok(parseOutlookCursor(r.cursor).delta.endsWith('$deltatoken=d2'))
  const again = await registry.sync('outlook', { cursor: r.cursor })
  assert.equal(again.ok, true)
  assert.equal(again.documents.length, 0)
})

test('outlook: at most maxPerSync messages per sync; the rest wait in the nextLink cursor', async () => {
  const inbox = Array.from({ length: 12 }, (_, i) => graphMessage(i + 1))
  const { registry, seen } = setup(fakeGraph({ inbox }), { maxPerSync: 5 })
  const a = await registry.sync('outlook')
  assert.equal(a.ok, true, JSON.stringify(a.error))
  assert.deepEqual(a.documents.map((d) => d.id), inbox.slice(0, 5).map((m) => m.id))
  assert.match(seen.prefer[0], /odata\.maxpagesize=5\b/)
  assert.ok(parseOutlookCursor(a.cursor).next)
  const b = await registry.sync('outlook', { cursor: a.cursor })
  assert.deepEqual(b.documents.map((d) => d.id), inbox.slice(5, 10).map((m) => m.id))
  const c = await registry.sync('outlook', { cursor: b.cursor })
  assert.deepEqual(c.documents.map((d) => d.id), inbox.slice(10).map((m) => m.id))
  assert.ok(parseOutlookCursor(c.cursor).delta, 'round finished')
})

test('outlook: an expired delta token (410) starts a fresh round', async () => {
  const { registry, seen } = setup()
  const stale = outlookCursor({ delta: `${GRAPH_API}/me/mailFolders('inbox')/messages/delta?$deltatoken=gone` })
  const r = await registry.sync('outlook', { cursor: stale })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(seen.deltas.length, 2)
  assert.ok(seen.deltas[1].$filter, 'fresh round with the lookback filter')
  assert.equal(r.documents.length, 3)
})

test('outlook: cursors and links off our Graph path are refused', () => {
  assert.equal(isOwnDeltaLink(`${INBOX_DELTA}?$deltatoken=x`), true)
  assert.equal(isOwnDeltaLink(`${GRAPH_API}/me/mailFolders('inbox')/messages/delta?$skiptoken=x`), true)
  assert.equal(isOwnDeltaLink('https://evil.example/v1.0/me/mailFolders/inbox/messages/delta'), false)
  assert.equal(isOwnDeltaLink(`http://${GRAPH_HOST}/v1.0/me/mailFolders/inbox/messages/delta`), false)
  assert.equal(isOwnDeltaLink(`https://${GRAPH_HOST}/v1.0/me/messages/delta`), false)
  assert.equal(isOwnDeltaLink(`https://${GRAPH_HOST}/v1.0/users/other@x.com/mailFolders/inbox/messages/delta`), false)
  assert.equal(isOwnDeltaLink(`https://user:pw@${GRAPH_HOST}/v1.0/me/mailFolders/inbox/messages/delta`), false)
  assert.equal(parseOutlookCursor(JSON.stringify({ v: 1, d: 'https://evil.example/x' })), null)
  assert.equal(parseOutlookCursor('not json'), null)
})

test('outlook: a nextLink to another host is refused, not followed', async () => {
  const graph = {
    seen: {},
    respond: ({ url }) => {
      if (url === MICROSOFT_TOKEN_URL) return { body: { access_token: ACCESS, expires_in: 3600, scope: 'Mail.Read' } }
      return { body: { value: [graphMessage(1)], '@odata.nextLink': 'https://evil.example/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=1' } }
    },
  }
  const { registry, calls } = setup(graph)
  const r = await registry.sync('outlook')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'egress')
  assert.ok(calls.every((c) => new URL(c.url).hostname !== 'evil.example'))
})

test('outlook: HTML bodies become text; recipients read as Name <address>', () => {
  const d = messageToDocument(graphMessage(7, { contentType: 'html', body: '<p>Hello <b>there</b></p><script>x()</script>', attachments: true }))
  assert.match(d.text, /Hello there/)
  assert.ok(!d.text.includes('<p>') && !d.text.includes('x()'))
  assert.match(d.text, /Attachments: yes \(not opened\)/)
  assert.equal(d.meta.attachments, true)
  assert.equal(recipient({ emailAddress: { name: 'bob@x.com', address: 'bob@x.com' } }), 'bob@x.com')
  assert.equal(messageToDocument({ id: 'bad id with spaces' }), null)
  assert.equal(messageToDocument(graphMessage(8, { draft: true })), null)
  const foreign = messageToDocument({ ...graphMessage(9), webLink: 'https://evil.example/x' })
  assert.equal(foreign.url, undefined)
})

test('outlook: search_mail is read-only, quotes the query and returns previews', async () => {
  const { registry, seen } = setup()
  const name = connectorToolName('outlook', 'read', 'search_mail')
  const res = await registry.callTool(name, { query: 'invoice" OR from:x\\', limit: 3 })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  assert.equal(seen.searches[0].$search, '"invoice OR from:x"')
  assert.equal(seen.searches[0].$top, '3')
  const text = JSON.stringify(res)
  assert.match(text, /Invoice/)
  assert.ok(registry.tools().every((t) => t.readOnly))
})

test('outlook: test() reads the Inbox folder; disconnect forgets the tokens', async () => {
  const { registry, credentials } = setup()
  const t = await registry.test('outlook')
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.match(t.detail, /Inbox \(42 messages\)/)
  const r = await registry.disconnect('outlook')
  assert.equal(r.ok, true)
  assert.deepEqual(credentials.describe('outlook').keys, [])
})
