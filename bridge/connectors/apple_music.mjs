/**
 * Apple Music data connector (task C38; library export file, read-only).
 *
 * Grant-local-access pattern, the same shape as Apple Health: the owner makes
 * a library export in the Music app (File → Library → Export Library…, also
 * in iTunes on Windows), types the full path of that `.xml` file and ticks
 * consent. No network, no credential, no AppleScript and no Automation or
 * Full Disk Access permission; the only thing kept (in the credential slot, so
 * Disconnect forgets it) is the file's real path. Because it is one plain
 * file, this works on every system, not only on a Mac. Written fresh; no
 * OpenJarvis code is reused.
 *
 * Why the export file and not the Music app itself: the app's own library
 * file is not a database that can be read, and driving the app with
 * AppleScript needs Automation rights and a script interpreter. A file the
 * owner exports is read-only by construction.
 *
 * Reading the file safely:
 *   - One `.xml` file, never a symlink (opened with O_NOFOLLOW and the real
 *     path must equal the stored path), with a size limit.
 *   - The export is a property list that can be hundreds of megabytes, so it
 *     is stream-parsed in chunks and never loaded whole. Only the `Tracks`
 *     part is read; reading stops there, so playlists are never looked at.
 *     No XML parser is used, so DOCTYPE entities and external references are
 *     never expanded.
 *   - Only a fixed list of track fields is kept. The `Location` field (where
 *     a song file lives on disk) is never kept.
 *
 * Mapping (plan 38 Document):
 *   track:<Persistent ID>  one song: artist, album, genre, year, length, play
 *                          and skip counts, last played, added, rating
 *   summary:library        totals, most played artists and songs, last played
 * Films, TV shows and podcasts are left out. At most the 10 000 most recently
 * played or added songs become documents. Sensitivity `personal`.
 *
 * Sync: the export is a snapshot. If the file's size and modified time match
 * the cursor nothing is read. Otherwise it is parsed again and only songs
 * played or added since the newest one seen before are yielded, plus the
 * summary. Cursor: `{"v":1,"r":"<hash of the path>","m":<mtime>,"s":<size>,
 * "t":<newest played/added ms>}`. A rating changed without a play is picked
 * up only after "erase synced data" and a fresh sync. The adapter never
 * reports deletions. Fetched text is untrusted data (wrapped by the
 * registry); no live tool is offered.
 */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { resolveExportFile } from './apple_health.mjs'
import { ConnectorError } from './http.mjs'

const MAX_XML_BYTES = 2 * 1024 ** 3
const MAX_TOKEN_BYTES = 256 * 1024
const MAX_SCANNED = 300_000 // tracks looked at in one export
const MAX_TRACKS = 10_000 // tracks that become documents
const MAX_NAME = 300
const TOP = 15
const MIN_MS = Date.UTC(1990, 0, 1)

const clean = (s, max = MAX_NAME) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const pathHash = (p) => createHash('sha256').update(p).digest('hex').slice(0, 16)

// --------------------------------------------------------- the plist stream

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s) =>
  s.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (_m, dec, hex, name) => {
    if (name) return ENTITIES[name]
    const cp = dec ? Number(dec) : parseInt(hex, 16)
    return cp > 0 && cp < 0x110000 && !(cp >= 0xd800 && cp < 0xe000) ? String.fromCodePoint(cp) : ' '
  })

// 1 open, 2 close, 3 key, 4+5 value, 6 true/false, 7 empty value; the rest is skipped.
const TOKEN =
  /<(dict|array)>|<\/(dict|array)>|<key>([^<]*)<\/key>|<(string|integer|real|date|data)>([^<]*)<\/\4>|<(true|false)\s*\/>|<(string|data|dict|array)\s*\/>|<\?[^>]*\?>|<!DOCTYPE[^>]*>|<\/?plist[^>]*>/g

/** The track fields that are kept. Anything else in a track (such as `Location`) is dropped as it is read. */
const KEEP = new Set([
  'Persistent ID', 'Name', 'Artist', 'Album Artist', 'Album', 'Genre', 'Year', 'Total Time',
  'Play Count', 'Skip Count', 'Play Date UTC', 'Date Added', 'Rating', 'Loved', 'Favorited',
  'Podcast', 'Movie', 'TV Show',
])

/**
 * Walk a stream of library-export XML and call `onTrack(fields)` for each
 * entry of the top-level `Tracks` dictionary. Stops reading once that
 * dictionary ends. Chunk boundaries may fall anywhere.
 * @param {AsyncIterable<Buffer>} source
 * @param {(fields: Record<string, string | number | boolean>) => void} onTrack
 * @returns {Promise<{ bytes: number, sawTracks: boolean, complete: boolean }>}
 */
export async function scanLibraryXml(source, onTrack, { maxBytes = MAX_XML_BYTES } = {}) {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  let bytes = 0
  let depth = 0
  let key = null // the pending key at the current depth
  let inTracks = false
  let sawTracks = false
  let track = null
  let complete = false
  let sawPlist = false

  const value = (type, raw) => {
    // A value consumes the pending key, whatever its depth.
    const k = key
    key = null
    if (!track || depth !== 3 || k === null || !KEEP.has(k)) return
    if (type === 'string' || type === 'date') track[k] = unescapeXml(raw)
    else if (type === 'integer' || type === 'real') { const n = Number(raw); if (Number.isFinite(n)) track[k] = n }
    else if (type === 'true' || type === 'false') track[k] = type === 'true'
  }

  outer: for await (const chunk of source) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new ConnectorError('bad-response', { detail: 'the export is larger than the limit' })
    buf += decoder.write(chunk)
    if (!sawPlist) {
      if (/<plist[\s>]/.test(buf)) sawPlist = true
      else if (bytes > 1024 * 1024) throw new ConnectorError('bad-response', { detail: 'not a library export' })
    }
    TOKEN.lastIndex = 0
    let end = 0
    for (let m = TOKEN.exec(buf); m; m = TOKEN.exec(buf)) {
      end = TOKEN.lastIndex
      if (m[1]) {
        depth++
        if (m[1] === 'dict' && depth === 2 && key === 'Tracks') { inTracks = true; sawTracks = true }
        else if (m[1] === 'dict' && depth === 3 && inTracks) track = {}
        key = null
        if (depth > 64) throw new ConnectorError('bad-response', { detail: 'the export is nested too deeply' })
      } else if (m[2]) {
        if (depth === 3 && track) { onTrack(track); track = null }
        if (depth === 2 && inTracks) { complete = true; break outer }
        depth = Math.max(0, depth - 1)
        key = null
      } else if (m[3] !== undefined) {
        key = depth <= 3 ? unescapeXml(m[3]) : null
      } else if (m[4]) value(m[4], m[5])
      else if (m[6]) value(m[6], '')
      else if (m[7]) {
        // An empty library writes `<dict/>` for Tracks.
        if (m[7] === 'dict' && depth === 1 && key === 'Tracks') { sawTracks = true; complete = true; break outer }
        value('empty', '')
      }
    }
    // Keep only what follows the last whole token: at most one unfinished token.
    const rest = buf.slice(end)
    const lt = rest.indexOf('<')
    buf = lt >= 0 ? rest.slice(lt) : ''
    if (buf.length > MAX_TOKEN_BYTES) throw new ConnectorError('bad-response', { detail: 'a value in the export is too long' })
  }
  return { bytes, sawTracks, complete }
}

// ------------------------------------------------------------------ mapping

const dateMs = (v, nowMs) => {
  const ms = typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN
  return Number.isFinite(ms) && ms >= MIN_MS && ms <= nowMs + 86_400_000 ? ms : null
}
const count = (v) => (Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.floor(v) : 0)

/**
 * One `Tracks` entry to a compact song record; null for films, TV, podcasts
 * and entries without a stable id or a name.
 */
export function toTrack(f, { nowMs = Date.now() } = {}) {
  if (!f || f.Movie === true || f['TV Show'] === true || f.Podcast === true) return null
  const id = typeof f['Persistent ID'] === 'string' && /^[0-9A-Fa-f]{8,32}$/.test(f['Persistent ID']) ? f['Persistent ID'].toUpperCase() : null
  const name = clean(f.Name)
  if (!id || !name) return null
  const year = Number.isInteger(f.Year) && f.Year >= 1000 && f.Year <= 2999 ? f.Year : null
  const lengthMs = Number.isFinite(f['Total Time']) && f['Total Time'] > 0 && f['Total Time'] < 7 * 86_400_000 ? Math.round(f['Total Time']) : null
  const rating = Number.isFinite(f.Rating) && f.Rating > 0 && f.Rating <= 100 ? Math.round(f.Rating / 20) : null
  return {
    id,
    name,
    artist: clean(f.Artist) || clean(f['Album Artist']),
    album: clean(f.Album),
    genre: clean(f.Genre, 80),
    year,
    lengthMs,
    plays: count(f['Play Count']),
    skips: count(f['Skip Count']),
    playedMs: dateMs(f['Play Date UTC'], nowMs),
    addedMs: dateMs(f['Date Added'], nowMs),
    rating,
    favourite: f.Loved === true || f.Favorited === true,
  }
}

/** When a song last changed for sync purposes: last played, else added. */
const recency = (t) => Math.max(t.playedMs ?? 0, t.addedMs ?? 0)
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const mmss = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`
const label = (t) => (t.artist ? `${t.name} — ${t.artist}` : t.name)

export function trackToDocument(t, { now = Date.now } = {}) {
  const lines = [`Song: ${t.name}`]
  if (t.artist) lines.push(`Artist: ${t.artist}`)
  if (t.album) lines.push(`Album: ${t.album}`)
  if (t.genre) lines.push(`Genre: ${t.genre}`)
  if (t.year) lines.push(`Year: ${t.year}`)
  if (t.lengthMs) lines.push(`Length: ${mmss(t.lengthMs)}`)
  lines.push(`Plays: ${t.plays}`)
  if (t.skips) lines.push(`Skips: ${t.skips}`)
  if (t.playedMs) lines.push(`Last played: ${new Date(t.playedMs).toISOString()}`)
  if (t.addedMs) lines.push(`Added to the library: ${day(t.addedMs)}`)
  if (t.rating) lines.push(`Rating: ${t.rating} of 5`)
  if (t.favourite) lines.push('Marked as a favourite')
  lines.push('Source: Apple Music library export')
  const meta = { kind: 'track', plays: t.plays }
  if (t.artist) meta.artist = t.artist
  return {
    id: `track:${t.id}`,
    title: label(t).slice(0, 500),
    text: lines.join('\n'),
    updatedAt: recency(t) || now(),
    sensitivity: 'personal',
    meta,
  }
}

/** The one overview document: totals, most played, last played. Null for an empty library. */
export function summaryDocument(tracks, { exportedMs, now = Date.now } = {}) {
  if (!tracks.length) return null
  let plays = 0
  const artists = new Map()
  for (const t of tracks) {
    plays += t.plays
    if (t.artist && t.plays) artists.set(t.artist, (artists.get(t.artist) ?? 0) + t.plays)
  }
  const topArtists = [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)
  const topSongs = tracks.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, TOP)
  const recent = tracks.filter((t) => t.playedMs).sort((a, b) => b.playedMs - a.playedMs).slice(0, TOP)
  const lines = [`Apple Music library: ${tracks.length} song${tracks.length === 1 ? '' : 's'}, ${plays} play${plays === 1 ? '' : 's'} in total.`]
  if (exportedMs) lines.push(`From the library export made on ${day(exportedMs)}; plays after that are not included.`)
  if (topArtists.length) lines.push('', 'Most played artists:', ...topArtists.map(([a, n]) => `- ${a} (${n} plays)`))
  if (topSongs.length) lines.push('', 'Most played songs:', ...topSongs.map((t) => `- ${label(t)} (${t.plays} plays)`))
  if (recent.length) lines.push('', 'Last played:', ...recent.map((t) => `- ${label(t)} (${day(t.playedMs)})`))
  return {
    id: 'summary:library',
    title: 'Apple Music library summary',
    text: lines.join('\n'),
    updatedAt: exportedMs ?? now(),
    sensitivity: 'personal',
    meta: { kind: 'summary', songs: tracks.length, plays },
  }
}

// ------------------------------------------------------------------- cursor

export function parseMusicCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 300) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.r !== 'string' || !/^[0-9a-f]{16}$/.test(c.r)) return null
    if (!Number.isFinite(c.m) || !Number.isFinite(c.s) || !Number.isFinite(c.t) || c.t < 0) return null
    return { r: c.r, m: Math.floor(c.m), s: Math.floor(c.s), t: Math.floor(c.t) }
  } catch {
    return null
  }
}
export const musicCursor = ({ r, m, s, t }) => JSON.stringify({ v: 1, r, m, s, t })

// ----------------------------------------------------------------- the file

/** Check and resolve the file the owner typed: one `.xml` file, never a link target of another kind. */
export async function resolveLibraryFile(input, opts = {}) {
  const f = await resolveExportFile(input, opts)
  if (f.kind !== 'xml') throw new ConnectorError('folder-missing', { detail: 'pick the exported Library.xml' })
  return f
}

const openXml = (real) => createReadStream(real, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })

/** Read the songs of an export. Throws `bad-response` when it is not a complete library export. */
async function readLibrary(real, { nowMs, onlyCheck = false }) {
  const tracks = []
  let scanned = 0
  const stream = openXml(real)
  let res
  try {
    res = await scanLibraryXml(
      onlyCheck
        ? (async function* () {
            let seen = 0
            for await (const c of stream) {
              yield c
              seen += c.length
              if (seen > 256 * 1024) return
            }
          })()
        : stream,
      (fields) => {
        if (++scanned > MAX_SCANNED) throw new ConnectorError('bad-response', { detail: 'too many tracks in the export' })
        const t = toTrack(fields, { nowMs })
        if (t) tracks.push(t)
      },
    )
  } catch (err) {
    if (err instanceof ConnectorError) throw err
    throw new ConnectorError(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'folder-missing' : 'bad-response', { detail: 'could not read the export' })
  } finally {
    stream.destroy()
  }
  if (!res.sawTracks) throw new ConnectorError('bad-response', { detail: 'not a Music library export' })
  if (!onlyCheck && !res.complete) throw new ConnectorError('bad-response', { detail: 'the export is cut short' })
  return tracks
}

const SEES = [
  'The one library export file you choose (Library.xml from the Music app, or from iTunes).',
  'For each song: name, artist, album, genre, year, length, play and skip counts, when it was last played and added, and your rating.',
  'Not the music itself, not where song files are stored, not playlists, films, TV shows or podcasts, and not your Apple account.',
  'Read-only: the file is never changed and nothing in Music can be played, added or removed. It is read in a stream, so a big library does not fill memory.',
  'The export is a snapshot. To refresh it, export again over the same file and press Sync now.',
  'Song, artist and album names are treated as information, never as instructions.',
]

/** @param {{ home?: string }} [opts] */
export function appleMusicConnector({ home } = {}) {
  const fileOpts = home ? { home } : {}
  return Object.freeze({
    id: 'apple_music',
    create({ credentials, now }) {
      let lastSync

      async function fileOrThrow() {
        const real = credentials.get('file')
        if (!real) throw new ConnectorError('not-connected')
        try {
          const f = await resolveLibraryFile(real, fileOpts)
          if (f.real !== real) throw new Error('moved or replaced by a link')
          return f
        } catch (err) {
          throw new ConnectorError('folder-missing', { detail: err?.detail ?? err?.message ?? 'file missing' })
        }
      }

      return {
        id: 'apple_music',
        name: 'Apple Music',
        kind: 'data',
        auth: 'filesystem',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R0',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'personal',
        setup: {
          sees: SEES,
          localWhy:
            'JARVIS reads the library export file you make in the Music app, on this computer, to answer questions about your songs and what you have played. ' +
            'Type the full path of the exported Library.xml.',
          steps: [
            'In the Music app on a Mac (or iTunes on Windows) choose File → Library → Export Library… and save Library.xml somewhere on this computer.',
            'Type the full path of that file here and press Grant access.',
            'Press Test: JARVIS checks the file is a library export. Export again over the same file for fresher play counts, then press Sync now.',
          ],
          testQuestion: 'Which songs have I played the most?',
        },

        /** Grant pattern: `{ confirmed: true, path }`. Stores nothing unless the file is a library export. */
        async connect({ confirmed, path } = {}) {
          if (confirmed !== true) throw new ConnectorError('consent-denied', { detail: 'not confirmed' })
          const f = await resolveLibraryFile(path, fileOpts)
          if (f.size > MAX_XML_BYTES) throw new ConnectorError('bad-response', { detail: 'the export is larger than the limit' })
          await readLibrary(f.real, { nowMs: now(), onlyCheck: true })
          credentials.set('file', f.real)
          lastSync = undefined
          const name = clean(basename(f.real), 100)
          return { account: name, detail: `Connected to "${name}" (read-only).` }
        },

        async disconnect() {
          credentials.delete('file')
          lastSync = undefined
        },

        status() {
          const real = credentials.get('file')
          if (!real) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: `Reading "${clean(basename(real), 100)}" (read-only library export)` }
          return lastSync ? { ...s, lastSync } : s
        },

        /** Looks at the start of the file only. */
        async test() {
          const f = await fileOrThrow()
          await readLibrary(f.real, { nowMs: now(), onlyCheck: true })
          return { detail: `Apple Music works: the library export looks right (made ${day(f.mtimeMs)}, read-only).` }
        },

        async *sync({ cursor } = {}) {
          const f = await fileOrThrow()
          const r = pathHash(f.real)
          const prev = parseMusicCursor(cursor)
          if (prev && prev.r === r && prev.m === f.mtimeMs && prev.s === f.size) {
            lastSync = now()
            yield { cursor }
            return
          }
          if (f.size > MAX_XML_BYTES) throw new ConnectorError('bad-response', { detail: 'the export is larger than the limit' })
          const tracks = await readLibrary(f.real, { nowMs: now() })
          // The same export file, changed: only what was played or added since. Another file: everything.
          const after = prev && prev.r === r ? prev.t : 0
          let newest = after
          const seen = new Set()
          const fresh = []
          for (const t of tracks) {
            if (seen.has(t.id)) continue
            seen.add(t.id)
            const at = recency(t)
            if (at > newest) newest = at
            if (!after || at > after) fresh.push(t)
          }
          fresh.sort((a, b) => recency(b) - recency(a))
          for (const t of fresh.slice(0, MAX_TRACKS)) yield trackToDocument(t, { now })
          const summary = summaryDocument(tracks, { exportedMs: f.mtimeMs, now })
          if (summary) yield summary
          yield { cursor: musicCursor({ r, m: f.mtimeMs, s: f.size, t: newest }) }
          lastSync = now()
        },
      }
    },
  })
}
