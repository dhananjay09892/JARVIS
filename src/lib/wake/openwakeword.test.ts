// The openWakeWord pipeline port, the score gate and the resampler, tested with
// fake models so no ONNX runtime is needed. The fakes record the shapes they are
// called with, which are the contract with the real model files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenWakeWord, melTransform } from './openwakeword.ts'
import { WAKE_FRAME_SAMPLES } from './detector.ts'
import { WAKE_COOLDOWN_MS, makeWakeGate, thresholdFor } from './gate.ts'
import { FrameResampler } from './resample.ts'

function fakeModels(score = 0.9) {
  const calls = { mel: [] as number[][], embedding: [] as number[][], wake: [] as number[][] }
  let lastMelInput: Float32Array = new Float32Array(0)
  let lastEmbedInput: Float32Array = new Float32Array(0)
  let lastWakeInput: Float32Array = new Float32Array(0)
  return {
    calls,
    last: () => ({ mel: lastMelInput, embedding: lastEmbedInput, wake: lastWakeInput }),
    models: {
      // The real mel model returns 8 rows of 32 bins for 1760 samples.
      mel: async (input: Float32Array, dims: number[]) => {
        calls.mel.push(dims)
        lastMelInput = input
        return new Float32Array(8 * 32).fill(-20) // transforms to 0
      },
      embedding: async (input: Float32Array, dims: number[]) => {
        calls.embedding.push(dims)
        lastEmbedInput = input
        return new Float32Array(96).fill(calls.embedding.length)
      },
      wake: async (input: Float32Array, dims: number[]) => {
        calls.wake.push(dims)
        lastWakeInput = input
        return new Float32Array([score])
      },
    },
  }
}

const frame = (v = 0) => new Float32Array(WAKE_FRAME_SAMPLES).fill(v)

test('feeds the models the shapes the real openWakeWord files expect', async () => {
  const f = fakeModels()
  const d = new OpenWakeWord(f.models)
  await d.process(frame(0.5))
  assert.deepEqual(f.calls.mel[0], [1, 1760])
  assert.deepEqual(f.calls.embedding[0], [1, 76, 32, 1])
  // Audio is scaled to the int16 range the mel model was trained on, after 480 samples of history.
  const mel = f.last().mel
  assert.equal(mel[0], 0)
  assert.equal(mel[480], Math.trunc(0.5 * 32767))
  // The first embedding window is upstream's 76 rows of ones, shifted by the 8 new rows.
  const emb = f.last().embedding
  assert.equal(emb[0], 1)
  assert.equal(emb[emb.length - 1], melTransform(-20))
})

test('holds the score at 0 until 16 embeddings exist, then scores every frame', async () => {
  const f = fakeModels(0.9)
  const d = new OpenWakeWord(f.models)
  const scores: number[] = []
  for (let i = 0; i < 18; i++) scores.push(await d.process(frame()))
  assert.deepEqual(scores.slice(0, 15), Array(15).fill(0))
  assert.ok(Math.abs(scores[15] - 0.9) < 1e-6)
  assert.equal(f.calls.wake.length, 3)
  assert.deepEqual(f.calls.wake[0], [1, 16, 96])
  // The classifier sees the 16 most recent embeddings, oldest first.
  const w = f.last().wake
  assert.equal(w[0], 3)
  assert.equal(w[w.length - 1], 18)
})

test('carries the last 480 samples into the next mel window', async () => {
  const f = fakeModels()
  const d = new OpenWakeWord(f.models)
  const a = frame()
  a[WAKE_FRAME_SAMPLES - 1] = 1
  await d.process(a)
  await d.process(frame())
  assert.equal(f.last().mel[479], 32767)
})

test('reset forgets context; clamps out-of-range scores; rejects wrong frame sizes', async () => {
  const f = fakeModels(7)
  const d = new OpenWakeWord(f.models)
  for (let i = 0; i < 16; i++) await d.process(frame())
  assert.equal(await d.process(frame()), 1)
  d.reset()
  assert.equal(await d.process(frame()), 0)
  await assert.rejects(d.process(new Float32Array(100)), /1280/)
  d.dispose()
  assert.equal(await d.process(frame()), 0)
})

test('gate: threshold per sensitivity, one wake per phrase', () => {
  assert.equal(thresholdFor('low'), 0.7)
  assert.equal(thresholdFor('medium'), 0.5)
  assert.equal(thresholdFor('high'), 0.3)
  assert.equal(thresholdFor('nonsense'), 0.5)
  assert.equal(thresholdFor(undefined), 0.5)

  const g = makeWakeGate('medium')
  assert.equal(g.push(0.49, 0), false)
  assert.equal(g.push(0.8, 10), true)
  assert.equal(g.push(0.9, 90), false) // same phrase, next frames
  assert.equal(g.push(0.9, 10 + WAKE_COOLDOWN_MS), true)
  g.setSensitivity('low')
  assert.equal(g.push(0.6, 10_000), false)
  assert.equal(g.peak(), 0.6)
})

test('resampler: 48 kHz to 16 kHz in 1280-sample frames, across chunk boundaries', () => {
  const r = new FrameResampler(48000, 16000, 1280)
  const out: Float32Array[] = []
  // 0.2 s of a ramp in uneven chunks.
  const input = Float32Array.from({ length: 9600 }, (_, i) => i)
  for (let i = 0; i < input.length; i += 700) out.push(...r.push(input.subarray(i, i + 700)))
  assert.equal(out.length, 2) // 3200 samples out → 2 full frames
  assert.equal(out[0][0], 1) // mean of 0,1,2
  assert.equal(out[1][0], (3840 + 3841 + 3842) / 3)
})

test('resampler: 44.1 kHz keeps time (one second in, one second out)', () => {
  const r = new FrameResampler(44100, 16000, 1280)
  let samples = 0
  for (let s = 0; s < 10; s++) {
    for (const f of r.push(new Float32Array(44100).fill(0.25))) {
      samples += f.length
      assert.ok(f.every((x) => Math.abs(x - 0.25) < 1e-6))
    }
  }
  assert.ok(Math.abs(samples - 160000) <= 1280)
  assert.throws(() => new FrameResampler(8000, 16000, 1280), /upsampling/)
})
