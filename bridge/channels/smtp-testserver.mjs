// A fake SMTP submission server for the email channel's tests (task C50).
// It speaks just enough SMTP: EHLO, STARTTLS (a stub that does not encrypt),
// AUTH PLAIN or LOGIN, MAIL, RCPT, DATA, QUIT. Not a test file itself.
import net from 'node:net'

export const SMTP_USER = 'jarvis@example.com'
export const SMTP_PASS = String.fromCharCode(...Array.from({ length: 16 }, (_, i) => 97 + i))

/**
 * @param {{ user?: string, pass?: string, starttls?: boolean, authBeforeTls?: boolean, auth?: 'plain'|'login'|'none', rejectRcpt?: boolean, rejectData?: boolean }} [opts]
 */
export async function startFakeSmtp({ user = SMTP_USER, pass = SMTP_PASS, starttls = true, authBeforeTls = false, auth = 'plain', rejectRcpt = false, rejectData = false } = {}) {
  const state = { commands: [], messages: [], connections: 0, hosts: [] }
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    state.connections++
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    let buf = ''
    let tlsOn = state.nextImplicit === true // a port-465 connection is encrypted from the first byte
    state.nextImplicit = false
    let stage = 'cmd'
    let loginStep = 0
    let authed = false
    let mailFrom = null
    let rcpt = []
    let data = ''
    const out = (s) => sock.write(`${s}\r\n`)
    out('220 fake.example.com ESMTP ready')
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (;;) {
        if (stage === 'data') {
          const end = buf.indexOf('\r\n.\r\n')
          if (end === -1) return
          data = buf.slice(0, end + 2)
          buf = buf.slice(end + 5)
          // undo dot-stuffing
          const body = data.replace(/^\.\./gm, '.')
          stage = 'cmd'
          if (rejectData) {
            out('554 5.7.1 Message refused')
          } else {
            state.messages.push({ from: mailFrom, to: [...rcpt], data: body, authed, tls: tlsOn })
            out('250 2.0.0 queued')
          }
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl === -1) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        if (stage === 'login') {
          if (loginStep === 0) {
            loginStep = 1
            out('334 UGFzc3dvcmQ6')
          } else {
            authed = Buffer.from(line, 'base64').toString() === pass
            stage = 'cmd'
            out(authed ? '235 2.7.0 Accepted' : '535 5.7.8 Authentication failed')
          }
          state.commands.push('LOGIN-STEP [masked]')
          continue
        }
        const verb = line.split(' ')[0].toUpperCase()
        state.commands.push(verb === 'AUTH' ? 'AUTH [masked]' : line)
        if (verb === 'EHLO') {
          const lines = ['fake.example.com']
          if (starttls && !tlsOn) lines.push('STARTTLS')
          if (auth !== 'none' && (tlsOn || authBeforeTls)) lines.push(auth === 'plain' ? 'AUTH PLAIN LOGIN' : 'AUTH LOGIN')
          lines.push('8BITMIME')
          lines.forEach((l, i) => out(`250${i === lines.length - 1 ? ' ' : '-'}${l}`))
        } else if (verb === 'STARTTLS') {
          tlsOn = true
          out('220 Ready to start TLS')
        } else if (verb === 'AUTH') {
          const [, mech, cred] = line.split(' ')
          if (mech.toUpperCase() === 'PLAIN') {
            const [, u, p] = Buffer.from(cred ?? '', 'base64').toString().split('\u0000')
            authed = u === user && p === pass
            out(authed ? '235 2.7.0 Accepted' : '535 5.7.8 Authentication failed')
          } else {
            stage = 'login'
            loginStep = 0
            out('334 VXNlcm5hbWU6')
          }
        } else if (verb === 'MAIL') {
          mailFrom = /<([^>]*)>/.exec(line)?.[1]
          rcpt = []
          out(authed ? '250 2.1.0 OK' : '530 5.7.0 Authentication required')
        } else if (verb === 'RCPT') {
          if (rejectRcpt) out('550 5.1.1 No such user')
          else {
            rcpt.push(/<([^>]*)>/.exec(line)?.[1])
            out('250 2.1.5 OK')
          }
        } else if (verb === 'DATA') {
          stage = 'data'
          out('354 End data with <CR><LF>.<CR><LF>')
        } else if (verb === 'QUIT') {
          out('221 Bye')
          sock.end()
        } else {
          out('502 Command not implemented')
        }
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    state,
    port,
    openSocket({ host, implicitTls }) {
      state.hosts.push(host)
      state.nextImplicit = implicitTls === true
      return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1')
        s.once('connect', () => resolve(s))
        s.once('error', reject)
      })
    },
    /** A STARTTLS stand-in: the fake does not encrypt, so the socket is handed back. */
    startTls: async (sock) => sock,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

/** Decode a captured message to `{ headers, body }` (the body is base64 text/plain). */
export function decodeSent(data) {
  const [head, ...rest] = data.split('\r\n\r\n')
  const headers = {}
  for (const l of head.split('\r\n')) {
    const i = l.indexOf(':')
    headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim()
  }
  return { headers, body: Buffer.from(rest.join('\r\n\r\n').replace(/\s+/g, ''), 'base64').toString('utf8') }
}
