import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  chunkText, words, parseSources, createHashingEmbedder, createKnowledgeBase, evaluate, KNOWLEDGE_SETTINGS,
} from './knowledge-base.mjs'
import { CORPUS, QUESTIONS } from './fixtures/knowledge-corpus.mjs'

function folder(files) {
  const root = mkdtempSync(join(tmpdir(), 'kb-src-'))
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  return root
}
const make = (opts = {}) => createKnowledgeBase({ dir: mkdtempSync(join(tmpdir(), 'kb-db-')), ...opts })

test('parseSources reads folders and the |cloud mark; unmarked is restricted', () => {
  assert.deepEqual(parseSources('none'), [])
  assert.deepEqual(parseSources(''), [])
  assert.deepEqual(parseSources('/a;/b|cloud; /a'), [{ path: '/a', cloud: false }, { path: '/b', cloud: true }])
  assert.equal(KNOWLEDGE_SETTINGS.enabled, 'JARVIS_KNOWLEDGE')
})

test('chunkText keeps pages and line numbers, and cuts a very long line', () => {
  const c = chunkText('one\ntwo\n\nthree\n\fpage two')
  assert.equal(c[0].page, 1)
  assert.deepEqual([c[0].lineStart, c[0].lineEnd], [1, 4])
  assert.equal(c.at(-1).page, 2)
  assert.equal(c.at(-1).text, 'page two')
  const long = chunkText('word '.repeat(1000), { maxChars: 200 })
  assert.ok(long.length > 10)
  assert.ok(long.every((x) => x.text.length <= 220))
})

test('words drop stop words and keep Gujarati and Hindi words whole', () => {
  assert.deepEqual(words('What is the price of the Lisbon flight?'), ['price', 'lisbon', 'flight'])
  assert.ok(words('પતંગ ઉડાડવા').includes('પતંગ'))
  assert.ok(words('दिवाली की सफाई').includes('दिवाली'))
})

test('the embedder is deterministic, unit length and puts related text closer', () => {
  const e = createHashingEmbedder()
  const a = e.embed('boiler service due in November'), b = e.embed('boiler service due in November')
  assert.deepEqual([...a], [...b])
  const dot = (x, y) => x.reduce((n, v, i) => n + v * y[i], 0)
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-5)
  assert.ok(dot(a, e.embed('when is the boiler serviced')) > dot(a, e.embed('lentil soup recipe')))
  assert.equal(e.embed('the of and').every((v) => v === 0), true)
})

test('a question about an indexed file gets a cited answer; file and page are named', () => {
  const root = folder(CORPUS)
  const kb = make({ sources: () => [{ path: root, cloud: false }] })
  const r = kb.indexAll()
  assert.equal(r.ok, true)
  assert.ok(r.sources[0].chunks >= 12)
  const a = kb.answer('When does the car insurance renew?')
  assert.equal(a.found, true)
  assert.match(a.text, /9 January/)
  assert.match(a.citations[0], /car-insurance\.md, page 1, lines? \d/)
})

test('"I can\'t find that" is the answer when the folders do not say', () => {
  const kb = make({ sources: () => [{ path: folder(CORPUS), cloud: false }] })
  kb.indexAll()
  const a = kb.answer('Where is the wedding venue?')
  assert.equal(a.found, false)
  assert.match(a.text, /can't find that/)
  assert.deepEqual(a.citations, [])
})

// The baseline embedder matches words and word shapes, not meaning: "delayed" does
// not find "postponed". The set keeps that paraphrase on purpose, so the plan's 98%
// citation target is for the model embedder (a task after the vector store decision).
test('held-out set with the baseline embedder: hit rate >= 90%, citations >= 90%, no invented answers', () => {
  const kb = make({ sources: () => [{ path: folder(CORPUS), cloud: false }] })
  kb.indexAll()
  const m = evaluate(kb, QUESTIONS)
  assert.equal(m.answerable, 20)
  assert.ok(m.hitRate >= 90, `hit rate ${m.hitRate}: ${JSON.stringify(m.misses)}`)
  assert.ok(m.citationCorrectness >= 90, `citations ${m.citationCorrectness}: ${JSON.stringify(m.misses)}`)
  assert.equal(m.correctRefusals, 100, JSON.stringify(m.misses))
})

test('a restricted folder is never sent to a brain; a cloud folder may be', () => {
  const restricted = folder({ 'health/notes.md': 'Blood pressure was 128 over 84 at the clinic visit on Tuesday.' })
  const open = folder({ 'public/trip.md': 'The conference talk is on Thursday at ten in the main hall.' })
  const kb = make({ sources: () => [{ path: restricted, cloud: false }, { path: open, cloud: true }] })
  kb.indexAll()
  const b = kb.forBrain('What was my blood pressure at the clinic?')
  assert.equal(b.block, '')
  assert.equal(b.withheld, true)
  assert.doesNotMatch(JSON.stringify(b), /128/)
  assert.equal(kb.search('blood pressure clinic', { audience: 'cloud' }).found, false)
  // The owner locally still gets it.
  assert.equal(kb.answer('What was my blood pressure at the clinic?').found, true)
  const ok = kb.forBrain('When is the conference talk?')
  assert.match(ok.block, /<untrusted_data/)
  assert.match(ok.block, /main hall/)
  assert.match(ok.citations[0], /trip\.md, page 1/)
  assert.equal(kb.stats().restrictedWithheld >= 2, true)
})

test('secrets are removed before anything is stored', () => {
  const kb = make({ sources: () => [{ path: folder(CORPUS), cloud: false }] })
  kb.indexAll()
  const r = kb.search('router admin password', { k: 5 })
  const all = JSON.stringify(r.hits)
  assert.doesNotMatch(all, /hunter2hunter2/)
  assert.doesNotMatch(all, /sk-abcdefghijklmnop/)
})

test('off means nothing is searched and what was kept is forgotten', () => {
  let on = true
  const kb = make({ sources: () => [{ path: folder(CORPUS), cloud: false }], enabled: () => on })
  kb.indexAll()
  assert.ok(kb.stats().passages > 0)
  on = false
  assert.equal(kb.search('boiler').found, false)
  assert.equal(kb.indexAll().ok, false)
  assert.equal(kb.stats().passages, 0)
})

test('removing a folder from the list deletes its passages; changed files are re-read', () => {
  const a = folder({ 'a.md': 'The garden shed key is under the blue pot.' })
  const b = folder({ 'b.md': 'The attic ladder is stored behind the water tank.' })
  let list = [{ path: a, cloud: false }, { path: b, cloud: false }]
  const kb = make({ sources: () => list })
  kb.indexAll()
  assert.equal(kb.answer('where is the shed key').found, true)
  list = [{ path: b, cloud: false }]
  kb.indexAll()
  assert.equal(kb.answer('where is the shed key').found, false)
  assert.equal(kb.answer('where is the attic ladder').found, true)
  writeFileSync(join(b, 'b.md'), 'The attic ladder moved to the garage wall.')
  kb.indexAll()
  assert.match(kb.answer('where is the attic ladder').text, /garage wall/)
  rmSync(join(b, 'b.md'))
  kb.indexAll()
  assert.equal(kb.answer('where is the attic ladder').found, false)
})

test('links, hidden folders, big files and other file types are skipped', () => {
  const root = folder({ 'ok.md': 'The spare phone charger lives in the hall drawer.', '.hidden/x.md': 'The secret stash is behind the clock.', 'image.png': 'not text' })
  const outside = folder({ 'out.md': 'The outside file mentions the zebra password.' })
  try { symlinkSync(outside, join(root, 'link')) } catch { /* no symlinks here */ }
  writeFileSync(join(root, 'big.md'), 'x '.repeat(600 * 1024))
  const kb = make({ sources: () => [{ path: root, cloud: false }] })
  kb.indexAll()
  assert.equal(kb.stats().files, 1)
  assert.equal(kb.search('secret stash behind the clock').found, false)
  assert.equal(kb.search('zebra password').found, false)
})

test('a new embedder id re-embeds what is stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-db-'))
  const root = folder({ 'n.md': 'The warranty card for the dishwasher is in the blue folder.' })
  const first = createKnowledgeBase({ dir, sources: () => [{ path: root, cloud: false }] })
  first.indexAll(); first.close()
  const other = { ...createHashingEmbedder({ dims: 256 }) }
  const second = createKnowledgeBase({ dir, sources: () => [{ path: root, cloud: false }], embedder: other })
  assert.equal(second.stats().embedder, 'hash-256-v1')
  assert.equal(second.answer('where is the dishwasher warranty card').found, true)
})

test('stats hold counts only and the audit event carries no passage text', () => {
  const events = []
  const kb = make({ sources: () => [{ path: folder(CORPUS), cloud: false }], audit: (e) => events.push(e) })
  kb.indexAll(); kb.answer('boiler service'); kb.answer('wedding venue')
  const s = kb.stats()
  assert.equal(s.queries, 2); assert.equal(s.found, 1); assert.equal(s.notFound, 1)
  assert.doesNotMatch(JSON.stringify([s, events]), /Hartley|pressure valve/)
})
