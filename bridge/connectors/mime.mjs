/**
 * A small, defensive MIME reader for mail connectors (task C09): raw RFC 5322
 * message bytes, as IMAP hands them over, to the headers JARVIS shows and a
 * plain-text body. Written for reading, not for round-tripping:
 *
 *   - headers are unfolded and RFC 2047 encoded words (=?utf-8?B?…?=) decoded;
 *   - multipart bodies are walked (depth and part count capped); the first
 *     text/plain parts win, otherwise text/html is reduced to text;
 *   - base64 and quoted-printable are decoded; the charset comes from the
 *     part's Content-Type and falls back to UTF-8;
 *   - attachments (and attached messages) are listed by name and type only:
 *     their bytes are never decoded or kept.
 *
 * Every string it returns is still untrusted; the registry wraps it.
 */

const MAX_DEPTH = 12
const MAX_PARTS = 100
const MAX_HEADER_BYTES = 256 * 1024
const MAX_BODY = 100_000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * HTML mail to readable text. Not a sanitiser — the result is text that the
 * registry wraps as untrusted — just enough to drop markup, scripts and styles.
 * (Shared with the Gmail API connector, which re-exports it.)
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '
      }
      return ENTITIES[e.toLowerCase()] ?? all
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim()
}

/** A TextDecoder for a charset name, UTF-8 when it is unknown. */
function decoderFor(charset) {
  const name = String(charset ?? '').trim().toLowerCase()
  if (name && /^[a-z0-9._:-]{1,40}$/.test(name)) {
    try {
      return new TextDecoder(name)
    } catch {
      /* unknown charset: fall through */
    }
  }
  return new TextDecoder('utf-8')
}

/** Quoted-printable bytes to bytes (soft line breaks removed). */
export function decodeQuotedPrintable(input) {
  const s = Buffer.isBuffer(input) ? input.toString('latin1') : String(input ?? '')
  const out = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '=') {
      if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 2; continue }
      if (s[i + 1] === '\n') { i += 1; continue }
      const hex = s.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    out.push(s.charCodeAt(i) & 0xff)
  }
  return Buffer.from(out)
}

/**
 * Decode RFC 2047 encoded words in a header value. Whitespace between two
 * adjacent encoded words is dropped, as the RFC says.
 */
export function decodeEncodedWords(value) {
  const s = String(value ?? '')
  const re = /=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]*)\?=/g
  let out = ''
  let last = 0
  let prevEncoded = false
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const between = s.slice(last, m.index)
    if (!(prevEncoded && /^\s*$/.test(between))) out += between
    const [, charsetRaw, enc, text] = m
    const charset = charsetRaw.split('*')[0] // RFC 2231 language suffix
    let bytes
    if (enc.toLowerCase() === 'b') bytes = Buffer.from(text, 'base64')
    else bytes = decodeQuotedPrintable(text.replace(/_/g, ' '))
    out += decoderFor(charset).decode(bytes)
    last = m.index + m[0].length
    prevEncoded = true
  }
  out += s.slice(last)
  return out
}

/** Split raw bytes into the header block (latin1 text) and the body bytes. */
function splitMessage(buf) {
  const lfIdx = buf.indexOf('\n\n')
  const crlfIdx = buf.indexOf('\r\n\r\n')
  let headEnd
  let bodyStart
  if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
    headEnd = crlfIdx
    bodyStart = crlfIdx + 4
  } else if (lfIdx !== -1) {
    headEnd = lfIdx
    bodyStart = lfIdx + 2
  } else {
    headEnd = buf.length
    bodyStart = buf.length
  }
  // Header bytes stay raw (latin1) until decoded: 8-bit UTF-8 headers are common.
  const head = buf.subarray(0, Math.min(headEnd, MAX_HEADER_BYTES))
  return { head, body: buf.subarray(bodyStart) }
}

/**
 * Parse a header block into `[{ name, value }]` (names lower case, values
 * unfolded and decoded). 8-bit header bytes are read as UTF-8.
 */
export function parseHeaders(head) {
  const text = (Buffer.isBuffer(head) ? new TextDecoder('utf-8').decode(head) : String(head ?? ''))
    .replace(/\r\n/g, '\n')
  const out = []
  for (const line of text.split('\n')) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1].raw += ` ${line.trim()}`
      continue
    }
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!/^[!-9;-~]{1,76}$/.test(name)) continue
    out.push({ name, raw: line.slice(i + 1).trim() })
    if (out.length >= 500) break
  }
  return out.map(({ name, raw }) => ({ name, raw, value: decodeEncodedWords(raw).slice(0, 2000) }))
}

const headerOf = (headers, name) => headers.find((h) => h.name === name)

/**
 * A structured header such as Content-Type: the value before the first `;`
 * and its parameters (quoted values unquoted, RFC 2231 `name*=` decoded and
 * continuations `name*0=`, `name*1=` joined).
 */
export function parseParams(raw) {
  const s = String(raw ?? '')
  const parts = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && quoted && i + 1 < s.length) { cur += s[++i]; continue }
    if (ch === '"') { quoted = !quoted; continue }
    if (ch === ';' && !quoted) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  const value = parts.shift().trim().toLowerCase()
  const params = {}
  const pieces = {}
  for (const p of parts.slice(0, 50)) {
    const i = p.indexOf('=')
    if (i <= 0) continue
    const key = p.slice(0, i).trim().toLowerCase()
    const val = p.slice(i + 1).trim()
    const m = /^([a-z0-9._-]+)\*(\d+)?(\*)?$/.exec(key)
    if (m) {
      const [, base, idx, enc] = m
      ;(pieces[base] ??= []).push({ idx: Number(idx ?? 0), val, enc: Boolean(enc) || (idx === undefined) })
    } else if (/^[a-z0-9._-]+$/.test(key)) {
      params[key] = decodeEncodedWords(val)
    }
  }
  for (const [base, list] of Object.entries(pieces)) {
    list.sort((a, b) => a.idx - b.idx)
    let charset = 'utf-8'
    const bytes = []
    list.forEach((piece, n) => {
      let v = piece.val
      if (piece.enc) {
        if (n === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(v)
          if (m) { charset = m[1] || 'utf-8'; v = m[2] }
        }
        v.replace(/%([0-9A-Fa-f]{2})|([\s\S])/g, (_, hex, ch) => {
          if (hex) bytes.push(parseInt(hex, 16))
          else bytes.push(...Buffer.from(ch, 'utf8'))
          return ''
        })
      } else {
        bytes.push(...Buffer.from(v, 'utf8'))
      }
    })
    params[base] = decoderFor(charset).decode(Buffer.from(bytes))
  }
  return { value, params }
}

function decodeBody(bytes, encoding) {
  const enc = String(encoding ?? '').trim().toLowerCase()
  if (enc === 'base64') return Buffer.from(bytes.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') return decodeQuotedPrintable(bytes)
  return bytes
}

/** Split a multipart body on its boundary; preamble and epilogue dropped. */
function splitMultipart(body, boundary) {
  const parts = []
  const delim = Buffer.from(`--${boundary}`, 'latin1')
  let pos = body.indexOf(delim)
  while (pos !== -1 && parts.length < MAX_PARTS) {
    let start = pos + delim.length
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break // closing --boundary--
    // Skip to the end of the delimiter line.
    const eol = body.indexOf('\n', start)
    if (eol === -1) break
    start = eol + 1
    const next = body.indexOf(delim, start)
    let end = next === -1 ? body.length : next
    // The CRLF before the next delimiter belongs to it.
    if (next !== -1) {
      if (body[end - 1] === 0x0a) end--
      if (body[end - 1] === 0x0d) end--
    }
    parts.push(body.subarray(start, Math.max(start, end)))
    pos = next
  }
  return parts
}

/**
 * Walk one MIME entity, collecting text and attachments.
 * @param {Buffer} buf
 */
function walk(buf, depth, acc) {
  if (depth > MAX_DEPTH || acc.count >= MAX_PARTS) return
  acc.count++
  const { head, body } = splitMessage(buf)
  const headers = parseHeaders(head)
  const ct = parseParams(headerOf(headers, 'content-type')?.raw ?? 'text/plain')
  const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ct.value) ? ct.value : 'text/plain'
  const disp = parseParams(headerOf(headers, 'content-disposition')?.raw ?? '')
  const filename = disp.params.filename ?? ct.params.name
  if (type.startsWith('multipart/') && ct.params.boundary) {
    for (const part of splitMultipart(body, ct.params.boundary)) walk(part, depth + 1, acc)
    return
  }
  const isAttachment = disp.value === 'attachment' || Boolean(filename) || type === 'message/rfc822' ||
    !(type === 'text/plain' || type === 'text/html')
  if (isAttachment) {
    acc.attachments.push({
      name: String(filename || (type === 'message/rfc822' ? 'attached message' : 'unnamed')).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200),
      type: type.slice(0, 100),
    })
    return
  }
  const text = decoderFor(ct.params.charset).decode(decodeBody(body, headerOf(headers, 'content-transfer-encoding')?.raw))
  if (type === 'text/plain') acc.plain.push(text)
  else acc.html.push(text)
}

/**
 * Parse a raw message.
 * @param {Buffer | string} raw
 * @returns {{ headers: { name: string, value: string }[], header: (name: string) => string,
 *            text: string, attachments: { name: string, type: string }[] }}
 */
export function parseMessage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8')
  const { head } = splitMessage(buf)
  const headers = parseHeaders(head)
  const acc = { plain: [], html: [], attachments: [], count: 0 }
  walk(buf, 0, acc)
  let text = acc.plain.length ? acc.plain.join('\n\n') : htmlToText(acc.html.join('\n\n'))
  text = text.replace(/\r\n?/g, '\n').trim()
  if (text.length > MAX_BODY) text = `${text.slice(0, MAX_BODY)}\n[… message shortened]`
  return {
    headers: headers.map(({ name, value }) => ({ name, value })),
    header: (name) => (headerOf(headers, String(name).toLowerCase())?.value ?? '').replace(/[\r\n]+/g, ' '),
    text,
    attachments: acc.attachments.slice(0, 50),
  }
}
