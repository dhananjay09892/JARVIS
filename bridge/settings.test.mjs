import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-settings-'))
const { onSettingsChange, restartPending, updateSettings, publicSettings, setting } = await import('./settings.mjs')

test('secrets are stored but never exposed, only reported as set', () => {
  updateSettings({ ELEVENLABS_API_KEY: 'abcdefgh12345678' })
  const pub = publicSettings()
  assert.equal(pub.ELEVENLABS_API_KEY_set, true)
  assert.equal(JSON.stringify(pub).includes('abcdefgh12345678'), false)
  assert.equal(setting('ELEVENLABS_API_KEY'), 'abcdefgh12345678')
})

test('empty string clears a field; the file on disk follows', () => {
  updateSettings({ ELEVENLABS_API_KEY: '' })
  assert.equal(publicSettings().ELEVENLABS_API_KEY_set, false)
  const db = new DatabaseSync(join(process.env.JARVIS_HOME, 'settings.db'))
  assert.equal(db.prepare('SELECT * FROM settings WHERE key = ?').get('ELEVENLABS_API_KEY'), undefined)
  db.close()
})

test('unknown keys and invalid values are rejected without a partial save', () => {
  assert.throws(() => updateSettings({ PATH: 'x' }), /unknown setting/)
  assert.throws(() => updateSettings({ JARVIS_EFFORT: 'low', JARVIS_MODEL: 'bad model!' }), /invalid value/)
  assert.equal(publicSettings().JARVIS_EFFORT, '')
})

test('the result says what changed and when it takes effect', () => {
  updateSettings({ JARVIS_EFFORT: '' })
  const r = updateSettings({ JARVIS_EFFORT: 'medium', setupDone: '1', JARVIS_AUDIT: '0' })
  assert.deepEqual(r.changed.sort(), ['JARVIS_AUDIT', 'JARVIS_EFFORT', 'setupDone'])
  assert.deepEqual(r.needsRestart, ['JARVIS_AUDIT'])
  assert.deepEqual(r.nextConversation, ['JARVIS_EFFORT'])
  assert.deepEqual(r.appliedLive, ['setupDone'])
  // Saving the same values again changes nothing, so nothing needs a restart.
  const again = updateSettings({ JARVIS_EFFORT: 'medium', setupDone: '1', JARVIS_AUDIT: '0' })
  assert.deepEqual(again.changed, [])
  assert.deepEqual(again.needsRestart, [])
  updateSettings({ JARVIS_EFFORT: '', setupDone: '', JARVIS_AUDIT: '' })
})

test('booleans may be sent as true/false and null clears; other types are rejected', () => {
  updateSettings({ JARVIS_TRACES: false })
  assert.equal(publicSettings().JARVIS_TRACES, '0')
  updateSettings({ JARVIS_TRACES: null })
  assert.equal(publicSettings().JARVIS_TRACES, '')
  assert.throws(() => updateSettings({ JARVIS_MODEL: 5 }), /invalid value/)
  assert.throws(() => updateSettings({ JARVIS_MODEL: true }), /invalid value/)
  assert.throws(() => updateSettings({ JARVIS_EFFORT: 'max' }), /invalid value/)
  assert.throws(() => updateSettings([]), /must be an object/)
  assert.throws(() => updateSettings({ toString: 'x' }), /unknown setting/)
  assert.throws(() => updateSettings({ __proto__: { a: 1 }, constructor: 'x' }), /unknown setting/)
})

test('a setting overridden by the environment is reported as such', () => {
  process.env.JARVIS_MODEL = 'claude-sonnet-5'
  try {
    const r = updateSettings({ JARVIS_MODEL: 'claude-haiku-5' })
    assert.deepEqual(r.overridden, ['JARVIS_MODEL'])
    assert.equal(setting('JARVIS_MODEL'), 'claude-sonnet-5')
  } finally {
    delete process.env.JARVIS_MODEL
    updateSettings({ JARVIS_MODEL: '' })
  }
})

test('a saved change is announced to listeners after it is committed (plan 39 phase 4)', () => {
  const heard = []
  const off = onSettingsChange((e) => heard.push({ ...e, value: setting('JARVIS_VOICE_ID') }))
  try {
    updateSettings({ JARVIS_VOICE_ID: 'voice-abcdefgh', JARVIS_MODEL: 'claude-haiku-5' })
    assert.equal(heard.length, 1)
    assert.deepEqual(heard[0].changed.sort(), ['JARVIS_MODEL', 'JARVIS_VOICE_ID'])
    assert.deepEqual(heard[0].appliedLive, ['JARVIS_VOICE_ID'])
    assert.deepEqual(heard[0].nextConversation, ['JARVIS_MODEL'])
    // The listener already reads the new value: the event comes after the commit.
    assert.equal(heard[0].value, 'voice-abcdefgh')
    // Nothing changed, nothing announced.
    updateSettings({ JARVIS_VOICE_ID: 'voice-abcdefgh' })
    assert.equal(heard.length, 1)
    // A rejected patch is not announced either.
    assert.throws(() => updateSettings({ JARVIS_EFFORT: 'max' }))
    assert.equal(heard.length, 1)
  } finally {
    off()
    updateSettings({ JARVIS_VOICE_ID: '', JARVIS_MODEL: '' })
  }
  assert.equal(heard.length, 1, 'unsubscribed listeners hear nothing')
  assert.throws(() => onSettingsChange('nope'), /must be a function/)
})

test('a listener that throws cannot undo the save or silence the others', () => {
  const heard = []
  const offBad = onSettingsChange(() => {
    throw new Error('boom')
  })
  const offGood = onSettingsChange((e) => heard.push(e.changed))
  const error = console.error
  console.error = () => {}
  try {
    const r = updateSettings({ setupDone: '1' })
    assert.deepEqual(r.changed, ['setupDone'])
    assert.equal(publicSettings().setupDone, '1')
    assert.deepEqual(heard, [['setupDone']])
  } finally {
    console.error = error
    offBad()
    offGood()
    updateSettings({ setupDone: '' })
  }
})

test('restart-only settings wait for a restart until they are changed back', () => {
  assert.deepEqual(restartPending(), [])
  const r = updateSettings({ JARVIS_ALLOW_WRITES: '1' })
  assert.deepEqual(r.restartPending, ['JARVIS_ALLOW_WRITES'])
  assert.deepEqual(publicSettings().restartPending, ['JARVIS_ALLOW_WRITES'])
  // Live and next-conversation settings never wait for one.
  updateSettings({ JARVIS_VOICE_ID: 'voice-abcdefgh', JARVIS_EFFORT: 'low' })
  assert.deepEqual(restartPending(), ['JARVIS_ALLOW_WRITES'])
  // Saving the value in force at start (here: the default) clears it.
  const back = updateSettings({ JARVIS_ALLOW_WRITES: '0' })
  assert.deepEqual(back.restartPending, [])
  updateSettings({ JARVIS_ALLOW_WRITES: '', JARVIS_VOICE_ID: '', JARVIS_EFFORT: '' })
  assert.deepEqual(restartPending(), [])
})

test('a change an environment variable overrides neither applies nor waits for a restart', () => {
  process.env.JARVIS_AUDIT = '1'
  try {
    const r = updateSettings({ JARVIS_AUDIT: '0' })
    assert.deepEqual(r.overridden, ['JARVIS_AUDIT'])
    assert.deepEqual(r.needsRestart, [])
    assert.deepEqual(r.restartPending, [])
  } finally {
    delete process.env.JARVIS_AUDIT
    updateSettings({ JARVIS_AUDIT: '' })
  }
})
