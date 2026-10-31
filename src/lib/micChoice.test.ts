// Plan 29 phase 2 (Q77): choosing the microphone inside JARVIS. The "Done
// when" asks for the self-test to use the microphone chosen in Settings;
// openChosenMic is what both the self-test and getMic() open it with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIC_CHOICE_KEY,
  MIC_PROCESSING,
  micConstraints,
  micOptions,
  openChosenMic,
  readChoice,
  streamIsChosen,
  writeChoice,
} from './micChoice.ts'

type Constraints = { audio: { deviceId?: { exact: string } } & Record<string, unknown> }

/** A fake getUserMedia that records what it was asked for. */
function fakeMedia(present: string[], fail: string | null = null) {
  const asked: Constraints[] = []
  const gum = async (c: MediaStreamConstraints) => {
    const cc = c as unknown as Constraints
    asked.push(cc)
    if (fail) throw Object.assign(new Error(fail), { name: fail })
    const want = cc.audio.deviceId?.exact
    if (want && !present.includes(want)) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' })
    return { id: want ?? 'default-stream' } as unknown as MediaStream
  }
  return { gum, asked }
}

test('the self-test opens the microphone chosen in Settings, with the usual processing', async () => {
  const m = fakeMedia(['usb-mic'])
  const out = await openChosenMic({ chosen: 'usb-mic', shared: null, getUserMedia: m.gum })
  assert.equal(m.asked.length, 1)
  assert.deepEqual(m.asked[0].audio.deviceId, { exact: 'usb-mic' })
  assert.equal(m.asked[0].audio.echoCancellation, true)
  assert.equal(m.asked[0].audio.noiseSuppression, true)
  assert.equal(m.asked[0].audio.autoGainControl, true)
  assert.equal(out.owned, true)
  assert.equal(out.fellBack, false)
})

test('JARVIS\'s open stream is reused only when it is the chosen microphone', async () => {
  const shared = { id: 'shared' } as unknown as MediaStream
  const m = fakeMedia(['usb-mic', 'webcam-mic'])
  const same = await openChosenMic({ chosen: 'usb-mic', shared, sharedDeviceId: 'usb-mic', getUserMedia: m.gum })
  assert.equal(same.stream, shared)
  assert.equal(same.owned, false)
  assert.equal(m.asked.length, 0)

  // Open on the webcam, but the headset was chosen: test the headset.
  const other = await openChosenMic({ chosen: 'usb-mic', shared, sharedDeviceId: 'webcam-mic', getUserMedia: m.gum })
  assert.notEqual(other.stream, shared)
  assert.equal(other.owned, true)
  assert.deepEqual(m.asked[0].audio.deviceId, { exact: 'usb-mic' })

  // No choice: whatever is open is the default, so reuse it.
  const def = await openChosenMic({ chosen: '', shared, sharedDeviceId: 'webcam-mic', getUserMedia: m.gum })
  assert.equal(def.stream, shared)
})

test('no choice: the Windows default, as before', async () => {
  const m = fakeMedia([])
  const out = await openChosenMic({ chosen: '', shared: null, getUserMedia: m.gum })
  assert.equal(m.asked[0].audio.deviceId, undefined)
  assert.equal(out.fellBack, false)
})

test('a chosen microphone that is unplugged falls back to the default, and says so', async () => {
  const m = fakeMedia(['webcam-mic'])
  const out = await openChosenMic({ chosen: 'usb-mic', shared: null, getUserMedia: m.gum })
  assert.equal(m.asked.length, 2)
  assert.equal(m.asked[1].audio.deviceId, undefined)
  assert.equal(out.fellBack, true)
})

test('a blocked microphone is not hidden by the fallback', async () => {
  const m = fakeMedia(['usb-mic'], 'NotAllowedError')
  await assert.rejects(openChosenMic({ chosen: 'usb-mic', shared: null, getUserMedia: m.gum }), { name: 'NotAllowedError' })
  assert.equal(m.asked.length, 1)
})

test('constraints: exact device when chosen, never a loosened processing set', () => {
  assert.deepEqual(micConstraints(''), { audio: { ...MIC_PROCESSING } })
  assert.deepEqual(micConstraints('abc'), { audio: { ...MIC_PROCESSING, deviceId: { exact: 'abc' } } })
})

test('the list offers real microphones only, numbered until labels are allowed', () => {
  const opts = micOptions([
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Microphone (Realtek(R) Audio)' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Headset' },
    { kind: 'audioinput', deviceId: 'a1', label: 'Microphone (Realtek(R) Audio)' },
    { kind: 'audiooutput', deviceId: 'o1', label: 'Speakers' },
    { kind: 'videoinput', deviceId: 'v1', label: 'Webcam' },
    { kind: 'audioinput', deviceId: 'a2', label: '' },
    { kind: 'audioinput', deviceId: 'a1', label: 'Microphone (Realtek(R) Audio)' },
  ])
  assert.deepEqual(opts, [
    { id: 'a1', label: 'Microphone (Realtek(R) Audio)' },
    { id: 'a2', label: 'Microphone 2' },
  ])
})

test('streamIsChosen', () => {
  assert.equal(streamIsChosen('x', ''), true)
  assert.equal(streamIsChosen('x', 'x'), true)
  assert.equal(streamIsChosen('y', 'x'), false)
  assert.equal(streamIsChosen(undefined, 'x'), false)
})

test('the choice is kept in this browser, and missing or broken storage is survivable', () => {
  const data = new Map<string, string>()
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
  assert.equal(readChoice(store), '')
  writeChoice(store, 'usb-mic')
  assert.equal(data.get(MIC_CHOICE_KEY), 'usb-mic')
  assert.equal(readChoice(store), 'usb-mic')
  writeChoice(store, '')
  assert.equal(data.has(MIC_CHOICE_KEY), false)

  const broken = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
    removeItem: () => {
      throw new Error('blocked')
    },
  }
  assert.equal(readChoice(broken), '')
  assert.doesNotThrow(() => writeChoice(broken, 'x'))
  assert.equal(readChoice(null), '')
})
