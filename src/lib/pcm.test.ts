import { test } from 'node:test'
import assert from 'node:assert/strict'
import { concat, mixToMono, resample, seconds, toPcm16 } from './pcm.ts'

test('mixToMono averages the channels', () => {
  const m = mixToMono([Float32Array.of(1, 0), Float32Array.of(0, 1)])
  assert.deepEqual(Array.from(m), [0.5, 0.5])
  assert.equal(mixToMono([]).length, 0)
})

test('resample changes the length by the rate ratio and keeps a ramp a ramp', () => {
  const ramp = Float32Array.from({ length: 480 }, (_, i) => i / 480)
  const out = resample(ramp, 48000, 16000)
  assert.equal(out.length, 160)
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1])
  assert.equal(resample(ramp, 16000, 16000), ramp)
})

test('toPcm16 is little-endian and clips', () => {
  const b = toPcm16(Float32Array.of(0, 1, -1, 2, -2))
  const v = new DataView(b.buffer)
  assert.equal(b.length, 10)
  assert.equal(v.getInt16(0, true), 0)
  assert.equal(v.getInt16(2, true), 32767)
  assert.equal(v.getInt16(4, true), -32768)
  assert.equal(v.getInt16(6, true), 32767)
  assert.equal(v.getInt16(8, true), -32768)
})

test('concat joins in order and seconds counts at 16 kHz', () => {
  const a = new Uint8Array(32000)
  const c = concat([a, Uint8Array.of(1, 2)])
  assert.equal(c.length, 32002)
  assert.equal(c[32000], 1)
  assert.equal(seconds(a), 1)
})
