// Plan 02 phase 1: user-facing text must say what audio leaves the machine
// while JARVIS waits for his name, and must not claim the wake word is
// detected on-device until the offline engine (plan 02 phase 2) ships.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const USER_FACING = ['DISCLAIMER.txt', 'README.md', 'src/ui/Settings.tsx', 'installer/jarvis.iss']

/** Claims that are false while the wake word is matched on a cloud transcript. */
const OVERSTATEMENTS = [
  /nothing (?:ever )?leaves (?:your|the|this) (?:computer|machine|device)/i,
  /(?:wake[- ]word|wake) (?:detection |engine )?(?:runs |is )?(?:fully )?(?:on[- ]device|offline|locally|local)\b(?! wake)/i,
  /(?:on[- ]device|offline|local) wake[- ]word (?:detection|engine) (?:is (?:on|enabled|active|running|used|built in)|runs)\b/i,
  /audio never leaves/i,
  /(?:only|just) (?:sends|uploads) audio after (?:the )?wake/i,
]

for (const file of USER_FACING) {
  test(`${file} does not overstate on-device wake detection`, () => {
    const text = read(file)
    for (const re of OVERSTATEMENTS) {
      assert.doesNotMatch(text, re, `${file} matches ${re}`)
    }
  })
}

for (const file of ['DISCLAIMER.txt', 'README.md', 'src/ui/Settings.tsx']) {
  test(`${file} discloses where asleep audio goes`, () => {
    const text = read(file)
    assert.match(text, /not\s+detected\s+on\s+(?:your|this)\s+computer\s+yet/i)
    assert.match(text, /ElevenLabs/)
    assert.match(text, /Google/)
    assert.match(text, /Microsoft/)
    assert.match(text, /offline\s+wake[- ]word\s+(?:engine\s+)?is\s+planned/i)
  })
}

test('the overstatement patterns catch the claims they are meant to catch', () => {
  const bad = [
    'Wake word detection runs on-device.',
    'Nothing leaves your computer until you say Hey Jarvis.',
    'The offline wake-word engine is enabled.',
    'Audio never leaves the machine.',
  ]
  for (const line of bad) {
    assert.ok(OVERSTATEMENTS.some((re) => re.test(line)), `not caught: ${line}`)
  }
  assert.ok(!OVERSTATEMENTS.some((re) => re.test('An offline wake-word engine is planned.')))
})
