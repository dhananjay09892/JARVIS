// Plan 02: user-facing text must say truthfully what audio leaves the machine
// while JARVIS waits for his name.
//
// Phase 1 (Q07) pinned "not detected on this computer yet". Phase 2 (Q09)
// shipped the offline wake word, so the text now says asleep audio stays on
// the computer — and these tests tie that claim to the code that makes it
// true, and require the cloud fallback to be disclosed alongside it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { settingDef } from './settings-registry.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const USER_FACING = ['DISCLAIMER.txt', 'README.md', 'src/ui/Settings.tsx', 'installer/jarvis.iss']
const DISCLOSURES = ['DISCLAIMER.txt', 'README.md', 'src/ui/Settings.tsx']

/**
 * Claims that stay false even with the offline wake word: after a wake, speech
 * is transcribed by a cloud service, and with the engine off it is sent while
 * asleep too. So no unconditional "nothing leaves" and no "audio never leaves".
 */
const OVERSTATEMENTS = [
  /nothing (?:ever )?leaves (?:your|the|this) (?:computer|machine|device)/i,
  /audio never leaves/i,
  /never (?:sends|uploads) (?:any )?audio/i,
  /(?:all|everything) (?:is processed|runs|stays) (?:locally|on[- ]device|on your computer)/i,
]

for (const file of USER_FACING) {
  test(`${file} does not overstate what stays on the computer`, () => {
    const text = read(file)
    for (const re of OVERSTATEMENTS) {
      assert.doesNotMatch(text, re, `${file} matches ${re}`)
    }
  })
}

for (const file of DISCLOSURES) {
  test(`${file} discloses the offline wake word, where speech goes after a wake, and the cloud fallback`, () => {
    const text = read(file)
    assert.match(text, /offline wake[- ]word/i)
    assert.match(text, /asleep/i)
    // Where speech goes once he is awake.
    assert.match(text, /ElevenLabs/)
    assert.match(text, /Google/)
    assert.match(text, /Microsoft/)
    // The fallback is never silent: it has a name the user can see.
    assert.match(text, /CLOUD LISTENING/)
    assert.match(text, /(?:turn(?:ed)? (?:the offline wake[- ]word |it )?off|turned off)/i)
    // The phase-1 wording is gone now that it is no longer true.
    assert.doesNotMatch(text, /not\s+detected\s+on\s+(?:your|this)\s+computer\s+yet/i)
    assert.doesNotMatch(text, /offline\s+wake[- ]word\s+(?:engine\s+)?is\s+planned/i)
  })
}

test('the "stays on this computer" claim is backed by shipped code', () => {
  // On by default, and switchable (plan 02; standing constraint: every feature has an off switch).
  assert.equal(settingDef('JARVIS_WAKE_WORD').default, 'offline')
  // The engine, the router that keeps asleep audio local, and its test exist.
  for (const f of [
    'src/lib/wake/engine.ts',
    'src/lib/wake/openwakeword.ts',
    'src/lib/wake/router.ts',
    'src/lib/wake/router.test.ts',
  ]) {
    assert.ok(existsSync(join(root, f)), `${f} is missing`)
  }
  // The models are shipped with the app, not fetched from a vendor at run time.
  for (const f of ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx', 'LICENSE.md']) {
    assert.ok(existsSync(join(root, 'public/models/wake', f)), `public/models/wake/${f} is missing`)
  }
  // The voice loop routes VAD segments through the router rather than uploading them directly.
  const voice = read('src/lib/voice.ts')
  assert.match(voice, /router\.segmentEnd\(/)
  assert.doesNotMatch(voice, /onEnd:[^}]*pendingAudio\.push/s)
})

test('the overstatement patterns catch the claims they are meant to catch', () => {
  const bad = [
    'Nothing leaves your computer until you say Hey Jarvis.',
    'Audio never leaves the machine.',
    'JARVIS never sends audio anywhere.',
    'Everything runs locally.',
  ]
  for (const line of bad) {
    assert.ok(OVERSTATEMENTS.some((re) => re.test(line)), `not caught: ${line}`)
  }
  const fine = [
    'While he is asleep what the microphone hears stays here.',
    'The offline wake word listens for "Hey Jarvis" on this computer.',
  ]
  for (const line of fine) {
    assert.ok(!OVERSTATEMENTS.some((re) => re.test(line)), `wrongly caught: ${line}`)
  }
})
