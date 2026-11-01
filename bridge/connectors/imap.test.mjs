/**
 * Generic IMAP mail (task C20): the README's acceptance tests and the vetting
 * test pack (bad host, private address, plain port, wrong password, injection
 * fixture, rate limit, offline, erase, no writes, kill switches), driven
 * through the registry and the Settings routes against a fake IMAP server
 * and a fake DNS. No real account, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  imapConnector, parseServer, vetImapHost, guardedTlsSocket, imapDocument, cleanPassword,
  readServerCursor, imapServerCursor, KNOWN_PROVIDERS,
} from './imap.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { createConnectorRoutes, syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { INJECTION_TEXT, ATTACKER_HOST, captureLog } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'
import { startFakeImap, rawMail, FAKE_APP_PASSWORD } from './imap-testserver.mjs'

const USER = 'me@example.org'
const HOST = 'imap.example.org'
const PASSWORD = FAKE_APP_PASSWORD
const REFUSED = PASSWORD.split('').reverse().join('')
const AT = 1_790_000_000_000

/** A fake DNS: public TEST-NET answers unless a name is listed. */
function fakeLookup(table = {}) {
  const asked = []
  const lookup = (host, opts, cb) => {
    asked.push(host)
    const hit = table[host]
    if (hit === undefined) return cb(null, [{ address: '203.0.113.10', family: 4 }])
    if (hit instanceof Error) return cb(hit)
    return cb(null, hit.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
  }
  return { lookup, asked }
}
const notFound = () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })

const mail = (uid, extra = {}) => ({
  uid,
  raw: rawMail({ to: USER, subject: `Mail ${uid}`, body: `Body of mail ${uid}` }),
  at: AT + uid * 60_000,
  ...extra,
})

async function setup({ messages = [mail(1), mail(2), mail(3)], connected = true, fakeOpts = {}, onErase, maxPerSync, dns = {}, user = USER } = {}) {
  const fake = await startFakeImap({ user, pass: PASSWORD, messages, allMailbox: null, ...fakeOpts })
  const credentials = createMemoryCredentialStore()
  if (connected) {
    credentials.set('imap', 'host', HOST)
    credentials.set('imap', 'port', '993')
    credentials.set('imap', 'username', user)
    credentials.set('imap', 'password', PASSWORD)
  }
  const sleeps = []
  const { log, lines } = captureLog()
  const resolver = fakeLookup(dns)
  const registry = createConnectorRegistry({
    credentials, log, onErase,
    sleep: async (ms) => { sleeps.push(ms) },
    now: () => AT + 10 * 60_000,
    fetch: async () => { throw new Error('IMAP connectors never use fetch') },
  })
  const reg = registry.register(imapConnector({
    openSocket: fake.openSocket, lookup: resolver.lookup, timeoutMs: 2000, ...(maxPerSync ? { maxPerSync } : {}),
  }))
  assert.equal(reg.ok, true, reg.error)
  const routes = createConnectorRoutes({ registry, persist: () => {}, log: { warn() {}, error() {} } })
  const connect = (body) => routes.handle({ method: 'POST', path: '/connectors/imap/connect', body })
  return { fake, registry, credentials, sleeps, lines, resolver, connect }
}

const noSecret = (texts, secret = PASSWORD) => {
  for (const t of texts) assert.ok(!String(t).includes(secret), 'the password must never appear')
}

test('parseServer: host, host:port, TLS only, no IPv6, no junk', () => {
  assert.deepEqual(parseServer('imap.example.org'), { host: HOST, port: 993 })
  assert.deepEqual(parseServer(' IMAP.Example.org.:9993 '), { host: HOST, port: 9993 })
  assert.deepEqual(parseServer('203.0.113.7'), { host: '203.0.113.7', port: 993 })
  for (const [raw, why] of [
    ['', /enter the IMAP server/],
    ['imap.example.org:143', /plain IMAP or STARTTLS/],
    ['imap.example.org:0', /port/],
    ['imap.example.org:70000', /port/],
    ['[::1]:993', /IPv6/],
    ['localhost', /valid server name/],
    ['imap_example.org', /valid server name/],
    ['999.1.1.1', /valid IP/],
  ]) {
    assert.throws(() => parseServer(raw), (e) => e.code === 'setup-needed' && why.test(e.detail), raw)
  }
})

test('vetImapHost: private, loopback, link-local and local-only hosts are refused', async () => {
  const { lookup, asked } = fakeLookup({
    'lan.example.org': ['192.168.1.20'],
    'mixed.example.org': ['203.0.113.5', '10.0.0.5'],
    'v6.example.org': ['fd00::1'],
    'meta.example.org': ['169.254.169.254'],
    'gone.example.org': notFound(),
  })
  for (const h of ['lan.example.org', 'mixed.example.org', 'v6.example.org', 'meta.example.org']) {
    await assert.rejects(vetImapHost(h, lookup), (e) => e.code === 'egress' && /private/.test(e.detail), h)
  }
  for (const h of ['127.0.0.1', '10.1.2.3', 'mail.local', 'box.home.arpa', 'nas.internal']) {
    await assert.rejects(vetImapHost(h, lookup), (e) => e.code === 'egress', h)
  }
  assert.ok(!asked.includes('mail.local'), 'local-only names never reach DNS')
  await assert.rejects(vetImapHost('gone.example.org', lookup), (e) => e.code === 'offline' && /not found/.test(e.detail))
  assert.deepEqual(await vetImapHost(HOST, lookup), ['203.0.113.10'])
})

test('the production opener refuses a private host without opening a socket', async () => {
  await assert.rejects(guardedTlsSocket({ host: '127.0.0.1', port: 993 }), (e) => e.code === 'egress')
  await assert.rejects(guardedTlsSocket({ host: 'printer.local', port: 993 }), (e) => e.code === 'egress')
})

test('the card: paste pattern with username and server fields, honest about app-password scope', async () => {
  const { fake, registry } = await setup({ connected: false })
  try {
    const card = registry.list().find((c) => c.id === 'imap')
    assert.equal(card.pattern, 'token')
    assert.equal(card.risk, 'R1')
    assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
    assert.deepEqual(card.tools, [])
    assert.match(card.setup.accountLabel, /Username/)
    assert.match(card.setup.serverLabel, /IMAP server/)
    assert.ok(card.setup.sees.some((l) => /whole mailbox/.test(l)))
    assert.deepEqual(setupProblems(card.setup), [])
    assert.equal(card.status.state, 'disconnected')
  } finally {
    await fake.close()
  }
})

test('connect from Settings: stored only after a working login, on the host typed', async () => {
  const { fake, credentials, connect } = await setup({ connected: false })
  try {
    const missing = await connect({ token: PASSWORD, account: USER })
    assert.equal(missing.body.ok, false)
    assert.equal(missing.body.code, 'setup-needed', 'an unknown provider needs the server field')

    const wrong = await connect({ token: REFUSED, account: USER, server: HOST })
    assert.equal(wrong.body.ok, false)
    assert.equal(wrong.body.code, 'auth')
    assert.deepEqual(credentials.describe('imap').keys, [], 'a refused login stores nothing')

    const junk = await connect({ token: PASSWORD, account: USER, server: 'imap.example.org/x' })
    assert.equal(junk.status, 400)

    const ok = await connect({ token: `${PASSWORD.slice(0, 8)} ${PASSWORD.slice(8)}`, account: ` ${USER} `, server: `${HOST}:993` })
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body))
    assert.equal(ok.body.result.account, `${USER} on ${HOST}`)
    assert.equal(credentials.get('imap', 'password'), PASSWORD)
    assert.equal(credentials.get('imap', 'host'), HOST)
    assert.equal(credentials.get('imap', 'port'), '993')
    noSecret([JSON.stringify(ok.body), JSON.stringify(wrong.body)])
    assert.equal(ok.body.connector.status.state, 'ok')
    assert.ok(fake.state.hosts.every((h) => h === HOST))
  } finally {
    await fake.close()
  }
})

test('bad host: unknown, private or plain-IMAP servers give a clear error and store nothing', async () => {
  const { fake, credentials, connect } = await setup({
    connected: false,
    dns: { 'nowhere.example.org': notFound(), 'lan.example.org': ['192.168.0.9'] },
  })
  try {
    const cases = [
      ['nowhere.example.org', 'offline'],
      ['lan.example.org', 'egress'],
      ['127.0.0.1', 'egress'],
      ['mail.local', 'egress'],
      [`${HOST}:143`, 'setup-needed'],
    ]
    for (const [server, code] of cases) {
      const r = await connect({ token: PASSWORD, account: USER, server })
      assert.equal(r.body.ok, false, server)
      assert.equal(r.body.code, code, `${server}: ${JSON.stringify(r.body)}`)
    }
    assert.deepEqual(credentials.describe('imap').keys, [])
    assert.equal(fake.state.connections, 0, 'no socket was opened for any bad host')
  } finally {
    await fake.close()
  }
})

test('known providers: host filled in from the address; iCloud tries the name before the @', async () => {
  const icloud = 'someone@icloud.com'
  // The fake accepts only the local part, as Apple asks for.
  const { fake, credentials, connect } = await setup({ connected: false, user: 'someone' })
  try {
    const r = await connect({ token: PASSWORD, account: icloud })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal(credentials.get('imap', 'host'), KNOWN_PROVIDERS['icloud.com'].host)
    assert.equal(credentials.get('imap', 'username'), 'someone')
    assert.match(r.body.result.detail, /iCloud Mail/)
  } finally {
    await fake.close()
  }
  const gm = await setup({ connected: false })
  try {
    const r = await gm.connect({ token: PASSWORD, account: 'me@gmail.com' })
    assert.equal(r.body.ok, false)
    assert.equal(gm.fake.state.connections, 0)
  } finally {
    await gm.fake.close()
  }
})

test('sync a fixture inbox: ids, timestamps, untrusted text, read-only commands', async () => {
  const { fake, registry } = await setup()
  try {
    const r = await registry.sync('imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.equal(r.documents.length, 3)
    const d = r.documents[0]
    assert.equal(d.id, `${HOST}/700-3`)
    assert.equal(d.title, 'Mail 3')
    assert.equal(d.author, 'Alice <alice@example.com>')
    assert.equal(d.updatedAt, AT + 3 * 60_000)
    assert.equal(d.sensitivity, 'messages')
    assert.equal(d.url, undefined)
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:imap"/)
    assert.match(d.text, /Body of mail 3/)
    assert.ok(fake.state.commands.some((c) => /EXAMINE "INBOX"/.test(c)))
    assert.ok(fake.state.commands.every((c) => !/STORE|COPY|MOVE|APPEND|EXPUNGE|DELETE|SELECT /i.test(c)))
    assert.equal(registry.status('imap').state, 'ok')
  } finally {
    await fake.close()
  }
})

test('incremental sync through the document store returns only new mail', async () => {
  const { fake, registry } = await setup({ maxPerSync: 2 })
  const store = openDocumentStore({ file: ':memory:', now: () => AT + 10 * 60_000 })
  try {
    assert.deepEqual(await syncConnectorInto(registry, store, 'imap'), { ok: true, saved: 2, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'imap'), { ok: true, saved: 1, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'imap'), { ok: true, saved: 0, removed: 0, skipped: 0 })
    fake.state.messages.push(mail(4))
    const before = fake.state.commands.filter((c) => /UID FETCH/.test(c)).length
    assert.deepEqual(await syncConnectorInto(registry, store, 'imap'), { ok: true, saved: 1, removed: 0, skipped: 0 })
    const fetches = fake.state.commands.filter((c) => /UID FETCH/.test(c)).slice(before)
    assert.deepEqual(fetches.map((c) => c.split(' ')[3]), ['4'], 'only the new UID was fetched')
  } finally {
    store.close?.()
    await fake.close()
  }
})

test('a cursor from another server is ignored', () => {
  const c = imapServerCursor(`${HOST}:993`, '{"v":1}')
  assert.equal(readServerCursor(c, `${HOST}:993`), '{"v":1}')
  assert.equal(readServerCursor(c, 'imap.other.org:993'), undefined)
  assert.equal(readServerCursor('not json', `${HOST}:993`), undefined)
  assert.equal(imapDocument({ uid: 5, raw: rawMail(), internalDate: AT, size: 10, truncated: false }, HOST).id, `${HOST}/0-5`)
  assert.equal(cleanPassword(' ab cd\tef '), 'abcdef')
})

test('the saved host is vetted again at sync: a host that now resolves privately is refused', async () => {
  const { fake, registry } = await setup({ dns: { [HOST]: ['10.0.0.8'] } })
  try {
    const r = await registry.sync('imap')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'egress')
    assert.equal(fake.state.connections, 0)
  } finally {
    await fake.close()
  }
})

test('wrong or revoked password: clear error, no crash, no secret in logs', async () => {
  const { fake, registry, credentials, lines } = await setup()
  try {
    credentials.set('imap', 'password', REFUSED)
    const r = await registry.sync('imap')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'auth')
    assert.match(r.error.message, /Settings/)
    assert.deepEqual(r.documents, [])
    assert.equal(registry.status('imap').state, 'attention')
    noSecret([JSON.stringify(r), ...lines, JSON.stringify(registry.list())], REFUSED)
  } finally {
    await fake.close()
  }
})

test('injection fixture in a message is neutralised and changes nothing', async () => {
  const evil = { ...mail(1), raw: rawMail({ subject: `Re: ${INJECTION_TEXT.slice(0, 40)}`, body: INJECTION_TEXT }) }
  const { fake, registry } = await setup({ messages: [evil, mail(2)] })
  try {
    const before = registry.grants.of('imap')
    const r = await registry.sync('imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.ok(r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS')))
    for (const d of r.documents) {
      assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
      assert.ok(!/<system>/i.test(d.text))
      assert.ok(!/<\/?(system|untrusted_data)/i.test(d.title))
    }
    assert.deepEqual(registry.grants.of('imap'), before)
    assert.ok(!fake.state.hosts.includes(ATTACKER_HOST))
    assert.ok(fake.state.commands.every((c) => !/STORE|COPY|MOVE|APPEND|EXPUNGE|DELETE|SELECT /i.test(c)))
  } finally {
    await fake.close()
  }
})

test('a throttled account backs off, and one that stays throttled is reported', async () => {
  const once = await setup({ fakeOpts: { throttleLogins: 1 } })
  try {
    const r = await once.registry.sync('imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.deepEqual(once.sleeps, [2000])
  } finally {
    await once.fake.close()
  }
  const stuck = await setup({ fakeOpts: { throttleLogins: 99 } })
  try {
    const r = await stuck.registry.sync('imap')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'rate-limit')
    assert.equal(stuck.sleeps.length, 2)
  } finally {
    await stuck.fake.close()
  }
})

test('offline is reported, not thrown', async () => {
  const credentials = createMemoryCredentialStore()
  credentials.set('imap', 'host', HOST)
  credentials.set('imap', 'username', USER)
  credentials.set('imap', 'password', PASSWORD)
  const registry = createConnectorRegistry({ credentials, log: { warn() {}, error() {} } })
  registry.register(imapConnector({
    lookup: fakeLookup().lookup,
    openSocket: async () => { throw Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) },
  }))
  const r = await registry.sync('imap')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'offline')
  assert.equal(registry.status('imap').state, 'error')
})

test('disconnect with erase deletes the credentials and the synced mail', async () => {
  const erased = []
  const { fake, registry, credentials } = await setup({ onErase: (id) => { erased.push(id) } })
  try {
    const r = await registry.disconnect('imap', { eraseData: true })
    assert.equal(r.ok, true)
    assert.equal(r.erased, true)
    assert.deepEqual(erased, ['imap'])
    assert.deepEqual(credentials.describe('imap').keys, [])
    assert.equal(registry.status('imap').state, 'disconnected')
    assert.equal((await registry.sync('imap')).error.code, 'not-connected')
  } finally {
    await fake.close()
  }
})

test('no write capability, no tools; kill switches stop sync before any connection', async () => {
  const { fake, registry } = await setup()
  try {
    assert.equal(registry.grants.has('imap', 'write'), false)
    assert.equal(registry.tools().filter((t) => t.name.startsWith('imap__')).length, 0)
    registry.grants.disable('imap')
    assert.equal((await registry.sync('imap')).error.code, 'disabled')
    registry.grants.enable('imap')
    registry.grants.freezeAll()
    assert.equal((await registry.sync('imap')).error.code, 'frozen')
    assert.equal(fake.state.connections, 0)
    registry.grants.unfreezeAll()
    assert.equal((await registry.sync('imap')).ok, true)
  } finally {
    await fake.close()
  }
})

test('the Test button logs in and reads nothing', async () => {
  const { fake, registry } = await setup()
  try {
    const r = await registry.test('imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.match(r.detail, /the inbox, read-only/)
    assert.ok(!fake.state.commands.some((c) => /FETCH|SEARCH/.test(c)))
  } finally {
    await fake.close()
  }
})
