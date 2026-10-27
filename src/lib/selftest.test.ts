// Plan 29 phase 2 (Q31): the hardware self-test's judgement. The "Done when"
// is that the wizard catches a muted mic and a wrong default device; those
// cases are first, then the levels, then the advice wording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alternatives,
  diagnoseDevice,
  diagnoseOpenError,
  diagnoseQuiet,
  diagnoseSpeaker,
  diagnoseVoice,
  looksVirtual,
  plainLabel,
  rmsDb,
  summarise,
  worst,
  type MicFacts,
} from './selftest.ts'

const ids = (fs: { id: string }[]) => fs.map((f) => f.id)

const realtek: MicFacts = {
  label: 'Microphone (Realtek(R) Audio)',
  trackMuted: false,
  inputs: ['Default - Microphone (Realtek(R) Audio)', 'Microphone (Realtek(R) Audio)'],
}
const QUIET_ROOM = { floor: -65, peak: -55 }

// ---- muted microphone

test('a muted track is caught before anything is measured', () => {
  const f = diagnoseDevice({ ...realtek, trackMuted: true })
  assert.deepEqual(ids(f), ['mic-muted'])
  assert.equal(f[0].severity, 'fail')
  assert.match(f[0].title, /Realtek.*muted/)
  assert.match(f[0].fix, /mute/i)
})

test('digital silence with no other microphone reads as muted, with privacy advice', () => {
  const f = diagnoseQuiet(realtek, { floor: -120, peak: -120 })
  assert.deepEqual(ids(f), ['mic-silent'])
  assert.equal(f[0].severity, 'fail')
  assert.match(f[0].fix, /Privacy & security → Microphone/)
})

// ---- wrong default device

test('digital silence while another real microphone is plugged in reads as the wrong default', () => {
  const facts: MicFacts = {
    label: 'Headset Microphone (USB Audio)',
    trackMuted: false,
    inputs: [
      'Default - Headset Microphone (USB Audio)',
      'Headset Microphone (USB Audio)',
      'Microphone Array (Intel Smart Sound)',
    ],
  }
  const f = diagnoseQuiet(facts, { floor: -120, peak: -120 })
  assert.deepEqual(ids(f), ['mic-wrong-device'])
  assert.match(f[0].title, /Microphone Array \(Intel Smart Sound\)/)
  assert.match(f[0].fix, /System → Sound → Input/)
  assert.match(f[0].fix, /Microphone Array/)
})

test('a loopback or virtual device as the default is caught, and a real one is suggested', () => {
  for (const label of [
    'Stereo Mix (Realtek(R) Audio)',
    'CABLE Output (VB-Audio Virtual Cable)',
    'VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)',
    'Monitor of Built-in Audio Analog Stereo',
  ]) {
    const f = diagnoseDevice({ label, trackMuted: false, inputs: [label, 'Microphone (Realtek(R) Audio)'] })
    assert.deepEqual(ids(f), ['mic-virtual'], label)
    assert.match(f[0].fix, /“Microphone \(Realtek\(R\) Audio\)”/, label)
  }
})

test('a real microphone is not flagged', () => {
  assert.deepEqual(diagnoseDevice(realtek), [])
  for (const label of ['Microphone (Realtek(R) Audio)', 'Headset (Jabra Evolve2)', 'MacBook Pro Microphone', 'Yeti Stereo Microphone']) {
    assert.equal(looksVirtual(label), false, label)
  }
})

test('alternatives skip the current device, its "Default -" twin, virtual devices and duplicates', () => {
  const facts = {
    label: 'Microphone (Realtek(R) Audio)',
    inputs: [
      'Default - Microphone (Realtek(R) Audio)',
      'Communications - Microphone (Realtek(R) Audio)',
      'Microphone (Realtek(R) Audio)',
      'Stereo Mix (Realtek(R) Audio)',
      'Headset (Jabra)',
      'Headset (Jabra)',
      '',
    ],
  }
  assert.deepEqual(alternatives(facts), ['Headset (Jabra)'])
  assert.equal(plainLabel('Default - Mic'), 'Mic')
})

test('a very quiet voice mentions another plugged-in microphone', () => {
  const facts = { ...realtek, inputs: [...realtek.inputs, 'Headset (Jabra)'] }
  const f = diagnoseVoice(facts, -65, { peak: -50 })
  assert.deepEqual(ids(f), ['voice-quiet'])
  assert.match(f[0].fix, /Headset \(Jabra\)/)
})

// ---- opening the microphone

test('getUserMedia errors map to specific advice', () => {
  assert.equal(diagnoseOpenError('NotAllowedError').id, 'mic-blocked')
  assert.equal(diagnoseOpenError('SecurityError').id, 'mic-blocked')
  assert.equal(diagnoseOpenError('NotFoundError').id, 'mic-none')
  assert.equal(diagnoseOpenError('NotReadableError').id, 'mic-busy')
  assert.equal(diagnoseOpenError('Whatever').id, 'mic-error')
  for (const n of ['NotAllowedError', 'NotFoundError', 'NotReadableError', '']) {
    const f = diagnoseOpenError(n)
    assert.equal(f.severity, 'fail')
    assert.ok(f.fix.length > 20, n)
  }
})

// ---- levels

test('noise floor bands', () => {
  assert.deepEqual(ids(diagnoseQuiet(realtek, QUIET_ROOM)), ['noise-ok'])
  assert.deepEqual(ids(diagnoseQuiet(realtek, { floor: -45, peak: -40 })), ['noise-some'])
  assert.deepEqual(ids(diagnoseQuiet(realtek, { floor: -30, peak: -20 })), ['noise-high'])
})

test('voice bands', () => {
  assert.deepEqual(ids(diagnoseVoice(realtek, -65, { peak: -20 })), ['voice-ok'])
  assert.deepEqual(ids(diagnoseVoice(realtek, -65, { peak: -50 })), ['voice-quiet'])
  assert.deepEqual(ids(diagnoseVoice(realtek, -42, { peak: -36 })), ['voice-buried'])
  // The mic went dead between the quiet moment and the line.
  assert.deepEqual(ids(diagnoseVoice(realtek, -65, { peak: -120 })), ['mic-silent'])
})

test('speaker and echo', () => {
  assert.deepEqual(ids(diagnoseSpeaker(true, -65, { floor: -64 })), ['speaker-ok', 'echo-ok'])
  assert.deepEqual(ids(diagnoseSpeaker(false, -65, { floor: -64 })), ['speaker-silent', 'echo-ok'])
  assert.deepEqual(ids(diagnoseSpeaker(null, -65, { floor: -55 })), ['echo-some'])
  assert.deepEqual(ids(diagnoseSpeaker(true, -65, { floor: -40 })), ['speaker-ok', 'echo-high'])
  // Echo is advice, not a failure: JARVIS still works, with barge-in risk.
  assert.equal(worst(diagnoseSpeaker(true, -65, { floor: -40 })), 'warn')
  assert.equal(worst(diagnoseSpeaker(false, -65, { floor: -64 })), 'fail')
})

test('rmsDb and summarise', () => {
  assert.equal(rmsDb([]), -120)
  assert.equal(rmsDb(new Float32Array(256)), -120)
  assert.ok(Math.abs(rmsDb(new Float32Array(256).fill(1))) < 1e-9)
  assert.ok(Math.abs(rmsDb(new Float32Array(256).fill(0.1)) + 20) < 1e-4)
  // A cough in a quiet room raises the peak, not the floor.
  const blocks = [-66, -65, -64, -65, -66, -20, -65, -64, -65, -66]
  assert.deepEqual(summarise(blocks), { floor: -66, peak: -20 })
  assert.deepEqual(summarise([]), { floor: -120, peak: -120 })
})

test('worst', () => {
  assert.equal(worst([]), 'ok')
  assert.equal(worst([{ id: 'a', severity: 'ok', title: '', fix: '' }, { id: 'b', severity: 'warn', title: '', fix: '' }]), 'warn')
})
