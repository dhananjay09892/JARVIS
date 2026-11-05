import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAMPP_DIMENSIONS, CAMPP_FILE, CAMPP_MODEL_ID, createCamppEmbedder, ensureModel, fbank,
} from './speaker-campp.mjs'
import { createSpeakerService, createVoiceprintStore, loadSpeakerEmbedder, pcm16ToFloat } from './speaker.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-campp-'))

test('fbank: frame count and shape follow the 25 ms / 10 ms framing', () => {
  assert.equal(fbank(new Float32Array(399)).frames, 0)
  assert.equal(fbank(new Float32Array(400)).frames, 1)
  const { data, frames } = fbank(new Float32Array(16000))
  assert.equal(frames, 98)
  assert.equal(data.length, frames * 80)
  assert.ok(data.every(Number.isFinite))
})

test('fbank: a tone lights up the mel bin that holds its frequency, and means are removed', () => {
  const tone = (hz, n) => Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / 16000))
  // Half tone A, half tone B. Features are mean-subtracted, so A's frames are high where A has
  // energy and B's frames are high where B does: the bin that rises most in A's half is A's.
  const peak = (hzA, hzB) => {
    const { data, frames } = fbank(Float32Array.from([...tone(hzA, 8000), ...tone(hzB, 8000)]))
    const early = 20
    const late = frames - 20
    let best = 0
    for (let k = 0; k < 80; k++) {
      if (data[early * 80 + k] - data[late * 80 + k] > data[early * 80 + best] - data[late * 80 + best]) best = k
    }
    return best
  }
  const low = peak(500, 3000)
  const mid = peak(1200, 3000)
  const high = peak(2500, 400)
  assert.ok(low < mid && mid < high, `higher tone, higher mel bin (${low} ${mid} ${high})`)
  const { data, frames } = fbank(Float32Array.from(tone(440, 16000)))
  for (let k = 0; k < 80; k++) {
    let m = 0
    for (let f = 0; f < frames; f++) m += data[f * 80 + k]
    assert.ok(Math.abs(m / frames) < 1e-3)
  }
})

test('ensureModel downloads once, checks the checksum and keeps the file', async () => {
  const dir = tmp()
  try {
    const body = Buffer.from('pretend model')
    const sha256 = createHash('sha256').update(body).digest('hex')
    let calls = 0
    const fetchImpl = async () => { calls++; return { ok: true, status: 200, arrayBuffer: async () => body } }
    const p = await ensureModel({ dir, sha256, fetchImpl })
    assert.equal(readFileSync(p).toString(), 'pretend model')
    await ensureModel({ dir, sha256, fetchImpl })
    assert.equal(calls, 1, 'second call reuses the file')

    const bad = tmp()
    await assert.rejects(ensureModel({ dir: bad, sha256: '0'.repeat(64), fetchImpl }), { code: 'model-unavailable' })
    assert.equal(existsSync(join(bad, CAMPP_FILE)), false, 'a file with the wrong checksum is never kept')
    await assert.rejects(
      ensureModel({ dir: bad, sha256, fetchImpl: async () => ({ ok: false, status: 404 }) }), { code: 'model-unavailable' },
    )
    await assert.rejects(ensureModel({ dir: bad, sha256, fetchImpl: async () => { throw new Error('offline') } }), /offline/)
    rmSync(bad, { recursive: true, force: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the embedder loads lazily and reports an unreachable model as model-unavailable', async () => {
  const dir = tmp()
  try {
    const e = createCamppEmbedder({ dir, fetchImpl: async () => { throw new Error('offline') }, ort: {} })
    assert.equal(e.id, CAMPP_MODEL_ID)
    assert.equal(e.dimensions, CAMPP_DIMENSIONS)
    await assert.rejects(e.embed(new Float32Array(16000)), { code: 'model-unavailable' })
    assert.equal(loadSpeakerEmbedder('no-such-model'), null)
    assert.equal(loadSpeakerEmbedder(CAMPP_MODEL_ID, { dir }).id, CAMPP_MODEL_ID)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The real model: needs the ONNX file (29 MB). Set JARVIS_SPEAKER_MODEL_PATH to a copy, or
// JARVIS_SPEAKER_TEST_DOWNLOAD=1 to fetch it into a temp folder.
const modelPath = process.env.JARVIS_SPEAKER_MODEL_PATH
const wantDownload = process.env.JARVIS_SPEAKER_TEST_DOWNLOAD === '1'
const skip = !modelPath && !wantDownload && 'set JARVIS_SPEAKER_MODEL_PATH or JARVIS_SPEAKER_TEST_DOWNLOAD=1'

test('two enrolled voices are told apart on recorded clips, and delete removes the prints', { skip }, async () => {
  const dir = tmp()
  try {
    const clip = (voice, n) => pcm16ToFloat(readFileSync(join(here, 'fixtures', 'speaker', `${voice}-${n}.pcm`)))
    const embedder = createCamppEmbedder({ dir: join(dir, 'models'), modelPath })
    const store = createVoiceprintStore({ dir })
    // Synthetic voices score a little lower than human ones; the thresholds are for this test only.
    const svc = createSpeakerService({ store, embedder, thresholds: { confident: 0.4, unsure: 0.25 } })
    const a = await svc.enroll({ pcm: clip('slt', 1), name: 'Asha', role: 'owner', consent: true })
    await svc.enroll({ pcm: clip('slt', 2), personId: a.id, consent: true })
    const b = await svc.enroll({ pcm: clip('kal', 1), name: 'Ravi', consent: true })
    await svc.enroll({ pcm: clip('kal', 2), personId: b.id, consent: true })
    let right = 0
    let total = 0
    for (const n of [3, 4, 3, 4]) {
      for (const [voice, who] of [['slt', a], ['kal', b]]) {
        const r = await svc.identify(clip(voice, n))
        total++
        if (r.speaker?.personId === who.id) right++
      }
    }
    assert.equal(right, total, `${right}/${total} identified correctly`)
    assert.equal(embedder.dimensions, store.list()[0].embeddings[0].length)

    assert.equal(svc.forget(a.id), true)
    assert.ok(!JSON.stringify(store.list()).includes(a.id))
    assert.equal(store.list().length, 1)
    assert.notEqual((await svc.identify(clip('slt', 3))).speaker?.personId, a.id, 'a removed person is never matched')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
