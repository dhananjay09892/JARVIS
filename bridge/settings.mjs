/**
 * User settings, stored outside the repository so an installed copy of JARVIS
 * can be configured from its own Settings page instead of by editing files.
 *
 *   Windows  %APPDATA%\JARVIS\settings.db   (SQLite)
 *   others   ~/.jarvis/settings.db   (JARVIS_HOME overrides both)
 *
 * Secrets (registry type 'secret': API keys, tokens) are not kept here. They
 * go to the operating system's protected storage through bridge/secrets.mjs —
 * DPAPI on Windows, the Keychain on macOS, the Secret Service on Linux — and a
 * key saved by an older version is moved there on first start (backed up
 * first, see migrateSecrets). The browser is only ever told whether a key is
 * set, never what it is. Precedence everywhere: real environment variable,
 * then the stored value, then the built-in default — so a developer's shell
 * still wins.
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REGISTRY, isValid, normalise } from './settings-registry.mjs'
import { createVault, pickBackend } from './secrets.mjs'

export function settingsDir(env = process.env) {
  if (env.JARVIS_HOME) return env.JARVIS_HOME
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'JARVIS')
  return join(homedir(), '.jarvis')
}

const file = () => join(settingsDir(), 'settings.db')

/** Every key the Settings page may change, from the registry (plan 39). */
const FIELDS = Object.fromEntries(REGISTRY.map((d) => [d.id, d]))

const SECRET_IDS = REGISTRY.filter((d) => d.secret).map((d) => d.id)
/** Where a setting's secret is filed in the vault. */
export const vaultName = (id) => `settings/${id}`

let db = null
let cache = null
let vault = null
let migrated = false

/** The OS secret store for this computer (created on first use). */
export function secretVault() {
  if (vault) return vault
  let backend = null
  try {
    backend = pickBackend({ file: join(settingsDir(), 'secrets.dpapi') })
  } catch (err) {
    console.error('[jarvis] secure secret storage unavailable:', err?.message ?? err)
  }
  vault = createVault(backend)
  return vault
}

/** Use another vault (tests, or a host that brings its own). Re-runs the migration. */
export function useSecretVault(v) {
  vault = v
  cache = null
  migrated = false
}

/** Close the database (tests use it to reopen against a different JARVIS_HOME). */
export function closeSettings() {
  try { db?.close() } catch { /* already closed */ }
  db = null
  cache = null
  migrated = false
}

/** Open (and create) the database; fold in a legacy settings.json once. */
function open() {
  if (db) return db
  mkdirSync(settingsDir(), { recursive: true })
  db = new DatabaseSync(file())
  // Deleted rows are overwritten, not just unlinked, so a removed secret leaves no trace.
  db.exec('PRAGMA secure_delete = ON')
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  try {
    chmodSync(file(), 0o600)
  } catch {
    /* Windows ignores POSIX modes; the folder is already per-user. */
  }
  const legacy = join(settingsDir(), 'settings.json')
  if (existsSync(legacy)) {
    try {
      const old = JSON.parse(readFileSync(legacy, 'utf8'))
      const put = db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?, ?)')
      for (const [k, def] of Object.entries(FIELDS)) {
        if (isValid(def, old[k])) put.run(k, old[k], new Date().toISOString())
      }
      renameSync(legacy, `${legacy}.migrated`)
      // Secrets just copied into the table move on to the vault in migrateSecrets.
    } catch {
      /* unreadable legacy file: leave it alone */
    }
  }
  return db
}

/** Rows for secret settings still in the table (left by an older version). */
function secretRows(d) {
  if (!SECRET_IDS.length) return []
  return d.prepare(`SELECT key, value FROM settings WHERE key IN (${SECRET_IDS.map(() => '?').join(', ')})`).all(...SECRET_IDS)
}

/** Remove secret fields from the renamed legacy settings.json, which is plain text. */
function scrubLegacyJson() {
  const migratedJson = join(settingsDir(), 'settings.json.migrated')
  if (!existsSync(migratedJson)) return
  try {
    const old = JSON.parse(readFileSync(migratedJson, 'utf8'))
    if (!old || typeof old !== 'object' || !SECRET_IDS.some((k) => k in old)) return
    for (const k of SECRET_IDS) delete old[k]
    writeFileSync(migratedJson, JSON.stringify(old, null, 2), { mode: 0o600 })
  } catch {
    /* unreadable: leave it alone, as open() does */
  }
}

/**
 * Move secrets an older version kept in the settings table into the vault.
 *
 *   1. Back up the database (VACUUM INTO settings.db.pre-keychain.bak, mode 0600).
 *   2. Write each secret to the vault, read the vault back from the OS and check it.
 *   3. Delete the rows (secure_delete is on) and VACUUM, so no copy stays in the file.
 *   4. Delete the backup — it holds the plain secrets, so it must not outlive the move.
 *
 * If the bridge stops between 1 and 4, the next start finds the backup and
 * finishes the move from it. If anything fails, the rows stay where they were
 * and are still read from there. With no secure storage on this computer the
 * rows also stay (read-only: new keys cannot be saved) and a warning is logged.
 */
export function migrateSecrets(d = open()) {
  scrubLegacyJson()
  const backup = join(settingsDir(), 'settings.db.pre-keychain.bak')
  const found = new Map(secretRows(d).map((r) => [r.key, r.value]))
  if (existsSync(backup)) {
    try {
      const old = new DatabaseSync(backup, { readOnly: true })
      try {
        for (const r of secretRows(old)) if (!found.has(r.key)) found.set(r.key, r.value)
      } finally {
        old.close()
      }
    } catch {
      /* a damaged backup holds nothing we can use */
    }
  }
  if (!found.size) {
    rmSync(backup, { force: true })
    return { moved: [] }
  }
  const v = secretVault()
  if (!v.available) {
    console.warn('[jarvis] no secure secret storage on this computer; saved API keys stay in the settings file until one is available.')
    return { moved: [], kept: [...found.keys()] }
  }
  try {
    if (!existsSync(backup)) {
      d.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
      try { chmodSync(backup, 0o600) } catch { /* Windows: the folder is per-user */ }
    }
    const valid = [...found].filter(([k, value]) => isValid(FIELDS[k], value))
    for (const [k, value] of valid) {
      // A value already in the vault is newer than the leftover row: keep it.
      if (v.get(vaultName(k)) === null) v.set(vaultName(k), value)
    }
    v.reload()
    for (const [k] of valid) {
      if (v.get(vaultName(k)) === null) throw new Error(`the secret store did not keep ${k}`)
    }
    d.exec('BEGIN')
    try {
      const del = d.prepare('DELETE FROM settings WHERE key = ?')
      for (const k of found.keys()) del.run(k)
      d.exec('COMMIT')
    } catch (err) {
      d.exec('ROLLBACK')
      throw err
    }
    d.exec('VACUUM')
    rmSync(backup, { force: true })
    cache = null
    return { moved: valid.map(([k]) => k) }
  } catch (err) {
    console.error('[jarvis] could not move saved API keys to secure storage; they stay where they were:', err?.message ?? err)
    return { moved: [], kept: [...found.keys()] }
  }
}

export function readSettings() {
  if (cache) return cache
  const out = {}
  try {
    const d = open()
    if (!migrated) {
      migrated = true
      migrateSecrets(d)
    }
    for (const row of d.prepare('SELECT key, value FROM settings').all()) {
      const def = FIELDS[row.key]
      // A secret row is only here when there is no secure storage to move it to.
      if (def && isValid(def, row.value)) out[row.key] = row.value
    }
  } catch (err) {
    console.error('[jarvis] settings database unavailable:', err.message)
  }
  try {
    const v = secretVault()
    for (const k of SECRET_IDS) {
      const value = v.get(vaultName(k))
      if (value !== null && isValid(FIELDS[k], value)) out[k] = value
    }
  } catch (err) {
    console.error('[jarvis] secure secret storage unreadable:', err?.message ?? err)
  }
  cache = out
  return cache
}

/** env var first, then the settings database, then undefined. */
export function setting(key) {
  return process.env[key] || readSettings()[key] || undefined
}

/**
 * Apply a patch. A value of '' (or null) clears a field; booleans may be sent
 * as true/false. Unknown keys and values that fail validation are rejected as
 * a whole — nothing is half-saved.
 *
 * Returns which settings actually changed, split by when they take effect
 * (the registry's `apply`), and which of them an environment variable
 * overrides, so the change is saved but not in force.
 */
export function updateSettings(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings patch must be an object')
  const changes = []
  for (const [k, raw] of Object.entries(patch)) {
    const def = Object.hasOwn(FIELDS, k) ? FIELDS[k] : undefined
    if (!def) throw new Error(`unknown setting: ${k}`)
    const v = normalise(def, raw)
    if (v === undefined || (v !== '' && !isValid(def, v))) throw new Error(`invalid value for ${k}`)
    changes.push([k, v])
  }
  const before = readSettings()
  const changed = changes.filter(([k, v]) => (before[k] ?? '') !== v).map(([k]) => k)
  // Secrets go to the vault, never the table. Write them first: if the OS store
  // refuses, nothing at all is saved.
  const secretChanges = changes.filter(([k]) => FIELDS[k].secret)
  const plainChanges = changes.filter(([k]) => !FIELDS[k].secret)
  const v = secretChanges.length ? secretVault() : null
  const previous = secretChanges.map(([k]) => [k, v.get(vaultName(k))])
  const restoreSecrets = () => {
    for (const [k, old] of previous) {
      try {
        if (old === null) v.delete(vaultName(k))
        else v.set(vaultName(k), old)
      } catch {
        /* best effort; the original error is the one reported */
      }
    }
  }
  try {
    for (const [k, value] of secretChanges) {
      if (value === '') v.delete(vaultName(k))
      else v.set(vaultName(k), value)
    }
  } catch (err) {
    restoreSecrets()
    cache = null
    throw err
  }
  const d = open()
  const del = d.prepare('DELETE FROM settings WHERE key = ?')
  const put = d.prepare(
    'INSERT INTO settings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
  d.exec('BEGIN')
  try {
    for (const [k, value] of plainChanges) {
      if (value === '') del.run(k)
      else put.run(k, value, new Date().toISOString())
    }
    // Any leftover copy of a changed secret goes too (only possible without secure storage).
    for (const [k] of secretChanges) del.run(k)
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    restoreSecrets()
    cache = null
    throw err
  }
  cache = null
  return {
    changed,
    appliedLive: changed.filter((k) => FIELDS[k].apply === 'live'),
    needsRestart: changed.filter((k) => FIELDS[k].apply !== 'live'),
    overridden: changed.filter((k) => Boolean(process.env[k])),
  }
}

/** What the browser may see: secrets reduced to a yes/no. */
export function publicSettings() {
  const s = readSettings()
  const out = {}
  for (const [k, def] of Object.entries(FIELDS)) {
    if (def.secret) out[`${k}_set`] = Boolean(process.env[k] || s[k])
    else out[k] = process.env[k] ?? s[k] ?? ''
  }
  out.storage = file()
  const v = secretVault()
  out.secretStorage = v.label
  out.secretStorageAvailable = v.available
  return out
}
