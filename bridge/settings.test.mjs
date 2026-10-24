import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-settings-'))
const { updateSettings, publicSettings, setting, useSecretVault } = await import('./settings.mjs')
const { createVault, memoryBackend } = await import('./secrets.mjs')
useSecretVault(createVault(memoryBackend()))

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
  const r = updateSettings({ JARVIS_EFFORT: 'medium', setupDone: '1' })
  assert.deepEqual(r.changed.sort(), ['JARVIS_EFFORT', 'setupDone'])
  assert.deepEqual(r.needsRestart, ['JARVIS_EFFORT'])
  assert.deepEqual(r.appliedLive, ['setupDone'])
  // Saving the same values again changes nothing, so nothing needs a restart.
  const again = updateSettings({ JARVIS_EFFORT: 'medium', setupDone: '1' })
  assert.deepEqual(again.changed, [])
  assert.deepEqual(again.needsRestart, [])
  updateSettings({ JARVIS_EFFORT: '', setupDone: '' })
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
