/**
 * User settings, stored outside the repository so an installed copy of JARVIS
 * can be configured from its own Settings page instead of by editing files.
 *
 *   Windows  %APPDATA%\JARVIS\settings.db   (SQLite)
 *   others   ~/.jarvis/settings.db   (JARVIS_HOME overrides both)
 *
 * Secrets stay in this process. The browser is only ever told whether a key is
 * set, never what it is. Precedence everywhere: real environment variable, then
 * this file, then the built-in default — so a developer's shell still wins.
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function settingsDir(env = process.env) {
  if (env.JARVIS_HOME) return env.JARVIS_HOME
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'JARVIS')
  return join(homedir(), '.jarvis')
}

const file = () => join(settingsDir(), 'settings.db')

/** Every key the Settings page may change, with how to validate it. */
const FIELDS = {
  ELEVENLABS_API_KEY: { secret: true, check: (v) => /^[\w-]{8,200}$/.test(v) },
  JARVIS_MODEL: { check: (v) => /^[\w.-]{1,80}$/.test(v) },
  JARVIS_EFFORT: { check: (v) => ['low', 'medium', 'high', 'xhigh'].includes(v) },
  JARVIS_VOICE_ID: { check: (v) => /^[\w-]{8,64}$/.test(v) },
  JARVIS_ALLOW_WRITES: { check: (v) => v === '1' || v === '0' },
  setupDone: { check: (v) => v === '1' || v === '0' },
}

let db = null
let cache = null

/** Open (and create) the database; fold in a legacy settings.json once. */
function open() {
  if (db) return db
  mkdirSync(settingsDir(), { recursive: true })
  db = new DatabaseSync(file())
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
        if (typeof old[k] === 'string' && def.check(old[k])) put.run(k, old[k], new Date().toISOString())
      }
      renameSync(legacy, `${legacy}.migrated`)
    } catch {
      /* unreadable legacy file: leave it alone */
    }
  }
  return db
}

export function readSettings() {
  if (cache) return cache
  cache = {}
  try {
    for (const row of open().prepare('SELECT key, value FROM settings').all()) {
      const def = FIELDS[row.key]
      if (def && def.check(row.value)) cache[row.key] = row.value
    }
  } catch (err) {
    console.error('[jarvis] settings database unavailable:', err.message)
  }
  return cache
}

/** env var first, then the settings database, then undefined. */
export function setting(key) {
  return process.env[key] || readSettings()[key] || undefined
}

/**
 * Apply a patch. A value of '' clears a field. Unknown keys and values that
 * fail validation are rejected as a whole — nothing is half-saved.
 */
export function updateSettings(patch) {
  const changes = []
  for (const [k, raw] of Object.entries(patch ?? {})) {
    const def = FIELDS[k]
    if (!def) throw new Error(`unknown setting: ${k}`)
    const v = typeof raw === 'string' ? raw.trim() : raw
    if (v !== '' && !(typeof v === 'string' && def.check(v))) throw new Error(`invalid value for ${k}`)
    changes.push([k, v])
  }
  const d = open()
  const del = d.prepare('DELETE FROM settings WHERE key = ?')
  const put = d.prepare(
    'INSERT INTO settings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
  d.exec('BEGIN')
  try {
    for (const [k, v] of changes) {
      if (v === '') del.run(k)
      else put.run(k, v, new Date().toISOString())
    }
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  cache = null
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
  return out
}
