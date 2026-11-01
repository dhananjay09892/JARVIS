/**
 * Google Contacts connector (task C18): the shared connector test pack plus
 * Contacts' own acceptance tests — the minimal field mask, full and
 * incremental sync by sync token, an expired sync token, the page budget
 * carried in the cursor, deleted contacts (deletion markers, task C96), the
 * read-only find_contact tool, and disconnect revoking.
 * Google is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gcontactsConnector, personToDocument, contactFields, parseContactsCursor, contactsCursor,
  PEOPLE_HOST, PERSON_FIELDS,
} from './gcontacts.mjs'
import { createGoogleClient, GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPES } from './google-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry, connectorToolName, connectorMcpName } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'
import { openDocumentStore } from './store.mjs'

const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com'
const REFRESH = '1//gcontacts-refresh-token-abcdefghijklmnopqrstuvwxyz'
const ACCESS = 'ya29.gcontacts-access-abcdefghijklmnop'
const NOW = Date.parse('2026-11-01T12:00:00Z')

function googleClient() {
  const c = createGoogleClient(createMemoryCredentialStore().scoped(GOOGLE_CLIENT_ID))
  c.save({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-gcontacts-test-secret' })
  return c
}

function person(id, { name = `Person ${id}`, emails = [`${id}@example.com`], phones = ['+44 20 7946 0000'], updated = '2026-10-20T08:00:00Z', ...rest } = {}) {
  return {
    resourceName: `people/${id}`,
    etag: `%E${id}`,
    metadata: { sources: [{ type: 'CONTACT', id, updateTime: updated }] },
    names: name ? [{ displayName: name, givenName: name.split(' ')[0], metadata: { primary: true } }] : [],
    emailAddresses: emails.map((value, i) => ({ value, type: i ? 'work' : 'home', formattedType: i ? 'Work' : 'Home', metadata: { primary: i === 0 } })),
    phoneNumbers: phones.map((value) => ({ value, canonicalForm: value.replace(/[^+\d]/g, ''), type: 'mobile', formattedType: 'Mobile' })),
    ...rest,
  }
}

const EXPIRED = {
  error: {
    code: 400,
    message: 'Sync token is expired. Clear local cache and retry call without the sync token.',
    status: 'FAILED_PRECONDITION',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'EXPIRED_SYNC_TOKEN', domain: 'people.googleapis.com' }],
  },
}

/**
 * A fake People API. `pages` is the full-sync list of pages (arrays of
 * people); `changes[syncToken]` is an incremental response, or 'expired'.
 */
function fakePeople({
  pages = [[person('c1', { name: 'Sam Patel' }), person('c2', { name: 'Ann Lee' })]],
  changes = {},
  injection,
  search = [],
  seen = { lists: [], searches: [], revokes: 0 },
} = {}) {
  const respond = ({ url, init }) => {
    if (url === GOOGLE_TOKEN_URL) {
      return { body: { access_token: ACCESS, expires_in: 3599, scope: GOOGLE_SCOPES.gcontacts.join(' '), token_type: 'Bearer' } }
    }
    if (url === GOOGLE_REVOKE_URL) {
      seen.revokes++
      return { status: 200, body: '' }
    }
    const u = new URL(url)
    assert.equal(u.hostname, PEOPLE_HOST)
    assert.equal(init.headers.authorization, `Bearer ${ACCESS}`)
    const q = Object.fromEntries(u.searchParams)
    if (u.pathname === '/v1/people:searchContacts') {
      seen.searches.push(q)
      return { body: q.query ? { results: search.map((p) => ({ person: p })) } : {} }
    }
    if (u.pathname === '/v1/people/me/connections') {
      seen.lists.push(q)
      if (q.pageSize === '1') return { body: { connections: [pages[0]?.[0]].filter(Boolean), totalItems: 2 } }
      if (q.syncToken) {
        assert.equal(q.requestSyncToken, undefined)
        const c = changes[q.syncToken]
        if (!c || c === 'expired') return { status: 400, body: EXPIRED }
        if (Array.isArray(c)) {
          const i = Number(q.pageToken ?? 0)
          const more = i + 1 < c.length
          return { body: { connections: c[i], ...(more ? { nextPageToken: String(i + 1) } : { nextSyncToken: `${q.syncToken}-next` }) } }
        }
        return { body: c }
      }
      assert.equal(q.requestSyncToken, 'true')
      const i = Number(q.pageToken ?? 0)
      let items = pages[i] ?? []
      if (injection && i === 0) {
        items = [person('inj', { name: `Contact ${injection.slice(0, 40)}`, organizations: [{ name: injection.slice(0, 120), title: injection.slice(0, 120) }] }), ...items]
      }
      const more = i + 1 < pages.length
      return { body: { connections: items, totalItems: 2, ...(more ? { nextPageToken: String(i + 1) } : { nextSyncToken: 'sync-1' }) } }
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = gcontactsConnector({ googleClient: googleClient() })

// The shared pack: untrusted sync, injection, auth failure, revoked, rate limit, offline, erase, writes, kill switches.
for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakePeople({ injection }).respond({ url, init }),
  onlyHosts: [PEOPLE_HOST, 'oauth2.googleapis.com'],
})) test(name, run)

function setup(people = fakePeople(), opts = {}) {
  const credentials = createMemoryCredentialStore()
  credentials.set('gcontacts', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => people.respond({ url, init }))
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log, now: () => NOW })
  const f = Object.keys(opts).length ? gcontactsConnector({ googleClient: googleClient(), ...opts }) : factory
  assert.equal(registry.register(f).ok, true)
  return { registry, credentials, calls, lines, seen: people.seen }
}

test('gcontacts: card is read-only Google sign-in with only contacts.readonly', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'gcontacts')
  assert.equal(card.pattern, 'oauth')
  assert.equal(card.risk, 'R1')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['https://www.googleapis.com/auth/contacts.readonly'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'find_contact', capability: 'read' }])
  assert.throws(() => gcontactsConnector({}), /shared Google client/)
})

test('gcontacts: full sync asks only for the minimal fields and maps people to documents', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('gcontacts')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['c1', 'c2'])
  const d = r.documents[0]
  assert.equal(d.title, 'Sam Patel')
  assert.equal(d.updatedAt, Date.parse('2026-10-20T08:00:00Z'))
  assert.equal(d.sensitivity, 'personal')
  assert.equal(d.url, 'https://contacts.google.com/person/c1')
  assert.match(d.text, /Name: Sam Patel\nEmail: c1@example.com \(Home\)\nPhone: \+442079460000 \(Mobile\)/)
  assert.equal(d.meta.email, 'c1@example.com')
  const first = seen.lists[0]
  assert.equal(first.personFields, PERSON_FIELDS)
  for (const f of ['addresses', 'birthdays', 'photos', 'biographies', 'relations']) assert.ok(!first.personFields.includes(f), f)
  assert.equal(first.pageSize, '1000')
  assert.equal(first.requestSyncToken, 'true')
  assert.deepEqual(parseContactsCursor(r.cursor), { s: 'sync-1' })
})

test('gcontacts: incremental sync sends only the sync token and returns only changes; deleted contacts leave', async () => {
  const changes = { s1: { connections: [person('c3', { name: 'New Person' }), { resourceName: 'people/c1', metadata: { deleted: true } }], nextSyncToken: 's2' } }
  const { registry, seen } = setup(fakePeople({ changes }))
  const r = await registry.sync('gcontacts', { cursor: contactsCursor({ s: 's1' }) })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['c3'])
  assert.deepEqual(r.deleted, [{ connectorId: 'gcontacts', id: 'c1' }])
  assert.deepEqual(parseContactsCursor(r.cursor), { s: 's2' })
  assert.equal(seen.lists.length, 1)
  assert.equal(seen.lists[0].syncToken, 's1')
  assert.equal(seen.lists[0].personFields, PERSON_FIELDS, 'same mask as the first call, as Google requires')
})

test('gcontacts: a deleted contact synced incrementally removes the stored copy (C96)', async () => {
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  const full = await setup().registry.sync('gcontacts')
  store.ingest('gcontacts', full)
  assert.ok(store.get('gcontacts', 'c1'))
  const inc = await setup(fakePeople({ changes: { 'sync-1': { connections: [{ resourceName: 'people/c1', metadata: { deleted: true } }], nextSyncToken: 's2' } } }))
    .registry.sync('gcontacts', { cursor: store.state('gcontacts').cursor })
  assert.equal(inc.ok, true, JSON.stringify(inc.error))
  assert.equal(store.ingest('gcontacts', inc).removed, 1)
  assert.equal(store.get('gcontacts', 'c1'), null)
  assert.ok(store.get('gcontacts', 'c2'), 'other contacts stay')
  assert.deepEqual(store.search('Sam'), [])
  store.close()
})

test('gcontacts: an expired sync token (400 EXPIRED_SYNC_TOKEN) restarts with one full sync', async () => {
  const { registry, seen } = setup(fakePeople({ changes: { old: 'expired' } }))
  const r = await registry.sync('gcontacts', { cursor: contactsCursor({ s: 'old' }) })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['c1', 'c2'])
  assert.deepEqual(parseContactsCursor(r.cursor), { s: 'sync-1' })
  assert.equal(seen.lists.length, 2)
  assert.equal(seen.lists[0].syncToken, 'old')
  assert.equal(seen.lists[1].syncToken, undefined)
  assert.equal(registry.status('gcontacts').state, 'ok', 'an expired sync token is not a sign-in problem')
})

test('gcontacts: a page budget stops the sync and the cursor resumes where it stopped', async () => {
  const pages = [[person('p1')], [person('p2')], [person('p3')]]
  const { registry, seen } = setup(fakePeople({ pages }), { maxPagesPerSync: 2 })
  const r1 = await registry.sync('gcontacts')
  assert.deepEqual(r1.documents.map((d) => d.id), ['p1', 'p2'])
  assert.deepEqual(parseContactsCursor(r1.cursor), { p: '2' })
  const r2 = await registry.sync('gcontacts', { cursor: r1.cursor })
  assert.deepEqual(r2.documents.map((d) => d.id), ['p3'])
  assert.deepEqual(parseContactsCursor(r2.cursor), { s: 'sync-1' })
  // Every page repeats the first call's parameters.
  assert.ok(seen.lists.every((l) => l.requestSyncToken === 'true' && l.personFields === PERSON_FIELDS && l.pageSize === '1000'))
})

test('gcontacts: incremental paging keeps the sync token beside the page token', async () => {
  const { registry, seen } = setup(fakePeople({ changes: { s1: [[person('x1')], [person('x2')]] } }))
  const r = await registry.sync('gcontacts', { cursor: contactsCursor({ s: 's1' }) })
  assert.deepEqual(r.documents.map((d) => d.id), ['x1', 'x2'])
  assert.deepEqual(seen.lists.map((l) => [l.syncToken, l.pageToken]), [['s1', undefined], ['s1', '1']])
  assert.deepEqual(parseContactsCursor(r.cursor), { s: 's1-next' })
})

test('gcontacts: a cursor that is not ours means a fresh full sync', () => {
  for (const bad of [null, '', 'nope', '{"v":2,"s":"x"}', JSON.stringify({ v: 1, s: 'has space' })]) {
    assert.deepEqual(parseContactsCursor(bad), {}, String(bad))
  }
})

test('gcontacts: mapping keeps names, nicknames, emails, phones and work; drops junk', () => {
  const doc = personToDocument(person('c9', {
    name: 'Samuel Jones',
    emails: ['sam@work.example', 'SAM@work.example', 'not an email', '<script>@x'],
    phones: ['+1 (555) 010-9999', 'call me'],
    nicknames: [{ value: 'Sam' }, { value: 'Sammy' }],
    organizations: [{ name: 'Acme', title: 'Engineer' }],
    addresses: [{ formattedValue: '1 Secret St' }],
    biographies: [{ value: 'private notes' }],
  }), { now: () => NOW })
  assert.equal(doc.title, 'Samuel Jones')
  assert.match(doc.text, /Also called: Sam, Sammy/)
  assert.match(doc.text, /Email: sam@work.example \(Home\)\n/)
  assert.match(doc.text, /Phone: \+15550109999 \(Mobile\)\n/)
  assert.match(doc.text, /Work: Engineer, Acme/)
  assert.ok(!/Secret|private notes|script|call me/.test(doc.text), 'fields JARVIS did not ask for are never kept')
  // No name: known by email; nothing at all: skipped.
  assert.equal(personToDocument(person('c8', { name: '' }), { now: () => NOW }).title, 'c8@example.com')
  assert.equal(personToDocument(person('c7', { name: '', emails: [], phones: [] })), null)
  assert.equal(personToDocument({ resourceName: 'people/../x' }), null)
  assert.equal(personToDocument({ resourceName: 'otherContacts/c1', names: [{ displayName: 'X' }] }), null)
  // No update time from Google: stamped now.
  assert.equal(personToDocument({ resourceName: 'people/c6', names: [{ displayName: 'Y' }] }, { now: () => NOW }).updatedAt, NOW)
  assert.equal(contactFields(null), null)
})

test('gcontacts: find_contact warms Google\'s search cache once, then searches with the minimal mask', async () => {
  const search = [person('c1', { name: 'Sam Patel', organizations: [{ name: 'Acme' }] }), { resourceName: 'people/c0' }]
  const { registry, seen } = setup(fakePeople({ search }))
  const tool = connectorToolName('gcontacts', 'read', 'find_contact')
  const res = await registry.callTool(tool, { query: 'Sam\u0000', limit: 99 })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  const text = res.content[0].text
  assert.match(text, /^<untrusted_data/)
  const body = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  assert.deepEqual(body.contacts.map((c) => c.name), ['Sam Patel'])
  assert.deepEqual(body.contacts[0].phones, [{ value: '+442079460000', type: 'Mobile' }])
  assert.deepEqual(body.contacts[0].work, ['Acme'])
  assert.deepEqual(seen.searches.map((s) => s.query), ['', 'Sam'])
  assert.equal(seen.searches[1].pageSize, '30')
  assert.ok(!seen.searches[1].readMask.includes('metadata'))
  await registry.callTool(tool, { query: 'Ann' })
  assert.deepEqual(seen.searches.map((s) => s.query), ['', 'Sam', 'Ann'], 'only one warm-up per session')
})

test('gcontacts: the read tool is offered as read-only and passes the policy engine', () => {
  const { registry } = setup()
  const tools = registry.tools().filter((t) => t.name.includes('gcontacts'))
  assert.deepEqual(tools.map((t) => t.name), [connectorMcpName('gcontacts', 'read', 'find_contact')])
  assert.ok(tools.every((t) => t.readOnly))
  assert.equal(registry.policyRule(connectorToolName('gcontacts', 'read', 'find_contact')).allow, true)
})

test('gcontacts: test() reports the count; disconnect revokes and forgets the tokens', async () => {
  const { registry, credentials, seen, lines } = setup()
  const t = await registry.test('gcontacts')
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.match(t.detail, /2 contacts/)
  const d = await registry.disconnect('gcontacts')
  assert.equal(d.ok, true)
  assert.equal(seen.revokes, 1)
  assert.deepEqual(credentials.describe('gcontacts').keys, [])
  assert.equal(registry.status('gcontacts').state, 'disconnected')
  for (const l of lines) assert.ok(!l.includes(REFRESH) && !l.includes(ACCESS))
})
