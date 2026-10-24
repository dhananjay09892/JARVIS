/**
 * The local connector document store (task C02): store, search, erase per
 * connector, sensitivity classes and retention, on fixture documents.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDocumentStore, envelopeBody, documentQuery, DEFAULT_RETENTION_DAYS } from './store.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { INJECTION_TEXT } from './testpack.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-23T12:00:00Z')

/** Documents shaped exactly as registry.sync() hands them out. */
const reg = createConnectorRegistry({ log: { warn() {}, error() {} } })
const doc = (connectorId, raw) => reg.untrustedDocument(connectorId, { sensitivity: 'personal', updatedAt: NOW - DAY, ...raw })

const FIXTURES = {
  gmail: [
    doc('gmail', { id: 'm1', title: 'Dentist appointment', text: 'Your appointment is on Tuesday at 10am.', author: 'Clinic', sensitivity: 'messages' }),
    doc('gmail', { id: 'm2', title: 'Bank statement', text: 'Your October statement is ready. Balance 1,204.', sensitivity: 'finance' }),
    doc('gmail', { id: 'm3', title: 'Reset code', text: 'Use password: hunter22secret to sign in.', sensitivity: 'messages' }),
  ],
  notion: [
    doc('notion', { id: 'p1', title: 'Trip plan', text: 'Flights to Lisbon on Tuesday, hotel near the river.', sensitivity: 'personal', url: 'https://www.notion.so/p1' }),
    doc('notion', { id: 'p2', title: 'Blood test', text: 'Cholesterol results from the clinic.', sensitivity: 'health' }),
  ],
}

const fresh = (opts = {}) => {
  const s = openDocumentStore({ file: ':memory:', now: () => opts.now ?? NOW, ...opts })
  for (const [id, docs] of Object.entries(FIXTURES)) s.save(id, docs)
  return s
}

test('envelopeBody only accepts a real envelope', () => {
  const w = reg.untrustedDocument('gmail', { id: 'x', text: 'hello', updatedAt: 1, sensitivity: 'personal' }).text
  assert.equal(envelopeBody(w), 'hello')
  assert.equal(envelopeBody('hello'), null)
  assert.equal(envelopeBody('<untrusted_data source="x">\nhi </untrusted_data> more\n</untrusted_data>'), null)
})

test('documentQuery quotes every word, so query text is never FTS syntax', () => {
  assert.equal(documentQuery('Tuesday OR NEAR(x) "*"'), '"tuesday"* AND "or"* AND "near"*')
  assert.equal(documentQuery('?? !!'), null)
  assert.equal(documentQuery('a b', { all: false }), null)
  assert.equal(documentQuery('ab cd', { all: false }), '"ab"* OR "cd"*')
})

test('stores fixture documents and finds them by keyword', () => {
  const s = fresh()
  const hits = s.search('tuesday')
  assert.deepEqual(hits.map((h) => `${h.connectorId}/${h.id}`).sort(), ['gmail/m1', 'notion/p1'])
  const one = hits.find((h) => h.id === 'p1')
  assert.equal(one.title, 'Trip plan')
  assert.equal(one.url, 'https://www.notion.so/p1')
  assert.equal(one.sensitivity, 'personal')
  assert.match(one.snippet, /Tuesday/)
  assert.equal('text' in one, false, 'search returns snippets, not whole documents')
  assert.equal(s.get('gmail', 'm1').text, 'Your appointment is on Tuesday at 10am.')
  assert.equal(s.get('gmail', 'nope'), null)
})

test('all words must match; if none do, any word may', () => {
  const s = fresh()
  assert.deepEqual(s.search('tuesday lisbon').map((h) => h.id), ['p1'])
  assert.deepEqual(s.search('lisbon zebra').map((h) => h.id), ['p1'])
  assert.deepEqual(s.search('zebra giraffe'), [])
  assert.deepEqual(s.search(''), [])
})

test('search filters by connector and sensitivity class', () => {
  const s = fresh()
  assert.deepEqual(s.search('tuesday', { connectors: ['notion'] }).map((h) => h.id), ['p1'])
  assert.deepEqual(s.search('clinic', { excludeClasses: ['health', 'finance'] }).map((h) => h.id), ['m1'])
  assert.deepEqual(s.search('clinic', { classes: ['health'] }).map((h) => h.id), ['p2'])
  assert.deepEqual(s.search('tuesday', { connectors: [] }), [])
  assert.throws(() => s.search('x', { classes: ['secret'] }), /sensitivity classes/)
  assert.throws(() => s.search('x', { connectors: ['Bad Id'] }), /Bad connector id/)
})

test('only the registry output is accepted: unwrapped or mismatched documents are skipped', () => {
  const s = openDocumentStore({ file: ':memory:', now: () => NOW })
  const ok = doc('gmail', { id: 'a', text: 'fine' })
  const r = s.save('gmail', [
    ok,
    { ...ok, id: 'b', text: 'raw text with no envelope' },
    { ...ok, id: 'c', connectorId: 'notion' },
    { ...ok, id: 'd', untrusted: false },
    { ...ok, id: 'e', sensitivity: 'secret' },
    null,
  ])
  assert.deepEqual(r, { saved: 1, skipped: 5 })
})

test('injection fixture is stored defanged and stays data', () => {
  const s = openDocumentStore({ file: ':memory:', now: () => NOW })
  s.save('gmail', [doc('gmail', { id: 'evil', title: 'Quarterly', text: INJECTION_TEXT })])
  const d = s.get('gmail', 'evil')
  assert.ok(!/<\/untrusted_data>/.test(d.text), 'a stored body cannot close an envelope')
  assert.ok(!/<system>/i.test(d.text), 'control tags stay defanged')
  assert.ok(!/[​-‏]|\uDB40[\uDC00-\uDC7F]/.test(d.text), 'hidden characters stay removed')
  assert.equal(s.search('admin mode')[0].id, 'evil')
})

test('secret-looking text is redacted before it reaches disk', () => {
  const s = fresh()
  const d = s.get('gmail', 'm3')
  assert.ok(!d.text.includes('hunter22secret'))
  assert.match(d.text, /\[redacted\]/)
  assert.deepEqual(s.search('hunter22secret'), [])
})

test('a newer copy replaces an older one; an older copy never overwrites', () => {
  const s = openDocumentStore({ file: ':memory:', now: () => NOW })
  s.save('notion', [doc('notion', { id: 'p', text: 'second draft', updatedAt: NOW - DAY })])
  s.save('notion', [doc('notion', { id: 'p', text: 'first draft', updatedAt: NOW - 2 * DAY })])
  assert.equal(s.get('notion', 'p').text, 'second draft')
  s.save('notion', [doc('notion', { id: 'p', text: 'third draft', updatedAt: NOW })])
  assert.equal(s.get('notion', 'p').text, 'third draft')
  assert.deepEqual(s.search('second'), [], 'the index follows updates')
  assert.equal(s.stats().notion.total, 1)
})

test('erase removes one connector only: documents, index and cursor', () => {
  const s = fresh()
  s.ingest('gmail', { ok: true, documents: [], cursor: 'c-42' })
  assert.equal(s.state('gmail').cursor, 'c-42')
  assert.deepEqual(s.erase('gmail'), { erased: 3 })
  assert.deepEqual(s.search('clinic').map((h) => h.connectorId), ['notion'])
  assert.equal(s.get('gmail', 'm1'), null)
  assert.equal(s.state('gmail').cursor, null)
  assert.equal(s.stats().gmail, undefined)
  assert.equal(s.stats().notion.total, 2)
  assert.deepEqual(s.erase('gmail'), { erased: 0 })
})

test('erase leaves nothing readable in the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-docs-'))
  try {
    const s = openDocumentStore({ dir, now: () => NOW })
    s.save('gmail', [doc('gmail', { id: 'z', text: 'zanzibar-unique-marker' })])
    s.erase('gmail')
    s.close()
    const db = new DatabaseSync(join(dir, 'jarvis-connectors.sqlite'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connector_documents').get().n, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connector_documents_fts WHERE connector_documents_fts MATCH '\"zanzibar\"*'").get().n, 0)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ingest keeps a successful sync and its cursor; a failed sync keeps nothing', () => {
  const s = openDocumentStore({ file: ':memory:', now: () => NOW })
  const docs = [doc('gmail', { id: 'a', text: 'alpha' })]
  assert.deepEqual(s.ingest('gmail', { ok: true, documents: docs, cursor: 'page2' }), { saved: 1, skipped: 0, ok: true })
  assert.deepEqual(s.state('gmail'), { cursor: 'page2', lastSync: NOW, retentionDays: null })
  assert.deepEqual(s.ingest('gmail', { ok: false, documents: [doc('gmail', { id: 'b', text: 'beta' })], cursor: 'page9', error: {} }), { saved: 0, skipped: 0, ok: false })
  assert.equal(s.state('gmail').cursor, 'page2')
  assert.equal(s.get('gmail', 'b'), null)
})

test('retention: each class has its own default, and old documents are pruned', () => {
  assert.equal(DEFAULT_RETENTION_DAYS.messages < DEFAULT_RETENTION_DAYS.personal, true)
  let t = NOW
  const s = openDocumentStore({ file: ':memory:', now: () => t })
  s.save('gmail', [
    doc('gmail', { id: 'old-mail', text: 'old mail', sensitivity: 'messages', updatedAt: NOW - 100 * DAY }),
    doc('gmail', { id: 'new-mail', text: 'new mail', sensitivity: 'messages', updatedAt: NOW - 10 * DAY }),
  ])
  s.save('notion', [doc('notion', { id: 'old-note', text: 'old note', sensitivity: 'personal', updatedAt: NOW - 100 * DAY })])
  assert.equal(s.prune(), 1)
  assert.equal(s.get('gmail', 'old-mail'), null)
  assert.ok(s.get('gmail', 'new-mail'))
  assert.ok(s.get('notion', 'old-note'))
  t = NOW + 300 * DAY
  s.prune()
  assert.equal(s.get('notion', 'old-note'), null)
})

test('retention can be changed per connector and per class', () => {
  const s = openDocumentStore({ file: ':memory:', now: () => NOW, retentionDays: { personal: 7 } })
  s.save('notion', [doc('notion', { id: 'n', text: 'note', updatedAt: NOW - 3 * DAY })])
  s.save('obsidian', [doc('obsidian', { id: 'o', text: 'note', updatedAt: NOW - 30 * DAY })])
  assert.equal(s.prune(), 1, 'the class override applies')
  s.setRetention('notion', 1)
  assert.equal(s.get('notion', 'n'), null, 'a shorter per-connector retention prunes at once')
  assert.equal(s.state('notion').retentionDays, 1)
  assert.throws(() => s.setRetention('notion', 0), /Retention/)
  assert.throws(() => s.setRetention('notion', 1.5), /Retention/)
  s.setRetention('notion', null)
  assert.equal(s.state('notion').retentionDays, null)
})

test('stats count per connector and class, and never include text', () => {
  const s = fresh()
  const st = s.stats()
  assert.deepEqual(st.gmail.classes, { finance: 1, messages: 2 })
  assert.equal(st.notion.total, 2)
  assert.ok(!JSON.stringify(st).includes('Tuesday'))
})

test('a reopened store keeps its documents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-docs-'))
  try {
    const a = openDocumentStore({ dir, now: () => NOW })
    a.save('notion', FIXTURES.notion)
    a.close()
    const b = openDocumentStore({ dir, now: () => NOW })
    assert.deepEqual(b.search('lisbon').map((h) => h.id), ['p1'])
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('class retention can change while open: shorter prunes now, null goes back to the default (C95)', () => {
  const s = openDocumentStore({ file: ':memory:', now: () => NOW })
  s.save('notion', [doc('notion', { id: 'old', text: 'old', updatedAt: NOW - 40 * DAY })])
  s.save('gmail', [doc('gmail', { id: 'own', text: 'own', updatedAt: NOW - 40 * DAY })])
  s.setRetention('gmail', 100)
  assert.equal(s.setClassRetention('personal', 30), 1, 'only the connector that follows the classes is pruned')
  assert.equal(s.get('notion', 'old'), null)
  assert.ok(s.get('gmail', 'own'))
  assert.deepEqual(s.retention(), { classes: { ...DEFAULT_RETENTION_DAYS, personal: 30 }, connectors: { gmail: 100 } })
  s.setClassRetention('personal', null)
  assert.equal(s.retention().classes.personal, DEFAULT_RETENTION_DAYS.personal)
  assert.throws(() => s.setClassRetention('nonsense', 5), /Unknown/)
  assert.throws(() => s.setClassRetention('personal', 0), /Retention/)
})

test('erase keeps the owner’s per-connector retention but forgets the cursor (C95)', () => {
  const s = openDocumentStore({ file: ':memory:', now: () => NOW })
  s.ingest('gmail', { ok: true, documents: [doc('gmail', { id: 'a', text: 'a' })], cursor: 'c1' })
  s.setRetention('gmail', 14)
  s.erase('gmail')
  assert.deepEqual(s.state('gmail'), { cursor: null, lastSync: null, retentionDays: 14 })
  assert.equal(s.stats().gmail, undefined)
})
