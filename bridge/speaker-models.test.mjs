import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SPEAKER_MODEL, SPEAKER_MODELS, createSpeakerModels, embedderFor, isAvailable, modelSpec, readChosenModel,
} from './speaker-models.mjs'
import { CAMPP_MODEL_ID } from './speaker-campp.mjs'
import { createSpeakerService, createVoiceprintStore, loadSpeakerEmbedder } from './speaker.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-models-'))
const pcm = new Float32Array(16000 * 2).map((_, i) => Math.sin(i / 7))

/** Two fake models whose "voices" are different vectors, so a print from one is useless to the other. */
const fakeEmbedder = (id, dimensions, { failWarm = false } = {}) => ({
  id, dimensions,
  warm: async () => { if (failWarm) throw Object.assign(new Error('offline'), { code: 'model-unavailable' }) },
  embed: async () => Float32Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0.1)),
})
const catalogue = [
  { id: 'a', label: 'A', dimensions: 4, sha256: 'x'.repeat(64), sizeMb: 1, licence: 'l' },
  { id: 'b', label: 'B', dimensions: 6, sha256: 'y'.repeat(64), sizeMb: 2, licence: 'l' },
  { id: 'broken', label: 'Broken', dimensions: 3, sha256: 'z'.repeat(64), sizeMb: 3, licence: 'l' },
  { id: 'pending', label: 'Pending', dimensions: 3, sha256: null, sizeMb: 3, licence: 'l' },
]
const makeEmbedder = (id) => {
  const spec = catalogue.find((m) => m.id === id)
  return fakeEmbedder(id, spec.dimensions, { failWarm: id === 'broken' })
}

test('the catalogue starts with the default, and an unpinned model cannot be chosen', () => {
  assert.equal(SPEAKER_MODELS[0].id, DEFAULT_SPEAKER_MODEL)
  assert.equal(DEFAULT_SPEAKER_MODEL, CAMPP_MODEL_ID)
  assert.ok(isAvailable(SPEAKER_MODELS[0]))
  assert.ok(SPEAKER_MODELS.length >= 2 && SPEAKER_MODELS.length <= 3, 'the default plus at most two alternatives')
  for (const m of SPEAKER_MODELS) assert.ok(m.sizeMb > 0 && m.licence && m.label, `${m.id} shows size and licence`)
  assert.equal(modelSpec('nope'), null)
  assert.equal(embedderFor('nope', { dir: tmp() }), null)
  assert.equal(loadSpeakerEmbedder(CAMPP_MODEL_ID, { dir: tmp() }).id, CAMPP_MODEL_ID)
})

test('switching deletes every voiceprint, keeps the choice, and the new model starts empty', async () => {
  const d2 = tmp()
  try {
    const cat = catalogue.map((m, i) => (i === 0 ? { ...m, id: DEFAULT_SPEAKER_MODEL } : m))
    const mk = (id) => fakeEmbedder(id, cat.find((m) => m.id === id).dimensions)
    const store = createVoiceprintStore({ dir: d2 })
    const models = createSpeakerModels({ dir: d2, store, catalogue: cat, makeEmbedder: mk })
    assert.equal(models.current(), DEFAULT_SPEAKER_MODEL)
    const svc = createSpeakerService({ store, embedder: models.embedder() })
    await svc.enroll({ pcm, name: 'Asha', role: 'owner', consent: true })
    assert.equal(store.list().length, 1)

    const { embedder, changed } = await models.switchTo('b')
    assert.equal(changed, true)
    assert.equal(embedder.id, 'b')
    assert.equal(models.current(), 'b')
    assert.equal(store.list().length, 0, 'old voiceprints are deleted, not converted')
    assert.ok(!readFileSync(join(d2, 'voiceprints.json'), 'utf8').includes('Asha'))
    assert.equal(readChosenModel(d2, cat), 'b', 'the choice survives a restart')
    assert.equal(createSpeakerModels({ dir: d2, store, catalogue: cat, makeEmbedder: mk }).current(), 'b')

    // Enrol again with the new model and be recognised.
    const svc2 = createSpeakerService({ store, embedder })
    const p = await svc2.enroll({ pcm, name: 'Asha', role: 'owner', consent: true })
    assert.equal((await svc2.identify(pcm)).speaker?.personId, p.id)

    // Choosing the model already in use changes nothing.
    await svc2.enroll({ pcm, name: 'Ravi', consent: true })
    assert.equal((await models.switchTo('b')).changed, false)
    assert.equal(store.list().length, 2)
    assert.equal(models.list().find((m) => m.selected).id, 'b')
  } finally { rmSync(d2, { recursive: true, force: true }) }
})

test('a model whose download fails changes nothing: old model, old voiceprints', async () => {
  const dir = tmp()
  try {
    const cat = catalogue.map((m, i) => (i === 0 ? { ...m, id: DEFAULT_SPEAKER_MODEL } : m))
    const mk = (id) => fakeEmbedder(id, cat.find((m) => m.id === id).dimensions, { failWarm: id === 'broken' })
    const store = createVoiceprintStore({ dir })
    const models = createSpeakerModels({ dir, store, catalogue: cat, makeEmbedder: mk })
    const svc = createSpeakerService({ store, embedder: models.embedder() })
    await svc.enroll({ pcm, name: 'Asha', role: 'owner', consent: true })
    await assert.rejects(models.switchTo('broken'), { code: 'model-unavailable' })
    assert.equal(models.current(), DEFAULT_SPEAKER_MODEL)
    assert.equal(store.list().length, 1)
    assert.equal(existsSync(join(dir, 'model.json')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unknown and unpinned models are refused without touching anything', async () => {
  const dir = tmp()
  try {
    const store = createVoiceprintStore({ dir })
    const models = createSpeakerModels({ dir, store, catalogue, makeEmbedder })
    store.add({ name: 'Asha', role: 'owner', model: 'a', embedding: [1, 0, 0, 0] })
    await assert.rejects(models.switchTo('nope'), { code: 'unknown-model' })
    await assert.rejects(models.switchTo('pending'), { code: 'not-available' })
    assert.equal(store.list().length, 1)
    assert.deepEqual(models.list().map((m) => m.available), [true, true, true, false])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stored choice that is unknown or unpinned falls back to the default', () => {
  const dir = tmp()
  try {
    const store = createVoiceprintStore({ dir })
    for (const bad of ['{"id":"pending"}', '{"id":"ghost"}', 'not json']) {
      writeFileSync(join(dir, 'model.json'), bad)
      assert.equal(readChosenModel(dir, catalogue), DEFAULT_SPEAKER_MODEL)
    }
    assert.ok(store)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a real download of an alternative is checksum-checked, and a bad file is never kept', async () => {
  const dir = tmp()
  try {
    const body = Buffer.from('pretend onnx')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const cat = [{ id: 'dl', label: 'DL', file: 'dl.onnx', url: 'https://example.invalid/dl.onnx', sha256, dimensions: 2, sizeMb: 1, licence: 'l' }]
    const ort = { InferenceSession: { create: async () => ({ inputNames: ['x'], outputNames: ['y'], run: async () => ({ y: { data: [1, 0] } }) }) }, Tensor: class {} }
    const good = async () => ({ ok: true, status: 200, arrayBuffer: async () => body })
    const e = embedderFor('dl', { dir, catalogue: cat, ort, fetchImpl: good })
    await e.warm()
    assert.ok(existsSync(join(dir, 'models', 'dl.onnx')))

    const dir2 = tmp()
    const wrong = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('tampered') })
    await assert.rejects(embedderFor('dl', { dir: dir2, catalogue: cat, ort, fetchImpl: wrong }).warm(), { code: 'model-unavailable' })
    assert.equal(existsSync(join(dir2, 'models', 'dl.onnx')), false)
    const unpinned = [{ ...cat[0], sha256: null }]
    await assert.rejects(embedderFor('dl', { dir: dir2, catalogue: unpinned, ort, fetchImpl: good }).warm(), /checksum is not pinned/)
    rmSync(dir2, { recursive: true, force: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
