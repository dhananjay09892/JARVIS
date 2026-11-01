/**
 * The shared read-only IMAP reader (task C09), used by the Gmail-over-IMAP
 * connector now and by the generic IMAP and Outlook connectors later
 * (tasks C20, C21). No dependency: a small IMAP4rev1 client (RFC 3501) over
 * a TLS socket, enough to log in, pick a mailbox and fetch messages.
 *
 * Read-only by construction:
 *   - the mailbox is opened with EXAMINE (never SELECT), so the server keeps
 *     it read-only for the session;
 *   - message bodies are fetched with BODY.PEEK[], which leaves the \Seen
 *     flag alone (reading mail in JARVIS never marks it read);
 *   - the only commands this module can send are CAPABILITY, LOGIN, LIST,
 *     EXAMINE, UID SEARCH, UID FETCH and LOGOUT (see `READ_COMMANDS`); there
 *     is no STORE, COPY, MOVE, EXPUNGE, APPEND or DELETE in it at all.
 *
 * Safety:
 *   - TLS only (implicit TLS, port 993 by default, TLS 1.2 or newer, the
 *     certificate checked); plain IMAP and STARTTLS are refused by design.
 *   - Egress allow-list (vetting rule 7): the host must be one the adapter
 *     names; anything else fails with `egress` before a socket opens.
 *   - Bounded: each fetched message is at most `maxMessageBytes` (a partial
 *     fetch, `BODY.PEEK[]<0.N>`), each literal and each session's total bytes
 *     are capped, and every command has a timeout.
 *   - Errors are ConnectorErrors with owner-readable messages: a refused
 *     password is `auth`, a throttled account `rate-limit` (retried with
 *     backoff), a dropped connection `offline`.
 *
 * Sync is UID based: the cursor `{"v":1,"uv":"<UIDVALIDITY>","last":<uid>,"p":[uids…]}`
 * remembers the mailbox's UIDVALIDITY, the highest UID seen and the UIDs
 * found but not fetched yet (at most `perSync` are fetched per sync, newest
 * first). A changed UIDVALIDITY starts again from a full sync.
 */
import tls from 'node:tls'
import { ConnectorError, isNetworkError } from './http.mjs'
import { parseMessage } from './mime.mjs'

export const IMAP_TLS_PORT = 993
/** Every command this reader can send. Nothing here changes a mailbox. */
export const READ_COMMANDS = Object.freeze(['CAPABILITY', 'LOGIN', 'LIST', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'LOGOUT'])

const DEFAULT_TIMEOUT = 30_000
const MAX_LINE = 1024 * 1024
const MAX_LITERAL = 2 * 1024 * 1024
const MAX_SESSION_BYTES = 64 * 1024 * 1024
const MAX_PENDING = 1000
const FETCH_CHUNK = 10
const RATE_BACKOFF = Object.freeze([2_000, 8_000])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Open a TLS socket (the production opener). Resolves once the handshake is done. */
export function tlsSocket({ host, port, timeoutMs = DEFAULT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(Object.assign(new Error('TLS connect timed out'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    sock.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Tokenise one IMAP response (text chunks and literal Buffers, in order)
 * into nested arrays: atoms and quoted strings as strings, NIL as null,
 * literals as Buffers, parenthesised lists as arrays. Square brackets stay
 * inside their atom (`BODY[]<0>`, `[UIDVALIDITY`).
 * @param {(string | Buffer)[]} items
 */
export function tokenize(items) {
  const root = []
  const stack = [root]
  const top = () => stack[stack.length - 1]
  for (const item of items) {
    if (Buffer.isBuffer(item)) {
      top().push(item)
      continue
    }
    const s = item
    let i = 0
    while (i < s.length) {
      const c = s[i]
      if (c === ' ') { i++; continue }
      if (c === '(') {
        const list = []
        top().push(list)
        if (stack.length < 32) stack.push(list)
        i++
        continue
      }
      if (c === ')') {
        if (stack.length > 1) stack.pop()
        i++
        continue
      }
      if (c === '"') {
        let j = i + 1
        let out = ''
        while (j < s.length && s[j] !== '"') {
          if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2 } else out += s[j++]
        }
        top().push(out)
        i = j + 1
        continue
      }
      let j = i
      let depth = 0
      while (j < s.length) {
        const d = s[j]
        if (d === '[') depth++
        else if (d === ']') depth = Math.max(0, depth - 1)
        else if (depth === 0 && (d === ' ' || d === '(' || d === ')')) break
        j++
      }
      const atom = s.slice(i, j)
      top().push(atom === 'NIL' ? null : atom)
      i = j
    }
  }
  return root
}

const STATUS_LINE = /^(\S+) (OK|NO|BAD|BYE|PREAUTH)(?: \[([^\]]*)\])? ?(.*)$/i

/** `{ tag, status, code, text }` for a status response line, else null. */
export function parseStatus(line) {
  const m = STATUS_LINE.exec(String(line ?? ''))
  if (!m) return null
  return { tag: m[1], status: m[2].toUpperCase(), code: (m[3] ?? '').slice(0, 200), text: m[4].slice(0, 300) }
}

/** Which ConnectorError a NO/BAD/BYE response is. */
export function errorForStatus({ status, code, text }, what) {
  const s = `${code} ${text}`
  const detail = `${what}: ${status} ${s}`.slice(0, 300)
  if (/AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|EXPIRED|invalid credentials|application-specific password|web login required|username and password not accepted|login failed/i.test(s)) {
    return new ConnectorError('auth', { detail })
  }
  if (/THROTTLED|\bLIMIT\b|too many|bandwidth|rate.?limit|try again later/i.test(s)) {
    return new ConnectorError('rate-limit', { detail, retryAfterMs: 60_000 })
  }
  if (/UNAVAILABLE|SERVERBUG|temporar|system error/i.test(s) || status === 'BYE') return new ConnectorError('server', { detail })
  if (status === 'BAD') return new ConnectorError('bad-response', { detail })
  return new ConnectorError('other', { detail })
}

/**
 * An IMAP quoted string. Values that cannot be sent quoted (line breaks,
 * NUL, characters outside ASCII) are refused rather than sent as literals:
 * this reader only ever quotes a user name, a password and a mailbox name.
 */
export function quote(value, what = 'value') {
  const s = String(value ?? '')
  if (!/^[\x20-\x7e]*$/.test(s)) throw new ConnectorError('auth', { detail: `${what} has characters IMAP LOGIN cannot send` })
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/** An IMAP date (`SINCE 5-Oct-2026`). */
export const imapDate = (ms) => {
  const d = new Date(ms)
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

/** INTERNALDATE (`17-Jul-1996 02:44:25 -0700`) to ms, or null. */
export function parseInternalDate(s) {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\s*$/.exec(String(s ?? ''))
  if (!m) return null
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase())
  if (mon < 0) return null
  const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === '-' ? -1 : 1)
  const t = utc - offset
  return Number.isFinite(t) && t >= 0 ? t : null
}

/**
 * One IMAP connection: reads the greeting, then runs one command at a time.
 * `command(text)` resolves `{ status, code, text, untagged }` for an OK and
 * throws a ConnectorError otherwise; `untagged` holds `{ line, tokens }` for
 * each `*` response seen while the command ran.
 */
export async function openImapConnection({ host, port, openSocket, timeoutMs = DEFAULT_TIMEOUT, maxBytes = MAX_SESSION_BYTES }) {
  let sock
  try {
    sock = await openSocket({ host, port, timeoutMs })
  } catch (err) {
    // An opener that refuses on policy (a private address, task C20) says so itself.
    if (err instanceof ConnectorError) throw err
    // No network, DNS failure, refused, timed out, or a TLS certificate that does not check out.
    const why = isNetworkError(err) ? 'network' : 'tls'
    throw new ConnectorError('offline', { detail: `connect ${host}:${port} (${why}): ${err?.code ?? err?.message ?? err}` })
  }
  let buf = Buffer.alloc(0)
  let total = 0
  let parts = []
  let literal = -1
  const ready = [] // complete responses
  let waiter = null
  let failure = null
  let closed = false
  let sawBye = null

  const wake = () => {
    if (waiter) {
      const w = waiter
      waiter = null
      w()
    }
  }
  const fail = (err) => {
    if (!failure) failure = err
    wake()
  }

  const pump = () => {
    for (;;) {
      if (literal >= 0) {
        if (buf.length < literal) return
        parts.push(Buffer.from(buf.subarray(0, literal)))
        buf = buf.subarray(literal)
        literal = -1
        continue
      }
      const nl = buf.indexOf(0x0a)
      if (nl === -1) {
        if (buf.length > MAX_LINE) fail(new ConnectorError('bad-response', { detail: 'IMAP line too long' }))
        return
      }
      const end = nl > 0 && buf[nl - 1] === 0x0d ? nl - 1 : nl
      const line = buf.subarray(0, end).toString('utf8')
      buf = buf.subarray(nl + 1)
      const m = /\{(\d{1,10})\+?\}$/.exec(line)
      if (m) {
        const n = Number(m[1])
        if (n > MAX_LITERAL) {
          fail(new ConnectorError('bad-response', { detail: `IMAP literal of ${n} bytes is too large` }))
          return
        }
        parts.push(line.slice(0, m.index))
        literal = n
        continue
      }
      parts.push(line)
      ready.push(parts)
      parts = []
      wake()
    }
  }

  sock.on('data', (chunk) => {
    total += chunk.length
    if (total > maxBytes) {
      fail(new ConnectorError('bad-response', { detail: 'IMAP session read too much' }))
      sock.destroy()
      return
    }
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    pump()
  })
  sock.on('error', (err) => fail(new ConnectorError('offline', { detail: `socket: ${err?.code ?? err?.message ?? err}` })))
  sock.on('close', () => {
    closed = true
    fail(sawBye ? errorForStatus(sawBye, 'server closed the connection') : new ConnectorError('offline', { detail: 'connection closed' }))
  })

  /** The next complete response, or throw on failure/timeout. */
  const next = () => {
    if (ready.length) return Promise.resolve(ready.shift())
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null
        sock.destroy()
        reject(new ConnectorError('offline', { detail: 'IMAP server did not answer in time' }))
      }, timeoutMs)
      waiter = () => {
        clearTimeout(timer)
        if (ready.length) resolve(ready.shift())
        else reject(failure ?? new ConnectorError('offline', { detail: 'connection lost' }))
      }
    })
  }

  const close = () => {
    if (!closed) {
      closed = true
      sock.destroy()
    }
  }

  // Greeting.
  let greeting
  try {
    const g = await next()
    greeting = parseStatus(typeof g[0] === 'string' ? g[0] : '')
  } catch (err) {
    close()
    throw err
  }
  if (!greeting || greeting.tag !== '*' || !['OK', 'PREAUTH'].includes(greeting.status)) {
    close()
    throw greeting ? errorForStatus(greeting, 'greeting') : new ConnectorError('bad-response', { detail: 'not an IMAP server' })
  }

  let seq = 0
  const conn = {
    greeting,
    /** Run one command (text after the tag). Never logs the command (it may hold a password). */
    async command(text, what = text.split(' ')[0]) {
      if (failure) throw failure
      const tag = `J${++seq}`
      sock.write(`${tag} ${text}\r\n`)
      const untagged = []
      for (;;) {
        const resp = await next()
        const first = typeof resp[0] === 'string' ? resp[0] : ''
        if (first.startsWith('* ')) {
          const st = parseStatus(first)
          if (st?.status === 'BYE') sawBye = st
          untagged.push({ line: first, tokens: tokenize(resp) })
          continue
        }
        if (first.startsWith('+')) continue // no command here waits on a continuation
        const st = parseStatus(first)
        if (!st || st.tag !== tag) continue
        if (st.status !== 'OK') throw errorForStatus(st, what)
        return { ...st, untagged }
      }
    },
    async logout() {
      try {
        if (!failure && !closed) await conn.command('LOGOUT')
      } catch {
        /* the server may simply close */
      } finally {
        close()
      }
    },
    close,
  }
  return conn
}

/** Read the cursor; null when there is none or it is not ours. */
export function parseImapCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 40_000) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.uv !== 'string' || !/^\d{1,10}$/.test(c.uv)) return null
    if (!Number.isInteger(c.last) || c.last < 0) return null
    const p = Array.isArray(c.p) ? c.p.filter((x) => Number.isInteger(x) && x > 0).slice(0, MAX_PENDING) : []
    return { uv: c.uv, last: c.last, p }
  } catch {
    return null
  }
}

export const imapCursor = (uv, last, p = []) => JSON.stringify({ v: 1, uv, last, p: p.slice(0, MAX_PENDING) })

const asText = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : '')

/** Pairs of a FETCH data list to a plain object (keys upper case). */
function fetchPairs(list) {
  const out = {}
  if (!Array.isArray(list)) return out
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = typeof list[i] === 'string' ? list[i].toUpperCase() : ''
    if (!k) continue
    out[/^BODY\[\]/.test(k) ? 'BODY[]' : k] = list[i + 1]
  }
  return out
}

/**
 * A fetched message for an adapter to turn into a Document:
 *   { uid, uidValidity, internalDate, size, raw (Buffer), truncated, gmail?: { msgid, thrid, labels } }
 * (`uidValidity` is added by sync(); a UID is only unique together with it.)
 * `msgid`/`thrid` are Gmail's 64-bit ids as hex (the same ids the Gmail API
 * and web interface use).
 */
function fetchedMessage(pairs, maxBytes) {
  const uid = Number(pairs.UID)
  if (!Number.isInteger(uid) || uid <= 0) return null
  const raw = Buffer.isBuffer(pairs['BODY[]']) ? pairs['BODY[]'] : Buffer.from(asText(pairs['BODY[]']), 'utf8')
  const size = Number(pairs['RFC822.SIZE'])
  const msg = {
    uid,
    internalDate: parseInternalDate(asText(pairs.INTERNALDATE)),
    size: Number.isFinite(size) ? size : raw.length,
    raw,
    truncated: Number.isFinite(size) ? size > raw.length : raw.length >= maxBytes,
  }
  const hex = (v) => {
    const s = asText(v)
    if (!/^\d{1,20}$/.test(s)) return null
    try {
      return BigInt(s).toString(16)
    } catch {
      return null
    }
  }
  if (pairs['X-GM-MSGID'] !== undefined) {
    msg.gmail = {
      msgid: hex(pairs['X-GM-MSGID']),
      thrid: hex(pairs['X-GM-THRID']),
      labels: Array.isArray(pairs['X-GM-LABELS']) ? pairs['X-GM-LABELS'].map(asText).filter(Boolean).slice(0, 50) : [],
    }
  }
  return msg
}

/**
 * A fetched message to a connector document (plan 38 shape, before the
 * registry's untrusted wrapping). `id` and `url` come from the adapter.
 */
export function mailToDocument(msg, { id, url, meta = {} }) {
  const mail = parseMessage(msg.raw)
  const subject = mail.header('subject')
  const from = mail.header('from')
  const to = mail.header('to')
  const cc = mail.header('cc')
  const date = mail.header('date')
  const lines = []
  if (from) lines.push(`From: ${from}`)
  if (to) lines.push(`To: ${to}`)
  if (cc) lines.push(`Cc: ${cc}`)
  if (date) lines.push(`Date: ${date}`)
  if (subject) lines.push(`Subject: ${subject}`)
  if (mail.attachments.length) {
    lines.push(`Attachments (not opened): ${mail.attachments.slice(0, 20).map((a) => `${a.name} (${a.type})`).join(', ')}`)
  }
  let text = mail.text
  if (msg.truncated && !text.endsWith('[… message shortened]')) text = `${text}\n[… message shortened]`
  const time = msg.internalDate ?? (Date.parse(date) || undefined)
  return {
    id,
    title: subject || '(no subject)',
    text: `${lines.join('\n')}\n\n${text}`.trim(),
    author: from || undefined,
    createdAt: time,
    updatedAt: time,
    sensitivity: 'messages',
    ...(url ? { url } : {}),
    meta: {
      uid: msg.uid,
      attachments: mail.attachments.length,
      ...(to ? { to: to.slice(0, 500) } : {}),
      ...meta,
    },
  }
}

/**
 * The reader. One per adapter; it holds no credentials itself.
 * @param {{
 *   host: string, port?: number, allowedHosts: string[],
 *   openSocket?: (o: { host: string, port: number, timeoutMs: number }) => Promise<import('node:stream').Duplex>,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   mailbox?: 'inbox' | 'all',             'all' = the special-use \All mailbox (Gmail's All Mail), INBOX if none
 *   gmail?: boolean,                        also fetch X-GM-MSGID, X-GM-THRID, X-GM-LABELS
 *   maxMessageBytes?: number,
 * }} opts
 */
export function createImapReader({
  host, port = IMAP_TLS_PORT, allowedHosts, openSocket = tlsSocket,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = DEFAULT_TIMEOUT, mailbox = 'inbox', gmail = false, maxMessageBytes = 256 * 1024,
}) {
  const hostName = String(host ?? '').toLowerCase()
  const maxBytes = Math.max(4096, Math.min(MAX_LITERAL, Math.floor(maxMessageBytes)))
  const fetchItems = `(UID INTERNALDATE RFC822.SIZE${gmail ? ' X-GM-MSGID X-GM-THRID X-GM-LABELS' : ''} BODY.PEEK[]<0.${maxBytes}>)`

  /** Log in, retrying a throttled login with backoff. Returns an open connection. */
  async function login({ user, pass }) {
    if (!Array.isArray(allowedHosts) || !allowedHosts.map((h) => String(h).toLowerCase()).includes(hostName)) {
      throw new ConnectorError('egress', { detail: `IMAP host ${hostName} is not on this connector's allow-list` })
    }
    if (!user || !pass) throw new ConnectorError('not-connected')
    const userQ = quote(user, 'the address')
    const passQ = quote(pass, 'the password')
    for (let attempt = 0; ; attempt++) {
      let conn
      try {
        conn = await openImapConnection({ host: hostName, port, openSocket, timeoutMs })
        if (conn.greeting.status !== 'PREAUTH') {
          const caps = await conn.command('CAPABILITY')
          const capLine = caps.untagged.map((u) => u.line).join(' ')
          if (/\bLOGINDISABLED\b/i.test(capLine)) throw new ConnectorError('auth', { detail: 'server has LOGIN disabled' })
          await conn.command(`LOGIN ${userQ} ${passQ}`, 'LOGIN')
        }
        return conn
      } catch (err) {
        conn?.close()
        if (err instanceof ConnectorError && err.code === 'rate-limit' && attempt < RATE_BACKOFF.length) {
          await sleep(RATE_BACKOFF[attempt])
          continue
        }
        throw err
      }
    }
  }

  /** The mailbox to read, as a quoted name. */
  async function pickMailbox(conn) {
    if (mailbox !== 'all') return 'INBOX'
    const list = await conn.command('LIST "" "*"', 'LIST')
    for (const u of list.untagged) {
      const [, kind, flags, , name] = u.tokens
      if (String(kind).toUpperCase() !== 'LIST' || !Array.isArray(flags)) continue
      if (!flags.some((f) => typeof f === 'string' && f.toLowerCase() === '\\all')) continue
      if (flags.some((f) => typeof f === 'string' && f.toLowerCase() === '\\noselect')) continue
      const n = asText(name)
      if (n && /^[\x20-\x7e]{1,200}$/.test(n)) return n
    }
    return 'INBOX'
  }

  /** EXAMINE (read-only open). Returns `{ name, uidValidity }`. */
  async function examine(conn) {
    const name = await pickMailbox(conn)
    const r = await conn.command(`EXAMINE ${quote(name, 'the mailbox name')}`, 'EXAMINE')
    let uidValidity = null
    for (const u of r.untagged) {
      const m = /\[UIDVALIDITY (\d{1,10})\]/i.exec(u.line)
      if (m) uidValidity = m[1]
    }
    if (!uidValidity) throw new ConnectorError('bad-response', { detail: 'mailbox without UIDVALIDITY' })
    if (r.code && !/READ-ONLY/i.test(r.code)) {
      // EXAMINE must open read-only; a server that says otherwise is not trusted.
      throw new ConnectorError('bad-response', { detail: `EXAMINE answered [${r.code}]` })
    }
    return { name, uidValidity }
  }

  async function uidSearch(conn, criteria) {
    const r = await conn.command(`UID SEARCH ${criteria}`, 'UID SEARCH')
    const uids = new Set()
    for (const u of r.untagged) {
      if (String(u.tokens[1]).toUpperCase() !== 'SEARCH') continue
      for (const t of u.tokens.slice(2)) {
        const n = Number(t)
        if (Number.isInteger(n) && n > 0) uids.add(n)
      }
    }
    return [...uids].sort((a, b) => a - b)
  }

  /** Fetch messages by UID; returns a Map uid -> message (missing = gone). */
  async function uidFetch(conn, uids) {
    const out = new Map()
    if (!uids.length) return out
    const r = await conn.command(`UID FETCH ${uids.join(',')} ${fetchItems}`, 'UID FETCH')
    for (const u of r.untagged) {
      if (String(u.tokens[2]).toUpperCase() !== 'FETCH') continue
      const pairs = fetchPairs(u.tokens[3])
      if (pairs['BODY[]'] === undefined) continue // a flags-only update
      const msg = fetchedMessage(pairs, maxBytes)
      if (msg && uids.includes(msg.uid)) out.set(msg.uid, msg)
    }
    return out
  }

  const reader = {
    host: hostName,
    port,
    /** Log in, open the mailbox read-only, log out. Returns `{ mailbox }`. */
    async check(creds) {
      const conn = await login(creds)
      try {
        const { name } = await examine(conn)
        return { mailbox: name }
      } finally {
        await conn.logout()
      }
    },

    /**
     * Sync. Yields `{ message }` for each fetched message (newest first) and
     * `{ cursor }` checkpoints; the adapter maps messages to documents.
     * @param {{ user: string, pass: string, cursor?: string, since?: number, perSync?: number, maxInitial?: number }} o
     */
    async *sync({ user, pass, cursor, since, perSync = 50, maxInitial = 500 }) {
      const batchSize = Math.max(1, Math.min(500, Math.floor(perSync)))
      const initial = Math.max(1, Math.min(MAX_PENDING, Math.floor(maxInitial)))
      const conn = await login({ user, pass })
      try {
        const { uidValidity } = await examine(conn)
        const state = parseImapCursor(cursor)
        let last
        let pending
        if (state && state.uv === uidValidity) {
          const fresh = (await uidSearch(conn, `UID ${state.last + 1}:*`)).filter((u) => u > state.last)
          last = fresh.length ? fresh[fresh.length - 1] : state.last
          pending = [...fresh.reverse(), ...state.p.filter((u) => !fresh.includes(u))]
        } else {
          // First sync, or the mailbox was rebuilt (new UIDVALIDITY): start again.
          const criteria = Number.isFinite(since) && since > 0 ? `SINCE ${imapDate(since)}` : 'ALL'
          const all = await uidSearch(conn, criteria)
          last = all.length ? all[all.length - 1] : 0
          pending = all.slice(-initial).reverse()
        }
        pending = pending.slice(0, MAX_PENDING)
        const batch = pending.slice(0, batchSize)
        for (let i = 0; i < batch.length; i += FETCH_CHUNK) {
          const chunk = batch.slice(i, i + FETCH_CHUNK)
          const got = await uidFetch(conn, chunk)
          for (const uid of chunk) {
            const message = got.get(uid)
            if (message) yield { message: { ...message, uidValidity } } // missing: expunged since it was found
          }
          yield { cursor: imapCursor(uidValidity, last, pending.slice(i + chunk.length)) }
        }
        yield { cursor: imapCursor(uidValidity, last, pending.slice(batch.length)) }
      } finally {
        await conn.logout()
      }
    },
  }
  return Object.freeze(reader)
}
