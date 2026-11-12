/**
 * Apple Notes (task C37): the README's acceptance tests against fixture
 * NoteStore databases built in a temp folder. No real Notes data is touched;
 * the platform is injected so this runs everywhere.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { appleNotesConnector, cleanBody, decodeNoteText, noteToDocument, notesDbPath, parseNotesCursor } from './apple_notes.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const ID = 'apple_notes'
const NOW = Date.parse('2026-11-12T08:00:00Z')
const CORE = Date.UTC(2001, 0, 1)
const sec = (iso) => (Date.parse(iso) - CORE) / 1000
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'notes-')))
  temps.push(d)
  return d
}

const varint = (n) => {
  const out = []
  while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128) }
  out.push(n)
  return Buffer.from(out)
}
const field = (no, payload) => Buffer.concat([varint(no * 8 + 2), varint(payload.length), payload])
/** gzip(protobuf) the way Notes stores a body: root.2 = document, document.3 = note, note.2 = text. */
const bodyBlob = (text) =>
  gzipSync(Buffer.concat([
    Buffer.concat([varint(1 * 8), varint(7)]), // an unrelated varint field is skipped
    field(2, Buffer.concat([Buffer.concat([varint(2 * 8), varint(0)]), field(3, Buffer.concat([field(1, Buffer.from('x')), field(2, Buffer.from(text, 'utf8'))]))])),
  ]))

function makeDb(file, { notes = [], layout = 'ok' } = {}) {
  const db = new DatabaseSync(file)
  if (layout === 'ok') {
    db.exec(`CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE2 TEXT,
      ZSNIPPET TEXT, ZMODIFICATIONDATE1 REAL, ZFOLDER INTEGER, ZFOLDERTYPE INTEGER, ZNOTEDATA INTEGER, ZMARKEDFORDELETION INTEGER,
      ZISPASSWORDPROTECTED INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB)`)
    db.exec('CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB)')
    db.exec("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2, ZFOLDERTYPE) VALUES (900, 'Notes', 0), (901, 'Recently Deleted', 1)")
    let pk = 1
    for (const n of notes) {
      const dataPk = pk
      db.prepare('INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (?,?,?)').run(dataPk, pk, n.rawBody ?? (n.body === undefined ? null : bodyBlob(n.body)))
      db.prepare(`INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZSNIPPET, ZMODIFICATIONDATE1, ZFOLDER, ZNOTEDATA,
        ZMARKEDFORDELETION, ZISPASSWORDPROTECTED, ZCRYPTOINITIALIZATIONVECTOR) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(pk, 12, n.uid ?? null, n.title ?? null, n.snippet ?? null, n.mod ?? null, n.trash ? 901 : 900, dataPk, n.deleted ? 1 : 0, n.locked ? 1 : 0, n.iv ? Buffer.from('iv') : null)
      pk++
    }
  } else {
    db.exec('CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZSOMETHING TEXT)')
  }
  db.close()
}

const NOTES = [
  { uid: 'NOTE-AAAA-1', title: 'Shopping list', body: 'Shopping list\nmilk\u{FFFC}\neggs\n\n\n\nbread', snippet: 'Shopping list milk', mod: sec('2026-10-01T00:00:00Z') },
  { uid: 'NOTE-BBBB-2', body: 'Untitled idea\nfirst line becomes the title', mod: null },
  { uid: 'NOTE-CCCC-3', title: 'Snippet only', rawBody: Buffer.from('not gzip at all'), snippet: 'Only the snippet is known', mod: sec('2026-09-01T00:00:00Z') },
  { uid: 'NOTE-DDDD-4', title: 'Bank PINs', body: 'SECRET LOCKED TEXT', locked: true },
  { uid: 'NOTE-EEEE-5', title: 'Encrypted', body: 'SECRET IV TEXT', iv: true },
  { uid: 'NOTE-FFFF-6', title: 'In the bin', body: 'DELETED TEXT', trash: true },
  { uid: 'NOTE-GGGG-7', title: 'Marked', body: 'MARKED TEXT', deleted: true },
  { uid: null, title: 'No id', body: 'x' },
]

function fixture({ notes = NOTES, layout = 'ok', create = true } = {}) {
  const home = tempDir()
  const file = notesDbPath(home)
  mkdirSync(dirname(file), { recursive: true })
  if (create) makeDb(file, { notes, layout })
  return { home, file }
}

function setup({ home, platform = 'darwin', granted = true, onErase } = {}) {
  const credentials = createMemoryCredentialStore()
  if (granted) credentials.set(ID, 'granted', '1')
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase, now: () => NOW })
  assert.equal(registry.register(appleNotesConnector({ home, platform })).ok, true)
  return { registry, credentials, lines }
}

test('apple_notes: the card is valid, read-only, R1, mac-only and explains Full Disk Access', () => {
  const { registry } = setup({ home: tempDir() })
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.equal(c.risk, 'R1')
  assert.deepEqual(c.platforms, ['mac'])
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.match(c.setup.localWhy, /Full Disk Access/)
  assert.match(c.setup.localWhy, /private copy/)
  assert.deepEqual(c.tools, [])
})

test('apple_notes: fixture notes sync as wrapped documents; locked, deleted and id-less notes are left out', async () => {
  const { home } = fixture()
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  for (const d of r.documents) {
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:apple_notes"/)
    assert.equal(d.sensitivity, 'personal')
  }
  assert.deepEqual(r.documents.map((d) => d.id).sort(), ['note:NOTE-AAAA-1', 'note:NOTE-BBBB-2', 'note:NOTE-CCCC-3'])
  const all = r.documents.map((d) => d.text).join('\n')
  assert.doesNotMatch(all, /SECRET|DELETED TEXT|MARKED TEXT/, 'locked and deleted note text is never read')
  const list = r.documents.find((d) => d.id === 'note:NOTE-AAAA-1')
  assert.equal(list.title, 'Shopping list')
  assert.match(list.text, /Folder: Notes/)
  assert.match(list.text, /milk\neggs\n\nbread/, 'placeholders removed, blank runs collapsed')
  assert.equal(list.updatedAt, Date.parse('2026-10-01T00:00:00Z'))
  const idea = r.documents.find((d) => d.id === 'note:NOTE-BBBB-2')
  assert.equal(idea.title, 'Untitled idea', 'no title: the first line')
  assert.equal(idea.updatedAt, NOW)
  const snip = r.documents.find((d) => d.id === 'note:NOTE-CCCC-3')
  assert.match(snip.text, /Only the snippet is known/, 'undecodable body falls back to the snippet')
})

test('apple_notes: incremental sync reads nothing until the Notes database changes', async () => {
  const { home, file } = fixture()
  const { registry } = setup({ home })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 3)
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0, 'unchanged: nothing to read')
    const db = new DatabaseSync(file)
    db.exec("UPDATE ZICCLOUDSYNCINGOBJECT SET ZTITLE1 = 'Shopping list v2' WHERE ZIDENTIFIER = 'NOTE-AAAA-1'")
    db.close()
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 3)
  } finally {
    store.close()
  }
  assert.equal(parseNotesCursor('{"v":1,"g":"short"}'), null)
  assert.equal(parseNotesCursor('nope'), null)
})

test('apple_notes: off macOS it reports itself unavailable and cannot connect or sync', async () => {
  const { home } = fixture()
  const { registry } = setup({ home, platform: 'linux', granted: false })
  assert.equal(registry.status(ID).state, 'error')
  assert.match(registry.status(ID).detail, /only works on a Mac/)
  assert.equal((await registry.connect(ID, { confirmed: true })).error.code, 'unsupported-platform')
  assert.equal((await registry.sync(ID)).error.code, 'unsupported-platform')
})

test('apple_notes: connect needs consent and a readable database; nothing is stored otherwise', async () => {
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
  assert.match(t.detail, /3 notes/)
})

test('apple_notes: missing permission gives the Full Disk Access message, not a crash', async () => {
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

test('apple_notes: an unrecognised layout and a non-database fail cleanly', async () => {
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

test('apple_notes: a link in place of the database is not followed', async () => {
  const home = tempDir()
  const file = notesDbPath(home)
  mkdirSync(dirname(file), { recursive: true })
  const elsewhere = tempDir()
  makeDb(join(elsewhere, 'x.sqlite'), { notes: NOTES })
  symlinkSync(join(elsewhere, 'x.sqlite'), file)
  assert.equal((await setup({ home }).registry.sync(ID)).error.code, 'folder-missing')
})

test('apple_notes: injection text in a note is neutralised and changes nothing', async () => {
  const { home } = fixture({ notes: [{ uid: 'NOTE-INJ-1', title: INJECTION_TEXT, body: INJECTION_TEXT }] })
  const { registry } = setup({ home })
  const before = registry.grants.of(ID)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.ok(r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS')), 'the fixture must reach a document')
  for (const d of r.documents) assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
  assert.deepEqual(registry.grants.of(ID), before, 'no grant changed')
  assert.deepEqual(registry.tools?.(ID) ?? [], [])
})

test('apple_notes: disconnect forgets the marker and erase clears the store; no write; kill switches stop sync', async () => {
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

test('apple_notes: body decoding, cleaning and the document shape', () => {
  assert.equal(decodeNoteText(bodyBlob('héllo\nwörld')), 'héllo\nwörld')
  assert.equal(decodeNoteText(null), null)
  assert.equal(decodeNoteText(Buffer.from('junk')), null)
  assert.equal(decodeNoteText(gzipSync(Buffer.from([0x12, 0xff, 0xff]))), null, 'truncated protobuf')
  assert.equal(decodeNoteText(gzipSync(Buffer.alloc(5 * 1024 * 1024))), null, 'inflate bomb refused')
  assert.equal(cleanBody('a\u0000b\r\nc\u{FFFC}\n\n\n\nd'), 'ab\nc\n\nd')
  assert.equal(cleanBody('x'.repeat(30000)).length, 20000)
  const base = { uid: 'U-0001', title: '', folder: '', snippet: '', body: null, modifiedMs: null }
  assert.equal(noteToDocument(base), null, 'nothing to show')
  assert.equal(noteToDocument({ ...base, uid: null, title: 'X' }), null, 'no stable id')
  const d = noteToDocument({ ...base, snippet: 'just a snippet' }, { now: () => NOW })
  assert.equal(d.title, 'just a snippet')
  assert.equal(d.updatedAt, NOW)
})
