/**
 * A fake IMAP server for connector tests (task C09; reused by the generic
 * IMAP and Outlook connectors). It listens on 127.0.0.1 over plain TCP and
 * hands tests an `openSocket` to inject in place of the TLS opener, so the
 * real client code runs end to end with no network and no real account.
 *
 * It speaks just enough IMAP4rev1 (plus Gmail's X-GM-* fetch items) for the
 * reader, records every command (passwords masked), and can be told to
 * misbehave: refuse logins, throttle, drop the connection, go silent, or
 * lose a message between SEARCH and FETCH (`state.expunged`).
 */
import net from 'node:net'
import { tokenize } from './imap-reader.mjs'

/**
 * The fake mailbox's app password: a fixture, not a secret. Built at run time
 * so secret scanners do not mistake a test value for a hardcoded password.
 */
export const FAKE_APP_PASSWORD = String.fromCharCode(...Array.from({ length: 16 }, (_, i) => 97 + i))
/** Four groups of four, as Google shows app passwords. */
export const spacedPassword = (p, sep = ' ') => p.match(/.{1,4}/g).join(sep)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** INTERNALDATE text for ms (UTC). */
export function internalDate(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

/** A simple RFC 5322 message. */
export function rawMail({ from = 'Alice <alice@example.com>', to = 'me@gmail.com', subject = 'Hello', date = 'Mon, 19 Oct 2026 09:00:00 +0000', body = 'Hi there.', headers = '' } = {}) {
  return Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@example.com>\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n${headers}\r\n${body}\r\n`,
    'utf8',
  )
}

/**
 * Start a fake server.
 * @param {{
 *   user?: string, pass?: string,
 *   uidValidity?: string,
 *   messages?: { uid: number, raw: Buffer, at?: number, msgid?: string, thrid?: string, labels?: string[] }[],
 *   allMailbox?: string | null,              name of the \All mailbox (null: none)
 *   throttleLogins?: number,                 refuse this many logins with [THROTTLED]
 *   dropAfter?: string,                      close the socket when this command arrives
 *   silentAfter?: string,                    stop answering when this command arrives
 *   greeting?: string,
 * }} [opts]
 */
export async function startFakeImap({
  user = 'me@gmail.com', pass = FAKE_APP_PASSWORD, uidValidity = '700', messages = [],
  allMailbox = '[Gmail]/All Mail', throttleLogins = 0, dropAfter, silentAfter, greeting = '* OK Fake IMAP ready',
} = {}) {
  const state = { uidValidity, messages: [...messages], throttleLogins, commands: [], hosts: [], connections: 0, open: 0, expunged: new Set() }
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    state.connections++
    state.open++
    sock.on('close', () => { state.open--; sockets.delete(sock) })
    sock.on('error', () => {})
    let buf = ''
    let silent = false
    let authed = false
    let selected = null
    sock.write(`${greeting}\r\n`)
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        if (silent) continue
        const sp = line.indexOf(' ')
        const tag = line.slice(0, sp)
        const rest = line.slice(sp + 1)
        const upper = rest.toUpperCase()
        const verb = upper.startsWith('UID ') ? upper.split(' ').slice(0, 2).join(' ') : upper.split(' ')[0]
        state.commands.push(verb === 'LOGIN' ? `${tag} LOGIN [masked]` : `${tag} ${rest}`)
        const out = (s) => sock.write(`${s}\r\n`)
        if (dropAfter && verb === dropAfter) { sock.destroy(); return }
        if (silentAfter && verb === silentAfter) { silent = true; continue }
        if (verb === 'CAPABILITY') {
          out('* CAPABILITY IMAP4rev1 X-GM-EXT-1 SPECIAL-USE')
          out(`${tag} OK Done`)
        } else if (verb === 'LOGIN') {
          const [, , u, p] = tokenize([line])
          if (state.throttleLogins > 0) {
            state.throttleLogins--
            out(`${tag} NO [THROTTLED] Too many login attempts, try again later`)
          } else if (u !== user || p !== pass) {
            out(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`)
          } else {
            authed = true
            out(`${tag} OK ${user} authenticated (Success)`)
          }
        } else if (verb === 'LOGOUT') {
          out('* BYE LOGOUT Requested')
          out(`${tag} OK 73 good day (Success)`)
          sock.end()
        } else if (!authed) {
          out(`${tag} BAD Not authenticated`)
        } else if (verb === 'LIST') {
          out('* LIST (\\HasNoChildren) "/" "INBOX"')
          out('* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"')
          if (allMailbox) out(`* LIST (\\All \\HasNoChildren) "/" "${allMailbox}"`)
          out('* LIST (\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"')
          out(`${tag} OK Success`)
        } else if (verb === 'EXAMINE') {
          const [, , name] = tokenize([line])
          selected = name
          out('* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)')
          out(`* ${state.messages.length} EXISTS`)
          out(`* OK [UIDVALIDITY ${state.uidValidity}] UIDs valid.`)
          out(`${tag} OK [READ-ONLY] ${name} selected. (Success)`)
        } else if (verb === 'UID SEARCH') {
          if (!selected) { out(`${tag} BAD No mailbox selected`); continue }
          const crit = rest.slice('UID SEARCH '.length).trim()
          const uids = state.messages.map((m) => m.uid).sort((a, b) => a - b)
          let hits = uids
          const range = /^UID (\d+):\*$/i.exec(crit)
          const since = /^SINCE (\S+)$/i.exec(crit)
          if (range) {
            const from = Number(range[1])
            hits = uids.filter((u) => u >= from)
            // RFC 3501: n:* always includes the highest UID, even when it is below n.
            if (!hits.length && uids.length) hits = [uids[uids.length - 1]]
          } else if (since) {
            const day = Date.parse(`${since[1].replace(/-/g, ' ')} 00:00:00 UTC`)
            hits = state.messages.filter((m) => (m.at ?? 0) >= day).map((m) => m.uid).sort((a, b) => a - b)
          }
          out(`* SEARCH${hits.length ? ` ${hits.join(' ')}` : ''}`)
          out(`${tag} OK SEARCH completed (Success)`)
        } else if (verb === 'UID FETCH') {
          const m = /^UID FETCH (\S+) \((.*)\)$/i.exec(rest)
          if (!m) { out(`${tag} BAD bad fetch`); continue }
          const want = new Set(m[1].split(',').map(Number))
          const partial = /BODY\.PEEK\[\]<0\.(\d+)>/i.exec(m[2])
          const peek = /BODY\.PEEK\[\]/i.test(m[2])
          state.messages.forEach((msg, i) => {
            if (!want.has(msg.uid) || state.expunged.has(msg.uid)) return // expunged after SEARCH
            const raw = partial ? msg.raw.subarray(0, Number(partial[1])) : msg.raw
            let items = `UID ${msg.uid} INTERNALDATE "${internalDate(msg.at ?? 1_790_000_000_000)}" RFC822.SIZE ${msg.raw.length}`
            if (/X-GM-MSGID/i.test(m[2]) && msg.msgid) {
              items += ` X-GM-MSGID ${msg.msgid} X-GM-THRID ${msg.thrid ?? msg.msgid}`
              items += ` X-GM-LABELS (${(msg.labels ?? ['\\Inbox']).map((l) => `"${l.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(' ')})`
            }
            if (!peek) items += ' FLAGS (\\Seen)' // a non-PEEK read would mark it read
            sock.write(`* ${i + 1} FETCH (${items} BODY[]${partial ? '<0>' : ''} {${raw.length}}\r\n`)
            sock.write(raw)
            sock.write(')\r\n')
          })
          out(`${tag} OK Success`)
        } else {
          out(`${tag} BAD Command not allowed here`)
        }
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    state,
    port,
    /** Injected in place of tlsSocket: records the host asked for, connects to the fake. */
    openSocket({ host }) {
      state.hosts.push(host)
      return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1')
        s.once('connect', () => resolve(s))
        s.once('error', reject)
      })
    },
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}
