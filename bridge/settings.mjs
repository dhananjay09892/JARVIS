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
import { REGISTRY, isValid, normalise } from './settings-registry.mjs'

export function settingsDir(env = process.env) {
  if (env.JARVIS_HOME) return env.JARVIS_HOME
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'JARVIS')
  return join(homedir(), '.jarvis')
}

const file = () => join(settingsDir(), 'settings.db')

/** Every key the Settings page may change, from the registry (plan 39). */
const FIELDS = Object.fromEntries(REGISTRY.map((d) => [d.id, d]))

let db = null
let cache = null

/**
 * What each restart-only setting was when this bridge started (plan 39 phase
 * 4). A setting is "waiting for a restart" exactly while its effective value
 * differs from this, so changing it back clears the banner on its own.
 */
let boot = null

/** Who hears about a saved change (see onSettingsChange). */
const listeners = new Set()

/** env var, then the stored value, then the registry default. */
function effective(k, stored) {
  return process.env[k] || stored[k] || FIELDS[k].default
}

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
        if (isValid(def, old[k])) put.run(k, old[k], new Date().toISOString())
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
      if (def && isValid(def, row.value)) cache[row.key] = row.value
    }
  } catch (err) {
    console.error('[jarvis] settings database unavailable:', err.message)
  }
  if (!boot) {
    boot = {}
    for (const [k, def] of Object.entries(FIELDS)) if (def.apply === 'restart') boot[k] = effective(k, cache)
  }
  return cache
}

/**
 * The restart-only settings whose saved value is not yet in force: what the
 * "Restart JARVIS to apply" banner lists. Empty when nothing is waiting.
 */
export function restartPending() {
  const s = readSettings()
  return Object.keys(boot).filter((k) => effective(k, s) !== boot[k])
}

/**
 * Subscribe to saved changes: the settings-changed event (plan 39 phase 4).
 * Subsystems that can reconfigure live listen here instead of reading a value
 * once at boot. The listener gets { changed, appliedLive, nextConversation,
 * needsRestart, overridden } after the change is committed; one that throws
 * is logged and cannot undo the save or stop the others. Returns an
 * unsubscribe function.
 */
export function onSettingsChange(listener) {
  if (typeof listener !== 'function') throw new Error('listener must be a function')
  listeners.add(listener)
  return () => listeners.delete(listener)
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
 * (the registry's `apply`: `appliedLive` now, `nextConversation` from the
 * next conversation or task, `needsRestart` after a restart), which of them
 * an environment variable overrides, so the change is saved but not in
 * force, and every restart-only setting still waiting (`restartPending`).
 * Listeners registered with onSettingsChange hear about real changes only.
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
  // A change an environment variable overrides is saved but not in force, so
  // it neither applies live nor waits for a restart.
  const overridden = changed.filter((k) => Boolean(process.env[k]))
  const inForce = changed.filter((k) => !overridden.includes(k))
  const event = {
    changed,
    appliedLive: inForce.filter((k) => FIELDS[k].apply === 'live'),
    nextConversation: inForce.filter((k) => FIELDS[k].apply === 'reconnect'),
    needsRestart: inForce.filter((k) => FIELDS[k].apply === 'restart'),
    overridden,
  }
  if (changed.length) {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (err) {
        console.error('[jarvis] a settings listener failed:', err?.message ?? err)
      }
    }
  }
  return { ...event, restartPending: restartPending() }
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
  out.restartPending = restartPending()
  return out
}
