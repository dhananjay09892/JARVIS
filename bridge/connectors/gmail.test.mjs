/**
 * Gmail connector (task C06): the shared connector test pack plus Gmail's own
 * acceptance tests — full and incremental sync, history too old, the
 * per-sync cap carried in the cursor, MIME to text, the read-only search
 * tool, and disconnect revoking. Google is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gmailConnector, messageToDocument, messageBody, htmlToText, parseGmailCursor, gmailCursor,
  GMAIL_API, GMAIL_HOST,
} from './gmail.mjs'
import { createGoogleClient, GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPES } from './google-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry, connectorToolName, connectorMcpName } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'
import { openDocumentStore } from './store.mjs'

const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com'
const REFRESH = '1//gmail-refresh-token-abcdefghijklmnopqrstuvwxyz'
const ACCESS = 'ya29.gmail-access-abcdefghijklmnop'
const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64url')

function googleClient() {
  const c = createGoogleClient(createMemoryCredentialStore().scoped(GOOGLE_CLIENT_ID))
  c.save({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-gmail-test-secret' })
  return c
}

/** A message as users.messages.get?format=full returns it. */
function fullMessage(id, { subject = `Subject ${id}`, from = 'Alice <alice@example.com>', body = `Body of ${id}`, labels = ['INBOX'], at = 1_790_000_000_000 } = {}) {
  return {
    id,
    threadId: `t${id}`,
    labelIds: labels,
    snippet: `snippet ${id}`,
    internalDate: String(at),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Mon, 19 Oct 2026 09:00:00 +0000' },
      ],
      parts: [
        { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64(body) } },
        { mimeType: 'text/html', headers: [], body: { data: b64(`<p>${body}</p>`) } },
      ],
    },
  }
}

/**
 * A fake Gmail. `messages` is newest first. `history` maps a start id to
 * `{ added: [ids or {id, labels}], historyId }` (or raw `{ records, historyId }`), or 404 when absent.
 */
function fakeGmail({ messages = ['m3', 'm2', 'm1'], profileHistory = '1000', history = {}, injection, deleted = [], seen = { gets: [], lists: [], history: [], revokes: 0, refreshes: 0 } } = {}) {
  const store = new Map(messages.map((id, i) => [id, fullMessage(id, { at: 1_790_000_000_000 - i * 1000 })]))
  if (injection) store.set(messages[0], fullMessage(messages[0], { subject: `Re: ${injection.slice(0, 40)}`, body: injection }))
  const respond = ({ url, init }) => {
    if (url === GOOGLE_TOKEN_URL) {
      seen.refreshes++
      return { body: { access_token: ACCESS, expires_in: 3599, scope: GOOGLE_SCOPES.gmail.join(' '), token_type: 'Bearer' } }
    }
    if (url === GOOGLE_REVOKE_URL) {
      seen.revokes++
      return { status: 200, body: '' }
    }
    const u = new URL(url)
    assert.equal(u.hostname, GMAIL_HOST)
    assert.equal(init.headers.authorization, `Bearer ${ACCESS}`)
    const path = u.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/profile') return { body: { emailAddress: 'me@example.com', historyId: profileHistory } }
    if (path === '/messages') {
      seen.lists.push(Object.fromEntries(u.searchParams))
      const max = Number(u.searchParams.get('maxResults'))
      const start = Number(u.searchParams.get('pageToken') ?? 0)
      const ids = messages.slice(start, start + max)
      const next = start + max < messages.length ? String(start + max) : undefined
      return { body: { messages: ids.map((id) => ({ id, threadId: `t${id}` })), ...(next ? { nextPageToken: next } : {}) } }
    }
    if (path === '/history') {
      const start = u.searchParams.get('startHistoryId')
      seen.history.push({ ...Object.fromEntries(u.searchParams), historyTypes: u.searchParams.getAll('historyTypes') })
      const h = history[start]
      if (!h) return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.' } } }
      if (h.records) return { body: { history: h.records, historyId: h.historyId } }
      return {
        body: {
          history: h.added.map((a) => {
            const { id, labels = ['INBOX'] } = typeof a === 'string' ? { id: a } : a
            return { id: '1', messagesAdded: [{ message: { id, threadId: `t${id}`, labelIds: labels } }] }
          }),
          historyId: h.historyId,
        },
      }
    }
    const m = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(path)
    if (m) {
      seen.gets.push({ id: m[1], format: u.searchParams.get('format') })
      if (deleted.includes(m[1])) return { status: 404, body: { error: { code: 404 } } }
      const msg = store.get(m[1]) ?? fullMessage(m[1])
      return { body: msg }
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = gmailConnector({ googleClient: googleClient() })

// The shared pack: untrusted sync, injection, auth failure, revoked, rate limit, offline, erase, writes, kill switches.
for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeGmail({ injection }).respond({ url, init }),
  onlyHosts: [GMAIL_HOST, 'oauth2.googleapis.com'],
})) test(name, run)

function setup(gmail = fakeGmail(), { maxPerSync } = {}) {
  const credentials = createMemoryCredentialStore()
  credentials.set('gmail', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => gmail.respond({ url, init }))
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log })
  const f = maxPerSync ? gmailConnector({ googleClient: googleClient(), maxPerSync }) : factory
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, lines, seen: gmail.seen }
}

test('gmail: card is read-only Google sign-in with only gmail.readonly', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'gmail')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['https://www.googleapis.com/auth/gmail.readonly'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'search_mail', capability: 'read' }])
  assert.throws(() => gmailConnector({}), /shared Google client/)
})

test('gmail: full sync maps messages to documents with ids, times and a history cursor', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('gmail')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['m3', 'm2', 'm1'])
  const d = r.documents[0]
  assert.equal(d.title, 'Subject m3')
  assert.equal(d.author, 'Alice <alice@example.com>')
  assert.equal(d.updatedAt, 1_790_000_000_000)
  assert.equal(d.createdAt, 1_790_000_000_000)
  assert.equal(d.sensitivity, 'messages')
  assert.equal(d.travel, 'private')
  assert.equal(d.url, 'https://mail.google.com/mail/u/0/#all/tm3')
  assert.equal(d.meta.threadId, 'tm3')
  assert.match(d.text, /From: Alice/)
  assert.match(d.text, /Body of m3/)
  assert.ok(!d.text.includes('<p>'), 'plain part preferred over HTML')
  assert.deepEqual(parseGmailCursor(r.cursor), { h: '1000', p: [] })
  assert.ok(seen.gets.every((g) => g.format === 'full'))
})

test('gmail: incremental sync fetches only new messages and skips drafts and spam', async () => {
  const gmail = fakeGmail({ history: { 1000: { added: ['m4', { id: 'd1', labels: ['DRAFT'] }, { id: 's1', labels: ['SPAM'] }, 'm5', 'm4'], historyId: '1010' }, 1010: { added: [], historyId: '1010' } } })
  const { registry, seen } = setup(gmail)
  const r = await registry.sync('gmail', { cursor: gmailCursor('1000') })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['m4', 'm5'])
  assert.equal(seen.lists.length, 0, 'no full listing on an incremental sync')
  assert.deepEqual(seen.history[0].historyTypes, ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'])
  assert.deepEqual(r.deleted, [])
  assert.deepEqual(parseGmailCursor(r.cursor), { h: '1010', p: [] })

  const again = await registry.sync('gmail', { cursor: r.cursor })
  assert.equal(again.ok, true)
  assert.equal(again.documents.length, 0, 'nothing new since 1010')
  assert.equal(again.ok && seen.history.length, 2)
})

test('gmail: history too old (404) falls back to a full sync', async () => {
  const gmail = fakeGmail({ profileHistory: '2000' })
  const { registry, seen } = setup(gmail)
  const r = await registry.sync('gmail', { cursor: gmailCursor('5') })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(seen.history.length, 1)
  assert.equal(seen.lists.length, 1)
  assert.deepEqual(r.documents.map((d) => d.id), ['m3', 'm2', 'm1'])
  assert.deepEqual(parseGmailCursor(r.cursor), { h: '2000', p: [] })
})

test('gmail: at most maxPerSync full messages per sync; the rest wait in the cursor', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `n${12 - i}`)
  // Nothing new arrives in between: history stays at 1000.
  const { registry, seen } = setup(fakeGmail({ messages: ids, history: { 1000: { added: [], historyId: '1000' } } }), { maxPerSync: 5 })
  const first = await registry.sync('gmail')
  assert.equal(first.ok, true)
  assert.deepEqual(first.documents.map((d) => d.id), ids.slice(0, 5))
  assert.deepEqual(parseGmailCursor(first.cursor).p, ids.slice(5))
  const second = await registry.sync('gmail', { cursor: first.cursor })
  assert.deepEqual(second.documents.map((d) => d.id), ids.slice(5, 10))
  const third = await registry.sync('gmail', { cursor: second.cursor })
  assert.deepEqual(third.documents.map((d) => d.id), ids.slice(10))
  assert.deepEqual(parseGmailCursor(third.cursor).p, [])
  assert.equal(seen.gets.length, 12, 'each message fetched once')
})

test('gmail: "since" limits the first sync with after:<seconds>', async () => {
  const { registry, seen } = setup()
  await registry.sync('gmail', { since: 1_790_000_000_500 })
  assert.equal(seen.lists[0].q, 'after:1790000000')
})

test('gmail: a message deleted between listing and fetching is skipped', async () => {
  const { registry } = setup(fakeGmail({ deleted: ['m2'] }))
  const r = await registry.sync('gmail')
  assert.equal(r.ok, true)
  assert.deepEqual(r.documents.map((d) => d.id), ['m3', 'm1'])
  assert.deepEqual(r.deleted, [{ connectorId: 'gmail', id: 'm2' }])
})

const msgRef = (id, labelIds = ['INBOX']) => ({ message: { id, threadId: `t${id}`, labelIds } })

test('gmail: deleted, trashed and spammed messages leave the store; restored ones come back (C96)', async () => {
  const records = [
    { id: '1001', messagesDeleted: [msgRef('m1', [])] },
    { id: '1002', labelsAdded: [{ ...msgRef('m2', ['TRASH']), labelIds: ['TRASH'] }] },
    { id: '1003', labelsAdded: [{ ...msgRef('m3', ['SPAM']), labelIds: ['SPAM'] }] },
    { id: '1004', labelsRemoved: [{ ...msgRef('m3', ['INBOX']), labelIds: ['SPAM'] }] }, // not spam after all
    { id: '1005', labelsAdded: [{ ...msgRef('m3', ['INBOX', 'STARRED']), labelIds: ['STARRED'] }] }, // ordinary label: no change
    { id: '1006', messagesAdded: [msgRef('m9')] },
    { id: '1007', messagesDeleted: [msgRef('m9', [])] }, // added and deleted in the same window
    { id: '1008', messagesDeleted: [{ message: { id: 'bad id' } }] },
  ]
  const store = openDocumentStore({ file: ':memory:', now: () => 1_790_000_100_000 })
  const first = setup(fakeGmail())
  store.ingest('gmail', await first.registry.sync('gmail'))
  assert.deepEqual(['m1', 'm2', 'm3'].map((id) => Boolean(store.get('gmail', id))), [true, true, true])

  const gmail = fakeGmail({ history: { 1000: { records, historyId: '1008' } }, deleted: ['m9'] })
  const { registry, seen } = setup(gmail)
  const r = await registry.sync('gmail', { cursor: store.state('gmail').cursor })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['m3'], 'taken out of spam: fetched again')
  assert.deepEqual(r.deleted.map((d) => d.id).sort(), ['m1', 'm2', 'm9'])
  assert.ok(!seen.gets.some((g) => g.id === 'm9'), 'a message deleted before it was fetched is not fetched')
  const counts = store.ingest('gmail', r)
  assert.equal(counts.removed, 2)
  assert.equal(store.get('gmail', 'm1'), null)
  assert.equal(store.get('gmail', 'm2'), null)
  assert.ok(store.get('gmail', 'm3'))
  assert.deepEqual(parseGmailCursor(store.state('gmail').cursor), { h: '1008', p: [] })
  store.close()
})

test('gmail: a pending message deleted before its turn is dropped from the cursor', async () => {
  const records = [{ id: '1001', messagesDeleted: [msgRef('n2', [])] }]
  const { registry, seen } = setup(fakeGmail({ history: { 1000: { records, historyId: '1001' } } }))
  const r = await registry.sync('gmail', { cursor: gmailCursor('1000', ['n1', 'n2', 'n3']) })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['n1', 'n3'])
  assert.deepEqual(r.deleted, [{ connectorId: 'gmail', id: 'n2' }])
  assert.ok(!seen.gets.some((g) => g.id === 'n2'))
})

test('gmail: a bad cursor is ignored, not trusted', () => {
  assert.equal(parseGmailCursor('nonsense'), null)
  assert.equal(parseGmailCursor(JSON.stringify({ v: 1, h: '../x', p: [] })), null)
  assert.deepEqual(parseGmailCursor(JSON.stringify({ v: 1, h: '7', p: ['ok1', '../../etc', 5] })), { h: '7', p: ['ok1'] })
})

test('gmail MIME: HTML-only mail becomes text; attachments are listed, never fetched', () => {
  const msg = {
    id: 'h1',
    labelIds: ['INBOX'],
    internalDate: '1790000000000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'Subject', value: 'Invoice' }, { name: 'From', value: 'Shop <shop@example.com>' }],
      parts: [
        { mimeType: 'text/html', headers: [], body: { data: b64('<html><head><style>p{}</style></head><body><p>Total:&nbsp;&pound;5 &amp; &#8364;3</p><script>alert(1)</script><br>Thanks</body></html>') } },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', headers: [], body: { attachmentId: 'ATT1', size: 1000 } },
      ],
    },
  }
  const d = messageToDocument(msg)
  assert.match(d.text, /Total: &pound;5 & €3\nThanks/)
  assert.ok(!/alert|<p>|style/.test(d.text))
  assert.match(d.text, /Attachments \(not opened\): invoice\.pdf \(application\/pdf\)/)
  assert.equal(d.meta.attachments, 1)
})

test('gmail MIME: charset is honoured; drafts, spam and bad ids are skipped', () => {
  const latin = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }], body: { data: b64('café', 'latin1') } }
  assert.equal(messageBody(latin).text, 'café')
  assert.equal(messageToDocument(fullMessage('x', { labels: ['DRAFT'] })), null)
  assert.equal(messageToDocument(fullMessage('x', { labels: ['SPAM'] })), null)
  assert.equal(messageToDocument({ ...fullMessage('x'), id: '../x' }), null)
  assert.equal(htmlToText('<div>a</div><div>b</div>'), 'a\nb')
})

test('gmail: search_mail is a read tool, results wrapped as untrusted, no host but Google', async () => {
  const { registry, calls, seen } = setup()
  const name = connectorToolName('gmail', 'read', 'search_mail')
  assert.ok(registry.tools().some((t) => t.name === connectorMcpName('gmail', 'read', 'search_mail') && t.readOnly))
  const res = await registry.callTool(name, { query: 'from:bank\nnewer_than:7d', limit: 2 })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  const text = res.content[0].text
  assert.match(text, /^<untrusted_data/)
  assert.match(text, /Subject m3/)
  assert.equal(seen.lists[0].q, 'from:bank newer_than:7d')
  assert.equal(seen.lists[0].maxResults, '2')
  assert.ok(seen.gets.every((g) => g.format === 'metadata'))
  for (const c of calls) assert.ok([GMAIL_HOST, 'oauth2.googleapis.com'].includes(new URL(c.url).hostname))
  assert.ok(calls.every((c) => c.method === 'GET' || c.url === GOOGLE_TOKEN_URL), 'nothing but reads and a token refresh')
})

test('gmail: Test names the mailbox; disconnect revokes at Google and forgets tokens', async () => {
  const { registry, credentials, seen, lines } = setup()
  const t = await registry.test('gmail')
  assert.equal(t.ok, true)
  assert.match(t.detail, /me@example\.com/)
  const d = await registry.disconnect('gmail')
  assert.equal(d.ok, true)
  assert.equal(seen.revokes, 1)
  assert.deepEqual(credentials.describe('gmail').keys, [])
  assert.equal(registry.status('gmail').state, 'disconnected')
  for (const s of [REFRESH, ACCESS]) assert.ok(!lines.join('\n').includes(s))
})

test('gmail: every API URL is under the Gmail API base', () => {
  assert.equal(GMAIL_API, 'https://gmail.googleapis.com/gmail/v1/users/me')
})
