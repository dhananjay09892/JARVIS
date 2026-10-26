/**
 * Gmail over IMAP (task C09): the README's acceptance tests and the vetting
 * test pack (auth failure, revoked app password, injection fixture, rate
 * limit, offline, erase, no writes, kill switches), driven through the
 * registry and the Settings routes against a fake IMAP server. No real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gmailImapConnector, gmailImapDocument, cleanAppPassword, GMAIL_IMAP_HOST } from './gmail_imap.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { createConnectorRoutes, syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { INJECTION_TEXT, ATTACKER_HOST, captureLog } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'
import { startFakeImap, rawMail, FAKE_APP_PASSWORD, spacedPassword } from './imap-testserver.mjs'

const ADDRESS = 'me@gmail.com'
const APP_PASSWORD = FAKE_APP_PASSWORD
/** Another fixture value: what Google would refuse once the app password is revoked or mistyped. */
const REFUSED = APP_PASSWORD.split('').reverse().join('')
const AT = 1_790_000_000_000

const mail = (uid, extra = {}) => ({
  uid,
  raw: rawMail({ subject: `Mail ${uid}`, body: `Body of mail ${uid}` }),
  at: AT + uid * 60_000,
  msgid: String(1_840_000_000_000_000_000n + BigInt(uid)),
  thrid: String(1_840_000_000_000_000_000n),
  labels: ['\\Inbox'],
  ...extra,
})

async function setup({ messages = [mail(1), mail(2), mail(3)], connected = true, fakeOpts = {}, onErase, maxPerSync } = {}) {
  const fake = await startFakeImap({ user: ADDRESS, pass: APP_PASSWORD, messages, ...fakeOpts })
  const credentials = createMemoryCredentialStore()
  if (connected) {
    credentials.set('gmail_imap', 'address', ADDRESS)
    credentials.set('gmail_imap', 'app_password', APP_PASSWORD)
  }
  const sleeps = []
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({
    credentials, log, onErase,
    sleep: async (ms) => { sleeps.push(ms) },
    now: () => AT + 10 * 60_000,
    fetch: async () => { throw new Error('IMAP connectors never use fetch') },
  })
  const reg = registry.register(gmailImapConnector({ openSocket: fake.openSocket, timeoutMs: 2000, ...(maxPerSync ? { maxPerSync } : {}) }))
  assert.equal(reg.ok, true, reg.error)
  return { fake, registry, credentials, sleeps, lines }
}

const noSecret = (texts) => {
  for (const t of texts) assert.ok(!String(t).includes(APP_PASSWORD), 'the app password must never appear')
}

test('the card: paste pattern with an address field, honest about app-password scope', async () => {
  const { fake, registry } = await setup({ connected: false })
  try {
    const card = registry.list().find((c) => c.id === 'gmail_imap')
    assert.equal(card.pattern, 'token')
    assert.equal(card.risk, 'R1')
    assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
    assert.deepEqual(card.tools, [])
    assert.equal(card.setup.accountLabel, 'Gmail address')
    assert.ok(card.setup.sees.some((l) => /whole mailbox/.test(l)))
    assert.deepEqual(setupProblems(card.setup), [])
    assert.equal(card.status.state, 'disconnected')
  } finally {
    await fake.close()
  }
})

test('connect from Settings: address + app password (spaces allowed), stored only after a working login', async () => {
  const { fake, registry, credentials } = await setup({ connected: false })
  try {
    const routes = createConnectorRoutes({ registry, persist: () => {}, log: { warn() {}, error() {} } })
    const call = (body) => routes.handle({ method: 'POST', path: '/connectors/gmail_imap/connect', body })
    const missing = await call({ token: APP_PASSWORD })
    assert.equal(missing.status, 400)
    assert.match(missing.body.reason, /Gmail address/)

    const wrong = await call({ token: spacedPassword(REFUSED), account: ADDRESS })
    assert.equal(wrong.body.ok, false)
    assert.equal(wrong.body.code, 'auth')
    assert.deepEqual(credentials.describe('gmail_imap').keys, [], 'a refused login stores nothing')

    const ok = await call({ token: spacedPassword(APP_PASSWORD), account: ` ${ADDRESS} ` })
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body))
    assert.equal(ok.body.result.account, ADDRESS)
    assert.equal(credentials.get('gmail_imap', 'app_password'), APP_PASSWORD)
    assert.equal(credentials.get('gmail_imap', 'address'), ADDRESS)
    noSecret([JSON.stringify(ok.body)])
    assert.equal(ok.body.connector.status.state, 'ok')
    assert.deepEqual(fake.state.hosts.every((h) => h === GMAIL_IMAP_HOST), true)
  } finally {
    await fake.close()
  }
})

test('sync a fixture mailbox: Gmail ids, timestamps, links, untrusted text', async () => {
  const { fake, registry } = await setup()
  try {
    const r = await registry.sync('gmail_imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.equal(r.documents.length, 3)
    const d = r.documents[0]
    assert.equal(d.id, (1_840_000_000_000_000_000n + 3n).toString(16), 'the Gmail API message id, in hex')
    assert.equal(d.title, 'Mail 3')
    assert.equal(d.author, 'Alice <alice@example.com>')
    assert.equal(d.updatedAt, AT + 3 * 60_000)
    assert.equal(d.sensitivity, 'messages')
    assert.equal(d.url, `https://mail.google.com/mail/u/0/#all/${(1_840_000_000_000_000_000n).toString(16)}`)
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:gmail_imap"/)
    assert.match(d.text, /Body of mail 3/)
    assert.equal(registry.status('gmail_imap').state, 'ok')
  } finally {
    await fake.close()
  }
})

test('incremental sync through the document store returns only new mail', async () => {
  const { fake, registry } = await setup({ maxPerSync: 2 })
  const store = openDocumentStore({ file: ':memory:', now: () => AT + 10 * 60_000 })
  try {
    assert.deepEqual(await syncConnectorInto(registry, store, 'gmail_imap'), { ok: true, saved: 2, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'gmail_imap'), { ok: true, saved: 1, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'gmail_imap'), { ok: true, saved: 0, removed: 0, skipped: 0 })
    fake.state.messages.push(mail(4))
    const before = fake.state.commands.filter((c) => /UID FETCH/.test(c)).length
    assert.deepEqual(await syncConnectorInto(registry, store, 'gmail_imap'), { ok: true, saved: 1, removed: 0, skipped: 0 })
    const fetches = fake.state.commands.filter((c) => /UID FETCH/.test(c)).slice(before)
    assert.deepEqual(fetches.map((c) => c.split(' ')[3]), ['4'], 'only the new UID was fetched')
  } finally {
    store.close?.()
    await fake.close()
  }
})

test('drafts are skipped; no X-GM ids falls back to the UID', () => {
  const draft = { uid: 9, raw: rawMail(), internalDate: AT, size: 10, truncated: false, gmail: { msgid: 'ab', thrid: 'ab', labels: ['\\Draft'] } }
  assert.equal(gmailImapDocument(draft), null)
  const plain = gmailImapDocument({ uid: 9, raw: rawMail(), internalDate: AT, size: 10, truncated: false })
  assert.equal(plain.id, 'uid-9')
  assert.equal(plain.url, undefined)
  assert.equal(cleanAppPassword(` ${spacedPassword(APP_PASSWORD, ' \t')} `), APP_PASSWORD)
})

test('wrong or revoked app password: clear error, no crash, no secret in logs, nothing stored', async () => {
  const { fake, registry, credentials, lines } = await setup()
  try {
    credentials.set('gmail_imap', 'app_password', REFUSED) // revoked in Google: same refusal
    const r = await registry.sync('gmail_imap')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'auth')
    assert.match(r.error.message, /Settings/)
    assert.deepEqual(r.documents, [])
    const s = registry.status('gmail_imap')
    assert.equal(s.state, 'attention')
    for (const t of [JSON.stringify(r), JSON.stringify(s), ...lines, JSON.stringify(registry.list())]) {
      assert.ok(!t.includes(REFUSED))
    }
  } finally {
    await fake.close()
  }
})

test('injection fixture in a message is neutralised and changes nothing', async () => {
  const evil = { ...mail(1), raw: rawMail({ subject: `Re: ${INJECTION_TEXT.slice(0, 40)}`, body: INJECTION_TEXT }) }
  const { fake, registry } = await setup({ messages: [evil, mail(2)] })
  try {
    const before = registry.grants.of('gmail_imap')
    const r = await registry.sync('gmail_imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    const hit = r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
    assert.ok(hit)
    for (const d of r.documents) {
      assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
      assert.ok(!/<system>/i.test(d.text))
      assert.ok(!/<\/?(system|untrusted_data)/i.test(d.title))
    }
    assert.deepEqual(registry.grants.of('gmail_imap'), before)
    assert.ok(!fake.state.hosts.includes(ATTACKER_HOST))
    assert.ok(fake.state.commands.every((c) => !/STORE|COPY|MOVE|APPEND|EXPUNGE|DELETE|SELECT /i.test(c)))
  } finally {
    await fake.close()
  }
})

test('a throttled account backs off, and one that stays throttled is reported', async () => {
  const once = await setup({ fakeOpts: { throttleLogins: 1 } })
  try {
    const r = await once.registry.sync('gmail_imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.deepEqual(once.sleeps, [2000])
  } finally {
    await once.fake.close()
  }
  const stuck = await setup({ fakeOpts: { throttleLogins: 99 } })
  try {
    const r = await stuck.registry.sync('gmail_imap')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'rate-limit')
    assert.equal(stuck.sleeps.length, 2)
  } finally {
    await stuck.fake.close()
  }
})

test('offline is reported, not thrown', async () => {
  const credentials = createMemoryCredentialStore()
  credentials.set('gmail_imap', 'address', ADDRESS)
  credentials.set('gmail_imap', 'app_password', APP_PASSWORD)
  const registry = createConnectorRegistry({ credentials, log: { warn() {}, error() {} } })
  registry.register(gmailImapConnector({
    openSocket: async () => { throw Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) },
  }))
  const r = await registry.sync('gmail_imap')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'offline')
  assert.equal(registry.status('gmail_imap').state, 'error')
})

test('disconnect with erase deletes the app password and the synced mail', async () => {
  const erased = []
  const { fake, registry, credentials } = await setup({ onErase: (id) => { erased.push(id) } })
  try {
    const r = await registry.disconnect('gmail_imap', { eraseData: true })
    assert.equal(r.ok, true)
    assert.equal(r.erased, true)
    assert.deepEqual(erased, ['gmail_imap'])
    assert.deepEqual(credentials.describe('gmail_imap').keys, [])
    assert.equal(registry.status('gmail_imap').state, 'disconnected')
    const after = await registry.sync('gmail_imap')
    assert.equal(after.error.code, 'not-connected')
  } finally {
    await fake.close()
  }
})

test('no write capability, no tools; kill switches stop sync before any connection', async () => {
  const { fake, registry } = await setup()
  try {
    assert.equal(registry.grants.has('gmail_imap', 'write'), false)
    assert.equal(registry.tools().filter((t) => t.name.includes('gmail_imap')).length, 0)
    registry.grants.disable('gmail_imap')
    assert.equal((await registry.sync('gmail_imap')).error.code, 'disabled')
    registry.grants.enable('gmail_imap')
    registry.grants.freezeAll()
    assert.equal((await registry.sync('gmail_imap')).error.code, 'frozen')
    assert.equal(fake.state.connections, 0)
    registry.grants.unfreezeAll()
    assert.equal((await registry.sync('gmail_imap')).ok, true)
  } finally {
    await fake.close()
  }
})

test('the Test button logs in and reads nothing', async () => {
  const { fake, registry } = await setup()
  try {
    const r = await registry.test('gmail_imap')
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.match(r.detail, /All Mail, read-only/)
    assert.ok(!fake.state.commands.some((c) => /FETCH|SEARCH/.test(c)))
  } finally {
    await fake.close()
  }
})
