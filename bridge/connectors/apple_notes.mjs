/**
 * Apple Notes data connector (task C37; macOS local database, read-only).
 *
 * Same grant-local-access pattern as Apple Calendar and Contacts: the owner
 * reads what is read and why Full Disk Access is needed, ticks consent, and
 * JARVIS reads the Notes app's own database through the shared macOS helper
 * (macos-local.mjs): a private snapshot copy opened read-only, never the live
 * file, never written. Off macOS it reports itself unavailable. Written fresh;
 * no OpenJarvis code is reused.
 *
 * Database facts (Apple does not document the schema; checked against
 * community references on 2026-11-12, and verified at run time so an unknown
 * layout fails clearly instead of guessing):
 *   - ~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
 *   - notes, folders and attachments all live in ZICCLOUDSYNCINGOBJECT. A note
 *     has ZTITLE1, ZSNIPPET, ZIDENTIFIER, ZMODIFICATIONDATE1 (Core Data seconds
 *     since 2001-01-01 UTC), ZFOLDER, ZNOTEDATA, ZMARKEDFORDELETION,
 *     ZISPASSWORDPROTECTED and, when locked, ZCRYPTOINITIALIZATIONVECTOR.
 *     A folder has ZTITLE2 and ZFOLDERTYPE (1 = Recently Deleted).
 *   - the body is ZICNOTEDATA.ZDATA: gzip of a protobuf where field 2 is the
 *     document, its field 3 the note, and that note's field 2 the plain text.
 *     Only that one string is read; if it cannot be decoded the note's
 *     snippet is used instead.
 *
 * Locked notes (password protected) are skipped entirely, their text is never
 * read. Notes in Recently Deleted or marked for deletion are skipped. Only
 * local and iCloud notes are in this database and attachments are not read.
 *
 * Mapping (plan 38 Document): `note:<ZIDENTIFIER>`, title = note title,
 * sensitivity `personal`. At most 5 000 notes, 20 000 characters each.
 *
 * Sync: the cursor is a hash of the database's size and modified time (and
 * its -wal's), so nothing is re-read until Notes changed. Because the file
 * only changes when Notes writes, new notes appear after the next sync; the
 * card says so. Notes deleted since the last sync are not reported (a snapshot
 * has no change log); they leave with the retention setting or "erase synced
 * data". Fetched text is untrusted data (wrapped by the registry); no live
 * tool is offered.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ConnectorError } from './http.mjs'
import { columnsOf, ensureMac, explainAccess, findDatabase, isMac, withSnapshot } from './macos-local.mjs'

const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1)
const MAX_NOTES = 5_000
const MAX_TEXT = 20_000
const MAX_BLOB = 8 * 1024 * 1024 // compressed bytes read per note
const MAX_INFLATED = 4 * 1024 * 1024

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v === null || v === undefined || v === '' ? NaN : Number(v))
const coreToMs = (sec) => (Number.isFinite(sec) ? Math.round(CORE_DATA_EPOCH_MS + sec * 1000) : null)

export const notesDbPath = (home = homedir()) =>
  join(home, 'Library', 'Group Containers', 'group.com.apple.notes', 'NoteStore.sqlite')

/** Multi-line body text: control characters out (newlines and tabs kept), attachment placeholders out. */
export function cleanBody(s, max = MAX_TEXT) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[￼\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

/** Read one protobuf varint at `pos`; null when truncated or too long. */
function varint(buf, pos) {
  let x = 0
  let shift = 0
  for (let i = pos; i < buf.length && shift < 35; i++) {
    const b = buf[i]
    x += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) return { value: x, next: i + 1 }
    shift += 7
  }
  return null
}

/** First length-delimited field `field` in a protobuf message, or null. Other wire types are skipped safely. */
function lengthField(buf, field) {
  let pos = 0
  while (pos < buf.length) {
    const key = varint(buf, pos)
    if (!key) return null
    pos = key.next
    const no = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (wire === 0) {
      const v = varint(buf, pos)
      if (!v) return null
      pos = v.next
    } else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else if (wire === 2) {
      const len = varint(buf, pos)
      if (!len) return null
      const start = len.next
      const end = start + len.value
      if (end > buf.length) return null
      if (no === field) return buf.subarray(start, end)
      pos = end
    } else return null
  }
  return null
}

/**
 * The plain text of a note from its ZICNOTEDATA.ZDATA blob (gzip + protobuf),
 * or null when it cannot be decoded. Never throws; inflating is size-capped.
 */
export function decodeNoteText(blob) {
  try {
    if (!blob || blob.length === 0 || blob.length > MAX_BLOB) return null
    const raw = gunzipSync(Buffer.from(blob), { maxOutputLength: MAX_INFLATED })
    const doc = lengthField(raw, 2)
    const note = doc && lengthField(doc, 3)
    const text = note && lengthField(note, 2)
    return text ? text.toString('utf8') : null
  } catch {
    return null
  }
}

const NEED = ['Z_PK', 'ZIDENTIFIER', 'ZTITLE1', 'ZNOTEDATA']

/**
 * Read the notes from an open (snapshot) Notes database. Locked and deleted
 * notes are left out in the query, before any body is touched.
 * @returns {object[]} note records for `noteToDocument`
 */
export function readNotes(db, { limit = MAX_NOTES } = {}) {
  const obj = columnsOf(db, 'ZICCLOUDSYNCINGOBJECT')
  const data = columnsOf(db, 'ZICNOTEDATA')
  if (!NEED.every((c) => obj.has(c)) || !data.has('ZDATA') || !data.has('Z_PK')) {
    throw new ConnectorError('bad-response', { detail: 'unrecognised Notes database layout' })
  }
  const col = (c, alias = c) => (obj.has(c) ? `n.${c} AS ${alias}` : `NULL AS ${alias}`)
  const where = ['n.ZNOTEDATA IS NOT NULL', 'n.ZIDENTIFIER IS NOT NULL']
  if (obj.has('ZMARKEDFORDELETION')) where.push('COALESCE(n.ZMARKEDFORDELETION, 0) = 0')
  // Locked notes: skipped on either signal; their text is never read.
  if (obj.has('ZISPASSWORDPROTECTED')) where.push('COALESCE(n.ZISPASSWORDPROTECTED, 0) = 0')
  if (obj.has('ZCRYPTOINITIALIZATIONVECTOR')) where.push('n.ZCRYPTOINITIALIZATIONVECTOR IS NULL')
  let join = ''
  if (obj.has('ZFOLDER') && obj.has('ZFOLDERTYPE')) {
    join = 'LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER'
    where.push('COALESCE(f.ZFOLDERTYPE, 0) <> 1')
  }
  const folderTitle = join && obj.has('ZTITLE2') ? 'f.ZTITLE2 AS folder' : 'NULL AS folder'
  const rows = db.prepare(
    `SELECT n.Z_PK AS pk, ${col('ZIDENTIFIER', 'uid')}, ${col('ZTITLE1', 'title')}, ${col('ZSNIPPET', 'snippet')},
            ${col('ZMODIFICATIONDATE1', 'modified')}, ${folderTitle}, d.ZDATA AS body
     FROM ZICCLOUDSYNCINGOBJECT n
     JOIN ZICNOTEDATA d ON d.Z_PK = n.ZNOTEDATA
     ${join}
     WHERE ${where.join(' AND ')}
     ORDER BY n.Z_PK LIMIT ${Math.max(0, Math.floor(limit))}`,
  ).all()
  return rows.map((r) => ({
    uid: /^[A-Za-z0-9:._-]{4,120}$/.test(String(r.uid ?? '')) ? String(r.uid) : null,
    title: clean(r.title, 200),
    folder: clean(r.folder, 100),
    snippet: clean(r.snippet, 500),
    body: decodeNoteText(r.body),
    modifiedMs: coreToMs(num(r.modified)),
  }))
}

/**
 * One note to a document; null when it has no stable id or nothing to show.
 * @param {{ uid: string|null, title: string, folder: string, snippet: string, body: string|null, modifiedMs: number|null }} n
 */
export function noteToDocument(n, { now = Date.now } = {}) {
  if (!n?.uid) return null
  const body = cleanBody(n.body ?? n.snippet)
  const title = n.title || clean(body.split('\n')[0], 120)
  if (!title && !body) return null
  const lines = [`Title: ${title || '(untitled note)'}`]
  if (n.folder) lines.push(`Folder: ${n.folder}`)
  if (body) lines.push('', body)
  lines.push('', 'Source: Apple Notes')
  return {
    id: `note:${n.uid}`,
    title: title || '(untitled note)',
    text: lines.join('\n'),
    updatedAt: n.modifiedMs ?? now(),
    sensitivity: 'personal',
    meta: n.folder ? { folder: n.folder } : {},
  }
}

export function notesCursor({ g }) {
  return JSON.stringify({ v: 1, g })
}

export function parseNotesCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 200) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.g !== 'string' || !/^[0-9a-f]{32}$/.test(c.g)) return null
    return { g: c.g }
  } catch {
    return null
  }
}

const signatureOf = (db) => createHash('sha256').update(`${db.path}|${db.signature}`).digest('hex').slice(0, 32)

const SEES = [
  'Titles, folder names and the text of your notes (not pictures, scans, drawings or other attachments).',
  'Locked notes and notes in Recently Deleted are skipped; locked notes are never opened.',
  'Only notes kept on this Mac or in iCloud appear. New notes show up after the next sync, so the card shows when it last synced.',
  'JARVIS works on a private copy of the Notes database, deletes the copy right away, and never changes Notes.',
  'Needs Full Disk Access on a Mac; it does not work on Windows or Linux.',
  'Note text is treated as information, never as instructions.',
]

/** @param {{ home?: string, platform?: string }} [opts] */
export function appleNotesConnector({ home, platform } = {}) {
  const here = platform ?? process.platform
  return Object.freeze({
    id: 'apple_notes',
    create({ credentials, now }) {
      let lastSync

      const readAll = async (db) => {
        const seen = new Set()
        const docs = []
        for (const n of await withSnapshot(db.path, (d) => readNotes(d))) {
          const doc = noteToDocument(n, { now })
          if (!doc || seen.has(doc.id)) continue
          seen.add(doc.id)
          docs.push(doc)
        }
        return docs
      }

      return {
        id: 'apple_notes',
        name: 'Apple Notes',
        kind: 'data',
        auth: 'local',
        platforms: ['mac'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'personal',
        setup: {
          sees: SEES,
          localWhy: explainAccess({ app: 'Notes', reads: 'the titles and text of your notes', notReads: 'locked notes, your mail or other apps' }),
          steps: [
            'Open System Settings → Privacy & Security → Full Disk Access and turn it on for JARVIS (or the terminal that runs it). Restart JARVIS if you just did.',
            'Tick the box here and press Grant access.',
            'Press Test: JARVIS checks it can read Notes and shows only a count. Press Sync now after you write new notes.',
          ],
          testQuestion: 'What did I write in my shopping list note?',
        },

        /** Grant pattern: `{ confirmed: true }`. Stores a marker only when the database is readable. */
        async connect({ confirmed } = {}) {
          ensureMac(here)
          if (confirmed !== true) throw new ConnectorError('consent-denied', { detail: 'not confirmed' })
          const db = await findDatabase([notesDbPath(home)])
          await withSnapshot(db.path, (d) => {
            const obj = columnsOf(d, 'ZICCLOUDSYNCINGOBJECT')
            if (!NEED.every((c) => obj.has(c)) || !columnsOf(d, 'ZICNOTEDATA').has('ZDATA')) {
              throw new ConnectorError('bad-response', { detail: 'unrecognised Notes database layout' })
            }
          })
          credentials.set('granted', '1')
          lastSync = undefined
          return { account: 'This Mac', detail: 'Connected to the Notes app on this Mac (read-only, on a private copy).' }
        },

        async disconnect() {
          credentials.delete('granted')
          lastSync = undefined
        },

        status() {
          if (!isMac(here)) return { state: 'error', detail: 'Apple Notes only works on a Mac' }
          if (!credentials.get('granted')) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: 'Reading the Notes app on this Mac (read-only)' }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          ensureMac(here)
          const n = (await readAll(await findDatabase([notesDbPath(home)]))).length
          return { detail: `Apple Notes works: ${n} note${n === 1 ? '' : 's'} found (read-only, locked notes skipped).` }
        },

        async *sync({ cursor } = {}) {
          ensureMac(here)
          if (!credentials.get('granted')) throw new ConnectorError('not-connected')
          const db = await findDatabase([notesDbPath(home)])
          const g = signatureOf(db)
          if (parseNotesCursor(cursor)?.g === g) {
            lastSync = now()
            yield { cursor }
            return
          }
          for (const doc of await readAll(db)) yield doc
          yield { cursor: notesCursor({ g }) }
          lastSync = now()
        },
      }
    },
  })
}
