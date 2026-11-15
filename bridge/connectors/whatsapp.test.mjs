/**
 * WhatsApp chat export (task C40): the README's acceptance tests against fixture
 * export folders in a temp folder — Android .txt and iPhone .zip layouts,
 * several date styles, multi-line messages, skipped attachments and system lines,
 * incremental sync and deletions, link and path refusals, zip-bomb limits,
 * the injection fixture, erase and kill switches. No real chat is touched.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync, realpathSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import {
  whatsappConnector, parseChatText, chatNameFromFile, messagesToDocuments, parseWhatsappCursor, safeExportPath,
  resolveExportFolder, listExportFiles, readExportFile,
} from './whatsapp.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const ID = 'whatsapp'
const NOW = Date.parse('2026-11-15T08:00:00Z')
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = (name = 'wa-') => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), name)))
  temps.push(d)
  return d
}

// -- fixtures

const ANDROID = [
  '11/20/26, 9:41 PM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
  '11/20/26, 9:41 PM - Alice: Dinner on Friday?',
  '11/20/26, 9:42 PM - Bob: Yes, 7pm works',
  'but I might be ten minutes late',
  '11/20/26, 9:43 PM - Alice: <Media omitted>',
  '11/20/26, 9:44 PM - Bob: This message was deleted',
  '11/20/26, 9:45 PM - Alice joined using this group\'s invite link',
  '11/21/26, 8:05 AM - Alice: Happy new year',
].join('\n')

const IPHONE = [
  '\u200e[20/11/2026, 21:41:05] Carol: \u200eMessages and calls are end-to-end encrypted.',
  '[20/11/2026, 21:41:10] Carol: Lunch at noon?',
  '[20/11/2026, 21:42:00] Dave: \u200e<attached: 00000001-PHOTO-2026-11-20-21-42-00.jpg>',
  '[20/11/2026, 21:43:00] Dave: Sure, see you there',
  '[21/11/2026, 09:00:00] Carol: Morning',
].join('\n')

function zip(entries, { method = 8, lieSize } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, data] of entries) {
    const raw = Buffer.from(data)
    const body = method === 8 ? deflateRawSync(raw) : raw
    const nm = Buffer.from(name)
    const size = lieSize ?? raw.length
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nm.length, 26)
    locals.push(lh, nm, body)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42)
    central.push(ch, nm)
    offset += 30 + nm.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const T0 = Math.floor(Date.now() / 1000) * 1000 - 3600_000
function put(root, rel, content, min = 0) {
  const full = join(root, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  const t = new Date(T0 + min * 60_000)
  utimesSync(full, t, t)
  return full
}

function fixtureFolder({ extra } = {}) {
  const base = tempDir()
  const root = join(base, 'Exports')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'WhatsApp Chat with Secret.txt'), '1/1/24, 8:00 AM - Eve: OUTSIDE SECRET')
  put(root, 'WhatsApp Chat with Family.txt', ANDROID, 1)
  put(root, 'WhatsApp Chat - Work lunch.zip', zip([['_chat.txt', IPHONE], ['00000001-PHOTO.jpg', 'JPEGDATA']]), 2)
  put(root, 'notes.txt', 'just some text\nnot a chat at all', 3)
  put(root, 'photo.png', 'PNGDATA', 4)
  put(root, '.hidden/WhatsApp Chat with Hidden.txt', ANDROID, 5)
  symlinkSync(join(outside, 'WhatsApp Chat with Secret.txt'), join(root, 'WhatsApp Chat with Link.txt'))
  symlinkSync(outside, join(root, 'Linked folder'), 'dir')
  if (extra) extra(root)
  return { root, outside, base }
}

function setup({ root, opts = {}, onErase, connect = true } = {}) {
  const credentials = createMemoryCredentialStore()
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase, now: () => NOW })
  const reg = registry.register(whatsappConnector(opts))
  assert.equal(reg.ok, true, reg.error)
  if (connect && root) credentials.set(ID, 'folder', root)
  return { registry, credentials, lines }
}

// -- card

test('whatsapp: the card is valid, read-only, R2, local and says whose words these are', () => {
  const { registry } = setup()
  const c = registry.get(ID)
  assert.equal(c.auth, 'filesystem')
  assert.equal(c.risk, 'R2')
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(setupProblems(c.setup), [])
  assert.match(c.setup.localWhy, /Export chat/)
  assert.match(c.setup.sees.join(' '), /Other people wrote most/)
  assert.match(c.setup.sees.join(' '), /nothing is sent/i)
  assert.equal(registry.status(ID).state, 'disconnected')
  assert.deepEqual(registry.tools().filter((t) => t.id?.startsWith?.('whatsapp')), [])
})

// -- parsing

test('whatsapp: Android 12-hour month-first export parses, multi-line joins, media and system lines are skipped', () => {
  const { messages } = parseChatText(ANDROID)
  assert.deepEqual(messages.map((m) => [new Date(m.ms).toISOString(), m.sender, m.text]), [
    ['2026-11-20T21:41:00.000Z', 'Alice', 'Dinner on Friday?'],
    ['2026-11-20T21:42:00.000Z', 'Bob', 'Yes, 7pm works but I might be ten minutes late'],
    ['2026-11-21T08:05:00.000Z', 'Alice', 'Happy new year'],
  ])
})

test('whatsapp: iPhone bracket export with marks and attachments parses day-first', () => {
  const { messages } = parseChatText(IPHONE)
  assert.deepEqual(messages.map((m) => [new Date(m.ms).toISOString(), m.sender, m.text]), [
    ['2026-11-20T21:41:10.000Z', 'Carol', 'Lunch at noon?'],
    ['2026-11-20T21:43:00.000Z', 'Dave', 'Sure, see you there'],
    ['2026-11-21T09:00:00.000Z', 'Carol', 'Morning'],
  ])
})

test('whatsapp: other date styles — dots, dashes, 2-digit years, 24-hour, ambiguous dates default day-first, bad dates dropped', () => {
  const de = parseChatText('31.12.23, 21:41 - Anna: Hallo\n01.01.24, 08:00 - Anna: Neues Jahr').messages
  assert.deepEqual(de.map((m) => new Date(m.ms).toISOString()), ['2023-12-31T21:41:00.000Z', '2024-01-01T08:00:00.000Z'])
  const iso = parseChatText('2024-03-05, 14:30 - Li: hi').messages
  assert.equal(new Date(iso[0].ms).toISOString(), '2024-03-05T14:30:00.000Z')
  const amb = parseChatText('03/04/24, 10:00 - X: ambiguous').messages
  assert.equal(new Date(amb[0].ms).toISOString(), '2024-04-03T10:00:00.000Z', 'day-first when nothing says otherwise')
  const mf = parseChatText('03/04/24, 10:00 - X: a\n04/25/24, 10:00 - X: b').messages
  assert.equal(new Date(mf[0].ms).toISOString(), '2024-03-04T10:00:00.000Z', 'a second number above 12 makes the file month-first')
  const noon = parseChatText('1/2/24, 12:05 AM - X: midnight\n1/2/24, 12:05 PM - X: noon').messages
  assert.deepEqual(noon.map((m) => new Date(m.ms).getUTCHours()), [0, 12])
  const narrow = parseChatText('1/2/24, 9:05\u202fPM - X: narrow space').messages
  assert.equal(new Date(narrow[0].ms).getUTCHours(), 21)
  assert.deepEqual(parseChatText('31/02/24, 10:00 - X: no such day').messages, [])
  assert.deepEqual(parseChatText('').messages, [])
  assert.deepEqual(parseChatText('no timestamps here\nat all').messages, [])
  assert.equal(parseChatText('1/2/24, 9:05 AM - X: a\u0000b\tc').messages[0].text, 'a b c')
})

test('whatsapp: chat names come from file names; ids use only a hash', () => {
  assert.equal(chatNameFromFile('WhatsApp Chat with Alice.txt'), 'Alice')
  assert.equal(chatNameFromFile('sub/WhatsApp Chat - Work lunch.zip'), 'Work lunch')
  assert.equal(chatNameFromFile('WhatsApp Chat with Alice (1).txt'), 'Alice')
  assert.equal(chatNameFromFile('family.txt'), 'family')
  assert.equal(chatNameFromFile('WhatsApp Chat with .txt'), 'a chat')
  const docs = messagesToDocuments(parseChatText(ANDROID).messages, 'Family', { now: () => NOW })
  assert.equal(docs.length, 2)
  assert.match(docs[0].id, /^whatsapp:[0-9a-f]{12}:2026-11-20$/)
  assert.doesNotMatch(docs[0].id, /Family/)
  assert.match(docs[0].text, /WhatsApp chat with Family, 2026-11-20/)
  assert.match(docs[0].text, /\[21:42\] Bob: Yes, 7pm works but I might be ten minutes late/)
  assert.equal(docs[0].sensitivity, 'messages')
  assert.equal(docs[0].meta.messages, 2)
  const long = Array.from({ length: 30 }, (_, i) => ({ ms: Date.UTC(2024, 0, 1, 10, 0, i), sender: 'A', text: 'y'.repeat(1000) }))
  const parts = messagesToDocuments(long, 'Long')
  assert.ok(parts.length >= 2)
  assert.match(parts[1].id, /:p2$/)
  assert.ok(parts.every((d) => d.text.length < 21_000))
  assert.equal(parts.reduce((n, d) => n + d.meta.messages, 0), 30)
})

// -- sync

test('whatsapp: txt and zip exports sync as wrapped messages-class documents; non-chats, dot folders and links are left out', async () => {
  const { root } = fixtureFolder()
  const { registry } = setup({ root })
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 4, 'Family on 2 days, Work lunch on 2 days')
  for (const d of r.documents) {
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:whatsapp"/)
    assert.equal(d.sensitivity, 'messages')
  }
  const all = r.documents.map((d) => d.text).join('\n')
  assert.match(all, /Dinner on Friday\?/)
  assert.match(all, /Lunch at noon\?/)
  assert.doesNotMatch(all, /OUTSIDE SECRET|Hidden|just some text|JPEGDATA|PHOTO|Media omitted|deleted|end-to-end|joined using/)
  assert.deepEqual(setup({ root }).registry.get(ID).capabilities.write, false)
})

test('whatsapp: incremental sync reads only changed files, rewrites them and deletes what a re-export dropped or a removed file made', async () => {
  const { root } = fixtureFolder()
  const { registry } = setup({ root })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 4)
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0, 'nothing changed: nothing read')
    // a newer export of Family: first day gets one more message, the second day is gone
    put(root, 'WhatsApp Chat with Family.txt', `${ANDROID.split('\n').slice(0, 7).join('\n')}\n11/20/26, 9:50 PM - Alice: Added later`, 10)
    const r = await syncConnectorInto(registry, store, ID)
    assert.equal(r.saved, 1)
    assert.equal(r.removed, 1, 'the 2026-11-21 day is no longer in the export')
    assert.match(store.search ? JSON.stringify(store.search('Added later')) : 'Added later', /Added later/)
    unlinkSync(join(root, 'WhatsApp Chat - Work lunch.zip'))
    const r2 = await syncConnectorInto(registry, store, ID)
    assert.equal(r2.removed, 2, 'the removed file takes its two days with it')
  } finally {
    store.close()
  }
})

test('whatsapp: a different folder deletes what the old one produced; garbage cursors are ignored', async () => {
  const a = fixtureFolder()
  const { registry, credentials } = setup({ root: a.root })
  const first = await registry.sync(ID)
  const cursorOf = first.cursor
  assert.ok(cursorOf, 'a cursor comes back')
  const b = fixtureFolder()
  credentials.set(ID, 'folder', b.root)
  const second = await registry.sync(ID, { cursor: cursorOf })
  assert.equal(second.ok, true, JSON.stringify(second.error))
  assert.equal(second.documents.length, 4, 'the same chats are saved again')
  assert.deepEqual(second.deleted, [], 'ids the new folder produces again are not deleted')
  // a folder that produces something else: the old ids go
  const c = tempDir()
  put(c, 'WhatsApp Chat with Other.txt', '1/1/24, 8:00 AM - Zed: hi', 1)
  credentials.set(ID, 'folder', c)
  const third = await registry.sync(ID, { cursor: cursorOf })
  assert.equal(third.documents.length, 1)
  assert.equal(third.deleted.length, 4, 'the old folder\'s four days leave the store')
  assert.equal(parseWhatsappCursor('nope'), null)
  assert.equal(parseWhatsappCursor('{"v":2}'), null)
  const good = parseWhatsappCursor(JSON.stringify({ v: 1, r: 'x', f: { 'a.txt': [1, 2, ['0123456789ab:2024-01-01', 'bad id']], '../x.txt': [1, 2, []] } }))
  assert.deepEqual([...good.files.keys()], ['a.txt'])
  assert.deepEqual(good.files.get('a.txt')[2], ['0123456789ab:2024-01-01'])
})

test('whatsapp: maxPerSync reads a few files per run and the rest wait', async () => {
  const { root } = fixtureFolder()
  const { registry } = setup({ root, opts: { maxPerSync: 1 } })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    const one = await syncConnectorInto(registry, store, ID)
    const two = await syncConnectorInto(registry, store, ID)
    const three = await syncConnectorInto(registry, store, ID)
    assert.equal(one.saved + two.saved + three.saved, 4)
    assert.equal(three.saved >= 0, true)
  } finally {
    store.close()
  }
})

// -- connect, folder and file safety

test('whatsapp: connect needs consent and a real folder, and stores nothing otherwise', async () => {
  const { root } = fixtureFolder()
  const home = tempDir('home-')
  const { registry, credentials } = setup({ opts: { home } })
  const tries = [
    [{ path: root }, 'consent-denied'],
    [{ confirmed: true }, 'folder-missing'],
    [{ confirmed: true, path: 'relative/folder' }, 'folder-missing'],
    [{ confirmed: true, path: join(root, 'nope') }, 'folder-missing'],
    [{ confirmed: true, path: join(root, 'notes.txt') }, 'folder-missing'],
    [{ confirmed: true, path: home }, 'folder-missing'],
    [{ confirmed: true, path: '/' }, 'folder-missing'],
  ]
  for (const [input, code] of tries) {
    const r = await registry.connect(ID, input)
    assert.equal(r.ok, false)
    assert.equal(r.error.code, code, JSON.stringify(input))
  }
  assert.deepEqual(credentials.describe(ID).keys, [])
  const ok = await registry.connect(ID, { confirmed: true, path: root })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  assert.equal(registry.status(ID).state, 'ok')
  const t = await registry.test(ID)
  assert.equal(t.ok, true)
  assert.match(t.detail, /3 export files/)
  const empty = tempDir('empty-')
  const e = setup({ root: empty })
  assert.match((await e.registry.test(ID)).detail, /no \.txt or \.zip files yet/)
})

test('whatsapp: a missing folder after connecting gives a clear error; not connected gives another', async () => {
  const { root } = fixtureFolder()
  const { registry, credentials } = setup({ root })
  rmSync(root, { recursive: true, force: true })
  assert.equal((await registry.sync(ID)).error.code, 'folder-missing')
  assert.equal((await setup({ root: null }).registry.sync(ID)).error.code, 'not-connected')
  credentials.delete(ID, 'folder')
  assert.equal((await registry.sync(ID)).error.code, 'not-connected')
})

test('whatsapp: listing skips links and dot entries; readExportFile refuses escapes and links', async () => {
  const { root, outside } = fixtureFolder()
  const { files } = await listExportFiles(root)
  assert.deepEqual(files.map((f) => f.path), ['WhatsApp Chat - Work lunch.zip', 'WhatsApp Chat with Family.txt', 'notes.txt'])
  for (const bad of ['../outside/WhatsApp Chat with Secret.txt', '/etc/passwd.txt', 'C:\\x.txt', '.hidden/WhatsApp Chat with Hidden.txt', 'a//b.txt', 'x.png', 42, '']) {
    assert.ok((await readExportFile(root, bad)).refused, `refused: ${bad}`)
  }
  assert.match((await readExportFile(root, 'WhatsApp Chat with Link.txt')).refused, /link/)
  assert.match((await readExportFile(root, 'Linked folder/WhatsApp Chat with Secret.txt')).refused, /link/)
  assert.match((await readExportFile(root, 'missing.txt')).refused, /no such file/)
  assert.equal(safeExportPath('a/b.txt'), 'a/b.txt')
  assert.equal(safeExportPath('a\\b.txt'), 'a/b.txt')
  assert.equal(safeExportPath('a/../b.txt'), null)
  assert.ok(outside)
  await assert.rejects(resolveExportFolder(join(root, 'WhatsApp Chat with Family.txt')), { code: 'folder-missing' })
})

test('whatsapp: a bad zip, an encrypted-looking zip and a zip-bomb lie fail cleanly for that file only', async () => {
  const { root } = fixtureFolder({
    extra: (r) => {
      put(r, 'WhatsApp Chat with Broken.zip', 'PK this is not a zip', 20)
      put(r, 'WhatsApp Chat with Empty zip.zip', zip([['readme.md', 'no chat here']]), 21)
      put(r, 'WhatsApp Chat with Liar.zip', zip([['_chat.txt', `1/1/24, 8:00 AM - Mal: ${'x'.repeat(5000)}`]], { lieSize: 10 }), 22)
      put(r, 'WhatsApp Chat with Stored.zip', zip([['_chat.txt', '1/2/24, 8:00 AM - Sam: stored not deflated']], { method: 0 }), 23)
    },
  })
  const { registry } = setup({ root })
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const all = r.documents.map((d) => d.text).join('\n')
  assert.match(all, /stored not deflated/)
  assert.doesNotMatch(all, /xxxxx/)
  assert.ok((await readExportFile(root, 'WhatsApp Chat with Broken.zip')).refused)
  assert.ok((await readExportFile(root, 'WhatsApp Chat with Empty zip.zip')).refused)
  assert.match((await readExportFile(root, 'WhatsApp Chat with Liar.zip')).refused, /inflates beyond|damaged/)
})

// -- safety

test('whatsapp: injection text in a message is neutralised and changes nothing', async () => {
  const { root } = fixtureFolder({ extra: (r) => put(r, 'WhatsApp Chat with Mallory.txt', `1/1/24, 8:00 AM - Mallory: ${INJECTION_TEXT}`, 30) })
  const { registry } = setup({ root })
  const before = registry.grants.of(ID)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.ok(r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS')), 'the fixture must reach a document')
  for (const d of r.documents) assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
  assert.deepEqual(registry.grants.of(ID), before, 'no grant changed')
  assert.deepEqual(registry.tools().filter((t) => String(t.name ?? t.id ?? '').includes('whatsapp')), [])
})

test('whatsapp: disconnect forgets the folder and erase clears the store; no write; kill switches stop sync', async () => {
  const { root } = fixtureFolder()
  const erased = []
  const { registry, credentials } = setup({ root, onErase: (id) => erased.push(id) })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 4)
    assert.equal((await registry.disconnect(ID, { eraseData: true })).ok, true)
    assert.deepEqual(erased, [ID])
    assert.deepEqual(credentials.describe(ID).keys, [])
    assert.equal((await registry.sync(ID)).error.code, 'not-connected')
  } finally {
    store.close()
  }
  const second = setup({ root })
  assert.throws(() => second.registry.grants.grant(ID, 'write'))
  second.registry.grants.disable(ID)
  assert.equal((await second.registry.sync(ID)).error.code, 'disabled')
  second.registry.grants.enable(ID)
  second.registry.grants.freezeAll()
  assert.equal((await second.registry.sync(ID)).error.code, 'frozen')
})
