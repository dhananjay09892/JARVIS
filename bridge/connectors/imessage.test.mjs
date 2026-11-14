/**
 * iMessage (task C39): the README's acceptance tests against fixture chat.db
 * databases built in a temp folder. No real Messages data is touched; the
 * platform is injected so this runs everywhere.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  imessageConnector, messagesDbPath, messageDateMs, decodeAttributedBody, cleanMessage, messagesToDocuments, parseMessagesCursor,
} from './imessage.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const ID = 'imessage'
const NOW = Date.parse('2026-11-14T08:00:00Z')
const CORE = Date.UTC(2001, 0, 1)
const ns = (iso) => BigInt(Date.parse(iso) - CORE) * 1000000n
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'imsg-')))
  temps.push(d)
  return d
}

/** attributedBody the way Messages writes it: typedstream with the text after NSString, `+` and a length. */
function attributed(text) {
  const t = Buffer.from(text, 'utf8')
  const len = t.length < 0x80 ? Buffer.from([t.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([t.length & 0xff, t.length >> 8])])
  return Buffer.concat([Buffer.from([4, 0x0b]), Buffer.from('streamtyped'), Buffer.from([0x81, 0xe8, 3, 0x84, 1, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from('NSAttributedString'), Buffer.from([0, 0x84, 0x84, 8]), Buffer.from('NSObject'), Buffer.from([0x85, 0x92, 0x84, 0x84, 0x84, 8]),
    Buffer.from('NSString'), Buffer.from([1, 0x94, 0x84, 1, 0x2b]), len, t, Buffer.from([0x86, 0x84, 2]), Buffer.from('iI')])
}

const CHATS = [
  { id: 1, guid: 'iMessage;-;+15551230001', ident: '+15551230001', style: 45 },
  { id: 2, guid: 'iMessage;+;chat123', ident: 'chat123', name: 'Weekend plans', style: 43 },
]
const MSGS = [
  { chat: 1, h: 1, text: 'Dinner on Friday?', date: ns('2026-11-10T18:00:00Z') },
  { chat: 1, mine: true, text: 'Yes, 7pm works', date: ns('2026-11-10T18:05:00Z') },
  { chat: 1, h: 1, text: null, body: attributed('Body only message, no text column'), date: ns('2026-11-10T18:06:00Z') },
  { chat: 1, h: 1, text: 'Liked "Yes, 7pm works"', date: ns('2026-11-10T18:07:00Z'), assoc: 2000 },
  { chat: 1, h: 1, text: 'Unsent secret', date: ns('2026-11-10T18:08:00Z'), retracted: ns('2026-11-10T18:09:00Z') },
  { chat: 1, h: 1, text: 'left the group', date: ns('2026-11-10T18:10:00Z'), item: 3 },
  { chat: 1, h: 1, text: '', date: ns('2026-11-10T18:11:00Z') },
  { chat: 1, h: 1, text: 'Next day hello', date: ns('2026-11-11T09:00:00Z') },
  { chat: 2, h: 2, text: 'Hiking Saturday', date: ns('2026-11-10T20:00:00Z') },
  { chat: 2, h: 1, text: 'I am in', date: ns('2026-11-10T20:01:00Z') },
]

function makeDb(file, { msgs = MSGS, layout = 'ok' } = {}) {
  const db = new DatabaseSync(file)
  if (layout === 'ok') {
    db.exec('CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT)')
    db.exec('CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER)')
    db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, date INTEGER,
      is_from_me INTEGER, associated_message_type INTEGER, item_type INTEGER, date_retracted INTEGER)`)
    db.exec('CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)')
    db.exec("INSERT INTO handle (ROWID, id) VALUES (1, '+15551230001'), (2, 'friend@example.com')")
    for (const c of CHATS) db.prepare('INSERT INTO chat (ROWID, guid, chat_identifier, display_name, style) VALUES (?,?,?,?,?)').run(c.id, c.guid, c.ident, c.name ?? null, c.style)
    addMessages(db, msgs, 1)
  } else {
    db.exec('CREATE TABLE message (ROWID INTEGER PRIMARY KEY, something TEXT)')
  }
  db.close()
}

function addMessages(db, msgs, startRow) {
  let row = startRow
  for (const m of msgs) {
    db.prepare(`INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, date, is_from_me, associated_message_type, item_type, date_retracted)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row, `G-${row}`, m.text ?? null, m.body ?? null, m.mine ? 0 : m.h ?? 1, m.date, m.mine ? 1 : 0, m.assoc ?? 0, m.item ?? 0, m.retracted ?? 0)
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)').run(m.chat, row)
    row++
  }
}

function fixture({ msgs = MSGS, layout = 'ok', create = true } = {}) {
  const home = tempDir()
  const file = messagesDbPath(home)
  mkdirSync(dirname(file), { recursive: true })
  if (create) makeDb(file, { msgs, layout })
  return { home, file }
}

function setup({ home, platform = 'darwin', granted = true, onErase } = {}) {
  const credentials = createMemoryCredentialStore()
  if (granted) credentials.set(ID, 'granted', '1')
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase, now: () => NOW })
  assert.equal(registry.register(imessageConnector({ home, platform })).ok, true)
  return { registry, credentials, lines }
}

test('imessage: the card is valid, read-only, R2, mac-only and explains Full Disk Access and whose words these are', () => {
  const { registry } = setup({ home: tempDir() })
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.equal(c.risk, 'R2')
  assert.deepEqual(c.platforms, ['mac'])
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.match(c.setup.localWhy, /Full Disk Access/)
  assert.match(c.setup.localWhy, /private copy/)
  assert.match(c.setup.sees.join(' '), /Other people wrote some/)
  assert.match(c.setup.sees.join(' '), /never sends/)
  assert.deepEqual(c.tools, [])
})

test('imessage: fixture messages sync as wrapped, messages-class documents per chat and day', async () => {
  const { home } = fixture()
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  for (const d of r.documents) {
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:imessage"/)
    assert.equal(d.sensitivity, 'messages')
    assert.match(d.id, /^imessage:[0-9a-f]{12}:\d{4}-\d{2}-\d{2}$/)
    assert.doesNotMatch(d.id, /\+1555|@/, 'ids never carry a phone number or email')
  }
  assert.equal(r.documents.length, 3, 'chat 1 on two days, chat 2 on one')
  const all = r.documents.map((d) => d.text).join('\n')
  assert.doesNotMatch(all, /Unsent secret|left the group|Liked/, 'unsent, group events and tapbacks are left out')
  const day1 = r.documents.find((d) => d.text.includes('Dinner on Friday?'))
  assert.match(day1.text, /Messages with \+15551230001, 2026-11-10/)
  assert.match(day1.text, /\[18:00\] \+15551230001: Dinner on Friday\?\n\[18:05\] Me: Yes, 7pm works/)
  assert.match(day1.text, /Body only message, no text column/, 'text recovered from attributedBody')
  assert.equal(day1.updatedAt, Date.parse('2026-11-10T18:06:00Z'))
  const group = r.documents.find((d) => d.text.includes('Hiking Saturday'))
  assert.match(group.text, /Messages with Weekend plans/)
  assert.match(group.text, /\[20:01\] \+15551230001: I am in/)
  assert.match(group.text, /friend@example\.com: Hiking Saturday/)
})

test('imessage: incremental sync reads nothing when unchanged and rewrites only the days with new messages', async () => {
  const { home, file } = fixture()
  const { registry } = setup({ home })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 3)
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0, 'unchanged: nothing to read')
    const db = new DatabaseSync(file)
    addMessages(db, [{ chat: 2, h: 2, text: 'See you at nine', date: ns('2026-11-12T08:00:00Z') }], 100)
    db.close()
    const r = await syncConnectorInto(registry, store, ID)
    assert.equal(r.saved, 1, 'only the new day is written')
    const db2 = new DatabaseSync(file)
    addMessages(db2, [{ chat: 2, h: 1, text: 'Running late', date: ns('2026-11-12T08:30:00Z') }], 101)
    db2.close()
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 1, 'same day rewritten whole')
    const db3 = new DatabaseSync(file)
    db3.exec('UPDATE handle SET service = \'x\'')
    db3.close()
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0, 'database changed but no new messages')
  } finally {
    store.close()
  }
  assert.equal(parseMessagesCursor('{"v":1,"g":"short","r":1}'), null)
  assert.equal(parseMessagesCursor(`{"v":1,"g":"${'a'.repeat(32)}","r":-1}`), null)
  assert.equal(parseMessagesCursor('nope'), null)
  assert.deepEqual(parseMessagesCursor(`{"v":1,"g":"${'a'.repeat(32)}","r":7}`), { g: 'a'.repeat(32), r: 7 })
})

test('imessage: off macOS it reports itself unavailable and cannot connect or sync', async () => {
  const { home } = fixture()
  const { registry } = setup({ home, platform: 'linux', granted: false })
  assert.equal(registry.status(ID).state, 'error')
  assert.match(registry.status(ID).detail, /only works on a Mac/)
  assert.equal((await registry.connect(ID, { confirmed: true })).error.code, 'unsupported-platform')
  assert.equal((await registry.sync(ID)).error.code, 'unsupported-platform')
})

test('imessage: connect needs consent and a readable database; nothing is stored otherwise', async () => {
  const { home } = fixture()
  const { registry, credentials } = setup({ home, granted: false })
  assert.equal((await registry.connect(ID, {})).error.code, 'consent-denied')
  assert.deepEqual(credentials.describe(ID).keys, [])
  const none = setup({ home: tempDir(), granted: false })
  assert.equal((await none.registry.connect(ID, { confirmed: true })).error.code, 'folder-missing')
  assert.deepEqual(none.credentials.describe(ID).keys, [])
  const ok = await registry.connect(ID, { confirmed: true })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  assert.equal(registry.status(ID).state, 'ok')
  const t = await registry.test(ID)
  assert.equal(t.ok, true)
  assert.match(t.detail, /6 messages/)
})

test('imessage: missing permission gives the Full Disk Access message, not a crash', async () => {
  const { home, file } = fixture()
  const { registry } = setup({ home })
  let enforced = true
  chmodSync(file, 0o000)
  try { new DatabaseSync(file, { readOnly: true }).close(); enforced = false } catch { /* denied, as wanted */ }
  if (enforced) {
    const r = await registry.sync(ID)
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'permission-needed')
    assert.match(r.error.message, /Full Disk Access/)
  }
  chmodSync(file, 0o600)
})

test('imessage: an unrecognised layout and a non-database fail cleanly', async () => {
  const { home } = fixture({ layout: 'odd' })
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
  assert.equal((await registry.test(ID)).ok, false)
  assert.equal((await setup({ home, granted: false }).registry.connect(ID, { confirmed: true })).error.code, 'bad-response')
  const { home: h2, file } = fixture({ create: false })
  writeFileSync(file, 'this is not a database, just text '.repeat(50))
  assert.equal((await setup({ home: h2 }).registry.sync(ID)).error.code, 'bad-response')
})

test('imessage: a link in place of the database is not followed', async () => {
  const home = tempDir()
  const file = messagesDbPath(home)
  mkdirSync(dirname(file), { recursive: true })
  const elsewhere = tempDir()
  makeDb(join(elsewhere, 'x.sqlite'))
  symlinkSync(join(elsewhere, 'x.sqlite'), file)
  assert.equal((await setup({ home }).registry.sync(ID)).error.code, 'folder-missing')
})

test('imessage: injection text in a message is neutralised and changes nothing', async () => {
  const { home } = fixture({ msgs: [{ chat: 1, h: 1, text: INJECTION_TEXT, date: ns('2026-11-10T18:00:00Z') }] })
  const { registry } = setup({ home })
  const before = registry.grants.of(ID)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.ok(r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS')), 'the fixture must reach a document')
  for (const d of r.documents) assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
  assert.deepEqual(registry.grants.of(ID), before, 'no grant changed')
  assert.deepEqual(registry.tools?.(ID) ?? [], [])
})

test('imessage: disconnect forgets the marker and erase clears the store; no write; kill switches stop sync', async () => {
  const { home } = fixture()
  const erased = []
  const { registry, credentials } = setup({ home, onErase: (id) => erased.push(id) })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 3)
    assert.equal((await registry.disconnect(ID, { eraseData: true })).ok, true)
    assert.deepEqual(erased, [ID])
    assert.deepEqual(credentials.describe(ID).keys, [])
    assert.equal((await registry.sync(ID)).error.code, 'not-connected')
  } finally {
    store.close()
  }
  const second = setup({ home })
  assert.throws(() => second.registry.grants.grant(ID, 'write'))
  second.registry.grants.disable(ID)
  assert.equal((await second.registry.sync(ID)).error.code, 'disabled')
  second.registry.grants.enable(ID)
  second.registry.grants.freezeAll()
  assert.equal((await second.registry.sync(ID)).error.code, 'frozen')
})

test('imessage: dates, attributedBody decoding, cleaning and splitting long days', () => {
  assert.equal(messageDateMs(Number(ns('2026-11-10T18:00:00Z'))), Date.parse('2026-11-10T18:00:00Z'), 'nanoseconds')
  assert.equal(messageDateMs((Date.parse('2012-05-01T00:00:00Z') - CORE) / 1000), Date.parse('2012-05-01T00:00:00Z'), 'old seconds')
  assert.equal(messageDateMs(0), null)
  assert.equal(messageDateMs(null), null)
  assert.equal(decodeAttributedBody(attributed('héllo wörld')), 'héllo wörld')
  const long = 'x'.repeat(300)
  assert.equal(decodeAttributedBody(attributed(long)), long, 'two-byte length')
  assert.equal(decodeAttributedBody(null), null)
  assert.equal(decodeAttributedBody(Buffer.from('junk')), null)
  const cut = attributed('hello world').subarray(0, attributed('hello world').indexOf('hello') + 3)
  assert.equal(decodeAttributedBody(cut), null, 'length beyond the buffer')
  assert.equal(decodeAttributedBody(Buffer.concat([Buffer.from('NSString'), Buffer.from([1, 0x2b, 0x82, 0xff, 0xff, 0xff, 0x7f, 65])])), null)
  assert.equal(cleanMessage('a\u0000b\r\n  c\td'), 'a b c d')
  assert.equal(cleanMessage('x'.repeat(5000)).length, 2000)
  const rows = Array.from({ length: 30 }, (_, i) => ({
    rowid: i + 1, guid: 'g', ms: Date.parse('2026-11-10T10:00:00Z') + i * 1000, mine: i % 2 === 0, sender: 'a@b.c', text: 'y'.repeat(1000), chatName: '', chatIdent: 'a@b.c', group: false,
  }))
  const docs = messagesToDocuments(rows, { now: () => NOW })
  assert.ok(docs.length >= 2, 'a long day continues in parts')
  assert.match(docs[1].id, /:p2$/)
  assert.ok(docs.every((d) => d.text.length < 21_000))
  assert.equal(docs.reduce((n, d) => n + d.meta.messages, 0), 30)
  assert.deepEqual(messagesToDocuments([]), [])
})
