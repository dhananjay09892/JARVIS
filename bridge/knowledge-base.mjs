/**
 * Personal knowledge base, first slice (Q96): index folders you choose on this
 * computer, find passages by meaning and by words, and answer with the file and
 * page they came from. "I can't find that" is a valid answer.
 *
 *   kb.indexAll()                    walk the chosen folders and (re)index them
 *   kb.search(question, { audience }) → { found, hits }
 *   kb.answer(question)              → { found, text, citations }   (local, extractive)
 *   kb.forBrain(question)            → { block, citations, withheld } for a turn
 *   kb.stats()                       counts only, never a passage
 *   evaluate(kb, questions)          hit rate and citation correctness
 *
 * Rules this module keeps:
 *   - Off until the owner switches it on, and it reads only the folders listed
 *     in Settings. Each folder is restricted (stays on this computer) unless it
 *     is marked `|cloud`.
 *   - Restricted folders are filtered out in the query, before any result
 *     exists, whenever the audience is 'cloud'. A passage from one is never put
 *     into a block a brain reads. `forBrain` always uses the cloud audience.
 *   - Secrets are removed (the patterns in memory.mjs) before text is stored,
 *     so the index never holds what could not be shown.
 *   - Embeddings, passages and the index stay in one SQLite file on this
 *     computer. Removing a folder deletes its passages and vectors in the same
 *     step, with secure_delete on (ADR 004: derived data, forget must forget).
 *   - Files are read, never changed. Symbolic links, hidden folders and large
 *     files are skipped. Text (.txt .md .markdown .rst .log), PDF and DOCX (Q132);
 *     a PDF with no text layer (a scan), an encrypted one, or a damaged one is
 *     skipped and counted, never guessed at.
 *
 * Vectors are exact search over Float32 BLOBs (the plain-SQLite option in
 * ADR 004) behind `createVectorIndex`, so the store can change without the
 * callers noticing. The default embedder is a local, dependency-free hashing
 * embedder (words and letter groups, so Hindi and Gujarati work). It is a
 * baseline: a model embedder with the same `{ id, dims, embed }` shape can
 * replace it, and the index re-embeds when the embedder id changes.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { redact } from './memory.mjs'
import { extractDocument } from './doc-extract.mjs'
import { neutraliseControlTags, stripHiddenText, wrapUntrusted } from './untrusted.mjs'

export const KNOWLEDGE_SETTINGS = Object.freeze({ enabled: 'JARVIS_KNOWLEDGE', folders: 'JARVIS_KNOWLEDGE_FOLDERS' })
export const KNOWLEDGE_SETTING_IDS = Object.freeze(Object.values(KNOWLEDGE_SETTINGS))

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.rst', '.log'])
/** Read by `doc-extract.mjs`: a PDF cites its page, a DOCX the page breaks Word saved. */
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx'])
const EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS])
const MAX_FILE_BYTES = 1024 * 1024
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
const MAX_FILES_PER_SOURCE = 2000
const MAX_DEPTH = 8
const CHUNK_CHARS = 700
const DEFAULT_K = 5
/** A hit needs at least this similarity, and at least one of the question's words. */
const MIN_SCORE = 0.2
const SNIPPET_CHARS = 280

/** Default location: next to memory, outside the repository and any build output. */
export function defaultKnowledgeDir(env = process.env) {
  if (env.JARVIS_KNOWLEDGE_DIR) return env.JARVIS_KNOWLEDGE_DIR
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share')
  return join(base, 'JARVIS', 'knowledge')
}

/**
 * The folders setting: "none", or entries separated by ";", each a folder path
 * with an optional "|cloud" saying a brain may read passages from it.
 * Anything not marked is restricted.
 */
export function parseSources(value) {
  const text = String(value ?? '').trim()
  if (!text || text.toLowerCase() === 'none') return []
  const seen = new Set()
  const out = []
  for (const part of text.split(';')) {
    const [rawPath, flag] = part.split('|').map((s) => s.trim())
    if (!rawPath || seen.has(rawPath)) continue
    seen.add(rawPath)
    out.push({ path: rawPath, cloud: /^cloud$/i.test(flag ?? '') })
  }
  return out.slice(0, 50)
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Splits text into passages of about `maxChars`, on blank lines where it can.
 * A form feed (\f) starts a new page, as text exported from a PDF has them;
 * without one the whole file is page 1. Each passage keeps its page and the
 * lines it covers (1-based), which is what a citation points at.
 */
export function chunkText(text, { maxChars = CHUNK_CHARS } = {}) {
  const chunks = []
  let lineBase = 0
  String(text ?? '').split('\f').forEach((page, pageIndex) => {
    const lines = page.split(/\r?\n/)
    let buf = []
    let start = 0
    let size = 0
    let last = 0
    const flush = () => {
      const body = buf.join('\n').trim()
      if (body) chunks.push({ text: body, page: pageIndex + 1, lineStart: lineBase + start + 1, lineEnd: lineBase + last })
      buf = []
      size = 0
    }
    lines.forEach((raw, i) => {
      // A very long line (an article pasted without newlines) is cut on a space.
      const pieces = []
      for (let line = raw; ; ) {
        if (line.length <= maxChars) { pieces.push(line); break }
        const cut = line.lastIndexOf(' ', maxChars)
        const at = cut > maxChars * 0.4 ? cut : maxChars
        pieces.push(line.slice(0, at))
        line = line.slice(at).trim()
      }
      for (const line of pieces) {
        if (!line.trim()) {
          if (size >= maxChars * 0.5) flush()
          continue
        }
        if (buf.length && size + line.length > maxChars) flush()
        if (!buf.length) start = i
        buf.push(line)
        last = i + 1
        size += line.length + 1
      }
    })
    flush()
    lineBase += lines.length
  })
  return chunks
}

// ---------------------------------------------------------------------------
// Local embedding
// ---------------------------------------------------------------------------

const STOP = new Set(('a an and are as at be but by do does did for from had has have he her his how i in is it its me my of on or our she so than that the their them then there these they this those to was we were what when where which who whom why will with you your ' +
  'about into if not no can could would should tell said say says').split(' '))

/** Lower-case words of letters, marks and digits (Devanagari and Gujarati included), stop words removed. */
export function words(text) {
  const out = []
  for (const w of String(text ?? '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (w && !STOP.has(w) && (w.length > 1 || /\p{N}/u.test(w))) out.push(w)
  }
  return out
}

/** A light stem so "prices" and "price", "meetings" and "meeting" meet. English only; other scripts pass through. */
function stem(w) {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w
  return w.replace(/(ing|ed|es|s)$/, '') || w
}

const hash32 = (s) => createHash('sha1').update(s).digest().readUInt32LE(0)

/**
 * Feature hashing: each word (stemmed) and each three-letter group inside it
 * lands in one of `dims` slots with a sign, counts are damped with log, and the
 * vector is scaled to length 1, so a dot product is a cosine. Deterministic,
 * local, no model download. Word weight 1, letter-group weight 0.35, which
 * lets near spellings and word endings match without drowning exact words.
 */
export function createHashingEmbedder({ dims = 512 } = {}) {
  const id = `hash-${dims}-v1`
  const cache = new Map()
  function slot(feature, v, weight) {
    const h = cache.get(feature) ?? hash32(feature)
    if (cache.size < 50_000) cache.set(feature, h)
    v[h % dims] += (h & 0x80000000 ? -1 : 1) * weight
  }
  return {
    id,
    dims,
    embed(text) {
      const counts = new Map()
      for (const w of words(text)) {
        const s = stem(w)
        counts.set(`w:${s}`, (counts.get(`w:${s}`) ?? 0) + 1)
        const padded = `^${s}$`
        for (let i = 0; i + 3 <= padded.length; i++) {
          const g = `g:${padded.slice(i, i + 3)}`
          counts.set(g, (counts.get(g) ?? 0) + 0.35)
        }
      }
      const v = new Float32Array(dims)
      for (const [f, n] of counts) slot(f, v, Math.log1p(n))
      let norm = 0
      for (let i = 0; i < dims; i++) norm += v[i] * v[i]
      norm = Math.sqrt(norm)
      if (norm > 0) for (let i = 0; i < dims; i++) v[i] /= norm
      return v
    },
  }
}

// ---------------------------------------------------------------------------
// Vector index (ADR 004 option A: exact search over BLOBs in SQLite)
// ---------------------------------------------------------------------------

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
function fromBlob(blob, dims) {
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer, 0, dims)
}

/**
 * The seam the store sits behind. `scopes` are source ids: the filter is part
 * of the query, so a source that is not asked for is never read.
 */
export function createVectorIndex(db, dims) {
  const put = db.prepare('UPDATE chunks SET v = ? WHERE id = ?')
  return {
    set(chunkId, vector) { put.run(toBlob(vector), chunkId) },
    /** Top `k` chunks by dot product within `scopes`; `accept` filters rows on the way. */
    search(vector, { scopes, k = DEFAULT_K, minScore = -1 } = {}) {
      if (!scopes.length) return []
      const marks = scopes.map(() => '?').join(',')
      const rows = db.prepare(`SELECT id, v FROM chunks WHERE source_id IN (${marks}) AND v IS NOT NULL`).all(...scopes)
      const scored = []
      for (const r of rows) {
        const w = fromBlob(r.v, dims)
        let dot = 0
        for (let i = 0; i < dims; i++) dot += vector[i] * w[i]
        if (dot >= minScore) scored.push({ id: r.id, score: dot })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, k)
    },
  }
}

// ---------------------------------------------------------------------------
// The knowledge base
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, cloud INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER);
CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, rel TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT NOT NULL, UNIQUE (source_id, rel));
CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, source_id INTEGER NOT NULL, seq INTEGER NOT NULL, page INTEGER NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, text TEXT NOT NULL, v BLOB);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source_id);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks (doc_id);
`

const sha = (text) => createHash('sha256').update(text).digest('hex')
const clipText = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text)

/** Files under `root`, depth-first, skipping links, hidden and vendored folders. */
function* walk(root, dir = root, depth = 0) {
  if (depth > MAX_DEPTH) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) yield* walk(root, full, depth + 1)
    else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.')
      if (dot > 0 && EXTENSIONS.has(e.name.slice(dot).toLowerCase())) yield full
    }
  }
}

/**
 * @param {object} o
 * @param {string} [o.dir]                    where the index file lives
 * @param {() => Array<{path:string,cloud:boolean}>} [o.sources]  the chosen folders (read each time)
 * @param {() => boolean} [o.enabled]         the switch
 * @param {{id:string,dims:number,embed:(t:string)=>Float32Array}} [o.embedder]
 * @param {(e: object) => void} [o.audit]     counts and names, never passage text
 * @param {() => number} [o.now]
 */
export function createKnowledgeBase({ dir = defaultKnowledgeDir(), sources = () => [], enabled = () => true, embedder = createHashingEmbedder(), audit = () => {}, now = Date.now } = {}) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'knowledge.db'))
  db.exec('PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;')
  db.exec(SCHEMA)
  const index = createVectorIndex(db, embedder.dims)
  const counters = { queries: 0, found: 0, notFound: 0, restrictedWithheld: 0, brainPassages: 0, indexRuns: 0, filesIndexed: 0, filesSkipped: 0 }

  // A different embedder means the stored vectors mean something else: embed again.
  const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get('embedder')?.value
  const reembed = stored !== undefined && stored !== embedder.id
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('embedder', embedder.id)
  if (reembed) {
    const rows = db.prepare('SELECT id, text FROM chunks').all()
    for (const r of rows) index.set(r.id, embedder.embed(r.text))
  }

  function syncSources() {
    const wanted = new Map()
    for (const s of sources()) {
      let real
      try { real = realpathSync(s.path.startsWith('~') ? join(homedir(), s.path.slice(1)) : s.path) } catch { continue }
      wanted.set(real, { cloud: s.cloud === true })
    }
    const have = db.prepare('SELECT id, path, cloud FROM sources').all()
    for (const row of have) {
      const w = wanted.get(row.path)
      if (!w) removeSource(row.id)
      else if (Boolean(row.cloud) !== w.cloud) db.prepare('UPDATE sources SET cloud = ? WHERE id = ?').run(w.cloud ? 1 : 0, row.id)
    }
    const ids = new Map(db.prepare('SELECT id, path FROM sources').all().map((r) => [r.path, r.id]))
    for (const [path, w] of wanted) {
      if (!ids.has(path)) {
        const r = db.prepare('INSERT INTO sources (path, cloud) VALUES (?, ?)').run(path, w.cloud ? 1 : 0)
        ids.set(path, Number(r.lastInsertRowid))
      }
    }
    return [...wanted.keys()].map((path) => ({ id: ids.get(path), path }))
  }

  function removeSource(id) {
    db.prepare('DELETE FROM chunks WHERE source_id = ?').run(id)
    db.prepare('DELETE FROM docs WHERE source_id = ?').run(id)
    db.prepare('DELETE FROM sources WHERE id = ?').run(id)
  }

  function removeDoc(docId) {
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM docs WHERE id = ?').run(docId)
  }

  function indexSource({ id, path }) {
    const result = { path: basename(path), files: 0, chunks: 0, skipped: 0, removed: 0 }
    const known = new Map(db.prepare('SELECT id, rel, size, mtime, hash FROM docs WHERE source_id = ?').all(id).map((d) => [d.rel, d]))
    const seen = new Set()
    let count = 0
    for (const file of walk(path)) {
      if (++count > MAX_FILES_PER_SOURCE) { result.skipped++; break }
      const rel = relative(path, file).split(sep).join('/')
      let st
      try { st = lstatSync(file) } catch { result.skipped++; continue }
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
      const isDocument = DOCUMENT_EXTENSIONS.has(ext)
      if (st.size > (isDocument ? MAX_DOCUMENT_BYTES : MAX_FILE_BYTES) || st.size === 0) { result.skipped++; continue }
      seen.add(rel)
      const prev = known.get(rel)
      if (prev && prev.size === st.size && prev.mtime === Math.trunc(st.mtimeMs)) { result.files++; continue }
      let raw
      if (isDocument) {
        let bytes
        try { bytes = readFileSync(file) } catch { result.skipped++; continue }
        const doc = extractDocument(bytes, ext)
        if (!doc.text) { result.skipped++; continue }
        raw = doc.text
      } else {
        try { raw = readFileSync(file, 'utf8') } catch { result.skipped++; continue }
        if (raw.includes('\u0000')) { result.skipped++; continue }
      }
      const clean = redact(stripHiddenText(raw).text).text
      const hash = sha(clean)
      if (prev && prev.hash === hash) {
        db.prepare('UPDATE docs SET size = ?, mtime = ? WHERE id = ?').run(st.size, Math.trunc(st.mtimeMs), prev.id)
        result.files++
        continue
      }
      if (prev) removeDoc(prev.id)
      const d = db.prepare('INSERT INTO docs (source_id, rel, size, mtime, hash) VALUES (?, ?, ?, ?, ?)').run(id, rel, st.size, Math.trunc(st.mtimeMs), hash)
      const docId = Number(d.lastInsertRowid)
      const ins = db.prepare('INSERT INTO chunks (doc_id, source_id, seq, page, line_start, line_end, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      // The file name and folder are part of what a question may mention ("the pricing note").
      const title = rel.replace(/[/_.-]+/g, ' ')
      chunkText(clean).forEach((c, seq) => {
        const r = ins.run(docId, id, seq, c.page, c.lineStart, c.lineEnd, c.text)
        index.set(Number(r.lastInsertRowid), embedder.embed(`${title} ${c.text}`))
        result.chunks++
      })
      result.files++
    }
    for (const [rel, d] of known) if (!seen.has(rel)) { removeDoc(d.id); result.removed++ }
    db.prepare('UPDATE sources SET indexed_at = ? WHERE id = ?').run(now(), id)
    counters.filesIndexed += result.files
    counters.filesSkipped += result.skipped
    return result
  }

  /** Index every chosen folder; forget folders no longer chosen. Off: forget everything that was kept. */
  function indexAll() {
    if (!enabled()) {
      for (const s of db.prepare('SELECT id FROM sources').all()) removeSource(s.id)
      return { ok: false, reason: 'The knowledge base is switched off.', sources: [] }
    }
    counters.indexRuns++
    const results = syncSources().map(indexSource)
    audit({ kind: 'knowledge-index', sources: results.length, files: results.reduce((n, r) => n + r.files, 0), chunks: results.reduce((n, r) => n + r.chunks, 0) })
    return { ok: true, sources: results }
  }

  const sourceRows = () => db.prepare('SELECT id, path, cloud FROM sources').all()
  const chunkRow = db.prepare('SELECT c.id, c.page, c.line_start AS ls, c.line_end AS le, c.text, c.source_id AS sid, d.rel FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id = ?')

  function cite(row, srcName) {
    const lines = row.ls === row.le ? `line ${row.ls}` : `lines ${row.ls}-${row.le}`
    return `${srcName}/${row.rel}, page ${row.page}, ${lines}`
  }

  /**
   * @param {string} question
   * @param {{ audience?: 'local'|'cloud', k?: number }} [opts]  'cloud' leaves restricted folders out of the query itself
   */
  function search(question, { audience = 'local', k = DEFAULT_K } = {}) {
    if (!enabled()) return { found: false, hits: [], reason: 'off' }
    counters.queries++
    const q = String(question ?? '').slice(0, 1000)
    const rows = sourceRows()
    const allowed = rows.filter((s) => audience === 'local' || s.cloud)
    if (audience === 'cloud') {
      const restricted = rows.filter((s) => !s.cloud)
      if (restricted.length) counters.restrictedWithheld++
    }
    const qWords = new Set(words(q).map(stem))
    if (!qWords.size || !allowed.length) { counters.notFound++; return { found: false, hits: [] } }
    const names = new Map(allowed.map((s) => [s.id, basename(s.path)]))
    const cands = index.search(embedder.embed(q), { scopes: allowed.map((s) => s.id), k: k * 3, minScore: MIN_SCORE })
    const hits = []
    for (const c of cands) {
      const row = chunkRow.get(c.id)
      const own = new Set(words(`${row.rel.replace(/[/_.-]+/g, ' ')} ${row.text}`).map(stem))
      const shared = [...qWords].filter((w) => own.has(w))
      if (!shared.length) continue
      // Similarity plus how much of the question the passage actually says.
      const score = c.score * 0.7 + (shared.length / qWords.size) * 0.3
      hits.push({
        score: Math.round(score * 1000) / 1000,
        source: names.get(row.sid), file: row.rel, page: row.page, lines: [row.ls, row.le],
        cite: cite(row, names.get(row.sid)), text: row.text,
      })
    }
    hits.sort((a, b) => b.score - a.score)
    const top = hits.slice(0, k)
    if (top.length) counters.found++; else counters.notFound++
    return { found: top.length > 0, hits: top }
  }

  // The sentence that says the most about the question. Words from the file's
  // own name are left out of the count (a heading repeats them), and a later
  // sentence wins a tie, because the heading is usually first.
  const snippet = (text, qWords, titleWords) => {
    const sentences = text.split(/(?<=[.!?।])\s+|\n+/).filter(Boolean)
    const score = (s, skipTitle) => words(s).map(stem).filter((w) => qWords.has(w) && !(skipTitle && titleWords.has(w))).length
    for (const skipTitle of [true, false]) {
      let best = null
      let bestN = 0
      for (const s of sentences) {
        const n = score(s, skipTitle)
        if (n > 0 && n >= bestN) { best = s; bestN = n }
      }
      if (best) return clipText(best.trim(), SNIPPET_CHARS)
    }
    return clipText((sentences[0] ?? text).trim(), SNIPPET_CHARS)
  }

  /** A local answer: the best sentences with their citations. Nothing leaves this computer. */
  function answer(question) {
    const r = search(question, { audience: 'local', k: 3 })
    if (!r.found) return { found: false, text: "I can't find that in your indexed folders.", citations: [] }
    const qWords = new Set(words(question).map(stem))
    const lines = r.hits.slice(0, 2).map((h) => `${snippet(h.text, qWords, new Set(words(h.file.replace(/[/_.-]+/g, ' ')).map(stem)))} (${h.cite})`)
    return { found: true, text: lines.join('\n'), citations: r.hits.map((h) => h.cite) }
  }

  /**
   * What a brain may read for this question: cloud-marked folders only, wrapped
   * as untrusted. `withheld` says only whether restricted folders were left
   * out, never what they hold.
   */
  function forBrain(question, { k = 3 } = {}) {
    const r = search(question, { audience: 'cloud', k })
    const withheld = sourceRows().some((s) => !s.cloud)
    if (!r.found) return { block: '', citations: [], withheld }
    counters.brainPassages += r.hits.length
    const body = r.hits.map((h, i) => `[${i + 1}] ${h.cite}\n${neutraliseControlTags(clipText(h.text, 900))}`).join('\n\n')
    const block = wrapUntrusted(`Passages from the owner's own files. Cite the file and page when you use one, and say you can't find it if they do not answer the question.\n\n${body}`, 'knowledge-base')
    return { block, citations: r.hits.map((h) => h.cite), withheld }
  }

  function stats() {
    const total = (sql) => Number(db.prepare(sql).get().n)
    return {
      enabled: enabled(), embedder: embedder.id,
      sources: total('SELECT COUNT(*) AS n FROM sources'),
      restrictedSources: total('SELECT COUNT(*) AS n FROM sources WHERE cloud = 0'),
      files: total('SELECT COUNT(*) AS n FROM docs'),
      passages: total('SELECT COUNT(*) AS n FROM chunks'),
      ...counters,
    }
  }

  /** Delete everything the index holds (Settings "forget the index"). */
  function clear() {
    for (const s of db.prepare('SELECT id FROM sources').all()) removeSource(s.id)
    db.exec('VACUUM')
    return { ok: true }
  }

  return { indexAll, search, answer, forBrain, stats, clear, close: () => db.close(), sourcesList: () => sourceRows().map((s) => ({ name: basename(s.path), restricted: !s.cloud })) }
}

/**
 * Hit rate and citation correctness over a held-out set.
 * Each question is `{ q, file, contains }`, or `{ q, none: true }` for one the
 * folders cannot answer. A hit is the expected file among the top 5. A citation
 * is correct when the best hit is that file and its passage holds `contains`.
 * Questions with no answer count the other way: a correct "can't find that".
 */
export function evaluate(kb, questions, { audience = 'local' } = {}) {
  let answerable = 0, hits = 0, cited = 0, unanswerable = 0, refused = 0
  const misses = []
  for (const item of questions) {
    const r = kb.search(item.q, { audience, k: 5 })
    if (item.none) {
      unanswerable++
      if (!r.found) refused++; else misses.push({ q: item.q, why: 'answered something that is not there' })
      continue
    }
    answerable++
    const inTop = r.hits.some((h) => h.file === item.file)
    if (inTop) hits++; else misses.push({ q: item.q, why: 'expected file not in the top 5' })
    const best = r.hits[0]
    const fold = (s) => s.toLowerCase().replace(/\s+/g, ' ')
    if (best && best.file === item.file && fold(best.text).includes(fold(item.contains))) cited++
    else if (inTop) misses.push({ q: item.q, why: 'best citation is not the right passage' })
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null)
  return { answerable, hitRate: pct(hits, answerable), citationCorrectness: pct(cited, answerable), unanswerable, correctRefusals: pct(refused, unanswerable), misses }
}
