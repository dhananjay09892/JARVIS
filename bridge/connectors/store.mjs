/**
 * The local connector document store (task C02).
 *
 * Where the documents a data connector syncs are kept until plans 07/33 bring
 * semantic search: one SQLite file (node:sqlite, no dependency) with a keyword
 * index (FTS5), keyed by connector. It is the `onErase` target of the
 * registry, so Disconnect → Erase data really erases.
 *
 * What it keeps, and how:
 *
 *   - Only what the registry hands out. `ingest()` takes the result of
 *     `registry.sync()`, whose documents are already validated and wrapped as
 *     untrusted; the store keeps the envelope's body (hidden characters
 *     stripped, control tags defanged) and wraps again on the way out through
 *     the documents connector (documents.mjs). Nothing the store returns to a
 *     brain is ever unwrapped.
 *   - Text runs through the same secret filter as memory before it touches
 *     disk, so a password-reset code in a synced mail is not kept verbatim.
 *   - A sensitivity class per document (interface.mjs SENSITIVITY_CLASSES).
 *     `search()` can include or exclude classes; the documents connector keeps
 *     the vault classes (health, finance) out of results unless the owner
 *     allows it.
 *   - Retention: every class has a default number of days (shorter for other
 *     people's messages, health, finance and location), changeable per
 *     connector. `prune()` runs on open and after every ingest.
 *   - Deletions (task C96): a sync can report items that are gone at the
 *     source; `ingest()` removes this connector's copy of each one outright
 *     (no tombstone text kept, `secure_delete` overwrites the pages). A
 *     deletion tagged with another connector's id is skipped.
 *   - Erase per connector: rows, index entries and the sync cursor, with
 *     `secure_delete` on so the pages are overwritten, not just unlinked. The
 *     owner's retention choice for that connector is a setting and stays.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONNECTOR_ID, SENSITIVITY_CLASSES } from './interface.mjs'
import { redact, defaultMemoryDir } from '../memory.mjs'

const DAY = 24 * 60 * 60 * 1000

/** Days a document is kept after its last change, per sensitivity class. */
export const DEFAULT_RETENTION_DAYS = Object.freeze({
  public: 365,
  personal: 365,
  work: 365,
  contacts: 365,
  messages: 90,
  finance: 90,
  health: 90,
  location: 30,
})

const MAX_TEXT = 200_000
const MAX_SNIPPET = 400
const MAX_READ = 20_000
const MAX_LIMIT = 50

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_documents (
  id INTEGER PRIMARY KEY,
  connector_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  sensitivity TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  UNIQUE (connector_id, doc_id)
);
CREATE INDEX IF NOT EXISTS connector_documents_age ON connector_documents (connector_id, sensitivity, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS connector_documents_fts USING fts5(
  title, text, author, content='connector_documents', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS connector_documents_ai AFTER INSERT ON connector_documents BEGIN
  INSERT INTO connector_documents_fts (rowid, title, text, author) VALUES (new.id, new.title, new.text, new.author);
END;
CREATE TRIGGER IF NOT EXISTS connector_documents_ad AFTER DELETE ON connector_documents BEGIN
  INSERT INTO connector_documents_fts (connector_documents_fts, rowid, title, text, author)
    VALUES ('delete', old.id, old.title, old.text, old.author);
END;
CREATE TRIGGER IF NOT EXISTS connector_documents_au AFTER UPDATE ON connector_documents BEGIN
  INSERT INTO connector_documents_fts (connector_documents_fts, rowid, title, text, author)
    VALUES ('delete', old.id, old.title, old.text, old.author);
  INSERT INTO connector_documents_fts (rowid, title, text, author) VALUES (new.id, new.title, new.text, new.author);
END;
CREATE TABLE IF NOT EXISTS connector_state (
  connector_id TEXT PRIMARY KEY,
  cursor TEXT,
  last_sync INTEGER,
  retention_days INTEGER
);
`

const ENVELOPE = /^<untrusted_data\b[^>\n]*>\n([\s\S]*)\n<\/untrusted_data>$/

/**
 * The body of an untrusted envelope, or null when the text is not one. The
 * store only accepts wrapped text: that is proof it came through the registry
 * (hidden characters stripped, control tags defanged).
 */
export function envelopeBody(text) {
  const m = ENVELOPE.exec(String(text ?? ''))
  if (!m || /<\s*\/\s*untrusted_data/i.test(m[1])) return null
  return m[1]
}

const clean = (s, max) => redact(String(s ?? '')).text.slice(0, max)

/**
 * A keyword query for FTS5: words of 2+ letters or digits, each quoted (so
 * nothing in the query is FTS syntax), prefix-matched. `all` joins with AND.
 */
export function documentQuery(text, { all = true } = {}) {
  const words = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
  const unique = [...new Set(words)].slice(0, 10)
  if (!unique.length) return null
  return unique.map((w) => `"${w}"*`).join(all ? ' AND ' : ' OR ')
}

const checkId = (id) => {
  if (typeof id !== 'string' || !CONNECTOR_ID.test(id)) throw new Error(`Bad connector id: ${String(id)}`)
}
const checkClasses = (list, what) => {
  if (list === undefined) return undefined
  if (!Array.isArray(list) || !list.every((c) => SENSITIVITY_CLASSES.includes(c))) {
    throw new Error(`${what} must be sensitivity classes from ${SENSITIVITY_CLASSES.join(', ')}`)
  }
  return list
}
const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ')

/**
 * @param {{
 *   file?: string,                 a SQLite path (':memory:' in tests)
 *   dir?: string,                  where jarvis-connectors.sqlite goes otherwise
 *   now?: () => number,
 *   retentionDays?: Partial<Record<string, number>>,   overrides DEFAULT_RETENTION_DAYS
 * }} [opts]
 */
export function openDocumentStore({ file, dir = defaultMemoryDir(), now = Date.now, retentionDays = {} } = {}) {
  let path = file
  if (!path) {
    mkdirSync(dir, { recursive: true })
    path = join(dir, 'jarvis-connectors.sqlite')
  }
  const retention = { ...DEFAULT_RETENTION_DAYS }
  for (const [k, v] of Object.entries(retentionDays)) {
    if (SENSITIVITY_CLASSES.includes(k) && Number.isInteger(v) && v > 0) retention[k] = v
  }

  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;')
  db.exec(SCHEMA)

  const q = {
    upsert: db.prepare(`
      INSERT INTO connector_documents (connector_id, doc_id, title, text, author, url, sensitivity, created_at, updated_at, synced_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (connector_id, doc_id) DO UPDATE SET
        title = excluded.title, text = excluded.text, author = excluded.author, url = excluded.url,
        sensitivity = excluded.sensitivity, created_at = excluded.created_at, updated_at = excluded.updated_at,
        synced_at = excluded.synced_at, meta = excluded.meta
      WHERE excluded.updated_at >= connector_documents.updated_at`),
    get: db.prepare('SELECT * FROM connector_documents WHERE connector_id = ? AND doc_id = ?'),
    eraseDocs: db.prepare('DELETE FROM connector_documents WHERE connector_id = ?'),
    deleteDoc: db.prepare('DELETE FROM connector_documents WHERE connector_id = ? AND doc_id = ?'),
    // Erase forgets the cursor and last sync but keeps the owner's retention
    // choice: that is a setting, not synced data.
    eraseState: db.prepare('DELETE FROM connector_state WHERE connector_id = ? AND retention_days IS NULL'),
    eraseCursor: db.prepare('UPDATE connector_state SET cursor = NULL, last_sync = NULL WHERE connector_id = ?'),
    state: db.prepare('SELECT * FROM connector_state WHERE connector_id = ?'),
    saveState: db.prepare(`
      INSERT INTO connector_state (connector_id, cursor, last_sync) VALUES (?, ?, ?)
      ON CONFLICT (connector_id) DO UPDATE SET cursor = excluded.cursor, last_sync = excluded.last_sync`),
    saveRetention: db.prepare(`
      INSERT INTO connector_state (connector_id, retention_days) VALUES (?, ?)
      ON CONFLICT (connector_id) DO UPDATE SET retention_days = excluded.retention_days`),
    customRetention: db.prepare('SELECT connector_id, retention_days FROM connector_state WHERE retention_days IS NOT NULL'),
    pruneClass: db.prepare('DELETE FROM connector_documents WHERE sensitivity = ? AND updated_at < ? AND connector_id NOT IN (SELECT connector_id FROM connector_state WHERE retention_days IS NOT NULL)'),
    pruneConnector: db.prepare('DELETE FROM connector_documents WHERE connector_id = ? AND updated_at < ?'),
    stats: db.prepare(`
      SELECT connector_id, sensitivity, COUNT(*) AS n, MAX(updated_at) AS newest
      FROM connector_documents GROUP BY connector_id, sensitivity ORDER BY connector_id, sensitivity`),
  }

  const tx = (fn) => {
    db.exec('BEGIN')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /** One stored row as the store hands it out: body text, never wrapped here. */
  const rowOut = (r, { text } = {}) => ({
    connectorId: r.connector_id,
    id: r.doc_id,
    ...(r.title ? { title: r.title } : {}),
    ...(r.author ? { author: r.author } : {}),
    ...(r.url ? { url: r.url } : {}),
    sensitivity: r.sensitivity,
    ...(r.created_at !== null ? { createdAt: r.created_at } : {}),
    updatedAt: r.updated_at,
    syncedAt: r.synced_at,
    ...(text !== undefined ? { text } : {}),
  })

  const store = {
    path,

    /**
     * Keep documents a registry sync returned for one connector. Each must be
     * the registry's own output (wrapped text, matching connectorId); anything
     * else is skipped and counted. Returns `{ saved, skipped }`.
     */
    save(connectorId, documents) {
      checkId(connectorId)
      let saved = 0
      let skipped = 0
      const at = now()
      tx(() => {
        for (const d of documents ?? []) {
          const body = d && d.connectorId === connectorId && d.untrusted === true ? envelopeBody(d.text) : null
          if (body === null || typeof d.id !== 'string' || !SENSITIVITY_CLASSES.includes(d.sensitivity)
              || !Number.isFinite(d.updatedAt)) {
            skipped++
            continue
          }
          const meta = d.meta && typeof d.meta === 'object' ? JSON.stringify(d.meta).slice(0, 8000) : '{}'
          q.upsert.run(
            connectorId, d.id.slice(0, 512), clean(d.title, 500), clean(body, MAX_TEXT), clean(d.author, 200),
            typeof d.url === 'string' ? d.url.slice(0, 2048) : '', d.sensitivity,
            Number.isFinite(d.createdAt) ? d.createdAt : null, d.updatedAt, at, meta,
          )
          saved++
        }
      })
      return { saved, skipped }
    },

    /**
     * Remove documents a sync reported as gone at the source. Each entry is a
     * registry deletion `{ connectorId, id }`; one tagged with another
     * connector is skipped, so a connector can never remove another's
     * documents. Returns `{ removed, skipped }` (removed counts rows that
     * existed).
     */
    remove(connectorId, deletions) {
      checkId(connectorId)
      let removed = 0
      let skipped = 0
      tx(() => {
        for (const d of deletions ?? []) {
          if (!d || d.connectorId !== connectorId || typeof d.id !== 'string' || !d.id || d.id.length > 512) {
            skipped++
            continue
          }
          removed += Number(q.deleteDoc.run(connectorId, d.id).changes)
        }
      })
      return { removed, skipped }
    },

    /**
     * Keep a whole `registry.sync()` result: its documents and deletions, and
     * its cursor and time when the sync succeeded, then prune. A failed sync
     * keeps nothing, removes nothing and leaves the old cursor, so the next
     * sync resumes from there.
     */
    ingest(connectorId, result) {
      checkId(connectorId)
      if (!result?.ok) return { saved: 0, skipped: 0, removed: 0, ok: false }
      const counts = store.save(connectorId, result.documents)
      const gone = store.remove(connectorId, result.deleted)
      q.saveState.run(connectorId, typeof result.cursor === 'string' ? result.cursor : null, now())
      store.prune()
      return { saved: counts.saved, skipped: counts.skipped + gone.skipped, removed: gone.removed, ok: true }
    },

    /** Where the next sync of this connector resumes: `{ cursor, lastSync }`. */
    state(connectorId) {
      checkId(connectorId)
      const r = q.state.get(connectorId)
      return { cursor: r?.cursor ?? null, lastSync: r?.last_sync ?? null, retentionDays: r?.retention_days ?? null }
    },

    /**
     * Keyword search. Ranked by FTS5; all words must match, and if nothing
     * does, any word may. Filters: connector ids, classes to include, classes
     * to exclude. Returns snippets, not whole documents.
     *
     * @param {string} query
     * @param {{ connectors?: string[], classes?: string[], excludeClasses?: string[], limit?: number }} [opts]
     */
    search(query, { connectors, classes, excludeClasses, limit = 10 } = {}) {
      checkClasses(classes, 'classes')
      checkClasses(excludeClasses, 'excludeClasses')
      if (connectors !== undefined) {
        if (!Array.isArray(connectors)) throw new Error('connectors must be a list of connector ids')
        connectors.forEach(checkId)
        if (!connectors.length) return []
      }
      if (classes && !classes.length) return []
      const n = Math.max(1, Math.min(MAX_LIMIT, Number.isInteger(limit) ? limit : 10))
      const where = []
      const args = []
      if (connectors) {
        where.push(`d.connector_id IN (${placeholders(connectors.length)})`)
        args.push(...connectors)
      }
      if (classes) {
        where.push(`d.sensitivity IN (${placeholders(classes.length)})`)
        args.push(...classes)
      }
      if (excludeClasses?.length) {
        where.push(`d.sensitivity NOT IN (${placeholders(excludeClasses.length)})`)
        args.push(...excludeClasses)
      }
      const sql = `SELECT d.*, snippet(connector_documents_fts, 1, '', '', ' … ', 40) AS snip
        FROM connector_documents_fts f JOIN connector_documents d ON d.id = f.rowid
        WHERE connector_documents_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
        ORDER BY rank LIMIT ?`
      const run = (match) => db.prepare(sql).all(match, ...args, n)
      for (const all of [true, false]) {
        const match = documentQuery(query, { all })
        if (!match) return []
        const rows = run(match)
        if (rows.length || !all) {
          return rows.map((r) => ({ ...rowOut(r), snippet: String(r.snip ?? '').slice(0, MAX_SNIPPET) }))
        }
      }
      return []
    },

    /** One document with its text (capped), or null. */
    get(connectorId, docId) {
      checkId(connectorId)
      const r = q.get.get(connectorId, String(docId ?? ''))
      if (!r) return null
      const truncated = r.text.length > MAX_READ
      return { ...rowOut(r, { text: truncated ? r.text.slice(0, MAX_READ) : r.text }), truncated }
    },

    /** Erase everything kept for one connector: documents, index, cursor. */
    erase(connectorId) {
      checkId(connectorId)
      return tx(() => {
        const { changes } = q.eraseDocs.run(connectorId)
        q.eraseState.run(connectorId)
        q.eraseCursor.run(connectorId)
        return { erased: Number(changes) }
      })
    },

    /** Keep this connector's documents for `days` (null goes back to the class defaults). */
    setRetention(connectorId, days) {
      checkId(connectorId)
      if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 3650)) {
        throw new Error('Retention must be a whole number of days from 1 to 3650, or null.')
      }
      q.saveRetention.run(connectorId, days)
      return store.prune()
    },

    /**
     * Keep documents of one sensitivity class for `days` (null goes back to
     * DEFAULT_RETENTION_DAYS). Connectors with their own retention keep it.
     * Prunes at once, so a shorter retention deletes now; returns how many went.
     */
    setClassRetention(cls, days) {
      if (!SENSITIVITY_CLASSES.includes(cls)) throw new Error(`Unknown sensitivity class: ${String(cls)}`)
      if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 3650)) {
        throw new Error('Retention must be a whole number of days from 1 to 3650, or null.')
      }
      retention[cls] = days === null ? DEFAULT_RETENTION_DAYS[cls] : days
      return store.prune()
    },

    /**
     * The retention in force: days per class, and the connectors that have
     * their own (`{ connectorId: days }`).
     */
    retention() {
      const connectors = {}
      for (const r of q.customRetention.all()) connectors[r.connector_id] = Number(r.retention_days)
      return { classes: { ...retention }, connectors }
    },

    /** Delete documents older than their retention. Returns how many went. */
    prune() {
      const t = now()
      return tx(() => {
        let removed = 0
        for (const [cls, days] of Object.entries(retention)) {
          removed += Number(q.pruneClass.run(cls, t - days * DAY).changes)
        }
        for (const r of q.customRetention.all()) {
          removed += Number(q.pruneConnector.run(r.connector_id, t - r.retention_days * DAY).changes)
        }
        return removed
      })
    },

    /** Counts per connector and class, for Settings and the Privacy Centre. Never any text. */
    stats() {
      const out = {}
      for (const r of q.stats.all()) {
        const s = (out[r.connector_id] ??= { total: 0, classes: {}, newest: 0 })
        s.total += Number(r.n)
        s.classes[r.sensitivity] = Number(r.n)
        s.newest = Math.max(s.newest, Number(r.newest))
      }
      return out
    },

    close() {
      db.close()
    },
  }

  store.prune()
  return store
}
