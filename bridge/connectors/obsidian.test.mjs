/**
 * Obsidian (task C13): the README's acceptance tests against fixture vaults in
 * a temp folder — sync, incremental sync, deletions, path-escape attempts,
 * symlinks, the injection fixture, erase, no writes, kill switches, and the
 * folder watcher. No real vault is touched.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync, realpathSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  obsidianConnector, parseFrontmatter, mapWikilinks, inlineTags, obsidianUrl, noteToDocument,
  safeNotePath, readNoteSafely, listNotes, parseObsidianCursor, resolveVaultFolder,
} from './obsidian.mjs'
import { createConnectorRegistry, connectorToolName } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { createConnectorWatcher } from './watch.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = (name = 'obs-') => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), name)))
  temps.push(d)
  return d
}

const T0 = Math.floor(Date.now() / 1000) * 1000 - 60 * 60_000
const at = (min) => new Date(T0 + min * 60_000)
function put(root, rel, content, min = 0) {
  const full = join(root, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  utimesSync(full, at(min), at(min))
  return full
}

/** A fixture vault, plus a secret folder outside it that links point at. */
function fixtureVault({ injection } = {}) {
  const base = tempDir()
  const root = join(base, 'My Vault')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.md'), 'OUTSIDE SECRET')
  mkdirSync(join(outside, 'dir'))
  writeFileSync(join(outside, 'dir', 'leak.md'), 'OUTSIDE DIR SECRET')
  put(root, '.obsidian/workspace.json', '{"x":1}')
  put(root, '.obsidian/notes.md', 'config note, never read')
  put(root, '.trash/old.md', 'trashed, never read')
  put(root, 'Welcome.md', [
    '---',
    'title: Welcome home',
    'tags: [inbox, "start"]',
    'aliases:',
    '  - Hello',
    '  - Start page',
    'status: draft',
    'nested:',
    '  key: skipped',
    '---',
    '# Welcome',
    'See [[Trips/Lisbon|the Lisbon trip]] and [[Ideas#Later]] and [[Plain]].',
    '![[photo.png]] #todo #2024 and `#notatag`',
  ].join('\n'), 1)
  put(root, 'Trips/Lisbon.md', injection ? `Packing list\n${injection}` : 'Packing list\n- passport\n- charger', 2)
  put(root, 'Ideas.markdown', 'An idea worth keeping.', 3)
  put(root, 'log.txt', 'plain [[not a link]] text', 4)
  put(root, 'photo.png', 'PNGDATA', 5)
  put(root, 'empty.md', '', 6)
  symlinkSync(join(outside, 'secret.md'), join(root, 'linked.md'))
  symlinkSync(join(outside, 'dir'), join(root, 'Linked folder'), 'dir')
  return { root, outside, base }
}

function setup({ root, opts = {}, onErase, connect = true } = {}) {
  const credentials = createMemoryCredentialStore()
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase })
  const reg = registry.register(obsidianConnector(opts))
  assert.equal(reg.ok, true, reg.error)
  if (connect && root) credentials.set('obsidian', 'vault', root)
  return { registry, credentials, lines }
}

const strip = (t) => t.replace(/^<untrusted_data[^>]*>\n?/, '').replace(/\n?<\/untrusted_data>$/, '')
const tool = async (registry, name, input) => {
  const r = await registry.callTool(connectorToolName('obsidian', 'read', name), input)
  return { ...r, value: r.isError ? null : JSON.parse(strip(r.content[0].text)) }
}

// ------------------------------------------------------------- card and connect

test('obsidian registers as a read-only, local, R0 data connector with a valid card', () => {
  const { registry } = setup()
  const c = registry.get('obsidian')
  assert.equal(c.auth, 'filesystem')
  assert.equal(c.risk, 'R0')
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: true })
  assert.deepEqual(setupProblems(c.setup), [])
  assert.match(c.setup.localWhy, /vault/)
  assert.equal(registry.grants.has('obsidian', 'subscribe'), false, 'background sync starts off')
  assert.equal(registry.status('obsidian').state, 'disconnected')
  assert.ok(registry.tools().every((t) => t.readOnly))
})

test('connect checks consent and the folder, and stores nothing when it is not usable', async () => {
  const { root, base } = fixtureVault()
  const home = tempDir('home-')
  const { registry, credentials } = setup({ opts: { home } })
  const tries = [
    [{ path: root }, 'consent-denied'],
    [{ confirmed: true }, 'folder-missing'],
    [{ confirmed: true, path: 'relative/vault' }, 'folder-missing'],
    [{ confirmed: true, path: join(base, 'nope') }, 'folder-missing'],
    [{ confirmed: true, path: join(root, 'Welcome.md') }, 'folder-missing'],
    [{ confirmed: true, path: '/' }, 'folder-missing'],
    [{ confirmed: true, path: home }, 'folder-missing'],
    [{ confirmed: true, path: '~' }, 'folder-missing'],
  ]
  for (const [opts, code] of tries) {
    const r = await registry.connect('obsidian', opts)
    assert.equal(r.ok, false, JSON.stringify(opts))
    assert.equal(r.error.code, code, JSON.stringify(opts))
    assert.deepEqual(credentials.describe('obsidian').keys, [])
  }
  const ok = await registry.connect('obsidian', { confirmed: true, path: root })
  assert.equal(ok.ok, true)
  assert.equal(ok.result.account, 'My Vault')
  assert.match(ok.result.detail, /read-only/)
  assert.equal(credentials.get('obsidian', 'vault'), root)
  assert.equal(registry.status('obsidian').state, 'ok')
})

test('connect follows ~ to the home folder and resolves a linked folder to its real path', async () => {
  const home = tempDir('home-')
  put(home, 'Notes/a.md', 'a')
  symlinkSync(join(home, 'Notes'), join(home, 'NotesLink'), 'dir')
  assert.equal(await resolveVaultFolder('~/Notes', { home }), join(home, 'Notes'))
  assert.equal(await resolveVaultFolder(join(home, 'NotesLink'), { home }), join(home, 'Notes'))
  const { registry } = setup({ opts: { home } })
  const r = await registry.connect('obsidian', { confirmed: true, path: '~/Notes' })
  assert.equal(r.ok, true)
  assert.match(r.result.detail, /no \.obsidian folder/)
})

// ------------------------------------------------------------- sync

test('fixture vault sync: notes only, ids, titles, times, links, tags, wrapped as untrusted', async () => {
  const { root } = fixtureVault()
  const { registry } = setup({ root })
  const r = await registry.sync('obsidian')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const ids = r.documents.map((d) => d.id).sort()
  assert.deepEqual(ids, ['Ideas.markdown', 'Trips/Lisbon.md', 'Welcome.md', 'empty.md', 'log.txt'])
  for (const d of r.documents) {
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:obsidian"/)
    assert.ok(!d.text.includes('OUTSIDE'), 'nothing behind a link is read')
    assert.ok(!d.text.includes('never read'))
  }
  const w = r.documents.find((d) => d.id === 'Welcome.md')
  assert.equal(w.title, 'Welcome home')
  assert.equal(w.updatedAt, at(1).getTime())
  assert.equal(w.url, 'obsidian://open?vault=My%20Vault&file=Welcome')
  assert.match(w.text, /Tags: inbox, start, todo/)
  assert.match(w.text, /Aliases: Hello, Start page/)
  assert.match(w.text, /status: draft/)
  assert.ok(!w.text.includes('skipped'), 'nested maps are not read')
  assert.match(w.text, /See the Lisbon trip and Ideas › Later and Plain\./)
  assert.match(w.text, /\[embedded: photo\.png\]/)
  assert.equal(w.meta.links, 'Trips/Lisbon, Ideas, Plain')
  assert.equal(w.meta.tags, 'inbox, start, todo')
  assert.equal(w.meta.folder, '')
  const l = r.documents.find((d) => d.id === 'Trips/Lisbon.md')
  assert.equal(l.title, 'Lisbon')
  assert.equal(l.meta.folder, 'Trips')
  assert.equal(l.url, 'obsidian://open?vault=My%20Vault&file=Trips%2FLisbon')
  assert.match(r.documents.find((d) => d.id === 'log.txt').text, /\[\[not a link\]\]/, '.txt is plain text')
  assert.equal(r.documents.find((d) => d.id === 'empty.md').title, 'empty')
  assert.ok(registry.status('obsidian').lastSync)
})

test('incremental sync through the store: only changed notes, and deletions leave', async () => {
  const { root } = fixtureVault()
  const { registry } = setup({ root })
  const store = openDocumentStore({ file: ':memory:' })
  try {
    assert.deepEqual(await syncConnectorInto(registry, store, 'obsidian'), { ok: true, saved: 5, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'obsidian'), { ok: true, saved: 0, removed: 0, skipped: 0 })
    put(root, 'Ideas.markdown', 'An idea worth keeping. Edited.', 30)
    put(root, 'New/Fresh.md', 'brand new', 31)
    assert.deepEqual(await syncConnectorInto(registry, store, 'obsidian'), { ok: true, saved: 2, removed: 0, skipped: 0 })
    assert.match(store.get('obsidian', 'Ideas.markdown').text, /Edited/)
    unlinkSync(join(root, 'log.txt'))
    renameSync(join(root, 'empty.md'), join(root, 'New', 'empty.md'))
    const r = await syncConnectorInto(registry, store, 'obsidian')
    assert.deepEqual(r, { ok: true, saved: 1, removed: 2, skipped: 0 })
    assert.equal(store.get('obsidian', 'log.txt'), null)
    assert.ok(store.get('obsidian', 'New/empty.md'))
  } finally {
    store.close?.()
  }
})

test('a large vault syncs in batches, newest first, and the rest wait for the next run', async () => {
  const root = tempDir()
  for (let i = 0; i < 7; i++) put(root, `n${i}.md`, `note ${i}`, i)
  const { registry } = setup({ root, opts: { maxPerSync: 3 } })
  const one = await registry.sync('obsidian')
  assert.deepEqual(one.documents.map((d) => d.id), ['n6.md', 'n5.md', 'n4.md'])
  const two = await registry.sync('obsidian', { cursor: one.cursor })
  assert.deepEqual(two.documents.map((d) => d.id), ['n3.md', 'n2.md', 'n1.md'])
  const three = await registry.sync('obsidian', { cursor: two.cursor })
  assert.deepEqual(three.documents.map((d) => d.id), ['n0.md'])
  const four = await registry.sync('obsidian', { cursor: three.cursor })
  assert.deepEqual(four.documents, [])
  assert.equal(parseObsidianCursor(four.cursor).files.size, 7)
})

test('since skips older notes on the first sync; a cursor from another vault deletes its notes', async () => {
  const root = tempDir()
  put(root, 'old.md', 'old', 0)
  put(root, 'new.md', 'new', 50)
  const { registry, credentials } = setup({ root })
  const r = await registry.sync('obsidian', { since: at(10).getTime() })
  assert.deepEqual(r.documents.map((d) => d.id), ['new.md'])
  const other = tempDir()
  put(other, 'x.md', 'x', 1)
  credentials.set('obsidian', 'vault', other)
  const s = await registry.sync('obsidian', { cursor: r.cursor })
  assert.deepEqual(s.deleted.map((x) => x.id).sort(), ['new.md', 'old.md'])
  assert.deepEqual(s.documents.map((d) => d.id), ['x.md'])
})

test('a note too large or not text is skipped, and leaves the store if it was kept', async () => {
  const root = tempDir()
  put(root, 'a.md', 'small', 1)
  put(root, 'bin.md', Buffer.from([0x61, 0x00, 0x62]), 2)
  const { registry } = setup({ root, opts: { maxFileBytes: 100 } })
  const one = await registry.sync('obsidian')
  assert.deepEqual(one.documents.map((d) => d.id), ['a.md'])
  put(root, 'a.md', 'x'.repeat(500), 3)
  const two = await registry.sync('obsidian', { cursor: one.cursor })
  assert.deepEqual(two.documents, [])
  assert.deepEqual(two.deleted.map((x) => x.id), ['a.md'])
})

test('a vault folder that disappears is reported clearly, not thrown', async () => {
  const { root } = fixtureVault()
  const { registry } = setup({ root })
  rmSync(root, { recursive: true, force: true })
  const r = await registry.sync('obsidian')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'folder-missing')
  assert.match(r.error.message, /Settings → Connectors/)
  assert.equal(registry.status('obsidian').state, 'attention')
  const t = await registry.test('obsidian')
  assert.equal(t.ok, false)
})

test('a vault folder replaced by a link is refused', async () => {
  const { root, outside } = fixtureVault()
  const { registry } = setup({ root })
  rmSync(root, { recursive: true, force: true })
  symlinkSync(outside, root, 'dir')
  const r = await registry.sync('obsidian')
  assert.equal(r.error.code, 'folder-missing')
})

// ------------------------------------------------------------- path escape

test('path-escape attempts are refused by the read tool', async () => {
  const { root } = fixtureVault()
  const { registry } = setup({ root })
  const attempts = [
    '../outside/secret.md', 'Trips/../../outside/secret.md', '..\\outside\\secret.md',
    '/etc/passwd', 'C:\\Windows\\win.ini', '//server/share/x.md',
    'linked.md', 'Linked folder/leak.md', '.obsidian/notes.md', '.trash/old.md',
    'photo.png', 'Trips/./Lisbon.md', 'nope.md', 'Welcome.md\u0000.txt',
  ]
  for (const path of attempts) {
    const r = await tool(registry, 'read_note', { path })
    if (r.isError) continue // refused by the parameter check
    assert.ok(r.value.error, `${path} must be refused`)
    assert.ok(!JSON.stringify(r.value).includes('SECRET'), path)
  }
  const ok = await tool(registry, 'read_note', { path: 'Trips/Lisbon.md' })
  assert.equal(ok.value.path, 'Trips/Lisbon.md')
  assert.match(ok.value.text, /passport/)
})

test('safeNotePath and readNoteSafely refuse escapes directly', async () => {
  for (const p of ['', '..', 'a/../b.md', '/a.md', 'a//b.md', '.hidden.md', 'a/.git/x.md', 'C:/x.md', 'a\u0001.md']) {
    assert.equal(safeNotePath(p), null, p)
  }
  assert.equal(safeNotePath('Trips\\Lisbon.md'), 'Trips/Lisbon.md')
  const { root } = fixtureVault()
  assert.ok((await readNoteSafely(root, 'linked.md')).refused)
  assert.ok((await readNoteSafely(root, 'Linked folder/leak.md')).refused)
  assert.equal((await readNoteSafely(root, 'Welcome.md')).refused, undefined)
  const { notes, skippedLinks } = await listNotes(root)
  assert.equal(skippedLinks, 2)
  assert.ok(notes.every((n) => !n.path.startsWith('.') && !n.path.includes('Linked')))
})

// ------------------------------------------------------------- tools

test('search_notes finds by title and text, bounded, output wrapped as untrusted', async () => {
  const { root } = fixtureVault()
  const { registry } = setup({ root })
  const r = await registry.callTool(connectorToolName('obsidian', 'read', 'search_notes'), { query: 'lisbon' })
  assert.ok(isWrapped(r.content[0].text))
  const v = JSON.parse(strip(r.content[0].text))
  assert.equal(v.notes[0].path, 'Trips/Lisbon.md')
  const byText = await tool(registry, 'search_notes', { query: 'passport' })
  assert.equal(byText.value.notes[0].path, 'Trips/Lisbon.md')
  assert.match(byText.value.notes[0].excerpt, /passport/)
  assert.deepEqual((await tool(registry, 'search_notes', { query: 'OUTSIDE' })).value.notes, [])
  assert.deepEqual((await tool(registry, 'search_notes', { query: 'never read' })).value.notes, [])
  for (let i = 0; i < 15; i++) put(root, `many/match${i}.md`, 'x')
  assert.equal((await tool(registry, 'search_notes', { query: 'match', limit: 10 })).value.notes.length, 10)
})

// ------------------------------------------------------------- vetting rules

test('injection fixture in a note is neutralised and changes nothing', async () => {
  const { root } = fixtureVault({ injection: INJECTION_TEXT })
  const { registry } = setup({ root })
  const before = registry.grants.of('obsidian')
  const r = await registry.sync('obsidian')
  const hit = r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.ok(hit)
  for (const d of r.documents) {
    assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
    assert.ok(!/<system>/i.test(d.text))
  }
  assert.match(hit.text, /hidden_chars_removed="\d+"/)
  assert.deepEqual(registry.grants.of('obsidian'), before)
  const read = await registry.callTool(connectorToolName('obsidian', 'read', 'read_note'), { path: 'Trips/Lisbon.md' })
  assert.equal((read.content[0].text.match(/<\/untrusted_data>/g) ?? []).length, 1)
})

test('disconnect with erase forgets the folder and erases synced data; the vault is untouched', async () => {
  const { root } = fixtureVault()
  const erased = []
  const { registry, credentials } = setup({ root, onErase: (id) => erased.push(id) })
  await registry.sync('obsidian')
  const r = await registry.disconnect('obsidian', { eraseData: true })
  assert.equal(r.ok, true)
  assert.deepEqual(erased, ['obsidian'])
  assert.deepEqual(credentials.describe('obsidian').keys, [])
  assert.equal(registry.status('obsidian').state, 'disconnected')
  assert.equal((await listNotes(root)).notes.length, 5, 'nothing in the vault was changed')
  const s = await registry.sync('obsidian')
  assert.equal(s.error.code, 'not-connected')
})

test('no write tools; kill switches stop sync and tools', async () => {
  const { root } = fixtureVault()
  const { registry } = setup({ root })
  assert.equal(registry.list().find((c) => c.id === 'obsidian').tools.filter((t) => t.capability === 'write').length, 0)
  assert.throws(() => registry.grants.grant('obsidian', 'write'))
  registry.grants.disable('obsidian')
  assert.equal((await registry.sync('obsidian')).error.code, 'disabled')
  assert.equal(registry.tools().filter((t) => t.name.includes('obsidian')).length, 0)
  registry.grants.enable('obsidian')
  registry.grants.freezeAll()
  assert.equal((await registry.sync('obsidian')).error.code, 'frozen')
  registry.grants.unfreezeAll()
  assert.equal((await registry.sync('obsidian')).ok, true)
})

// ------------------------------------------------------------- mapping helpers

test('frontmatter, wikilinks, tags and the Obsidian link are mapped', () => {
  assert.deepEqual(parseFrontmatter('no frontmatter').data, {})
  const f = parseFrontmatter('---\ntitle: "Quoted"\ntags: a, b\nlist:\n- x\n- \'y\'\nmap: {a: 1}\n---\nBody')
  assert.deepEqual(f.data, { title: 'Quoted', tags: 'a, b', list: ['x', 'y'] })
  assert.equal(f.body, 'Body')
  assert.equal(parseFrontmatter('---\nunclosed: yes\nBody').body, '---\nunclosed: yes\nBody')
  const m = mapWikilinks('[[A]] [[B|bee]] [[C#Head]] [[D#^block]] ![[E.pdf]] [[#Local]]')
  assert.equal(m.text, 'A bee C › Head D › block [embedded: E.pdf] Local')
  assert.deepEqual(m.links, ['A', 'B', 'C', 'D'])
  assert.deepEqual(inlineTags('#one text #two/sub\n# Heading\n#123 `#code`\n```\n#fenced\n```'), ['one', 'two/sub'])
  assert.equal(obsidianUrl('V', 'a b/c.md'), 'obsidian://open?vault=V&file=a%20b%2Fc')
  assert.equal(obsidianUrl('V', 'x.txt'), 'obsidian://open?vault=V&file=x.txt')
  const d = noteToDocument({ path: 'x.md', content: '', mtimeMs: 5, birthtimeMs: 9, vaultName: 'V' })
  assert.equal(d.text, 'x')
  assert.equal(d.createdAt, undefined, 'a birth time after the edit time is not trusted')
  assert.equal(parseObsidianCursor('{"v":1,"r":"h","f":{"../x.md":[1,2],"ok.md":[1,2]}}').files.size, 1)
  assert.equal(parseObsidianCursor('junk'), null)
})

// ------------------------------------------------------------- watching

function fakeWatchFn() {
  const made = []
  const fn = (root, opts, cb) => {
    const w = Object.assign(new EventEmitter(), { root, opts, cb, closed: false, close() { this.closed = true } })
    made.push(w)
    return w
  }
  return { fn, made }
}

test('watch() reports note changes once they settle and ignores settings and attachments', async () => {
  const { root } = fixtureVault()
  const { fn, made } = fakeWatchFn()
  const { registry } = setup({ root, opts: { watchFn: fn, debounceMs: 10 } })
  const c = registry.get('obsidian')
  let changes = 0
  const stop = c.watch(() => { changes++ })
  assert.equal(made.length, 1)
  assert.deepEqual(made[0].opts, { recursive: true, persistent: false })
  made[0].cb('change', '.obsidian/workspace.json')
  made[0].cb('change', 'photo.png')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(changes, 0)
  made[0].cb('change', 'Trips/Lisbon.md')
  made[0].cb('rename', 'Trips')
  made[0].cb('change', 'Ideas.markdown')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(changes, 1, 'debounced into one')
  assert.match(registry.status('obsidian').detail, /watching/)
  stop()
  assert.equal(made[0].closed, true)
  await registry.disconnect('obsidian')
  assert.equal(c.watch(() => {}), null, 'nothing to watch when disconnected')
})

test('the background watcher only runs while connected and "Sync in the background" is granted', async () => {
  const { root } = fixtureVault()
  const { fn, made } = fakeWatchFn()
  const { registry, credentials } = setup({ root, opts: { watchFn: fn, debounceMs: 5 } })
  const synced = []
  const w = createConnectorWatcher({ registry, id: 'obsidian', syncNow: async (id) => { synced.push(id) }, everyMs: 0 })
  assert.equal(w.reconcile(), false, 'subscribe is off by default')
  assert.equal(made.length, 0)

  registry.grants.grant('obsidian', 'subscribe')
  assert.equal(w.reconcile(), true)
  await w.idle()
  assert.deepEqual(synced, ['obsidian'], 'starting catches up once')
  made[0].cb('change', 'Welcome.md')
  await new Promise((r) => setTimeout(r, 20))
  await w.idle()
  assert.equal(synced.length, 2)

  registry.grants.freezeAll()
  assert.equal(w.reconcile(), false)
  assert.equal(made[0].closed, true)
  registry.grants.unfreezeAll()
  assert.equal(w.reconcile(), true)
  registry.grants.revoke('obsidian', 'subscribe')
  // A change that arrives after the grant went is not synced.
  made[1].cb('change', 'Welcome.md')
  await new Promise((r) => setTimeout(r, 20))
  await w.idle()
  const before = synced.length
  assert.equal(w.reconcile(), false)
  assert.equal(made[1].closed, true)

  registry.grants.grant('obsidian', 'subscribe')
  w.reconcile()
  const other = tempDir()
  credentials.set('obsidian', 'vault', other)
  w.reconcile()
  assert.equal(made.at(-1).root, other, 'a new folder restarts the watch')
  credentials.delete('obsidian', 'vault')
  assert.equal(w.reconcile(), false)
  await w.idle()
  assert.ok(synced.length >= before)
  w.stop()
})

test('changes during a background sync run exactly one more sync after it', async () => {
  const { root } = fixtureVault()
  const { fn, made } = fakeWatchFn()
  const { registry } = setup({ root, opts: { watchFn: fn, debounceMs: 1 } })
  registry.grants.grant('obsidian', 'subscribe')
  let release
  let calls = 0
  const w = createConnectorWatcher({
    registry, id: 'obsidian', everyMs: 0,
    syncNow: () => { calls++; return new Promise((r) => { release = r }) },
  })
  w.reconcile()
  assert.equal(calls, 1)
  for (let i = 0; i < 3; i++) {
    made[0].cb('change', `n${i}.md`)
    await new Promise((r) => setTimeout(r, 10))
  }
  release()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(calls, 2)
  release()
  await w.idle()
  assert.equal(calls, 2)
  w.stop()
})

test('a real folder watch sees an edited note (recursive fs.watch)', async (t) => {
  const { root } = fixtureVault()
  const { registry } = setup({ root, opts: { debounceMs: 20 } })
  const c = registry.get('obsidian')
  let changed
  const seen = new Promise((r) => { changed = r })
  const stop = c.watch(() => changed(true))
  if (!stop) return t.skip('this platform cannot watch folders')
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(root, 'Trips', 'Lisbon.md'), 'edited')
  const got = await Promise.race([seen, new Promise((r) => setTimeout(() => r(false), 3000))])
  stop()
  assert.equal(got, true)
})
