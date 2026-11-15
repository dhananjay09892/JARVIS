/**
 * WhatsApp chat export data connector (task C40; files the owner exported).
 *
 * Grant-local-access pattern, no account: in WhatsApp the owner uses
 * Chat → More → Export chat (without media), puts the resulting `.txt` (Android)
 * or `.zip` (iPhone, holding `_chat.txt`) files in one folder, types that
 * folder's full path on the card and ticks "I understand what WhatsApp export
 * will read". Nothing is sent to or fetched from WhatsApp; the connector never
 * talks to the network and never sends a message. The only thing kept (in the
 * connector's credential slot, so Disconnect forgets it) is the folder's real path.
 *
 * What it reads, and nothing else:
 *   - Files ending .txt or .zip in that folder and up to 3 folders below it.
 *   - Never a symlink (file or folder), never a dot folder or dot file.
 *   - At most 500 files, 256 MB each. From a zip only one `.txt` entry is read,
 *     with a hard limit on how far it may inflate (no zip64, no encryption).
 *   - A file that is not a chat (no message lines) is skipped quietly.
 *   - Attachments are never opened: lines such as `<attached: IMG-1.jpg>` or
 *     `<Media omitted>`, deleted-message notices and system lines ("Messages are
 *     end-to-end encrypted", "X joined") are left out.
 *
 * Third parties' messages are inside these files, so the documents carry the
 * sensitivity class `messages` (kept local, shown to the brain by the policy
 * the owner set) and the card says so before consent.
 *
 * Export formats handled (WhatsApp does not document them; layouts below are
 * the common ones and several locales are covered by tests):
 *   Android  `31/12/2023, 21:41 - Alice: Hello`  or  `12/31/23, 9:41 PM - Alice: Hello`
 *   iPhone   `[31/12/2023, 21:41:05] Alice: Hello`
 *   A line without a timestamp continues the message before it. Separators
 *   `/ . -`, 12 or 24 hour clocks, left-to-right marks and narrow no-break
 *   spaces are all accepted. Day-first or month-first is decided per file from
 *   the dates themselves (a number above 12 settles it); when every date is
 *   ambiguous the file is read day-first. Exports carry no time zone, so times
 *   are kept as written and labelled "as written in the export".
 *
 * Mapping (plan 38 Document): one document per chat per day,
 * `whatsapp:<12 hex of sha256(chat name)>:<YYYY-MM-DD>` (a long day continues in
 * `...:p2`), sensitivity `messages`. The chat name comes from the file name
 * ("WhatsApp Chat with Alice.txt" → Alice); ids carry only its hash.
 *
 * Sync: the cursor holds, for each file, its size, modified time and the ids of
 * the documents it produced. Unchanged files are not read; a changed file is
 * parsed again, every day is rewritten and ids it no longer produces (for
 * example messages removed in a newer export) are deleted. Files that vanish,
 * or a different folder, delete what they produced. At most `maxPerSync` files
 * are read per run; the rest wait for the next run. Fetched text is untrusted
 * data (wrapped by the registry); there is no live tool.
 */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, parse as parsePath, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createInflateRaw } from 'node:zlib'
import { ConnectorError } from './http.mjs'
import { findZipEntry } from './apple_health.mjs'

const MAX_FILES = 500
const MAX_DEPTH = 3
const MAX_FILE_BYTES = 256 * 1024 ** 2
const MAX_INFLATED = 256 * 1024 ** 2
const MAX_RATIO = 400
const MAX_LINE = 20_000
const MAX_MESSAGES = 300_000
const MAX_MESSAGE_TEXT = 2_000
const MAX_DOC_TEXT = 20_000
const MAX_DOCS_PER_FILE = 3650
const MAX_TOTAL_DOCS = 100_000
const MAX_ID = 512
const MAX_CURSOR = 8_000_000

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const folderHash = (root) => createHash('sha256').update(root).digest('hex').slice(0, 16)
const chatKey = (name) => createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 12)
const isChatFile = (name) => ['.txt', '.zip'].includes(extname(name).toLowerCase())

/** Check a relative path coming from a cursor: no `..`, no dot segments, no control characters. */
export function safeExportPath(p) {
  if (typeof p !== 'string') return null
  const s = p.trim().replace(/\\/g, '/')
  if (!s || s.length > MAX_ID || /[\u0000-\u001f]/.test(s)) return null
  if (s.startsWith('/') || /^[a-z]:/i.test(s)) return null
  const parts = s.split('/')
  if (parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return null
  return parts.join('/')
}

// ---------------------------------------------------------------- parsing

const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g
const DATE = String.raw`(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})`
const TIME = String.raw`(\d{1,2}[:.]\d{2}(?::\d{2})?)\s*([AaPp]\.?\s?[Mm]\.?)?`
const BRACKET = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s?(.*)$`)
const DASH = new RegExp(String.raw`^${DATE},?\s+${TIME}\s+[-–—]\s+(.*)$`)

/** Words WhatsApp writes in place of media, deleted messages and similar. Not content. */
const NOT_CONTENT = [
  /^<attached: .*>$/i,
  /^<?\s*(?:[\p{L}]+(?: [\p{L}]+)?)\s+omitted\s*>?$/iu,
  /^(?:this message was deleted|you deleted this message|<this message was edited>)$/i,
  /^<media omitted>$/i,
  /^messages and calls are end-to-end encrypted\b/i,
  /^your security code with .* changed\b/i,
  /^null$/,
]

const cleanLine = (raw) => String(raw).replace(INVISIBLE, '').replace(/[   ]/g, ' ').replace(/\r$/, '')

/** One timestamp line to its pieces, or null when the line has none. */
function splitStamp(line) {
  const m = BRACKET.exec(line) ?? DASH.exec(line)
  if (!m) return null
  return { date: m[1], time: m[2], ampm: m[3] ?? '', rest: m[4] }
}

function dateParts(s) {
  const p = s.split(/[./-]/).map((x) => Number(x))
  if (p.length !== 3 || p.some((x) => !Number.isInteger(x))) return null
  if (String(s.split(/[./-]/)[0]).length === 4) return { ymd: [p[0], p[1], p[2]] }
  const year = p[2] < 100 ? 2000 + p[2] : p[2]
  return { a: p[0], b: p[1], year }
}

function clock(time, ampm) {
  const t = time.split(/[:.]/).map(Number)
  let h = t[0]
  const mi = t[1]
  const sec = t[2] ?? 0
  if (ampm) {
    const pm = /^p/i.test(ampm)
    if (h < 1 || h > 12) return null
    h = (h % 12) + (pm ? 12 : 0)
  }
  if (h > 23 || mi > 59 || sec > 59) return null
  return { h, mi, sec }
}

/**
 * A line-by-line parser. Feed lines with push(), then call finish().
 * Returns `{ messages: [{ ms, sender, text }], skipped }`, oldest first.
 * Never throws; a line it cannot read is part of the message above it, or
 * dropped when there is none.
 */
export function createChatParser() {
  const raw = []
  let cur = null
  let sawA = false // some day-first-only evidence: first number above 12
  let sawB = false // some month-first-only evidence: second number above 12
  let system = 0

  const flush = () => {
    if (!cur) return
    const text = cur.text.trim()
    if (cur.sender && text && !NOT_CONTENT.some((re) => re.test(text))) raw.push({ ...cur, text })
    else system++
    cur = null
  }

  return {
    push(line) {
      const l = cleanLine(line).slice(0, MAX_LINE)
      const st = splitStamp(l)
      const d = st ? dateParts(st.date) : null
      const c = st ? clock(st.time, st.ampm) : null
      if (!st || !d || !c) {
        if (cur && cur.text.length < MAX_MESSAGE_TEXT) cur.text += `\n${l}`
        return
      }
      flush()
      if (d.a !== undefined) {
        if (d.a > 12) sawA = true
        if (d.b > 12) sawB = true
      }
      const colon = st.rest.indexOf(': ')
      const sender = colon > 0 && colon <= 80 ? st.rest.slice(0, colon).trim() : ''
      const text = colon > 0 && colon <= 80 ? st.rest.slice(colon + 2) : st.rest
      cur = { d, c, sender, text }
      if (raw.length > MAX_MESSAGES * 1.2) raw.splice(0, raw.length - MAX_MESSAGES)
    },
    finish() {
      flush()
      const monthFirst = sawB && !sawA
      const messages = []
      for (const r of raw) {
        let y, mo, day
        if (r.d.ymd) [y, mo, day] = r.d.ymd
        else {
          y = r.d.year
          if (monthFirst) [mo, day] = [r.d.a, r.d.b]
          else [day, mo] = [r.d.a, r.d.b]
        }
        if (mo < 1 || mo > 12 || day < 1 || day > 31 || y < 2000 || y > 2100) { system++; continue }
        const ms = Date.UTC(y, mo - 1, day, r.c.h, r.c.mi, r.c.sec)
        const back = new Date(ms)
        if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== day) { system++; continue }
        messages.push({ ms, sender: clean(r.sender, 100), text: clean(r.text, MAX_MESSAGE_TEXT) })
      }
      messages.sort((a, b) => a.ms - b.ms)
      return { messages: messages.slice(-MAX_MESSAGES), skipped: system }
    },
  }
}

/** Parse a whole export held as a string (tests, small files). */
export function parseChatText(text) {
  const p = createChatParser()
  for (const line of String(text ?? '').split('\n')) p.push(line)
  return p.finish()
}

/** Parse byte chunks (a file or an inflating zip entry) without holding the file as one string. */
async function parseChunks(chunks) {
  const p = createChatParser()
  const decoder = new StringDecoder('utf8')
  let buf = ''
  for await (const chunk of chunks) {
    buf += decoder.write(chunk)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      p.push(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
    if (buf.length > MAX_LINE * 4) buf = buf.slice(0, MAX_LINE) // one enormous line: keep its start, drop the rest as it arrives
  }
  buf += decoder.end()
  if (buf) p.push(buf)
  return p.finish()
}

/** The chat's name from the export file name. */
export function chatNameFromFile(path) {
  const base = basename(path, extname(path))
  const name = base
    .replace(/^WhatsApp\s+Chat\s*(?:with|-|–|—|:)?\s*/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean(name, 100) || 'a chat'
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16)

/**
 * Messages of one chat to documents: one per day, long days in parts. Pure.
 * @param {{ ms: number, sender: string, text: string }[]} messages oldest first
 * @param {string} chat the chat's name
 */
export function messagesToDocuments(messages, chat, { now = Date.now } = {}) {
  const key = chatKey(chat)
  const days = new Map()
  for (const m of messages) {
    const d = dayOf(m.ms)
    if (!days.has(d)) days.set(d, [])
    days.get(d).push(m)
  }
  const docs = []
  for (const [day, rows] of days) {
    const header = `WhatsApp chat with ${chat}, ${day} (times as written in the export)`
    const parts = [{ lines: [], last: null, people: new Set() }]
    let size = 0
    for (const m of rows) {
      const line = `[${hhmm(m.ms)}] ${m.sender || 'Someone'}: ${m.text}`
      if (size + line.length + 1 > MAX_DOC_TEXT && parts.at(-1).lines.length) {
        parts.push({ lines: [], last: null, people: new Set() })
        size = 0
      }
      const p = parts.at(-1)
      p.lines.push(line)
      p.last = m
      if (m.sender) p.people.add(m.sender)
      size += line.length + 1
    }
    parts.forEach((p, i) => {
      docs.push({
        id: `whatsapp:${key}:${day}${i ? `:p${i + 1}` : ''}`,
        title: i ? `${header} (part ${i + 1})` : header,
        text: [header, '', ...p.lines, '', 'Source: WhatsApp chat export'].join('\n'),
        updatedAt: p.last?.ms ?? now(),
        sensitivity: 'messages',
        meta: { chat: chat.slice(0, 100), day, messages: p.lines.length, people: [...p.people].slice(0, 20).join(', ').slice(0, 500) },
      })
    })
  }
  return docs
}

// ---------------------------------------------------------------- the folder

/**
 * Check and resolve the folder the owner typed. Throws ConnectorError
 * 'folder-missing' with a developer detail when it is not usable.
 * @returns {Promise<string>} the folder's real path
 */
export async function resolveExportFolder(input, { home = homedir() } = {}) {
  let p = String(input ?? '').trim()
  if (!p) throw new ConnectorError('folder-missing', { detail: 'no folder given' })
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(home, p.slice(1))
  if (!isAbsolute(p)) throw new ConnectorError('folder-missing', { detail: 'the folder must be a full path' })
  let real
  try {
    real = await realpath(resolve(p))
    if (!(await stat(real)).isDirectory()) throw new Error('not a folder')
  } catch {
    throw new ConnectorError('folder-missing', { detail: 'folder not found or not a folder' })
  }
  let realHome = null
  try { realHome = await realpath(home) } catch { /* no home */ }
  if (real === parsePath(real).root || (realHome && real === realHome)) {
    throw new ConnectorError('folder-missing', { detail: 'pick the folder that holds the exports, not a whole drive or home folder' })
  }
  return real
}

/**
 * Every .txt / .zip file under the folder: `{ path, size, mtimeMs }`, sorted by
 * path. Skips symlinks, dot entries and files over the size limit.
 */
export async function listExportFiles(root, { maxFiles = MAX_FILES } = {}) {
  const out = []
  let truncated = false
  let tooBig = 0
  const walk = async (rel, depth) => {
    if (depth > MAX_DEPTH || out.length >= maxFiles) return
    let entries
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch (err) {
      if (!rel) throw err
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (out.length >= maxFiles) { truncated = true; return }
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { await walk(childRel, depth + 1); continue }
      if (!e.isFile() || !isChatFile(e.name) || childRel.length > MAX_ID) continue
      try {
        const s = await lstat(join(root, childRel))
        if (!s.isFile()) continue
        if (s.size > MAX_FILE_BYTES) { tooBig++; continue }
        out.push({ path: childRel, size: s.size, mtimeMs: Math.floor(s.mtimeMs) })
      } catch { /* vanished while walking */ }
    }
  }
  await walk('', 0)
  return { files: out, truncated, tooBig }
}

/** The inflated bytes of the first `.txt` entry of a zip, with a limit on how far it may inflate. */
async function* zipTextBytes(real, size) {
  const fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const e = await findZipEntry(fh, size, /\.txt$/i)
    if (e.size > MAX_INFLATED || (e.csize > 0 && e.size / e.csize > MAX_RATIO && e.size > 64 * 1024 * 1024)) {
      throw new ConnectorError('bad-response', { detail: 'the chat inside the zip is larger than the limit' })
    }
    if (e.csize === 0) return
    const raw = createReadStream(real, { start: e.offset, end: Math.max(e.offset, e.offset + e.csize - 1), flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })
    if (e.method === 0) { yield* raw; return }
    const inflate = createInflateRaw()
    raw.on('error', (err) => inflate.destroy(err))
    raw.pipe(inflate)
    let out = 0
    try {
      for await (const chunk of inflate) {
        out += chunk.length
        if (out > e.size + 1024 || out > MAX_INFLATED) throw new ConnectorError('bad-response', { detail: 'the zip inflates beyond its declared size' })
        yield chunk
      }
    } catch (err) {
      if (err instanceof ConnectorError) throw err
      throw new ConnectorError('bad-response', { detail: 'damaged zip data' })
    } finally {
      raw.destroy()
      inflate.destroy()
    }
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * Read and parse one export file, refusing anything outside the folder.
 * Returns `{ messages, skipped }` or `{ refused: reason }`.
 */
export async function readExportFile(root, rel) {
  const safe = safeExportPath(rel)
  if (!safe || !isChatFile(safe)) return { refused: 'not an export file path' }
  const full = join(root, ...safe.split('/'))
  let real
  let s
  try {
    real = await realpath(full)
    s = await lstat(full)
  } catch {
    return { refused: 'no such file' }
  }
  if (real !== full) return { refused: 'a link, which JARVIS does not follow' }
  if (!s.isFile()) return { refused: 'not a file' }
  if (s.size > MAX_FILE_BYTES) return { refused: 'too large' }
  try {
    const chunks = safe.toLowerCase().endsWith('.zip')
      ? zipTextBytes(full, s.size)
      : createReadStream(full, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })
    return await parseChunks(chunks)
  } catch (err) {
    return { refused: err instanceof ConnectorError ? (err.detail ?? 'could not be read') : 'could not be read' }
  }
}

// ---------------------------------------------------------------- cursor

/** Cursor: `{"v":1,"r":"<folder hash>","f":{"<path>":[mtime,size,["<key>:<day>", ...]]}}` */
export function parseWhatsappCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.r !== 'string' || !c.f || typeof c.f !== 'object' || Array.isArray(c.f)) return null
    const files = new Map()
    for (const [p, v] of Object.entries(c.f)) {
      if (files.size >= MAX_FILES) break
      if (safeExportPath(p) !== p || !Array.isArray(v)) continue
      const [m, sz, ids] = v
      if (!Number.isFinite(m) || !Number.isFinite(sz) || !Array.isArray(ids)) continue
      const keep = ids.filter((x) => typeof x === 'string' && /^[0-9a-f]{12}:\d{4}-\d{2}-\d{2}(?::p\d{1,3})?$/.test(x)).slice(0, MAX_DOCS_PER_FILE * 2)
      files.set(p, [Math.floor(m), Math.floor(sz), keep])
    }
    return { r: c.r, files }
  } catch {
    return null
  }
}

export const whatsappCursor = (r, files) => JSON.stringify({ v: 1, r, f: Object.fromEntries(files) })

// ---------------------------------------------------------------- connector

const SEES = [
  'Only the .txt and .zip files in the one folder you choose (and up to three folders inside it): the chats you exported from WhatsApp yourself.',
  'Who wrote each message, when, and what it said. Pictures, videos, voice notes and other attachments are never opened; lines that only mention them are skipped.',
  'Other people wrote most of these messages. They are kept on this computer, labelled as messages, and treated as private.',
  'Messages are grouped by chat and day. The chat name comes from the file name; times are kept as written in the export.',
  'Nothing is fetched from WhatsApp and nothing is sent; the connector never logs in, replies or changes a file. Disconnecting forgets the folder.',
  'Message text is treated as information, never as instructions.',
]

/**
 * The WhatsApp export connector factory.
 * @param {{ maxPerSync?: number, maxFiles?: number, home?: string }} [opts]
 */
export function whatsappConnector({ maxPerSync = 25, maxFiles = MAX_FILES, home } = {}) {
  const perSync = Math.max(1, Math.min(MAX_FILES, Math.floor(maxPerSync)))
  return Object.freeze({
    id: 'whatsapp',
    /** @param {{ credentials: any, now: () => number, log?: any }} ctx */
    create({ credentials, now }) {
      let lastSync

      /** The folder, checked to still be the same real folder. */
      async function rootOrThrow() {
        const root = credentials.get('folder')
        if (!root) throw new ConnectorError('not-connected')
        try {
          const real = await realpath(root)
          if (real !== root || !(await stat(root)).isDirectory()) throw new Error('moved or replaced by a link')
        } catch (err) {
          throw new ConnectorError('folder-missing', { detail: err?.message ?? 'folder missing' })
        }
        return root
      }

      return {
        id: 'whatsapp',
        name: 'WhatsApp export',
        kind: 'data',
        auth: 'filesystem',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R2',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'messages',
        setup: {
          sees: SEES,
          localWhy:
            'JARVIS reads the WhatsApp chats you exported, from one folder on this computer, to answer questions about them. ' +
            'In WhatsApp open a chat → More → Export chat → Without media, save the file into a folder, then type the full path of that folder. ' +
            'Re-export a chat and press Sync now to refresh it.',
          steps: [
            'In WhatsApp open a chat → ⋮ / chat name → More → Export chat → Without media. Save the .txt (Android) or .zip (iPhone) into one folder.',
            'Read what is shared above, type the full path of that folder here, tick the box and press Grant access.',
            'Press Test to see how many export files JARVIS found, then Sync now. Export a chat again later and press Sync now to update it.',
          ],
          testQuestion: 'What did we agree about the trip in the family group chat?',
        },

        /** Grant pattern: `{ confirmed: true, path }`. Stores nothing unless the folder is usable. */
        async connect({ confirmed, path } = {}) {
          if (confirmed !== true) throw new ConnectorError('consent-denied', { detail: 'not confirmed' })
          const root = await resolveExportFolder(path, home ? { home } : {})
          credentials.set('folder', root)
          lastSync = undefined
          const name = clean(basename(root), 100)
          return { account: name, detail: `Connected to the folder "${name}" (read-only; WhatsApp is never contacted).` }
        },

        async disconnect() {
          credentials.delete('folder')
          lastSync = undefined
        },

        status() {
          const root = credentials.get('folder')
          if (!root) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: `Reading chat exports in "${clean(basename(root), 100)}" (read-only)` }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          const root = await rootOrThrow()
          const { files, truncated, tooBig } = await listExportFiles(root, { maxFiles })
          const name = clean(basename(root), 100)
          const extra = tooBig ? ` ${tooBig} file${tooBig === 1 ? ' is' : 's are'} too large and will be skipped.` : ''
          return {
            detail: files.length
              ? `WhatsApp export works: ${files.length}${truncated ? '+' : ''} export file${files.length === 1 ? '' : 's'} (.txt or .zip) in "${name}" (read-only).${extra}`
              : `WhatsApp export works, but "${name}" has no .txt or .zip files yet. Export a chat into it and press Sync now.${extra}`,
          }
        },

        async *sync({ cursor } = {}) {
          const root = await rootOrThrow()
          const r = folderHash(root)
          const state = parseWhatsappCursor(cursor)
          const toId = (suffix) => `whatsapp:${suffix}`
          const gone = new Set()
          let prev = new Map()
          if (state && state.r !== r) {
            // Another folder was synced before: what it produced leaves the store
            // (unless this folder produces the same id again; see the end).
            for (const [, v] of state.files) for (const id of v[2]) gone.add(id)
          } else if (state) {
            prev = state.files
          }

          const { files, truncated } = await listExportFiles(root, { maxFiles })
          const current = new Map(files.map((f) => [f.path, f]))
          const next = new Map()
          // Files that disappeared (kept when the walk was cut short: they may be past the cap).
          for (const [p, v] of prev) {
            if (current.has(p)) continue
            if (truncated) next.set(p, v)
            else for (const id of v[2]) gone.add(id)
          }

          const changed = []
          for (const f of files) {
            const old = prev.get(f.path)
            if (old && old[0] === f.mtimeMs && old[1] === f.size) next.set(f.path, old)
            else changed.push(f)
          }
          changed.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))

          let total = 0
          for (const v of next.values()) total += v[2].length
          const batch = changed.slice(0, perSync)
          for (let i = 0; i < batch.length; i++) {
            const f = batch[i]
            const old = prev.get(f.path)
            const got = await readExportFile(root, f.path)
            let ids = []
            if (!got.refused && got.messages.length) {
              const docs = messagesToDocuments(got.messages, chatNameFromFile(f.path), { now })
              const kept = docs.slice(-MAX_DOCS_PER_FILE)
              if (total + kept.length > MAX_TOTAL_DOCS) continue // over the budget: not recorded, so not silently lost
              for (const doc of kept) {
                yield doc
                ids.push(doc.id.slice('whatsapp:'.length))
              }
              total += kept.length
            } else ids = []
            // A file that is not a chat, or could not be read, is remembered (so it is not re-read until it changes).
            next.set(f.path, [f.mtimeMs, f.size, ids])
            if (old) for (const id of old[2]) if (!ids.includes(id)) gone.add(id)
            if ((i + 1) % 10 === 0 && i + 1 < batch.length) yield { cursor: whatsappCursor(r, next) }
          }
          // Deletions: only ids no remaining file still produces (two files can be the same
          // chat, and the store applies saves before deletions, so a re-saved id must not be listed).
          const live = new Set()
          for (const v of next.values()) for (const id of v[2]) live.add(id)
          for (const id of gone) if (!live.has(id)) yield { deleted: toId(id) }
          yield { cursor: whatsappCursor(r, next) }
          lastSync = now()
        },
      }
    },
  })
}
