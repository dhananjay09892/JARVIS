/**
 * Apple Contacts (task C36): the README's acceptance tests against fixture
 * AddressBook databases built in a temp folder. No real Contacts data is
 * touched; the platform is injected so this runs everywhere.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  appleContactsConnector, addressBookDir, cleanLabel, contactToDocument, findDatabases, parseContactsCursor,
} from './apple_contacts.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const ID = 'apple_contacts'
const NOW = Date.parse('2026-11-11T08:00:00Z')
const CORE = Date.UTC(2001, 0, 1)
const sec = (iso) => (Date.parse(iso) - CORE) / 1000
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'abook-')))
  temps.push(d)
  return d
}

/** An AddressBook-v22.abcddb look-alike at `file`. */
function makeDb(file, { people = [], layout = 'ok' } = {}) {
  const db = new DatabaseSync(file)
  if (layout === 'ok') {
    db.exec(`CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFIRSTNAME TEXT, ZMIDDLENAME TEXT, ZLASTNAME TEXT,
      ZNICKNAME TEXT, ZORGANIZATION TEXT, ZJOBTITLE TEXT, ZDEPARTMENT TEXT, ZNAME TEXT, ZUNIQUEID TEXT, ZBIRTHDAY REAL,
      ZCREATIONDATE REAL, ZMODIFICATIONDATE REAL)`)
    db.exec('CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT, ZLABEL TEXT, ZORDERINGINDEX INTEGER)')
    db.exec('CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT, ZLABEL TEXT, ZORDERINGINDEX INTEGER)')
    db.exec('CREATE TABLE ZABCDNOTE (Z_PK INTEGER PRIMARY KEY, ZCONTACT INTEGER, ZTEXT TEXT)')
    db.exec('CREATE TABLE ZABCDPOSTALADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZSTREET TEXT, ZCITY TEXT)')
    const rec = db.prepare('INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZMIDDLENAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION, ZJOBTITLE, ZDEPARTMENT, ZNAME, ZUNIQUEID, ZBIRTHDAY, ZMODIFICATIONDATE) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const email = db.prepare('INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS, ZLABEL, ZORDERINGINDEX) VALUES (?,?,?,?)')
    const phone = db.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER, ZLABEL, ZORDERINGINDEX) VALUES (?,?,?,?)')
    for (const p of people) {
      rec.run(p.pk, p.ent ?? 22, p.first ?? null, p.middle ?? null, p.last ?? null, p.nick ?? null, p.org ?? null, p.job ?? null, p.dept ?? null,
        p.group ?? null, p.uid ?? null, sec('1990-05-01T00:00:00Z'), p.mod ?? null)
      ;(p.emails ?? []).forEach(([v, l], i) => email.run(p.pk, v, l ?? null, i))
      ;(p.phones ?? []).forEach(([v, l], i) => phone.run(p.pk, v, l ?? null, i))
      if (p.note) db.prepare('INSERT INTO ZABCDNOTE (ZCONTACT, ZTEXT) VALUES (?, ?)').run(p.pk, p.note)
      if (p.street) db.prepare('INSERT INTO ZABCDPOSTALADDRESS (ZOWNER, ZSTREET, ZCITY) VALUES (?, ?, ?)').run(p.pk, p.street, 'Pune')
    }
  } else {
    db.exec('CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZSOMETHING TEXT)')
  }
  db.close()
}

const LOCAL = [
  {
    pk: 1, first: 'Sam', last: 'Rivera', nick: 'Sammy', org: 'Acme', job: 'Engineer', dept: 'Platform', uid: 'AAAA-1111:ABPerson',
    mod: sec('2026-10-01T00:00:00Z'), emails: [['sam@example.com', '_$!<Work>!$_'], ['SAM@example.com', '_$!<Home>!$_'], ['sam.r@example.org', 'gym']],
    phones: [['+91 98765 43210', '_$!<Mobile>!$_']], note: 'Owes me lunch', street: '12 Hidden Lane',
  },
  { pk: 2, org: 'Pizza Place', uid: 'BBBB-2222:ABPerson', phones: [['020 1234 5678', null]] },
  { pk: 3, group: 'Family', uid: 'CCCC-3333:ABGroup', ent: 19 },
  { pk: 4, first: 'No', last: 'Id' },
]
const ICLOUD = [
  { pk: 1, first: 'Priya', last: 'Shah', uid: 'DDDD-4444:ABPerson', emails: [['priya@example.com', '_$!<Home>!$_']] },
  { pk: 2, first: 'Sam', last: 'Rivera', uid: 'AAAA-1111:ABPerson' },
]

/** A fake home with the local database and (optionally) one synced account. */
function fixture({ local = LOCAL, icloud = ICLOUD, layout = 'ok', withLocal = true } = {}) {
  const home = tempDir()
  const base = addressBookDir(home)
  mkdirSync(base, { recursive: true })
  if (withLocal) makeDb(join(base, 'AddressBook-v22.abcddb'), { people: local, layout })
  let source
  if (icloud) {
    const dir = join(base, 'Sources', '5E3F0D2A-ICLOUD')
    mkdirSync(dir, { recursive: true })
    source = join(dir, 'AddressBook-v22.abcddb')
    makeDb(source, { people: icloud })
  }
  return { home, file: join(base, 'AddressBook-v22.abcddb'), source }
}

function setup({ home, platform = 'darwin', granted = true, onErase } = {}) {
  const credentials = createMemoryCredentialStore()
  if (granted) credentials.set(ID, 'granted', '1')
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase, now: () => NOW })
  assert.equal(registry.register(appleContactsConnector({ home, platform })).ok, true)
  return { registry, credentials, lines }
}

test('apple_contacts: the card is valid, read-only, R1, mac-only and explains Full Disk Access', () => {
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

test('apple_contacts: local and synced-account databases sync wrapped documents with correct ids and mapping', async () => {
  const { home } = fixture()
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  for (const d of r.documents) {
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:apple_contacts"/)
    assert.equal(d.sensitivity, 'personal')
  }
  assert.deepEqual(r.documents.map((d) => d.id).sort(), [
    'contact:AAAA-1111:ABPerson', 'contact:BBBB-2222:ABPerson', 'contact:DDDD-4444:ABPerson',
  ], 'groups, records without an id and duplicates across accounts are left out')
  const sam = r.documents.find((d) => d.id === 'contact:AAAA-1111:ABPerson')
  assert.equal(sam.title, 'Sam Rivera')
  assert.match(sam.text, /Also called: Sammy/)
  assert.match(sam.text, /Email: sam@example\.com \(Work\), sam\.r@example\.org \(gym\)/, 'labels cleaned, case duplicates dropped')
  assert.match(sam.text, /Phone: \+91 98765 43210 \(Mobile\)/)
  assert.match(sam.text, /Work: Engineer, Platform, Acme/)
  assert.match(sam.text, /Source: Apple Contacts/)
  assert.equal(sam.updatedAt, Date.parse('2026-10-01T00:00:00Z'))
  assert.doesNotMatch(sam.text, /lunch|Hidden Lane|1990/, 'notes, addresses and birthdays are not read')
  const pizza = r.documents.find((d) => d.id === 'contact:BBBB-2222:ABPerson')
  assert.equal(pizza.title, 'Pizza Place')
  assert.doesNotMatch(pizza.text, /Work:/)
  assert.equal(pizza.updatedAt, NOW, 'no modification date: the sync time')
  assert.match(r.documents.find((d) => d.id === 'contact:DDDD-4444:ABPerson').text, /priya@example\.com \(Home\)/)
})

test('apple_contacts: only a synced account (no local database) still works', async () => {
  const { home } = fixture({ withLocal: false })
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 2)
})

test('apple_contacts: incremental sync reads nothing until a Contacts database changes', async () => {
  const { home, source } = fixture()
  const { registry } = setup({ home })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 3)
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0, 'unchanged: nothing to read')
    const db = new DatabaseSync(source)
    db.exec("UPDATE ZABCDRECORD SET ZLASTNAME = 'Shah-Mehta' WHERE Z_PK = 1")
    db.close()
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 3)
  } finally {
    store.close()
  }
  assert.equal(parseContactsCursor('{"v":1,"g":"short"}'), null)
  assert.equal(parseContactsCursor('nope'), null)
})

test('apple_contacts: off macOS it reports itself unavailable and cannot connect or sync', async () => {
  const { home } = fixture()
  const { registry } = setup({ home, platform: 'linux', granted: false })
  assert.equal(registry.status(ID).state, 'error')
  assert.match(registry.status(ID).detail, /only works on a Mac/)
  assert.equal((await registry.connect(ID, { confirmed: true })).error.code, 'unsupported-platform')
  assert.equal((await registry.sync(ID)).error.code, 'unsupported-platform')
})

test('apple_contacts: connect needs consent and a readable database; nothing is stored otherwise', async () => {
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
  assert.match(t.detail, /3 contacts/)
})

test('apple_contacts: missing permission gives the Full Disk Access message, not a crash', async () => {
  const { home, file } = fixture({ icloud: null })
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
  // A denied Sources folder is the permission error too (skipped where not enforced).
  const { home: h2 } = fixture()
  const src = join(addressBookDir(h2), 'Sources')
  chmodSync(src, 0o000)
  let srcEnforced = true
  try { (await import('node:fs')).readdirSync(src); srcEnforced = false } catch { /* denied */ }
  if (srcEnforced) await assert.rejects(() => findDatabases(h2), (e) => e.code === 'permission-needed')
  chmodSync(src, 0o700)
})

test('apple_contacts: an unrecognised database layout fails cleanly', async () => {
  const { home } = fixture({ layout: 'odd', icloud: null })
  const { registry } = setup({ home })
  const r = await registry.sync(ID)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
  assert.equal((await registry.test(ID)).ok, false)
  assert.equal((await setup({ home, granted: false }).registry.connect(ID, { confirmed: true })).error.code, 'bad-response')
})

test('apple_contacts: links in place of a database or account folder are not followed; a non-database fails cleanly', async () => {
  const home = tempDir()
  const base = addressBookDir(home)
  mkdirSync(join(base, 'Sources'), { recursive: true })
  const elsewhere = tempDir()
  makeDb(join(elsewhere, 'AddressBook-v22.abcddb'), { people: ICLOUD })
  symlinkSync(join(elsewhere, 'AddressBook-v22.abcddb'), join(base, 'AddressBook-v22.abcddb'))
  symlinkSync(elsewhere, join(base, 'Sources', 'LINKED'))
  await assert.rejects(() => findDatabases(home), (e) => e.code === 'folder-missing')
  rmSync(join(base, 'AddressBook-v22.abcddb'))
  writeFileSync(join(base, 'AddressBook-v22.abcddb'), 'this is not a database, just text '.repeat(50))
  const r = await setup({ home }).registry.sync(ID)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
})

test('apple_contacts: injection text in a contact is neutralised and changes nothing', async () => {
  const { home } = fixture({ local: [{ pk: 1, first: INJECTION_TEXT, org: INJECTION_TEXT, uid: 'EEEE-5555:ABPerson', emails: [['x@example.com', INJECTION_TEXT]] }], icloud: null })
  const { registry } = setup({ home })
  const before = registry.grants.of(ID)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const hit = r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.ok(hit, 'the fixture must reach a document')
  for (const d of r.documents) assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
  assert.deepEqual(registry.grants.of(ID), before, 'no grant changed')
  assert.deepEqual(registry.tools?.(ID) ?? [], [])
})

test('apple_contacts: disconnect forgets the marker and erase clears the store; no write; kill switches stop sync', async () => {
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

test('apple_contacts: labels and the document shape', () => {
  assert.equal(cleanLabel('_$!<Mobile>!$_'), 'Mobile')
  assert.equal(cleanLabel('gym'), 'gym')
  assert.equal(cleanLabel(null), '')
  const base = { uid: 'U-0001', name: '', nickname: '', org: '', jobTitle: '', department: '', emails: [], phones: [], modifiedMs: null }
  assert.equal(contactToDocument(base), null, 'nothing to show')
  assert.equal(contactToDocument({ ...base, uid: null, name: 'X' }), null, 'no stable id')
  const onlyEmail = contactToDocument({ ...base, emails: [{ value: 'a@example.com', label: '' }] }, { now: () => NOW })
  assert.equal(onlyEmail.title, 'a@example.com')
  assert.equal(onlyEmail.meta.email, 'a@example.com')
  assert.equal(onlyEmail.updatedAt, NOW)
})
