/**
 * Shared helper for connectors that read a macOS app's local database
 * (task C29; Apple Calendar first, Contacts / Notes / Music / iMessage reuse it).
 *
 * What it does and does not do:
 *   - `ensureMac()` makes every such connector report itself unavailable off a
 *     Mac, with a plain message, instead of failing in a confusing way.
 *   - `snapshotDatabase()` never opens the app's live database. It checks the
 *     path is a plain file (no link), copies it (and its -wal / -shm companions)
 *     into a private 0700 temp folder, opens the COPY read-only, and deletes the
 *     copy when done. So the app is never locked or written to, and a bug here
 *     cannot damage the owner's data.
 *   - macOS refuses reads of protected folders without Full Disk Access. That
 *     (EPERM / EACCES) becomes the `permission-needed` error whose message tells
 *     the owner exactly which setting to open, instead of "failed".
 *   - `explainAccess()` builds the plain-language "why this needs Full Disk
 *     Access and what is read" text shown on the card before the owner agrees.
 *
 * No network, no shell, no AppleScript: only file reads. The snapshot size is
 * capped.
 */
import { constants } from 'node:fs'
import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConnectorError } from './http.mjs'

export const FULL_DISK_ACCESS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
const MAX_DB_BYTES = 1024 ** 3 // 1 GiB

export const isMac = (platform = process.platform) => platform === 'darwin'

/** Throws `unsupported-platform` unless this is a Mac. */
export function ensureMac(platform = process.platform) {
  if (!isMac(platform)) throw new ConnectorError('unsupported-platform', { detail: `platform ${platform}` })
}

/** The card text: why Full Disk Access, and exactly what is read. */
export function explainAccess({ app, reads, notReads }) {
  const text =
    `JARVIS reads ${reads} from ${app}'s protected folder, so macOS needs Full Disk Access turned on for JARVIS. ` +
    `It works on a private copy, never changes ${app}${notReads ? `, and never touches ${notReads}` : ''}.`
  if (text.length > 300) throw new Error('explainAccess text must fit a card line (300 characters)')
  return text
}

const missing = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR'
const denied = (err) => err?.code === 'EPERM' || err?.code === 'EACCES'

/** Map a file-system error to the connector error the owner can act on. */
export function accessError(err, what = 'the database') {
  if (err instanceof ConnectorError) return err
  if (denied(err)) return new ConnectorError('permission-needed', { detail: `${what}: ${err.code}` })
  if (missing(err)) return new ConnectorError('folder-missing', { detail: `${what}: not found` })
  return new ConnectorError('bad-response', { detail: `${what}: could not be read` })
}

/** First of `candidates` that exists as a plain file. Permission errors win over "not found". */
export async function findDatabase(candidates) {
  let deniedErr = null
  for (const p of candidates) {
    try {
      const s = await lstat(p)
      if (s.isSymbolicLink() || !s.isFile()) continue
      // Changes land in the -wal file first, so it is part of the "did anything change" signature.
      let wal = ''
      try { const w = await lstat(p + '-wal'); wal = `${w.size}:${Math.floor(w.mtimeMs)}` } catch { /* no wal */ }
      return { path: p, size: s.size, mtimeMs: Math.floor(s.mtimeMs), signature: `${s.size}:${Math.floor(s.mtimeMs)}:${wal}` }
    } catch (err) {
      if (denied(err)) deniedErr = err
      else if (!missing(err)) throw accessError(err)
    }
  }
  throw deniedErr ? accessError(deniedErr) : new ConnectorError('folder-missing', { detail: 'database not found' })
}

/**
 * Run `fn(db)` on a read-only copy of the database, then delete the copy.
 * @template T
 * @param {string} path
 * @param {(db: DatabaseSync) => T | Promise<T>} fn
 */
export async function withSnapshot(path, fn, { maxBytes = MAX_DB_BYTES } = {}) {
  let dir
  try {
    const s = await lstat(path)
    if (s.isSymbolicLink() || !s.isFile()) throw new ConnectorError('folder-missing', { detail: 'not a plain file' })
    if (s.size > maxBytes) throw new ConnectorError('bad-response', { detail: 'the database is larger than the limit' })
    dir = await mkdtemp(join(tmpdir(), 'jarvis-snap-'))
    const copy = join(dir, 'db.sqlite')
    await copyFile(path, copy, constants.COPYFILE_EXCL)
    for (const ext of ['-wal', '-shm']) {
      try { await copyFile(path + ext, copy + ext, constants.COPYFILE_EXCL) } catch (err) { if (!missing(err)) throw err }
    }
    let db
    try {
      db = new DatabaseSync(copy, { readOnly: true })
    } catch {
      throw new ConnectorError('bad-response', { detail: 'not a readable database' })
    }
    try {
      return await fn(db)
    } finally {
      try { db.close() } catch { /* already closed */ }
    }
  } catch (err) {
    throw accessError(err)
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Column names of a table (empty when the table does not exist). */
export function columnsOf(db, table) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set()
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)))
}
