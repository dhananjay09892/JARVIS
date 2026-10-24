// Q20 (plan 39 phase 3): secrets live in the OS store, not the settings file,
// and keys saved by an older version are moved there with a backup first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVault, memoryBackend } from './secrets.mjs'

const SECRET = 'elevenlabs-key-SECRET-0123456789'
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-q20-'))
delete process.env.ELEVENLABS_API_KEY
const settings = await import('./settings.mjs')
const { updateSettings, publicSettings, setting, useSecretVault, closeSettings, migrateSecrets } = settings

/** A fresh settings folder and vault for one test. */
function fresh(backend = memoryBackend()) {
  closeSettings()
  process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-q20-'))
  const vault = createVault(backend)
  useSecretVault(vault)
  return { home: process.env.JARVIS_HOME, vault, backend }
}

/** Write rows straight into a settings.db the way an older version did. */
function seedOldDb(home, rows) {
  const d = new DatabaseSync(join(home, 'settings.db'))
  d.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  for (const [k, v] of Object.entries(rows)) d.prepare('INSERT INTO settings VALUES (?, ?, ?)').run(k, v, 'old')
  d.close()
}

/** The automated scan from plan 39's metric: no file in the settings folder holds the secret. */
function assertNoPlainSecret(home, secret = SECRET) {
  for (const name of readdirSync(home)) {
    const bytes = readFileSync(join(home, name))
    assert.equal(bytes.includes(Buffer.from(secret)), false, `${name} holds the secret in plain text`)
  }
}

test('a saved key goes to the vault; the settings file never holds it', () => {
  const { home, vault } = fresh()
  const r = updateSettings({ ELEVENLABS_API_KEY: SECRET, JARVIS_MODEL: 'claude-test-1' })
  assert.deepEqual(r.changed.sort(), ['ELEVENLABS_API_KEY', 'JARVIS_MODEL'])
  assert.equal(vault.get('settings/ELEVENLABS_API_KEY'), SECRET)
  assert.equal(setting('ELEVENLABS_API_KEY'), SECRET)
  closeSettings()
  const d = new DatabaseSync(join(home, 'settings.db'))
  assert.deepEqual(d.prepare('SELECT key FROM settings').all().map((x) => x.key), ['JARVIS_MODEL'])
  d.close()
  assertNoPlainSecret(home)
  const pub = publicSettings()
  assert.equal(pub.ELEVENLABS_API_KEY_set, true)
  assert.equal(pub.secretStorageAvailable, true)
  assert.equal(JSON.stringify(pub).includes(SECRET), false)
  updateSettings({ ELEVENLABS_API_KEY: '' })
  assert.equal(vault.get('settings/ELEVENLABS_API_KEY'), null)
  assert.equal(publicSettings().ELEVENLABS_API_KEY_set, false)
})

test('a key from an older version is backed up, moved to the vault, scrubbed, and the backup removed', () => {
  const { home, vault } = fresh()
  seedOldDb(home, { ELEVENLABS_API_KEY: SECRET, JARVIS_EFFORT: 'high' })
  assert.equal(setting('ELEVENLABS_API_KEY'), SECRET, 'still works after the move')
  assert.equal(setting('JARVIS_EFFORT'), 'high', 'plain settings are untouched')
  assert.equal(vault.get('settings/ELEVENLABS_API_KEY'), SECRET)
  closeSettings()
  assert.equal(existsSync(join(home, 'settings.db.pre-keychain.bak')), false)
  assertNoPlainSecret(home)
})

test('the move uses the backup: an interrupted run is finished from it on the next start', () => {
  const { home, vault } = fresh()
  // As if the last run made the backup, deleted the row, then stopped before writing the vault.
  seedOldDb(home, { ELEVENLABS_API_KEY: SECRET })
  const d = new DatabaseSync(join(home, 'settings.db'))
  d.exec(`VACUUM INTO '${join(home, 'settings.db.pre-keychain.bak')}'`)
  d.prepare('DELETE FROM settings').run()
  d.close()
  assert.equal(setting('ELEVENLABS_API_KEY'), SECRET)
  assert.equal(vault.get('settings/ELEVENLABS_API_KEY'), SECRET)
  closeSettings()
  assert.equal(existsSync(join(home, 'settings.db.pre-keychain.bak')), false)
  assertNoPlainSecret(home)
})

test('a vault value newer than the leftover row wins', () => {
  const { home, vault } = fresh()
  vault.set('settings/ELEVENLABS_API_KEY', 'newer-key-abcdefgh')
  seedOldDb(home, { ELEVENLABS_API_KEY: SECRET })
  assert.equal(setting('ELEVENLABS_API_KEY'), 'newer-key-abcdefgh')
  closeSettings()
  assertNoPlainSecret(home)
})

test('if the vault fails to keep the key, the row stays and nothing is lost', () => {
  const broken = { name: 'memory', label: 'broken', load: () => null, save() { /* silently drops */ }, clear() {} }
  const { home } = fresh(broken)
  seedOldDb(home, { ELEVENLABS_API_KEY: SECRET })
  const r = migrateSecrets()
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.kept, ['ELEVENLABS_API_KEY'])
  assert.equal(setting('ELEVENLABS_API_KEY'), SECRET)
})

test('without secure storage: an old key is still read, a new one is refused, clearing works', () => {
  closeSettings()
  process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-q20-'))
  const home = process.env.JARVIS_HOME
  useSecretVault(createVault(null))
  seedOldDb(home, { ELEVENLABS_API_KEY: SECRET })
  assert.equal(setting('ELEVENLABS_API_KEY'), SECRET)
  assert.equal(publicSettings().secretStorageAvailable, false)
  assert.throws(() => updateSettings({ ELEVENLABS_API_KEY: 'another-key-12345678' }), /No secure storage/)
  assert.equal(setting('ELEVENLABS_API_KEY'), SECRET, 'a refused save changes nothing')
  updateSettings({ ELEVENLABS_API_KEY: null })
  assert.equal(setting('ELEVENLABS_API_KEY'), undefined)
  closeSettings()
  assertNoPlainSecret(home)
})

test('a vault error rolls back the whole patch, and the error does not quote the key', () => {
  const failing = { name: 'memory', label: 'failing', load: () => null, save() { throw new Error('Could not save to the secret store (dpapi: exit code 5).') }, clear() {} }
  fresh(failing)
  assert.throws(
    () => updateSettings({ ELEVENLABS_API_KEY: SECRET, JARVIS_MODEL: 'claude-test-2' }),
    (err) => !err.message.includes(SECRET),
  )
  assert.equal(setting('JARVIS_MODEL'), undefined, 'nothing half-saved')
})

test('the old settings.json.migrated loses its secret fields', () => {
  const { home } = fresh()
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ ELEVENLABS_API_KEY: SECRET, JARVIS_MODEL: 'claude-old-1' }))
  assert.equal(setting('ELEVENLABS_API_KEY'), SECRET)
  assert.equal(setting('JARVIS_MODEL'), 'claude-old-1')
  const old = JSON.parse(readFileSync(join(home, 'settings.json.migrated'), 'utf8'))
  assert.deepEqual(old, { JARVIS_MODEL: 'claude-old-1' })
  closeSettings()
  assertNoPlainSecret(home)
})

test('an environment variable still wins over the stored key', () => {
  fresh()
  updateSettings({ ELEVENLABS_API_KEY: SECRET })
  process.env.ELEVENLABS_API_KEY = 'from-env-12345678'
  try {
    assert.equal(setting('ELEVENLABS_API_KEY'), 'from-env-12345678')
    assert.deepEqual(updateSettings({ ELEVENLABS_API_KEY: 'stored-key-87654321' }).overridden, ['ELEVENLABS_API_KEY'])
  } finally {
    delete process.env.ELEVENLABS_API_KEY
  }
})

test('the bridge hands connectors the vault as their keychain', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(src, /createCredentialStore\(\{\s*keychain: vault\.available \? connectorKeychain\(vault\) : null/)
})
