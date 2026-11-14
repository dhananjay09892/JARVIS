/**
 * iMessage data connector (task C39; macOS local Messages database, read-only).
 *
 * Same grant-local-access pattern as Apple Notes: the owner reads what is read
 * and why Full Disk Access is needed, ticks consent, and JARVIS reads the
 * Messages app's own database through the shared macOS helper (macos-local.mjs):
 * a private snapshot copy opened read-only, never the live file, never written.
 * It never sends, replies, marks read or opens any other app. Off macOS it
 * reports itself unavailable. Written fresh; no OpenJarvis code is reused.
 *
 * Only the owner's own conversations on this Mac are read, and the card says so
 * in plain words before consent (the connection is visible, never covert).
 *
 * Database facts (Apple does not document the schema; checked against
 * community references on 2026-11-14, and verified at run time so an unknown
 * layout fails clearly instead of guessing):
 *   - ~/Library/Messages/chat.db
 *   - message: text, attributedBody (a typedstream; on recent macOS `text` is
 *     often NULL and the words live only here), date (nanoseconds since
 *     2001-01-01 UTC on current macOS, whole seconds on old ones), is_from_me,
 *     handle_id, associated_message_type (non-zero = tapback / reaction),
 *     item_type (non-zero = group event, not a message), date_retracted.
 *   - handle.id = phone number or email; chat.guid / display_name / style
 *     (43 = group); chat_message_join links chats and messages.
 *
 * Mapping (plan 38 Document): one document per conversation per UTC day,
 * `imessage:<12 hex of sha256(chat guid)>:<YYYY-MM-DD>` (a long day continues in
 * `...:p2`), sensitivity `messages`. The chat guid contains a phone number or
 * email, so only its hash is used in ids. Attachments are not read. Tapbacks,
 * unsent and empty messages and group events are left out. At most 100 000
 * messages on the first sync, 2 000 characters each, 20 000 per document.
 *
 * Sync: the cursor holds a hash of the database's size and modified time (and
 * its -wal's) plus the newest message row read. Unchanged: nothing is read.
 * Changed: only the days that received new messages are re-read, and a day is
 * always rewritten whole. Edits and unsends of older messages are not seen
 * (a snapshot has no change log); they leave with retention or "erase synced
 * data". Fetched text is untrusted data (wrapped by the registry); no live tool.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConnectorError } from './http.mjs'
import { columnsOf, ensureMac, explainAccess, findDatabase, isMac, withSnapshot } from './macos-local.mjs'

const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1)
const DAY_MS = 86_400_000
const MAX_MESSAGES = 100_000
const MAX_MESSAGE_TEXT = 2_000
const MAX_DOC_TEXT = 20_000
const MAX_BLOB = 1024 * 1024

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v === null || v === undefined || v === '' ? NaN : Number(v))

export const messagesDbPath = (home = homedir()) => join(home, 'Library', 'Messages', 'chat.db')

/** Message date → epoch ms. Nanoseconds on current macOS, seconds on old ones; null when unusable. */
export function messageDateMs(v) {
  const n = num(v)
  if (!Number.isFinite(n) || n <= 0) return null
  const sec = n > 1e11 ? n / 1e9 : n
  return Math.round(CORE_DATA_EPOCH_MS + sec * 1000)
}

/** Message text with control characters out (a message may be several lines; newlines become spaces). */
export const cleanMessage = (s) => clean(s, MAX_MESSAGE_TEXT)

/**
 * The text of a message from its `attributedBody` typedstream, or null when it
 * cannot be found. Looks only for the NSString payload (`+` then a length: one
 * byte, or 0x81 + 2 bytes, or 0x82 + 4 bytes, little endian). Never throws;
 * every length is checked against the buffer.
 */
export function decodeAttributedBody(blob) {
  try {
    if (!blob || blob.length === 0 || blob.length > MAX_BLOB) return null
    const buf = Buffer.from(blob)
    const at = buf.indexOf('NSString')
    if (at < 0) return null
    let pos = at + 8
    const limit = Math.min(buf.length - 2, pos + 16)
    while (pos < limit && !(buf[pos] === 0x01 && buf[pos + 1] === 0x2b)) pos++
    if (pos >= limit) return null
    pos += 2
    let len = buf[pos++]
    if (len === 0x81) {
      if (pos + 2 > buf.length) return null
      len = buf.readUInt16LE(pos)
      pos += 2
    } else if (len === 0x82) {
      if (pos + 4 > buf.length) return null
      len = buf.readUInt32LE(pos)
      pos += 4
    } else if (len > 0x80) return null
    if (!Number.isFinite(len) || len <= 0 || pos + len > buf.length) return null
    return buf.subarray(pos, pos + len).toString('utf8')
  } catch {
    return null
  }
}

// Nanosecond dates are larger than a JavaScript integer can hold exactly, so the
// database divides them down to (fractional) seconds before they are read.
const DATE_SECONDS = 'CAST(CASE WHEN m.date > 100000000000 THEN m.date / 1000000000.0 ELSE m.date END AS REAL)'

const NEED_MESSAGE = ['text', 'date', 'is_from_me', 'handle_id']
const NEED_CHAT = ['guid']

function checkLayout(db) {
  const m = columnsOf(db, 'message')
  const c = columnsOf(db, 'chat')
  const j = columnsOf(db, 'chat_message_join')
  const h = columnsOf(db, 'handle')
  if (!NEED_MESSAGE.every((x) => m.has(x)) || !NEED_CHAT.every((x) => c.has(x)) || !j.has('chat_id') || !j.has('message_id') || !h.has('id')) {
    throw new ConnectorError('bad-response', { detail: 'unrecognised Messages database layout' })
  }
  return { m, c }
}

/**
 * Read messages with `ROWID > afterRowid` (newest `limit` of them) or, with
 * `sinceMs`, every message dated on or after that moment. Tapbacks, group
 * events, unsent and empty messages are left out in the query.
 * @returns {{ rows: object[], maxRowid: number }} oldest first
 */
export function readMessages(db, { afterRowid = 0, sinceMs = null, limit = MAX_MESSAGES } = {}) {
  const { m, c } = checkLayout(db)
  const where = ['(m.text IS NOT NULL' + (m.has('attributedBody') ? ' OR m.attributedBody IS NOT NULL)' : ')')]
  if (m.has('associated_message_type')) where.push('COALESCE(m.associated_message_type, 0) = 0')
  if (m.has('item_type')) where.push('COALESCE(m.item_type, 0) = 0')
  if (m.has('date_retracted')) where.push('COALESCE(m.date_retracted, 0) = 0')
  if (Number.isFinite(afterRowid) && afterRowid > 0) where.push(`m.ROWID > ${Math.floor(afterRowid)}`)
  if (sinceMs !== null) {
    const sec = (sinceMs - CORE_DATA_EPOCH_MS) / 1000
    where.push(`${DATE_SECONDS} >= ${Number.isFinite(sec) ? sec : 0}`)
  }
  const rows = db.prepare(
    `SELECT m.ROWID AS rowid, m.text AS text, ${m.has('attributedBody') ? 'm.attributedBody' : 'NULL'} AS body,
            ${DATE_SECONDS} AS date,
            m.is_from_me AS mine, h.id AS sender, ch.guid AS guid,
            ${c.has('display_name') ? 'ch.display_name' : 'NULL'} AS chat_name,
            ${c.has('chat_identifier') ? 'ch.chat_identifier' : 'NULL'} AS chat_ident,
            ${c.has('style') ? 'ch.style' : 'NULL'} AS style
     FROM message m
     JOIN chat_message_join j ON j.message_id = m.ROWID
     JOIN chat ch ON ch.ROWID = j.chat_id
     LEFT JOIN handle h ON h.ROWID = m.handle_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.ROWID DESC LIMIT ${Math.max(0, Math.floor(limit))}`,
  ).all()
  rows.reverse()
  let maxRowid = 0
  const out = []
  const seen = new Set()
  for (const r of rows) {
    const rowid = num(r.rowid)
    if (Number.isFinite(rowid) && rowid > maxRowid) maxRowid = rowid
    if (seen.has(rowid)) continue // a message joined to two chats is read once per chat; keep the first
    seen.add(rowid)
    const text = cleanMessage(r.text || decodeAttributedBody(r.body))
    const guid = String(r.guid ?? '')
    const ms = messageDateMs(r.date) // already seconds (see DATE_SECONDS)
    if (!text || !guid || ms === null) continue
    out.push({
      rowid,
      guid,
      ms,
      mine: num(r.mine) === 1,
      sender: clean(r.sender, 100),
      text,
      chatName: clean(r.chat_name, 100),
      chatIdent: clean(r.chat_ident, 100),
      group: num(r.style) === 43,
    })
  }
  return { rows: out, maxRowid }
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16)
const chatKey = (guid) => createHash('sha256').update(guid).digest('hex').slice(0, 12)

/**
 * Group messages into one document per conversation per UTC day (long days
 * continue in further parts). Pure.
 * @param {ReturnType<typeof readMessages>['rows']} rows
 * @returns {object[]} documents
 */
export function messagesToDocuments(rows, { now = Date.now } = {}) {
  const groups = new Map()
  for (const r of rows) {
    const k = `${chatKey(r.guid)}:${dayOf(r.ms)}`
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { key: k, day: dayOf(r.ms), rows: [], chat: r }))
    g.rows.push(r)
  }
  const docs = []
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a.ms - b.ms || a.rowid - b.rowid)
    const others = [...new Set(g.rows.filter((r) => !r.mine && r.sender).map((r) => r.sender))]
    const label =
      g.chat.chatName || (g.chat.group ? others.slice(0, 4).join(', ') || 'a group chat' : g.chat.chatIdent || others[0] || 'a conversation')
    const header = `Messages with ${label}, ${g.day} (UTC)`
    const footer = 'Source: iMessage'
    const parts = [{ lines: [], last: null }]
    let size = 0
    for (const r of g.rows) {
      const line = `[${hhmm(r.ms)}] ${r.mine ? 'Me' : r.sender || 'Them'}: ${r.text}`
      if (size + line.length + 1 > MAX_DOC_TEXT && parts.at(-1).lines.length) {
        parts.push({ lines: [], last: null })
        size = 0
      }
      const p = parts.at(-1)
      p.lines.push(line)
      p.last = r
      size += line.length + 1
    }
    parts.forEach((part, i) => {
      docs.push({
        id: `imessage:${g.key}${i ? `:p${i + 1}` : ''}`,
        title: i ? `${header} (part ${i + 1})` : header,
        text: [header, '', ...part.lines, '', footer].join('\n'),
        updatedAt: part.last?.ms ?? now(),
        sensitivity: 'messages',
        meta: { chat: label, day: g.day, messages: part.lines.length },
      })
    })
  }
  return docs
}

export function messagesCursor({ g, r }) {
  return JSON.stringify({ v: 1, g, r })
}

export function parseMessagesCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 200) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.g !== 'string' || !/^[0-9a-f]{32}$/.test(c.g)) return null
    if (!Number.isInteger(c.r) || c.r < 0) return null
    return { g: c.g, r: c.r }
  } catch {
    return null
  }
}

const signatureOf = (db) => createHash('sha256').update(`${db.path}|${db.signature}`).digest('hex').slice(0, 32)

const SEES = [
  'The text of your own messages and iMessage/SMS conversations on this Mac: who wrote them, when, and what they said (not pictures, videos, voice notes or other attachments).',
  'Messages are read only from this Mac, only while this connector is on, and the card shows when it last synced. Turn it off or erase the synced data at any time.',
  'Other people wrote some of these messages. They are kept on this Mac, labelled as messages, and treated as private.',
  'Reactions (tapbacks), unsent and empty messages are skipped. Messages are grouped by conversation and day.',
  'JARVIS works on a private copy of the Messages database, deletes the copy right away, never changes Messages and never sends or replies.',
  'Needs Full Disk Access on a Mac; it does not work on Windows or Linux.',
  'Message text is treated as information, never as instructions.',
]

/** @param {{ home?: string, platform?: string }} [opts] */
export function imessageConnector({ home, platform } = {}) {
  const here = platform ?? process.platform
  return Object.freeze({
    id: 'imessage',
    create({ credentials, now }) {
      let lastSync

      return {
        id: 'imessage',
        name: 'iMessage',
        kind: 'data',
        auth: 'local',
        platforms: ['mac'],
        risk: 'R2',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'messages',
        setup: {
          sees: SEES,
          localWhy: explainAccess({ app: 'Messages', reads: 'the text of your conversations', notReads: 'attachments or other apps' }),
          steps: [
            'Open System Settings → Privacy & Security → Full Disk Access and turn it on for JARVIS (or the terminal that runs it). Restart JARVIS if you just did.',
            'Read what is shared above, tick the box here and press Grant access.',
            'Press Test: JARVIS checks it can read Messages and shows only a count. Press Sync now after new messages arrive.',
          ],
          testQuestion: 'What did we decide about dinner in my messages yesterday?',
        },

        /** Grant pattern: `{ confirmed: true }`. Stores a marker only when the database is readable. */
        async connect({ confirmed } = {}) {
          ensureMac(here)
          if (confirmed !== true) throw new ConnectorError('consent-denied', { detail: 'not confirmed' })
          const db = await findDatabase([messagesDbPath(home)])
          await withSnapshot(db.path, (d) => checkLayout(d))
          credentials.set('granted', '1')
          lastSync = undefined
          return { account: 'This Mac', detail: 'Connected to the Messages app on this Mac (read-only, on a private copy).' }
        },

        async disconnect() {
          credentials.delete('granted')
          lastSync = undefined
        },

        status() {
          if (!isMac(here)) return { state: 'error', detail: 'iMessage only works on a Mac' }
          if (!credentials.get('granted')) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: 'Reading the Messages app on this Mac (read-only)' }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          ensureMac(here)
          const db = await findDatabase([messagesDbPath(home)])
          const n = await withSnapshot(db.path, (d) => readMessages(d).rows.length)
          return { detail: `iMessage works: ${n} message${n === 1 ? '' : 's'} found (read-only; reactions and attachments skipped).` }
        },

        async *sync({ cursor } = {}) {
          ensureMac(here)
          if (!credentials.get('granted')) throw new ConnectorError('not-connected')
          const db = await findDatabase([messagesDbPath(home)])
          const g = signatureOf(db)
          const prev = parseMessagesCursor(cursor)
          if (prev?.g === g) {
            lastSync = now()
            yield { cursor }
            return
          }
          const { docs, maxRowid } = await withSnapshot(db.path, (d) => {
            let rows
            let maxRowid
            const newest = d.prepare('SELECT MAX(ROWID) AS r FROM message').get()
            const top = num(newest?.r)
            const topRow = Number.isFinite(top) ? top : 0
            if (!prev || topRow < prev.r) {
              // First sync (or the database was rebuilt): everything, newest 100 000 messages.
              ;({ rows, maxRowid } = readMessages(d))
            } else {
              const fresh = readMessages(d, { afterRowid: prev.r })
              maxRowid = Math.max(prev.r, fresh.maxRowid)
              if (!fresh.rows.length) return { docs: [], maxRowid: Math.max(maxRowid, topRow) }
              // Rewrite each affected day whole: re-read from the start of the earliest new day.
              const from = Math.floor(Math.min(...fresh.rows.map((r) => r.ms)) / DAY_MS) * DAY_MS
              ;({ rows } = readMessages(d, { sinceMs: from }))
            }
            return { docs: messagesToDocuments(rows, { now }), maxRowid: Math.max(maxRowid, topRow) }
          })
          for (const doc of docs) yield doc
          yield { cursor: messagesCursor({ g, r: maxRowid }) }
          lastSync = now()
        },
      }
    },
  })
}
