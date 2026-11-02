/**
 * The one-shot loopback listener a guided sign-in (pattern 1) waits on for the
 * provider's redirect. Shared by the Google (task C04) and Microsoft (task
 * C21) OAuth modules; moved here unchanged from google-oauth.mjs, with one
 * addition: `publicHost`, the host name the browser is sent to.
 *
 *   - Binds `bindHost` (127.0.0.1) only, never a public interface.
 *   - Answers GET on one path, checks the Host header against
 *     `publicHost:<port>` (DNS rebinding) and `state` (CSRF), never echoes
 *     what it was sent, and closes after one result or after `timeoutMs`.
 *
 * Google wants http://127.0.0.1:<port>. Microsoft's app registration portal
 * accepts http://localhost (port ignored) for desktop apps but needs a
 * manifest edit for http://127.0.0.1, so the Microsoft module sends the
 * browser to http://localhost:<port>; the socket is still 127.0.0.1 only.
 */
import { createServer } from 'node:http'

const PAGE = (title, line) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;background:#05080d;color:#cfe8ff;padding:3rem">` +
  `<h1 style="font-weight:400">${title}</h1><p>${line}</p></body>`

const PUBLIC_HOSTS = new Set(['127.0.0.1', 'localhost'])

/**
 * Listen once for the provider's redirect.
 * @param {{ state: string, timeoutMs: number, bindHost?: string, publicHost?: '127.0.0.1'|'localhost' }} opts
 * @returns {Promise<{ redirectUri: string, result: Promise<{ code?: string, error?: string }>, close(): void }>}
 */
export function listenOnce({ state, timeoutMs, bindHost = '127.0.0.1', publicHost = '127.0.0.1' }) {
  if (!PUBLIC_HOSTS.has(publicHost)) throw new Error('The sign-in listener only answers a loopback name.')
  return new Promise((resolveListen, rejectListen) => {
    let settle
    const result = new Promise((r) => { settle = r })
    let done = false
    let port = 0
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(value)
      // Let the browser get its page before the socket goes away.
      setImmediate(() => server.close())
    }
    const server = createServer((req, res) => {
      const reply = (status, title, line) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(PAGE(title, line))
      }
      if (done) return reply(410, 'Already finished', 'This sign-in is over. Start again from Settings → Connectors in JARVIS.')
      if (req.method !== 'GET' || req.headers.host !== `${publicHost}:${port}`) return reply(400, 'Not here', 'This address only answers the JARVIS sign-in.')
      let u
      try {
        u = new URL(req.url, `http://${publicHost}:${port}`)
      } catch {
        return reply(400, 'Not here', 'This address only answers the JARVIS sign-in.')
      }
      if (u.pathname !== '/') return reply(404, 'Not here', 'This address only answers the JARVIS sign-in.')
      const q = u.searchParams
      // A reply without the right state is not the provider's answer to this sign-in: ignore it.
      if (q.get('state') !== state) return reply(400, 'Sign-in not recognised', 'Start again from Settings → Connectors in JARVIS.')
      if (q.get('error')) {
        reply(200, 'Sign-in cancelled', 'Nothing was connected. You can close this tab.')
        return finish({ error: q.get('error') === 'access_denied' ? 'access_denied' : 'other' })
      }
      const code = q.get('code')
      if (!code || code.length > 4096) return reply(400, 'Sign-in not recognised', 'Start again from Settings → Connectors in JARVIS.')
      reply(200, 'Signed in', 'JARVIS has what it needs. You can close this tab.')
      finish({ code })
    })
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs)
    server.on('error', (err) => {
      if (!server.listening) rejectListen(err)
    })
    server.listen(0, bindHost, () => {
      port = server.address().port
      resolveListen({ redirectUri: `http://${publicHost}:${port}`, result, close: () => finish({ error: 'cancelled' }) })
    })
  })
}
