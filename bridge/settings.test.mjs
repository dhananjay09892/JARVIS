import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-settings-'))
const { updateSettings, publicSettings, setting } = await import('./settings.mjs')

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
