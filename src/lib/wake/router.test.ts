// Plan 02 phase 2 (Q09): "no audio leaves the machine while JARVIS is asleep".
// The router is the only path from a VAD segment to the transcriber in the
// ElevenLabs voice loop, so these tests drive it the way voice.ts does and
// count every byte handed to `upload`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALSE_WAKE_AFTER_MS,
  WAKE_GRACE_MS,
  cloudMayListen,
  makeAudioRouter,
  type ListenMode,
  type UploadMeta,
} from './router.ts'

function rig(offline = true) {
  let t = 1_000_000
  const sent: { audio: Blob; meta: UploadMeta; at: number }[] = []
  let engineOn = offline
  const router = makeAudioRouter({
    offline: () => engineOn,
    upload: (audio, meta) => sent.push({ audio, meta, at: t }),
    now: () => t,
  })
  const segment = (startMode: ListenMode, endMode: ListenMode, bytes = 4000) => {
    router.segmentStart(startMode)
    t += 1500
    router.segmentEnd(new Blob([new Uint8Array(bytes)]), endMode)
  }
  return {
    router,
    sent,
    segment,
    advance: (ms: number) => {
      t += ms
    },
    setOffline: (v: boolean) => {
      engineOn = v
    },
    bytesSent: () => sent.reduce((n, s) => n + s.audio.size, 0),
  }
}

test('asleep with the offline engine: an hour of room speech uploads zero bytes', () => {
  const r = rig(true)
  // TV, conversation, someone saying "Travis" — 600 segments, no wake.
  for (let i = 0; i < 600; i++) {
    r.segment('wake', 'wake', 1000 + i)
    r.router.tick('wake')
    r.advance(4500)
    r.router.tick('wake')
  }
  assert.equal(r.sent.length, 0)
  assert.equal(r.bytesSent(), 0)
  const s = r.router.stats()
  assert.equal(s.uploadedAsleepBytes, 0)
  assert.equal(s.droppedAsleep, 600)
  assert.ok(s.droppedBytes > 600_000)
})

test('a wake releases only the segment that held the wake phrase, marked afterWake', () => {
  const r = rig(true)
  r.segment('wake', 'wake') // earlier chatter
  r.advance(WAKE_GRACE_MS + 1)
  r.router.tick('wake') // expired: dropped
  r.segment('wake', 'wake', 2222) // "hey jarvis" — the detector is a beat behind the energy gate
  r.advance(300)
  r.router.wake()
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0].audio.size, 2222)
  assert.deepEqual(r.sent[0].meta, { afterWake: true })
  assert.equal(r.router.stats().droppedAsleep, 1)
})

test('a wake after the grace window uploads nothing old', () => {
  const r = rig(true)
  r.segment('wake', 'wake')
  r.advance(WAKE_GRACE_MS + 50)
  r.router.wake()
  assert.equal(r.sent.length, 0)
  assert.equal(r.router.stats().droppedAsleep, 1)
})

test('"hey jarvis, what time is it" in one breath: the segment is uploaded once he is awake', () => {
  const r = rig(true)
  r.router.segmentStart('wake')
  r.router.wake() // detected mid-segment; nothing held yet
  assert.equal(r.sent.length, 0)
  r.router.segmentEnd(new Blob([new Uint8Array(5000)]), 'command')
  assert.equal(r.sent.length, 1)
  assert.deepEqual(r.sent[0].meta, { afterWake: true })
})

test('awake segments are uploaded as before; deaf ones never are', () => {
  const r = rig(true)
  r.segment('command', 'command')
  r.segment('guard', 'guard')
  r.segment('deaf', 'deaf')
  r.segment('command', 'deaf')
  assert.equal(r.sent.length, 2)
  assert.ok(r.sent.every((s) => s.meta.afterWake === false))
})

test('standing down mid-segment keeps that segment local', () => {
  const r = rig(true)
  r.segment('command', 'wake')
  r.advance(WAKE_GRACE_MS + 1)
  r.router.tick('wake')
  assert.equal(r.sent.length, 0)
})

test('cloud listening (engine off or failed) uploads asleep audio, and counts it', () => {
  const r = rig(false)
  r.segment('wake', 'wake', 3000)
  r.segment('wake', 'wake', 1000)
  assert.equal(r.sent.length, 2)
  assert.equal(r.router.stats().uploadedAsleepBytes, 4000)
})

test('false wakes: a wake with no command before he is back asleep', () => {
  const r = rig(true)
  r.router.wake()
  r.router.tick('command')
  r.advance(FALSE_WAKE_AFTER_MS + 10)
  r.router.tick('wake')
  assert.equal(r.router.stats().falseWakes, 1)

  r.router.wake()
  r.router.accepted()
  r.advance(FALSE_WAKE_AFTER_MS + 10)
  r.router.tick('wake')
  assert.equal(r.router.stats().falseWakes, 1)
  assert.equal(r.router.stats().wakes, 2)
})

test('the browser recogniser may not stream while asleep with the offline engine', () => {
  assert.equal(cloudMayListen('wake', true), false)
  assert.equal(cloudMayListen('command', true), true)
  assert.equal(cloudMayListen('guard', true), true)
  assert.equal(cloudMayListen('wake', false), true)
})
