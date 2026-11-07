import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertEmbedder, band, cosine, createSpeakerService, createVoiceprintStore, pcm16ToFloat, speakerPreface, SAMPLE_RATE,
} from './speaker.mjs'

/** A fake model: the first sample picks the "voice", so two voices are far apart. */
const embedder = {
  id: 'fake-1', dimensions: 4,
  async embed(pcm) {
    const v = [0, 0, 0, 0]
    v[Math.round(pcm[0] * 10) % 4] = 1
    v[3] += pcm[1] * 0.01
    return Float32Array.from(v)
  },
}
const clip = (voice, secs = 2) => { const a = new Float32Array(SAMPLE_RATE * secs); a[0] = voice / 10; return a }
const withService = async (fn, e = embedder) => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-spk-'))
  try {
    const store = createVoiceprintStore({ dir })
    let t = 0
    return await fn(createSpeakerService({ store, embedder: e, clock: () => t, carryMs: 20_000 }), dir, (n) => { t = n })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('cosine, bands and pcm conversion', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [1]), 0)
  assert.equal(band(0.7), 'confident'); assert.equal(band(0.5), 'unsure'); assert.equal(band(0.1), 'unknown')
  const b = Buffer.alloc(4); b.writeInt16LE(-32768, 0); b.writeInt16LE(16384, 2)
  assert.deepEqual(Array.from(pcm16ToFloat(b)), [-1, 0.5])
})

test('an embedder must follow the interface', () => {
  assert.throws(() => assertEmbedder({}), /id/)
  assert.throws(() => assertEmbedder({ id: 'x', dimensions: 2 }), /embed/)
  assert.ok(assertEmbedder(embedder))
})

test('enrolment needs consent and a name, and rejects short clips', () => withService(async (s) => {
  await assert.rejects(s.enroll({ pcm: clip(1), name: 'A' }), { code: 'consent-required' })
  await assert.rejects(s.enroll({ pcm: clip(1), consent: true }), { code: 'name-required' })
  await assert.rejects(s.enroll({ pcm: clip(1), name: 'A', role: 'root', consent: true }), { code: 'bad-role' })
  await assert.rejects(s.enroll({ pcm: new Float32Array(100), name: 'A', consent: true }), { code: 'too-short' })
  assert.equal(s.people().length, 0)
}))

test('two people are told apart; a stranger is a guest', () => withService(async (s) => {
  const a = await s.enroll({ pcm: clip(1), name: 'Asha', role: 'owner', consent: true })
  await s.enroll({ pcm: clip(2), name: 'Ravi', consent: true })
  let r = await s.identify(clip(1))
  assert.equal(r.speaker.personId, a.id); assert.equal(r.role, 'owner'); assert.equal(r.band, 'confident')
  r = await s.identify(clip(2))
  assert.equal(r.speaker.name, 'Ravi'); assert.equal(r.role, 'member')
  r = await s.identify(clip(3))
  assert.equal(r.speaker, null); assert.equal(r.role, 'guest'); assert.equal(r.band, 'unknown')
}))

test('with nobody enrolled everyone is a guest', () => withService(async (s) => {
  const r = await s.identify(clip(1))
  assert.equal(r.role, 'guest')
}))

test('more clips can be added to a person', () => withService(async (s) => {
  const a = await s.enroll({ pcm: clip(1), name: 'Asha', role: 'owner', consent: true })
  const b = await s.enroll({ pcm: clip(1), personId: a.id, consent: true })
  assert.equal(b.clips, 2); assert.equal(s.people().length, 1)
}))

test('recent() carries the last speaker for 20 s, then lapses', () => withService(async (s, _d, setT) => {
  await s.enroll({ pcm: clip(1), name: 'Asha', role: 'owner', consent: true })
  setT(1000); await s.identify(clip(1))
  setT(15_000); assert.equal(s.recent().name, 'Asha')
  setT(25_000); assert.equal(s.recent(), null)
}))

test('a print from another model is ignored, not converted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-spk-'))
  try {
    const store = createVoiceprintStore({ dir })
    store.add({ name: 'Old', role: 'owner', model: 'other-model', embedding: [1, 0, 0, 0] })
    const s = createSpeakerService({ store, embedder })
    const r = await s.identify(clip(0))
    assert.equal(r.role, 'guest')
    const p = store.list()[0]
    assert.throws(() => store.add({ id: p.id, model: 'fake-1', embedding: [1, 0, 0, 0] }), /model-mismatch/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('forgetting is a hard delete: nothing of the person stays on disk', () => withService(async (s, dir) => {
  const a = await s.enroll({ pcm: clip(1), name: 'Asha', role: 'owner', consent: true })
  await s.identify(clip(1))
  assert.equal(s.forget(a.id), true)
  assert.equal(s.forget(a.id), false)
  assert.equal(s.people().length, 0)
  assert.equal(readFileSync(join(dir, 'voiceprints.json'), 'utf8').includes('Asha'), false)
  assert.deepEqual(readdirSync(dir), ['voiceprints.json'])
  await s.enroll({ pcm: clip(1), name: 'B', consent: true })
  s.forgetAll(); assert.equal(s.people().length, 0); assert.equal(s.recent(), null)
}))

test('a wrong-sized embedding is refused', () => withService(async (s) => {
  await assert.rejects(s.enroll({ pcm: clip(1), name: 'A', consent: true }), /bad-embedding/)
}, { id: 'bad', dimensions: 4, embed: async () => new Float32Array(3) }))

test('the preface names a known speaker and warns about a guest', () => {
  assert.equal(speakerPreface(null), '')
  assert.match(speakerPreface({ name: 'Asha', role: 'owner' }), /Asha \(owner\)/)
  assert.match(speakerPreface({ role: 'guest' }), /guest/)
})

test('the bridge forgets a person over POST, so the browser preflight needs no new method', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(src, /req\.method === 'POST' && forgetMatch/)
  assert.match(src, /people\\\/\(\[\^\/\]\+\)\\\/forget/)
})

test('a person\'s language choices are stored with them, validated, clearable and deleted with them', () => withService(async (s, dir) => {
  const a = await s.enroll({ pcm: clip(1), name: 'Asha', role: 'member', consent: true })
  const b = await s.enroll({ pcm: clip(2), name: 'Ben', role: 'owner', consent: true })
  assert.equal(s.languageFor(a.id), null)
  assert.deepEqual(s.setLanguage(a.id, { primary: 'gu', reply: 'mirror', bogus: 'x' }).language, { primary: 'gu', reply: 'mirror' })
  assert.deepEqual(s.languageFor(a.id), { primary: 'gu', reply: 'mirror' })
  assert.equal(s.languageFor(b.id), null) // nobody else's changes
  assert.equal(s.languageFor('guest'), null)
  assert.equal(s.setLanguage('nobody', { primary: 'hi' }), null)
  assert.deepEqual(s.setLanguage(a.id, {}).language, {})
  assert.equal(s.languageFor(a.id), null)
  s.setLanguage(b.id, { primary: 'hi' })
  assert.equal(s.forget(b.id), true)
  assert.equal(s.languageFor(b.id), null)
  assert.ok(!readFileSync(join(dir, 'voiceprints.json'), 'utf8').includes('"hi"'))
}))

test('the turn takes the identified speaker\'s profile, and a guest gets the owner\'s', async () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(src, /readPersonProfile\(setting, speakerLanguage\(\)\)/)
  assert.match(src, /r\.personId !== 'guest' \? speakerService\.languageFor/)
  assert.match(src, /req\.method === 'POST' && langMatch/)
})
