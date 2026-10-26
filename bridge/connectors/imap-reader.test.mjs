/**
 * The shared IMAP reader (task C09): protocol parsing, read-only commands,
 * the egress allow-list, UID-based incremental sync, throttling backoff and
 * failures, against a fake IMAP server on 127.0.0.1. No real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createImapReader, tokenize, parseStatus, errorForStatus, quote, parseInternalDate, imapDate,
  parseImapCursor, imapCursor, READ_COMMANDS,
} from './imap-reader.mjs'
import { ConnectorError } from './http.mjs'
import { startFakeImap, rawMail } from './imap-testserver.mjs'

const USER = 'me@gmail.com'
const PASS = 'abcdefghijklmnop'
const HOST = 'imap.gmail.com'

const mails = (n, { start = 1, at = 1_790_000_000_000 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    uid: start + i,
    raw: rawMail({ subject: `Mail ${start + i}`, body: `Body ${start + i}` }),
    at: at + i * 60_000,
    msgid: String(1_000_000_000_000 + start + i),
  }))

async function withServer(opts, fn) {
  const fake = await startFakeImap(opts)
  try {
    await fn(fake)
  } finally {
    await fake.close()
  }
}

const reader = (fake, extra = {}) => createImapReader({
  host: HOST, allowedHosts: [HOST], openSocket: fake.openSocket, sleep: async () => {}, mailbox: 'all', gmail: true, timeoutMs: 2000, ...extra,
})

async function collect(gen) {
  const messages = []
  let cursor
  for await (const item of gen) {
    if (item.cursor) cursor = item.cursor
    else messages.push(item.message)
  }
  return { messages, cursor }
}

/** Every command a session sent, minus the tag. */
const verbs = (fake) => fake.state.commands.map((c) => c.split(' ').slice(1).join(' '))

test('tokenize: atoms, quoted strings, NIL, nested lists, literals and bracketed atoms', () => {
  const lit = Buffer.from('raw bytes')
  const t = tokenize(['* 1 FETCH (UID 7 FLAGS (\\Seen) X-GM-LABELS ("\\\\Inbox" Work) ENVELOPE NIL BODY[]<0> ', lit, ')'])
  assert.deepEqual(t.slice(0, 3), ['*', '1', 'FETCH'])
  const list = t[3]
  assert.deepEqual(list.slice(0, 4), ['UID', '7', 'FLAGS', ['\\Seen']])
  assert.deepEqual(list[5], ['\\Inbox', 'Work'])
  assert.equal(list[7], null)
  assert.equal(list[8], 'BODY[]<0>')
  assert.equal(list[9], lit)
  assert.deepEqual(tokenize(['* OK [UIDVALIDITY 5] ok'])[2], '[UIDVALIDITY 5]')
})

test('status lines and how refusals map to owner-readable errors', () => {
  assert.deepEqual(parseStatus('J3 NO [AUTHENTICATIONFAILED] Invalid credentials'), { tag: 'J3', status: 'NO', code: 'AUTHENTICATIONFAILED', text: 'Invalid credentials' })
  const code = (line) => errorForStatus(parseStatus(line), 'x').code
  assert.equal(code('J1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)'), 'auth')
  assert.equal(code('J1 NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833'), 'auth')
  assert.equal(code('J1 NO [THROTTLED] Too many login attempts'), 'rate-limit')
  assert.equal(code('* BYE [UNAVAILABLE] Temporary System Error'), 'server')
  assert.equal(code('J1 BAD Could not parse command'), 'bad-response')
})

test('quote escapes, and refuses what LOGIN cannot carry', () => {
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"')
  assert.throws(() => quote('line\r\nJ9 DELETE INBOX'), (e) => e instanceof ConnectorError && e.code === 'auth')
  assert.throws(() => quote('pässword'), ConnectorError)
})

test('dates: INTERNALDATE with offsets, SEARCH dates', () => {
  assert.equal(parseInternalDate('17-Jul-1996 02:44:25 -0700'), Date.UTC(1996, 6, 17, 9, 44, 25))
  assert.equal(parseInternalDate(' 1-Jan-2026 00:00:00 +0100'), Date.UTC(2025, 11, 31, 23, 0, 0))
  assert.equal(parseInternalDate('nonsense'), null)
  assert.equal(imapDate(Date.UTC(2026, 9, 5, 13)), '5-Oct-2026')
})

test('cursor round trip; foreign or broken cursors are ignored', () => {
  assert.deepEqual(parseImapCursor(imapCursor('700', 12, [3, 2])), { uv: '700', last: 12, p: [3, 2] })
  assert.equal(parseImapCursor('{"v":1,"h":"9"}'), null)
  assert.equal(parseImapCursor('not json'), null)
  assert.deepEqual(parseImapCursor('{"v":1,"uv":"7","last":1,"p":[1,"x",-2]}').p, [1])
})

test('a full sync reads All Mail read-only: EXAMINE, BODY.PEEK, nothing that changes mail', async () => {
  await withServer({ messages: mails(3) }, async (fake) => {
    const { messages, cursor } = await collect(reader(fake).sync({ user: USER, pass: PASS }))
    assert.deepEqual(messages.map((m) => m.uid), [3, 2, 1], 'newest first')
    assert.equal(messages[0].gmail.msgid, (1_000_000_000_003n).toString(16))
    assert.equal(messages[0].internalDate, 1_790_000_000_000 + 2 * 60_000)
    assert.deepEqual(parseImapCursor(cursor), { uv: '700', last: 3, p: [] })
    const sent = verbs(fake)
    assert.ok(sent.includes('EXAMINE "[Gmail]/All Mail"'))
    assert.ok(sent.some((c) => /^UID FETCH 3,2,1 \(.*BODY\.PEEK\[\]<0\.\d+>\)$/.test(c)))
    for (const c of sent) {
      assert.ok(READ_COMMANDS.some((v) => c.toUpperCase().startsWith(v)), `unexpected command ${c}`)
      assert.ok(!/^(SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|UID (STORE|COPY|MOVE|EXPUNGE))\b/i.test(c))
    }
    assert.ok(fake.state.commands.some((c) => c.endsWith('LOGIN [masked]')))
    for (let i = 0; i < 50 && fake.state.open; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(fake.state.open, 0, 'the session logged out and closed')
  })
})

test('incremental sync fetches only new UIDs; the per-sync cap carries the rest in the cursor', async () => {
  await withServer({ messages: mails(5) }, async (fake) => {
    const r = reader(fake)
    const first = await collect(r.sync({ user: USER, pass: PASS, perSync: 2 }))
    assert.deepEqual(first.messages.map((m) => m.uid), [5, 4])
    assert.deepEqual(parseImapCursor(first.cursor), { uv: '700', last: 5, p: [3, 2, 1] })
    // Nothing new: RFC 3501 answers "UID 6:*" with UID 5, which must not be re-read.
    const second = await collect(r.sync({ user: USER, pass: PASS, cursor: first.cursor, perSync: 2 }))
    assert.deepEqual(second.messages.map((m) => m.uid), [3, 2])
    fake.state.messages.push(...mails(1, { start: 6 }))
    const third = await collect(r.sync({ user: USER, pass: PASS, cursor: second.cursor, perSync: 2 }))
    assert.deepEqual(third.messages.map((m) => m.uid), [6, 1], 'new mail first, then the backlog')
    assert.deepEqual(parseImapCursor(third.cursor), { uv: '700', last: 6, p: [] })
    const fourth = await collect(r.sync({ user: USER, pass: PASS, cursor: third.cursor }))
    assert.deepEqual(fourth.messages, [])
  })
})

test('a new UIDVALIDITY starts again; maxInitial and since bound the first sync', async () => {
  await withServer({ messages: mails(4) }, async (fake) => {
    const r = reader(fake)
    const old = imapCursor('699', 4, [])
    const { messages } = await collect(r.sync({ user: USER, pass: PASS, cursor: old, maxInitial: 2 }))
    assert.deepEqual(messages.map((m) => m.uid), [4, 3])
    const since = await collect(r.sync({ user: USER, pass: PASS, since: 1_790_000_000_000 + 24 * 3600_000 }))
    assert.deepEqual(since.messages, [])
    assert.ok(verbs(fake).some((c) => /^UID SEARCH SINCE \d+-[A-Z][a-z]{2}-\d{4}$/.test(c)))
  })
})

test('INBOX when there is no \\All mailbox; expunged messages are skipped', async () => {
  await withServer({ messages: mails(2), allMailbox: null }, async (fake) => {
    const r = reader(fake)
    fake.state.expunged.add(1)
    const { messages } = await collect(r.sync({ user: USER, pass: PASS }))
    assert.deepEqual(messages.map((m) => m.uid), [2])
    assert.ok(verbs(fake).includes('EXAMINE "INBOX"'))
  })
})

test('large messages are fetched partially and marked shortened', async () => {
  const big = { uid: 1, raw: rawMail({ body: 'x'.repeat(20_000) }), msgid: '42' }
  await withServer({ messages: [big] }, async (fake) => {
    const { messages } = await collect(reader(fake, { maxMessageBytes: 5000 }).sync({ user: USER, pass: PASS }))
    assert.equal(messages[0].raw.length, 5000)
    assert.equal(messages[0].truncated, true)
    assert.equal(messages[0].size, big.raw.length)
  })
})

test('a host off the allow-list is refused before any socket opens', async () => {
  await withServer({}, async (fake) => {
    const r = createImapReader({ host: 'evil.example', allowedHosts: [HOST], openSocket: fake.openSocket })
    await assert.rejects(r.check({ user: USER, pass: PASS }), (e) => e.code === 'egress')
    assert.equal(fake.state.connections, 0)
  })
})

test('wrong password is an auth error', async () => {
  await withServer({}, async (fake) => {
    await assert.rejects(reader(fake).check({ user: USER, pass: 'wrong-password-xx' }), (e) => e.code === 'auth')
  })
})

test('a throttled login backs off and retries; one that stays throttled is reported', async () => {
  await withServer({ throttleLogins: 1 }, async (fake) => {
    const sleeps = []
    const r = reader(fake, { sleep: async (ms) => { sleeps.push(ms) } })
    assert.deepEqual(await r.check({ user: USER, pass: PASS }), { mailbox: '[Gmail]/All Mail' })
    assert.deepEqual(sleeps, [2000])
  })
  await withServer({ throttleLogins: 10 }, async (fake) => {
    const sleeps = []
    const r = reader(fake, { sleep: async (ms) => { sleeps.push(ms) } })
    await assert.rejects(r.check({ user: USER, pass: PASS }), (e) => e.code === 'rate-limit' && e.retryAfterMs === 60_000)
    assert.deepEqual(sleeps, [2000, 8000], 'bounded backoff')
  })
})

test('offline, a dropped connection and a silent server are reported, not hung', async () => {
  const offline = createImapReader({
    host: HOST, allowedHosts: [HOST],
    openSocket: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmail.com'), { code: 'ENOTFOUND' }) },
  })
  await assert.rejects(offline.check({ user: USER, pass: PASS }), (e) => e.code === 'offline')
  await withServer({ messages: mails(1), dropAfter: 'UID FETCH' }, async (fake) => {
    await assert.rejects(collect(reader(fake).sync({ user: USER, pass: PASS })), (e) => e.code === 'offline')
  })
  await withServer({ messages: mails(1), silentAfter: 'EXAMINE' }, async (fake) => {
    await assert.rejects(reader(fake, { timeoutMs: 200 }).check({ user: USER, pass: PASS }), (e) => e.code === 'offline')
  })
  await withServer({ greeting: '* BYE [UNAVAILABLE] Temporary System Error' }, async (fake) => {
    await assert.rejects(reader(fake).check({ user: USER, pass: PASS }), (e) => e.code === 'server')
  })
})
