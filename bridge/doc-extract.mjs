/**
 * Plain-text extraction from PDF and DOCX files for the knowledge base (Q132).
 * No dependencies: only node:zlib. Everything runs on this computer.
 *
 *   extractDocument(buffer, '.pdf' | '.docx') → { text, pages } | { text: '', reason }
 *
 * `text` has a form feed (\f) between pages, which `chunkText` turns into page
 * numbers for citations. A DOCX only has page breaks where Word saved them.
 *
 * What it reads, and what it does not (a file it cannot read is skipped, never guessed):
 *   - PDF: text with Flate-compressed streams, object streams, simple fonts,
 *     and Type0 fonts that carry a ToUnicode map (what most producers write).
 *     Not read: encrypted files, scanned pages (no text layer), text inside
 *     form XObjects, fonts with neither a ToUnicode map nor a standard encoding.
 *   - DOCX: the body text of word/document.xml.
 *
 * Limits keep a hostile file from using the computer's memory: output of any one
 * stream, the whole document, and the number of objects are capped.
 */
import { inflateRawSync, inflateSync } from 'node:zlib'

const MAX_STREAM_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 48 * 1024 * 1024
const MAX_OBJECTS = 200000
const MAX_PAGES = 2000
const MAX_TEXT_CHARS = 4 * 1024 * 1024

// ---------------------------------------------------------------------------
// DOCX (a zip file holding word/document.xml)
// ---------------------------------------------------------------------------

/** Reads one entry of a zip file by name. Returns a Buffer, or null. */
export function readZipEntry(buf, wanted) {
  const min = Math.max(0, buf.length - 65557)
  let eocd = -1
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (name !== wanted) continue
    if (usize > MAX_STREAM_BYTES || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + csize)
    try {
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_STREAM_BYTES })
    } catch { /* corrupt entry */ }
    return null
  }
  return null
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
  }
  return XML_ENTITIES[e.toLowerCase()] ?? m
})

/** Text of a Word document: paragraphs on their own lines, tabs kept. */
export function docxText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml')
  if (!xml) return null
  const s = xml.toString('utf8')
  const rendered = s.includes('<w:lastRenderedPageBreak')
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b([^>]*)\/>|<w:lastRenderedPageBreak\s*\/>|<\/w:p>/g
  let out = ''
  let pages = 1
  for (let m; (m = re.exec(s)); ) {
    if (out.length > MAX_TEXT_CHARS) break
    if (m[1] !== undefined) out += decodeXml(m[1])
    else if (m[0].startsWith('<w:tab')) out += '\t'
    else if (m[0].startsWith('<w:lastRendered')) { out += '\f'; pages++ }
    else if (m[0].startsWith('<w:br')) {
      if (/w:type="page"/.test(m[2] ?? '') && !rendered) { out += '\f'; pages++ }
      else if (!/w:type="page"/.test(m[2] ?? '')) out += '\n'
    } else out += '\n'
  }
  return { text: out.replace(/\n*\f\n*/g, '\f').replace(/\n{3,}/g, '\n\n').trim(), pages }
}

// ---------------------------------------------------------------------------
// PDF: object syntax
// ---------------------------------------------------------------------------

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)))

function skipWs(s, i) {
  for (;;) {
    const c = s.charCodeAt(i)
    if (c === 37) { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++ } else if (WS.has(c)) i++
    else return i
  }
}

const REF = /(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+R(?![A-Za-z0-9])/y

/**
 * Parses one PDF value at `i`. Names are { n }, strings { s } (one char per byte),
 * references { r }, bare words { k }; dictionaries are plain objects.
 */
function parseValue(s, i, refs = true, depth = 0) {
  i = skipWs(s, i)
  if (i >= s.length || depth > 40) return [{ k: '' }, s.length]
  const c = s[i]
  if (c === '<' && s[i + 1] === '<') {
    const d = Object.create(null)
    i += 2
    for (;;) {
      i = skipWs(s, i)
      if (i >= s.length) break
      if (s[i] === '>' && s[i + 1] === '>') { i += 2; break }
      if (s[i] !== '/') { i++; continue }
      const [key, ni] = parseValue(s, i, refs, depth + 1)
      const [val, nj] = parseValue(s, ni, refs, depth + 1)
      d[key.n] = val
      i = nj
    }
    return [d, i]
  }
  if (c === '<') {
    const end = s.indexOf('>', i)
    const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, '')
    let str = ''
    for (let j = 0; j < hex.length; j += 2) str += String.fromCharCode(parseInt(hex.slice(j, j + 2).padEnd(2, '0'), 16))
    return [{ s: str }, end < 0 ? s.length : end + 1]
  }
  if (c === '(') {
    let level = 1
    let str = ''
    i++
    while (i < s.length && level > 0) {
      const ch = s[i++]
      if (ch === '\\') {
        const e = s[i++]
        if (e === 'n') str += '\n'
        else if (e === 'r') str += '\r'
        else if (e === 't') str += '\t'
        else if (e === 'b') str += '\b'
        else if (e === 'f') str += '\f'
        else if (e >= '0' && e <= '7') {
          let oct = e
          while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++]
          str += String.fromCharCode(parseInt(oct, 8) & 255)
        } else if (e === '\r') { if (s[i] === '\n') i++ } else if (e !== '\n') str += e ?? ''
      } else if (ch === '(') { level++; str += ch } else if (ch === ')') { if (--level > 0) str += ch } else str += ch
    }
    return [{ s: str }, i]
  }
  if (c === '[') {
    const arr = []
    i++
    for (;;) {
      i = skipWs(s, i)
      if (i >= s.length) break
      if (s[i] === ']') { i++; break }
      const [v, ni] = parseValue(s, i, refs, depth + 1)
      arr.push(v)
      i = ni > i ? ni : i + 1
    }
    return [arr, i]
  }
  if (c === '/') {
    let j = i + 1
    while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++
    const n = s.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    return [{ n }, j]
  }
  if (c === ')' || c === '>' || c === ']' || c === '{' || c === '}') return [{ k: c }, i + 1]
  let j = i
  while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++
  if (j === i) j = i + 1
  const tok = s.slice(i, j)
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
    if (refs && /^\d+$/.test(tok)) {
      REF.lastIndex = i
      const m = REF.exec(s)
      if (m) return [{ r: Number(m[1]) }, REF.lastIndex]
    }
    return [Number(tok), j]
  }
  return [{ k: tok }, j]
}

/** Decodes a stream's filters. Only Flate is supported; anything else gives null. */
function decodeStream(dict, raw, budget) {
  let filters = dict.Filter
  if (filters === undefined) return raw
  filters = Array.isArray(filters) ? filters : [filters]
  let data = raw
  for (const f of filters) {
    const name = f?.n
    if (name !== 'FlateDecode' && name !== 'Fl') return null
    const parms = Array.isArray(dict.DecodeParms) ? dict.DecodeParms[0] : dict.DecodeParms
    if (parms && typeof parms === 'object' && !parms.r && Number(parms.Predictor) > 1) return null
    try { data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES }) } catch {
      try { data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES, finishFlush: 2 }) } catch { return null }
    }
  }
  budget.used += data.length
  return budget.used > MAX_TOTAL_BYTES ? null : data
}

/** Reads every object of the file (later definitions replace earlier ones). */
function loadObjects(buf) {
  const s = buf.toString('latin1')
  const objs = new Map()
  const budget = { used: 0 }
  const re = /(?:^|[\r\n \t>])(\d+)[ \t]+(\d+)[ \t]+obj\b/g
  const objStreams = []
  for (let m; (m = re.exec(s)); ) {
    if (objs.size > MAX_OBJECTS) break
    const num = Number(m[1])
    const [value, after] = parseValue(s, re.lastIndex)
    const entry = { value }
    if (value && typeof value === 'object' && !Array.isArray(value) && !value.n && !value.s && !value.k && !value.r) {
      const at = skipWs(s, after)
      if (s.startsWith('stream', at)) {
        let start = at + 6
        if (s[start] === '\r' && s[start + 1] === '\n') start += 2
        else if (s[start] === '\n' || s[start] === '\r') start += 1
        let end = -1
        const len = typeof value.Length === 'number' ? value.Length : -1
        if (len >= 0 && s.startsWith('endstream', skipWs(s, start + len))) end = start + len
        if (end < 0) {
          end = s.indexOf('endstream', start)
          if (end < 0) end = s.length
          else if (s[end - 1] === '\n') end -= s[end - 2] === '\r' ? 2 : 1
          else if (s[end - 1] === '\r') end -= 1
        }
        entry.raw = buf.subarray(start, end)
        re.lastIndex = Math.max(re.lastIndex, end)
        if (value.Type?.n === 'ObjStm') objStreams.push(entry)
      }
    }
    objs.set(num, entry)
  }
  for (const os of objStreams) {
    const data = decodeStream(os.value, os.raw, budget)
    if (!data) continue
    const t = data.toString('latin1')
    const n = Number(os.value.N)
    const first = Number(os.value.First)
    if (!(n > 0) || !(first >= 0)) continue
    const heads = t.slice(0, first).trim().split(/\s+/).map(Number)
    for (let j = 0; j < n && j * 2 + 1 < heads.length; j++) {
      const num = heads[j * 2]
      if (!objs.has(num) || objs.get(num).inStream) {
        objs.set(num, { value: parseValue(t, first + heads[j * 2 + 1])[0], inStream: true })
      }
    }
  }
  return { s, objs, budget }
}

// ---------------------------------------------------------------------------
// PDF: fonts and text
// ---------------------------------------------------------------------------

const hexUnits = (hex) => {
  let out = ''
  for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, '0'), 16))
  return out
}

/** A ToUnicode CMap as Map(code → text). */
export function parseToUnicode(text) {
  const map = new Map()
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexUnits(m[2]))
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16)
      const hi = Math.min(parseInt(m[2], 16), lo + 65535)
      if (m[3][0] === '[') {
        let code = lo
        for (const d of m[3].matchAll(/<([0-9a-fA-F]*)>/g)) { if (code <= hi) map.set(code++, hexUnits(d[1])) }
      } else {
        const dst = hexUnits(m[3].slice(1, -1))
        for (let code = lo; code <= hi; code++) {
          map.set(code, dst.slice(0, -1) + String.fromCharCode(dst.charCodeAt(dst.length - 1) + (code - lo)))
        }
      }
    }
  }
  return map
}

const cp1252 = new TextDecoder('windows-1252')

function makeContext({ objs, budget }) {
  const deref = (v, depth = 0) => (v && typeof v === 'object' && v.r !== undefined && depth < 10 ? deref(objs.get(v.r)?.value, depth + 1) : v)
  const streamOf = (v) => {
    const e = v && v.r !== undefined ? objs.get(v.r) : null
    if (!e || !e.raw) return null
    return decodeStream(e.value, e.raw, budget)
  }
  const fontCache = new Map()
  /** → { decode(str) → text } or null when the font cannot be read */
  const loadFont = (ref) => {
    const key = ref?.r ?? ref
    if (fontCache.has(key)) return fontCache.get(key)
    const font = deref(ref)
    let result = null
    if (font && typeof font === 'object') {
      const wide = font.Subtype?.n === 'Type0'
      const tu = font.ToUnicode ? streamOf(font.ToUnicode) : null
      const map = tu ? parseToUnicode(tu.toString('latin1')) : null
      if (map && map.size) {
        const maxCode = Math.max(...[...map.keys()].slice(0, 5000))
        const two = wide || maxCode > 255
        result = {
          decode(str) {
            let out = ''
            if (two) for (let i = 0; i + 1 < str.length; i += 2) out += map.get(str.charCodeAt(i) * 256 + str.charCodeAt(i + 1)) ?? ''
            else for (let i = 0; i < str.length; i++) out += map.get(str.charCodeAt(i)) ?? cp1252.decode(Buffer.from([str.charCodeAt(i)]))
            return out
          },
        }
      } else if (!wide) {
        result = { decode: (str) => cp1252.decode(Buffer.from(str, 'latin1')) }
      }
    }
    fontCache.set(key, result)
    return result
  }
  return { deref, streamOf, loadFont }
}

/** Text of one page's content stream. */
function contentText(content, fonts) {
  const s = content.toString('latin1')
  let out = ''
  let font = null
  let lastY = null
  let i = 0
  const stack = []
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n' }
  const space = () => { if (out && !/\s$/.test(out)) out += ' ' }
  const show = (str) => { if (font) out += font.decode(str) }
  while (i < s.length) {
    const [v, ni] = parseValue(s, i, false)
    i = ni > i ? ni : i + 1
    if (!(v && typeof v === 'object' && !Array.isArray(v) && v.k !== undefined)) {
      stack.push(v)
      if (stack.length > 64) stack.shift()
      continue
    }
    const op = v.k
    const num = (n) => (typeof stack[n] === 'number' ? stack[n] : 0)
    switch (op) {
      case 'BI': {
        const m = /[ \t\r\n]EI(?=[ \t\r\n]|$)/g
        m.lastIndex = i
        const hit = m.exec(s)
        i = hit ? hit.index + hit[0].length : s.length
        break
      }
      case 'Tf': font = fonts[stack[stack.length - 2]?.n] ?? null; break
      case 'Tj': { const a = stack[stack.length - 1]; if (a?.s !== undefined) show(a.s); break }
      case "'": newline(); { const a = stack[stack.length - 1]; if (a?.s !== undefined) show(a.s) } break
      case '"': newline(); { const a = stack[stack.length - 1]; if (a?.s !== undefined) show(a.s) } break
      case 'TJ': {
        const arr = stack[stack.length - 1]
        if (Array.isArray(arr)) {
          for (const el of arr) {
            if (el?.s !== undefined) show(el.s)
            else if (typeof el === 'number' && el < -250) space()
          }
        }
        break
      }
      case 'Td': case 'TD': {
        const tx = num(stack.length - 2)
        const ty = num(stack.length - 1)
        if (ty !== 0) newline()
        else if (tx !== 0) space()
        break
      }
      case 'T*': newline(); break
      case 'Tm': {
        const y = num(stack.length - 1)
        if (lastY !== null && Math.abs(y - lastY) > 1) newline()
        else if (lastY !== null) space()
        lastY = y
        break
      }
      case 'BT': lastY = null; break
      case 'ET': newline(); break
      default: break
    }
    stack.length = 0
  }
  return out
}

/** Page dictionaries in reading order. */
function pagesInOrder({ s, objs }, deref) {
  const pages = []
  const seen = new Set()
  const walk = (ref, depth) => {
    const node = deref(ref)
    if (!node || typeof node !== 'object' || depth > 30 || pages.length >= MAX_PAGES) return
    if (ref?.r !== undefined) { if (seen.has(ref.r)) return; seen.add(ref.r) }
    if (Array.isArray(node.Kids)) for (const k of node.Kids) walk(k, depth + 1)
    else if (node.Type?.n === 'Page' || node.Contents !== undefined) pages.push(node)
  }
  const roots = [...s.matchAll(/\/Root[ \t\r\n]+(\d+)[ \t\r\n]+\d+[ \t\r\n]+R/g)]
  if (roots.length) {
    const catalog = deref({ r: Number(roots[roots.length - 1][1]) })
    if (catalog?.Pages) walk(catalog.Pages, 0)
  }
  if (!pages.length) {
    for (const e of objs.values()) {
      if (e.value?.Type?.n === 'Page' && pages.length < MAX_PAGES) pages.push(e.value)
    }
  }
  return pages
}

/** Text of a PDF, page by page. */
export function pdfText(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 1024).indexOf('%PDF-') < 0) return { text: '', reason: 'not-pdf' }
  const doc = loadObjects(buf)
  if (/\/Encrypt[ \t\r\n]+\d+[ \t\r\n]+\d+[ \t\r\n]+R/.test(doc.s)) {
    return { text: '', reason: 'encrypted' }
  }
  const ctx = makeContext(doc)
  const pageNodes = pagesInOrder(doc, ctx.deref)
  if (!pageNodes.length) return { text: '', reason: 'no-pages' }
  const resourcesOf = (page) => {
    for (let node = page, n = 0; node && typeof node === 'object' && n < 20; node = ctx.deref(node.Parent), n++) {
      if (node.Resources) return ctx.deref(node.Resources)
    }
    return null
  }
  const texts = []
  for (const page of pageNodes) {
    const res = resourcesOf(page)
    const fontDict = res ? ctx.deref(res.Font) : null
    const fonts = Object.create(null)
    if (fontDict && typeof fontDict === 'object') {
      for (const [name, ref] of Object.entries(fontDict)) fonts[name] = ctx.loadFont(ref)
    }
    const parts = Array.isArray(ctx.deref(page.Contents)) ? ctx.deref(page.Contents) : [page.Contents]
    let body = ''
    for (const part of parts) {
      const data = part ? ctx.streamOf(part) : null
      if (data) body += `${contentText(data, fonts)}\n`
    }
    texts.push(body)
  }
  const text = texts
    .map((t) => t.normalize('NFKC').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim())
    .join('\f')
  const clipped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
  if (!clipped.replace(/\f/g, '').trim()) return { text: '', reason: 'no-text' }
  return { text: clipped, pages: pageNodes.length }
}

/** Entry point: `ext` is '.pdf' or '.docx'. */
export function extractDocument(buf, ext) {
  try {
    if (ext === '.pdf') return pdfText(buf)
    if (ext === '.docx') {
      const d = docxText(buf)
      if (!d) return { text: '', reason: 'unreadable' }
      return d.text ? d : { text: '', reason: 'no-text' }
    }
  } catch {
    return { text: '', reason: 'unreadable' }
  }
  return { text: '', reason: 'unsupported' }
}
