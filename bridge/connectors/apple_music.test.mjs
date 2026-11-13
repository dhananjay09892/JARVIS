/**
 * Apple Music (task C38): the README's acceptance tests against fixture
 * library export files in a temp folder — track mapping, the summary,
 * incremental sync, malformed / cut-short / oversized files, links,
 * injection and erase. No real library is touched.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appleMusicConnector, scanLibraryXml, toTrack, trackToDocument, summaryDocument, parseMusicCursor, resolveLibraryFile,
} from './apple_music.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { captureLog, INJECTION_TEXT } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const ID = 'apple_music'
const NOW = Date.parse('2026-11-13T08:00:00Z')
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })
const tempDir = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'music-')))
  temps.push(d)
  return d
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const value = (v) =>
  v === true ? '<true/>' : v === false ? '<false/>'
    : typeof v === 'number' ? `<integer>${v}</integer>`
      : /^\d{4}-\d{2}-\d{2}T/.test(v) ? `<date>${v}</date>` : `<string>${esc(v)}</string>`
const dict = (o, pad = '\t\t\t') => Object.entries(o).map(([k, v]) => `${pad}<key>${esc(k)}</key>${value(v)}`).join('\n')

/** A library export the way the Music app writes one (Tracks, then Playlists). */
function libraryXml(tracks, { doctype = true, playlists = true, cut = false } = {}) {
  const body = tracks.map((t, i) => `\t\t<key>${1000 + i}</key>\n\t\t<dict>\n${dict({ 'Track ID': 1000 + i, ...t })}\n\t\t</dict>`).join('\n')
  const head = `<?xml version="1.0" encoding="UTF-8"?>
${doctype ? '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' : ''}
<plist version="1.0">
<dict>
\t<key>Major Version</key><integer>1</integer>
\t<key>Application Version</key><string>1.5.1.31</string>
\t<key>Music Folder</key><string>file:///Users/owner/Music/Music/Media.localized/</string>
\t<key>Library Persistent ID</key><string>AAAAAAAAAAAAAAAA</string>
\t<key>Tracks</key>
\t<dict>
${body}`
  if (cut) return head
  return `${head}
\t</dict>
${playlists ? `\t<key>Playlists</key>
\t<array>
\t\t<dict>
\t\t\t<key>Name</key><string>PLAYLIST NAME NEVER READ</string>
\t\t\t<key>Smart Info</key><data>AQEAAwAAAAIAAAAZ</data>
\t\t\t<key>Playlist Items</key>
\t\t\t<array><dict><key>Track ID</key><integer>1000</integer></dict></array>
\t\t</dict>
\t</array>` : ''}
</dict>
</plist>
`
}

const TRACKS = [
  {
    'Name': 'Blue & Green <Live>', 'Artist': 'Mira Okafor', 'Album': 'Night Rooms', 'Genre': 'Jazz', 'Year': 2019, 'Total Time': 245_000,
    'Play Count': 42, 'Skip Count': 3, 'Play Date': 3_900_000_000, 'Play Date UTC': '2026-11-10T19:30:00Z', 'Date Added': '2020-02-01T10:00:00Z',
    'Rating': 80, 'Loved': true, 'Persistent ID': 'A1B2C3D4E5F60001', 'Track Type': 'File',
    'Location': 'file:///Users/owner/Music/SECRET-PATH/blue.m4a',
  },
  {
    'Name': 'Paper Boats', 'Album Artist': 'The Lanterns', 'Album': 'Harbour', 'Play Count': 7,
    'Play Date UTC': '2026-10-01T08:00:00Z', 'Date Added': '2024-05-05T00:00:00Z', 'Favorited': true, 'Persistent ID': 'a1b2c3d4e5f60002',
  },
  { 'Name': 'Never Played', 'Artist': 'Mira Okafor', 'Date Added': '2026-11-01T00:00:00Z', 'Persistent ID': 'A1B2C3D4E5F60003' },
  { 'Name': 'A Film', 'Artist': 'Someone', 'Movie': true, 'Persistent ID': 'A1B2C3D4E5F60004' },
  { 'Name': 'A Podcast Episode', 'Podcast': true, 'Persistent ID': 'A1B2C3D4E5F60005' },
  { 'Name': 'A TV Episode', 'TV Show': true, 'Persistent ID': 'A1B2C3D4E5F60006' },
  { 'Name': 'No stable id', 'Artist': 'X' },
  { 'Artist': 'No name', 'Persistent ID': 'A1B2C3D4E5F60008' },
]

function fixture(tracks = TRACKS, opts = {}) {
  const dir = tempDir()
  const file = join(dir, 'Library.xml')
  writeFileSync(file, typeof tracks === 'string' ? tracks : libraryXml(tracks, opts))
  return { dir, file }
}

function setup({ file, onErase } = {}) {
  const credentials = createMemoryCredentialStore()
  if (file) credentials.set(ID, 'file', file)
  const { log, lines } = captureLog()
  const registry = createConnectorRegistry({ credentials, log, onErase, now: () => NOW })
  assert.equal(registry.register(appleMusicConnector()).ok, true)
  return { registry, credentials, lines }
}

const chunks = async function* (text, size) {
  const b = Buffer.from(text)
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size)
}

test('apple_music: the card is valid, read-only, R0, a file on any system, with no live tool', () => {
  const { registry } = setup()
  const c = registry.list().find((x) => x.id === ID)
  assert.deepEqual(setupProblems(c.setup), [])
  assert.equal(c.risk, 'R0')
  assert.equal(c.auth, 'filesystem')
  assert.deepEqual(c.platforms, ['win', 'mac', 'linux'])
  assert.deepEqual(c.capabilities, { read: true, write: false, subscribe: false })
  assert.match(c.setup.localWhy, /library export file/)
  assert.deepEqual(c.tools, [])
  assert.equal(registry.status(ID).state, 'disconnected')
})

test('apple_music: a fixture export syncs as wrapped documents with correct ids, dates and a summary', async () => {
  const { file } = fixture()
  const { registry } = setup({ file })
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  for (const d of r.documents) {
    assert.equal(d.untrusted, true)
    assert.ok(isWrapped(d.text))
    assert.match(d.text, /source="connector:apple_music"/)
    assert.equal(d.sensitivity, 'personal')
  }
  assert.deepEqual(r.documents.map((d) => d.id).sort(), [
    'summary:library', 'track:A1B2C3D4E5F60001', 'track:A1B2C3D4E5F60002', 'track:A1B2C3D4E5F60003',
  ], 'films, podcasts, TV and entries without an id or a name are left out')
  const all = r.documents.map((d) => d.text).join('\n')
  assert.doesNotMatch(all, /SECRET-PATH|file:\/\/|PLAYLIST NAME/, 'file locations and playlists are never read')

  const blue = r.documents.find((d) => d.id === 'track:A1B2C3D4E5F60001')
  assert.equal(blue.title, 'Blue & Green <Live> — Mira Okafor')
  assert.equal(blue.updatedAt, Date.parse('2026-11-10T19:30:00Z'))
  for (const line of ['Album: Night Rooms', 'Genre: Jazz', 'Year: 2019', 'Length: 4:05', 'Plays: 42', 'Skips: 3',
    'Last played: 2026-11-10T19:30:00.000Z', 'Added to the library: 2020-02-01', 'Rating: 4 of 5', 'Marked as a favourite']) {
    assert.ok(blue.text.includes(line), line)
  }
  const boats = r.documents.find((d) => d.id === 'track:A1B2C3D4E5F60002')
  assert.match(boats.text, /Artist: The Lanterns/, 'album artist stands in for a missing artist; the id is upper-cased')
  const never = r.documents.find((d) => d.id === 'track:A1B2C3D4E5F60003')
  assert.match(never.text, /Plays: 0/)
  assert.equal(never.updatedAt, Date.parse('2026-11-01T00:00:00Z'), 'never played: the date it was added')

  const sum = r.documents.find((d) => d.id === 'summary:library')
  assert.match(sum.text, /3 songs, 49 plays in total/)
  assert.match(sum.text, /Most played artists:\n- Mira Okafor \(42 plays\)\n- The Lanterns \(7 plays\)/)
  assert.match(sum.text, /Last played:\n- Blue & Green <Live> — Mira Okafor \(2026-11-10\)/)
})

test('apple_music: incremental sync reads nothing for an unchanged file and only new plays for a changed one', async () => {
  const { file } = fixture()
  const { registry } = setup({ file })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 4)
    assert.equal((await syncConnectorInto(registry, store, ID)).saved, 0, 'unchanged file: nothing read')

    // A fresh export over the same file: one song played again, one song added.
    const next = TRACKS.map((t) => (t.Name === 'Paper Boats' ? { ...t, 'Play Count': 8, 'Play Date UTC': '2026-11-12T07:00:00Z' } : t))
    next.push({ 'Name': 'Brand New', 'Artist': 'Mira Okafor', 'Date Added': '2026-11-12T09:00:00Z', 'Persistent ID': 'A1B2C3D4E5F60009' })
    writeFileSync(file, libraryXml(next))
    utimesSync(file, new Date(NOW), new Date(NOW))
    const r = await registry.sync(ID, { cursor: store.state(ID).cursor })
    assert.equal(r.ok, true, JSON.stringify(r.error))
    assert.deepEqual(r.documents.map((d) => d.id).sort(), ['summary:library', 'track:A1B2C3D4E5F60002', 'track:A1B2C3D4E5F60009'])
    assert.match(r.documents.find((d) => d.id === 'summary:library').text, /4 songs, 50 plays/)
    assert.equal(parseMusicCursor(r.cursor).t, Date.parse('2026-11-12T09:00:00Z'))
  } finally {
    store.close()
  }
  assert.equal(parseMusicCursor('{"v":1,"r":"short","m":1,"s":1,"t":1}'), null)
  assert.equal(parseMusicCursor('nope'), null)
  assert.equal(parseMusicCursor('{"v":1,"r":"0123456789abcdef","m":1,"s":1}'), null)
})

test('apple_music: connect needs consent and a real library export, and stores nothing otherwise', async () => {
  const { dir, file } = fixture()
  const { registry, credentials } = setup()
  assert.equal((await registry.connect(ID, { path: file })).error.code, 'consent-denied')
  assert.equal((await registry.connect(ID, { confirmed: true })).error.code, 'folder-missing')
  assert.equal((await registry.connect(ID, { confirmed: true, path: 'Library.xml' })).error.code, 'folder-missing', 'a full path is needed')
  assert.equal((await registry.connect(ID, { confirmed: true, path: join(dir, 'gone.xml') })).error.code, 'folder-missing')
  writeFileSync(join(dir, 'Library.zip'), 'x')
  assert.equal((await registry.connect(ID, { confirmed: true, path: join(dir, 'Library.zip') })).error.code, 'folder-missing', 'only .xml')
  writeFileSync(join(dir, 'other.xml'), '<?xml version="1.0"?><HealthData><Record type="x"/></HealthData>')
  assert.equal((await registry.connect(ID, { confirmed: true, path: join(dir, 'other.xml') })).error.code, 'bad-response')
  writeFileSync(join(dir, 'plist.xml'), '<plist version="1.0"><dict><key>Other</key><dict></dict></dict></plist>')
  assert.equal((await registry.connect(ID, { confirmed: true, path: join(dir, 'plist.xml') })).error.code, 'bad-response')
  assert.deepEqual(credentials.describe(ID).keys, [])
  assert.equal((await registry.sync(ID)).error.code, 'not-connected')

  const ok = await registry.connect(ID, { confirmed: true, path: file })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  assert.equal(registry.status(ID).state, 'ok')
  assert.match(registry.status(ID).detail, /Library\.xml/)
  const t = await registry.test(ID)
  assert.equal(t.ok, true, JSON.stringify(t.error))
  assert.match(t.detail, /library export looks right/)
})

test('apple_music: a symlinked, moved or replaced file is refused', async () => {
  const { dir, file } = fixture()
  const link = join(dir, 'link.xml')
  symlinkSync(file, link)
  const f = await resolveLibraryFile(link)
  assert.equal(f.real, file, 'connect stores the real file, not the link')
  // The stored path later becomes a link to something else: not followed.
  const other = fixture()
  const { registry } = setup({ file: link })
  assert.equal((await registry.sync(ID)).error.code, 'folder-missing')
  rmSync(other.file)
  assert.equal((await setup({ file: other.file }).registry.sync(ID)).error.code, 'folder-missing')
  assert.equal((await setup({ file: other.file }).registry.test(ID)).ok, false)
})

test('apple_music: cut-short, malformed and oversized exports fail cleanly', async () => {
  const cut = fixture(TRACKS, { cut: true })
  const r = await setup({ file: cut.file }).registry.sync(ID)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response', 'a file that stops inside Tracks yields nothing')
  assert.deepEqual(r.documents ?? [], [])

  const junk = fixture('this is not xml at all '.repeat(100_000))
  assert.equal((await setup({ file: junk.file }).registry.sync(ID)).error.code, 'bad-response')

  await assert.rejects(scanLibraryXml(chunks(libraryXml(TRACKS), 4096), () => {}, { maxBytes: 1000 }), /did not understand/)
  const long = `<plist version="1.0"><dict><key>Tracks</key><dict><key>1</key><dict><key>Name</key><string>${'x'.repeat(300_000)}`
  await assert.rejects(scanLibraryXml(chunks(long, 65_536), () => {}), /did not understand/)
  const deep = `<plist version="1.0">${'<dict><key>k</key>'.repeat(70)}`
  await assert.rejects(scanLibraryXml(chunks(deep, 65_536), () => {}), /did not understand/)
})

test('apple_music: the stream scanner is the same whatever the chunk size, stops after Tracks and expands no entity', async () => {
  const xml = libraryXml([
    { 'Name': 'RAWNAME', 'Artist': 'A', 'Persistent ID': 'AAAAAAAAAAAAAAA1', 'Extra': 'dropped' },
    { 'Name': 'Second', 'Compilation': true, 'Disabled': false, 'Persistent ID': 'AAAAAAAAAAAAAAA2' },
  ]).replace('RAWNAME', 'Ünïcode &#233;t &#x1F3B5; &unknown; &amp;amp;')
  const run = async (size) => {
    const out = []
    const res = await scanLibraryXml(chunks(xml, size), (t) => out.push(t))
    return { out, res }
  }
  const whole = await run(1 << 20)
  assert.equal(whole.res.sawTracks, true)
  assert.equal(whole.res.complete, true)
  assert.equal(whole.out.length, 2)
  assert.equal(whole.out[0].Name, 'Ünïcode ét 🎵 &unknown; &amp;')
  assert.deepEqual(Object.keys(whole.out[0]).sort(), ['Artist', 'Name', 'Persistent ID'], 'only the fixed list of fields is kept')
  for (const size of [1, 7, 64, 1000]) assert.deepEqual((await run(size)).out, whole.out, `chunk size ${size}`)
  assert.ok(whole.res.bytes <= Buffer.byteLength(xml))

  const empty = await scanLibraryXml(chunks('<plist version="1.0"><dict><key>Tracks</key><dict/></dict></plist>', 16), () => assert.fail('no track'))
  assert.deepEqual([empty.sawTracks, empty.complete], [true, true])
  // A nested dictionary inside a track does not end the track or leak its values.
  const nested = []
  await scanLibraryXml(chunks('<plist><dict><key>Tracks</key><dict><key>1</key><dict><key>Name</key><string>Outer</string>' +
    '<key>Inner</key><dict><key>Name</key><string>INNER</string></dict><key>Artist</key><string>After</string></dict></dict></dict></plist>', 9), (t) => nested.push(t))
  assert.deepEqual(nested, [{ Name: 'Outer', Artist: 'After' }])
})

test('apple_music: an empty library syncs with no documents', async () => {
  const { file } = fixture([])
  const r = await setup({ file }).registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents, [])
})

test('apple_music: injection text in a song name is neutralised and changes nothing', async () => {
  const { file } = fixture([{ 'Name': INJECTION_TEXT, 'Artist': INJECTION_TEXT, 'Album': INJECTION_TEXT, 'Play Count': 5, 'Play Date UTC': '2026-11-01T00:00:00Z', 'Persistent ID': 'BBBBBBBBBBBBBBB1' }])
  const { registry } = setup({ file })
  const before = registry.grants.of(ID)
  const r = await registry.sync(ID)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 2)
  assert.ok(r.documents.every((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS')), 'the fixture must reach the track and the summary')
  for (const d of r.documents) assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
  assert.deepEqual(registry.grants.of(ID), before, 'no grant changed')
  assert.deepEqual(registry.tools?.(ID) ?? [], [])
})

test('apple_music: disconnect forgets the file and erase clears the store; no write; kill switches stop sync', async () => {
  const { file } = fixture()
  const erased = []
  const { registry, credentials } = setup({ file, onErase: (id) => erased.push(id) })
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
  const second = setup({ file })
  assert.throws(() => second.registry.grants.grant(ID, 'write'))
  second.registry.grants.disable(ID)
  assert.equal((await second.registry.sync(ID)).error.code, 'disabled')
  second.registry.grants.enable(ID)
  second.registry.grants.freezeAll()
  assert.equal((await second.registry.sync(ID)).error.code, 'frozen')
})

test('apple_music: track mapping bounds and the document shape', () => {
  const base = { 'Name': 'N', 'Persistent ID': 'CCCCCCCCCCCCCCC1' }
  assert.equal(toTrack(null), null)
  assert.equal(toTrack({ ...base, 'Persistent ID': 'not hex!' }), null)
  assert.equal(toTrack({ ...base, Name: ' \u0000 ' }), null)
  const odd = toTrack({ ...base, 'Year': 99999, 'Total Time': -5, 'Play Count': -1, 'Rating': 500, 'Play Date UTC': '2999-01-01T00:00:00Z', 'Date Added': 'yesterday' }, { nowMs: NOW })
  assert.deepEqual(
    [odd.year, odd.lengthMs, odd.plays, odd.rating, odd.playedMs, odd.addedMs, odd.favourite],
    [null, null, 0, null, null, null, false],
    'out-of-range values are dropped, not shown',
  )
  const d = trackToDocument(odd, { now: () => NOW })
  assert.equal(d.title, 'N')
  assert.equal(d.updatedAt, NOW, 'no usable date: the sync time')
  assert.equal(toTrack({ ...base, Name: 'x'.repeat(1000) }).name.length, 300)
  assert.equal(summaryDocument([]), null)
})
