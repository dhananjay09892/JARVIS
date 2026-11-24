/**
 * A small SMTP submission client for the email channel (task C50). No
 * dependency: just enough of RFC 5321 / 4954 / 3207 to send one plain-text
 * message through the owner's own mail server.
 *
 * - Encrypted only. Port 465 is implicit TLS; any other port must offer
 *   STARTTLS and the client upgrades before it says a word about credentials.
 *   If the server does not offer STARTTLS, or the upgrade fails, nothing is
 *   sent and the password is never written to the socket (no downgrade).
 *   Port 25 (server-to-server relay) is refused.
 * - The host is the one the owner typed, and nothing else. Private and local
 *   addresses are refused before and during the connection (the same guard
 *   the IMAP reader uses), and TLS certificates are checked.
 * - Header values are single lines: control characters are removed, so text
 *   from a person or a tool cannot add a header or a recipient (header
 *   injection). The body is base64, so no line of it can end the message.
 * - Errors are redacted: the password and its base64 form never appear in a
 *   message, a log line or a thrown error.
 */
import net from 'node:net'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import { blockedAddress, blockedHostname, guardedLookup } from '../net.mjs'
import { guardedTlsSocket } from '../connectors/imap.mjs'

export const SMTP_TLS_PORT = 465
export const SMTP_SUBMISSION_PORT = 587
const DEFAULT_TIMEOUT = 30_000
const MAX_REPLY_LINES = 200
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

/** An error with a code, for the channel's health line: `config`, `egress`, `offline`, `tls`, `auth`, `rejected`, `protocol`. */
export function smtpError(code, message) {
  return Object.assign(new Error(message), { code, name: 'SmtpError' })
}

/**
 * "host" or "host:port" (default 465). Returns `{ host, port, implicitTls }`,
 * or throws a `config` error that says what to fix.
 */
export function parseSmtpServer(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) throw smtpError('config', 'enter the SMTP server, e.g. smtp.example.com')
  const m = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(s)
  if (!m) throw smtpError('config', 'the SMTP server should look like smtp.example.com or smtp.example.com:587')
  const host = m[1].replace(/\.$/, '')
  const port = m[2] === undefined ? SMTP_TLS_PORT : Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw smtpError('config', 'the port must be a number from 1 to 65535')
  if (port === 25) throw smtpError('config', 'port 25 is for mail between servers; use 465 or 587')
  if (isIP(host) ? blockedAddress(host) : !HOSTNAME.test(host)) throw smtpError('config', 'that is not a valid public SMTP server name')
  if (blockedHostname(host)) throw smtpError('config', 'that is a local address; use your mail provider\'s public server')
  return { host, port, implicitTls: port === SMTP_TLS_PORT }
}

/** One line of header text: no control characters, bounded. */
export const headerText = (v, max = 500) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max)

/** RFC 2047 encoded-word for a header that is not plain ASCII. */
export function encodeHeader(v) {
  const s = headerText(v, 300)
  if (/^[\x20-\x7e]*$/.test(s)) return s
  // One word per ≤ 40 bytes of UTF-8, never splitting a character.
  const words = []
  let cur = ''
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 40) {
      words.push(cur)
      cur = ''
    }
    cur += ch
  }
  if (cur) words.push(cur)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ')
}

const ADDRESS = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/
/** A single plain address (`user@host`), or null. */
export const cleanAddress = (v) => (typeof v === 'string' && ADDRESS.test(v.trim()) ? v.trim().toLowerCase() : null)

/** Message-Ids from a header, as `<id>` tokens only. */
export const messageIds = (v) => (String(v ?? '').match(/<[^<>\s@]{1,200}@[^<>\s@]{1,200}>/g) ?? []).slice(-10)

/**
 * The text of one message as it goes on the wire (CRLF lines, base64 body).
 * @param {{ from: string, to: string, subject: string, text: string, inReplyTo?: string, references?: string[], date?: Date, id?: string }} m
 * @returns {{ id: string, data: string }}
 */
export function buildMessage({ from, to, subject, text, inReplyTo, references = [], date = new Date(), id }) {
  const f = cleanAddress(from)
  const t = cleanAddress(to)
  if (!f || !t) throw smtpError('config', 'the sender and recipient must each be one plain address')
  const msgId = id ?? `<${randomBytes(12).toString('hex')}@${f.split('@')[1]}>`
  const refs = references.filter((r) => /^<[^<>\s]{1,400}>$/.test(r)).slice(-10)
  const reply = typeof inReplyTo === 'string' && /^<[^<>\s]{1,400}>$/.test(inReplyTo) ? inReplyTo : null
  const headers = [
    `From: ${f}`,
    `To: ${t}`,
    `Subject: ${encodeHeader(subject) || '(no subject)'}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${msgId}`,
    ...(reply ? [`In-Reply-To: ${reply}`] : []),
    ...(refs.length || reply ? [`References: ${[...new Set([...refs, ...(reply ? [reply] : [])])].join(' ')}`] : []),
    // Other autoresponders (and ours) leave automatic replies alone.
    'Auto-Submitted: auto-replied',
    'X-Auto-Response-Suppress: All',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  const body = Buffer.from(String(text ?? '').replace(/\r\n?/g, '\n'), 'utf8').toString('base64').match(/.{1,76}/g) ?? []
  return { id: msgId, data: `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}\r\n` }
}

/** Dot-stuff and terminate DATA (RFC 5321 §4.5.2). */
const dataBlock = (data) => `${data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}${data.endsWith('\n') ? '' : '\r\n'}.\r\n`

/** The production opener: implicit TLS (465), or a plain socket on a guarded lookup (to upgrade with STARTTLS). */
export function guardedSmtpSocket({ host, port, implicitTls, timeoutMs = DEFAULT_TIMEOUT }) {
  if (implicitTls) return guardedTlsSocket({ host, port, timeoutMs })
  return new Promise((resolve, reject) => {
    if (blockedHostname(host) || (isIP(host) && blockedAddress(host))) {
      reject(smtpError('egress', `refusing ${host}: a private or local address`))
      return
    }
    const sock = net.connect({ host, port, lookup: guardedLookup })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (err) => {
      clearTimeout(timer)
      reject(err?.code === 'EBLOCKEDADDRESS' ? smtpError('egress', err.message) : err)
    })
  })
}

/** Upgrade a plain socket with STARTTLS: TLS 1.2+, certificate checked against the host. */
export function upgradeToTls(sock, host, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: sock, servername: isIP(host) ? undefined : host, minVersion: 'TLSv1.2' })
    const timer = setTimeout(() => {
      secure.destroy()
      reject(Object.assign(new Error('TLS upgrade timed out'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    secure.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(secure)
    })
    secure.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Send one message. Resolves `{ ok: true, id }`. Rejects with an `SmtpError`.
 *
 * @param {object} o
 * @param {{ host: string, port: number, implicitTls: boolean }} o.server  from parseSmtpServer
 * @param {string} o.user  login name (also the From address)
 * @param {string} o.pass
 * @param {string} o.to
 * @param {string} o.subject
 * @param {string} o.text
 * @param {string} [o.inReplyTo]
 * @param {string[]} [o.references]
 * @param {(o: { host: string, port: number, implicitTls: boolean, timeoutMs: number }) => Promise<import('node:stream').Duplex>} [o.openSocket]
 * @param {(sock: import('node:stream').Duplex, host: string, timeoutMs: number) => Promise<import('node:stream').Duplex>} [o.startTls]
 */
export async function sendMail({ server, user, pass, to, subject, text, inReplyTo, references, date, id, openSocket = guardedSmtpSocket, startTls = upgradeToTls, timeoutMs = DEFAULT_TIMEOUT }) {
  const from = cleanAddress(user)
  if (!from) throw smtpError('config', 'the mailbox user name must be the full email address')
  if (!pass) throw smtpError('config', 'the mailbox password is not set')
  const built = buildMessage({ from, to, subject, text, inReplyTo, references, date, id })
  const secrets = [pass, Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64'), Buffer.from(pass).toString('base64')]
  const scrub = (s) => secrets.reduce((acc, x) => (x ? acc.split(x).join('[redacted]') : acc), String(s ?? ''))

  let sock
  try {
    sock = await openSocket({ host: server.host, port: server.port, implicitTls: server.implicitTls, timeoutMs })
  } catch (err) {
    if (err?.name === 'SmtpError') throw err
    const tlsFault = /certificate|self.signed|TLS|SSL|altname|hostname/i.test(String(err?.code ?? '') + String(err?.message ?? ''))
    throw smtpError(tlsFault ? 'tls' : 'offline', `connect ${server.host}:${server.port}: ${scrub(err?.code ?? err?.message)}`)
  }

  let secure = server.implicitTls
  let buffer = ''
  let failure = null
  let wake = null
  const lines = []
  const attach = (s) => {
    s.setEncoding?.('utf8')
    s.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 64 * 1024) {
        failure ??= smtpError('protocol', 'the SMTP server sent too much')
        s.destroy()
      }
      let i
      while ((i = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, i).replace(/\r$/, ''))
        buffer = buffer.slice(i + 1)
      }
      wake?.()
    })
    s.on('error', (err) => {
      failure ??= smtpError('offline', `socket: ${scrub(err?.code ?? err?.message)}`)
      wake?.()
    })
    s.on('close', () => {
      failure ??= smtpError('offline', 'the SMTP server closed the connection')
      wake?.()
    })
  }
  attach(sock)

  const nextLine = () =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (lines.length) {
          wake = null
          clearTimeout(timer)
          resolve(lines.shift())
        } else if (failure) {
          wake = null
          clearTimeout(timer)
          reject(failure)
        }
      }
      const timer = setTimeout(() => {
        wake = null
        failure ??= smtpError('offline', 'the SMTP server did not answer in time')
        sock.destroy()
        reject(failure)
      }, timeoutMs)
      wake = check
      check()
    })

  /** One (possibly multi-line) reply: `{ code, lines }`. */
  async function reply() {
    const got = []
    for (let n = 0; n < MAX_REPLY_LINES; n++) {
      const line = await nextLine()
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) throw smtpError('protocol', 'the SMTP server sent something that is not SMTP')
      got.push(m[3])
      if (m[2] === ' ') return { code: Number(m[1]), lines: got }
    }
    throw smtpError('protocol', 'the SMTP server sent too many lines')
  }

  async function command(line, ok, what) {
    sock.write(`${line}\r\n`)
    const r = await reply()
    if (!ok.includes(r.code)) {
      throw smtpError(what === 'auth' ? 'auth' : 'rejected', `${what}: ${r.code} ${scrub(r.lines[0]).slice(0, 120)}`)
    }
    return r
  }

  try {
    const hello = await reply()
    if (hello.code !== 220) throw smtpError('protocol', `greeting: ${hello.code}`)
    let ehlo = await command('EHLO jarvis.local', [250], 'ehlo')
    if (!secure) {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw smtpError('tls', 'this server does not offer STARTTLS; JARVIS will not send a password in the clear')
      await command('STARTTLS', [220], 'starttls')
      sock.removeAllListeners('data')
      try {
        sock = await startTls(sock, server.host, timeoutMs)
      } catch (err) {
        throw smtpError('tls', `STARTTLS upgrade failed: ${scrub(err?.code ?? err?.message)}`)
      }
      buffer = ''
      lines.length = 0
      attach(sock)
      secure = true
      ehlo = await command('EHLO jarvis.local', [250], 'ehlo')
    }
    const mechs = ehlo.lines.map((l) => /^AUTH[ =](.*)$/i.exec(l)?.[1]?.toUpperCase().split(/\s+/)).find(Boolean) ?? []
    if (mechs.includes('PLAIN')) {
      await command(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64')}`, [235], 'auth')
    } else if (mechs.includes('LOGIN')) {
      await command('AUTH LOGIN', [334], 'auth')
      await command(Buffer.from(user).toString('base64'), [334], 'auth')
      await command(Buffer.from(pass).toString('base64'), [235], 'auth')
    } else {
      throw smtpError('auth', 'the server offers no password sign-in (PLAIN or LOGIN)')
    }
    await command(`MAIL FROM:<${from}>`, [250], 'mail')
    await command(`RCPT TO:<${cleanAddress(to)}>`, [250, 251], 'rcpt')
    await command('DATA', [354], 'data')
    sock.write(dataBlock(built.data))
    const done = await reply()
    if (done.code !== 250) throw smtpError('rejected', `send: ${done.code} ${scrub(done.lines[0]).slice(0, 120)}`)
    try {
      sock.write('QUIT\r\n')
    } catch {}
    return { ok: true, id: built.id }
  } catch (err) {
    if (err?.name === 'SmtpError') {
      err.message = scrub(err.message)
      throw err
    }
    throw smtpError('protocol', scrub(err?.message ?? err))
  } finally {
    sock.destroy()
  }
}
