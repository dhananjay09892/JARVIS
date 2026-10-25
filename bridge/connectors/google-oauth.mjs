/**
 * The shared Google OAuth module (task C04) for the Gmail, Calendar, Drive,
 * Contacts and Tasks connectors. Each of those adapters builds one of these in
 * its `create(ctx)` and leaves sign-in, refresh and revocation to it.
 *
 * Google's flow for desktop apps (OAuth 2.0 for Desktop Apps, checked
 * 2026-10-25 at developers.google.com/identity/protocols/oauth2/native-app):
 *   1. Authorization request to accounts.google.com/o/oauth2/v2/auth with
 *      PKCE (S256), a random `state`, and a loopback redirect
 *      http://127.0.0.1:<random port> that JARVIS listens on for one reply.
 *   2. Google redirects the browser back with `code` (or `error=access_denied`).
 *   3. The code and the PKCE verifier are exchanged at
 *      oauth2.googleapis.com/token for an access token and a refresh token.
 *      The `scope` field says what the owner actually granted (granular
 *      consent lets them untick boxes), so it is checked.
 *   4. Access tokens are refreshed with the refresh token; `invalid_grant`
 *      means it was revoked or expired, and the owner must reconnect.
 *   5. Disconnect revokes at oauth2.googleapis.com/revoke, then forgets.
 *
 * Choices made here:
 *   - One grant per connector, not one shared grant. Google does not support
 *     incremental authorization for installed apps, and separate grants mean
 *     Gmail asks only for Gmail's scope, and disconnecting Calendar revokes
 *     only Calendar's token. Scopes come from GOOGLE_SCOPES (read-only only);
 *     a connector cannot ask for anything else.
 *   - The OAuth *client* (client ID, and the client secret Google issues to
 *     Desktop clients, which Google itself treats as not confidential) is
 *     shared: the owner creates one Google Cloud client (task C05) and pastes
 *     it once. It lives in the credential store under the `google` id, apart
 *     from every connector, so no adapter can read another's tokens.
 *   - Tokens live only in the connector's own scoped credential view (the OS
 *     keychain since Q20). Nothing is logged; errors are ConnectorErrors with
 *     fixed owner-readable messages.
 *   - The loopback listener binds 127.0.0.1 only, answers one path, checks the
 *     Host header (DNS rebinding) and `state` (CSRF), never echoes what it was
 *     sent, and closes after one result or after `timeoutMs`.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createHttp, ConnectorError } from './http.mjs'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GOOGLE_OAUTH_HOST = 'oauth2.googleapis.com'

/** The credential-store id the shared OAuth client is kept under. */
export const GOOGLE_CLIENT_ID = 'google'

const S = 'https://www.googleapis.com/auth/'
/**
 * The smallest read-only scopes for each Google connector. Writes (send mail,
 * create events) would be separate scopes on a separate, approval-gated
 * capability, added by their own task — never here by default.
 * Drive, Contacts and Tasks scopes are re-checked in their own tasks (*verify*).
 */
export const GOOGLE_SCOPES = Object.freeze({
  gmail: Object.freeze([`${S}gmail.readonly`]),
  gcalendar: Object.freeze([`${S}calendar.events.readonly`, `${S}calendar.calendarlist.readonly`]),
  gdrive: Object.freeze([`${S}drive.readonly`]),
  gcontacts: Object.freeze([`${S}contacts.readonly`]),
  google_tasks: Object.freeze([`${S}tasks.readonly`]),
})

/** A Google OAuth client ID as the Cloud Console issues it. */
export const CLIENT_ID_SHAPE = /^[0-9]{6,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/
const MAX_SECRET = 512
const REFRESH_EARLY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** The setup steps every Google card shows (pattern 1, guided sign-in). */
export const GOOGLE_SETUP_STEPS = Object.freeze([
  'Open Google Cloud Console and create (or pick) a project.',
  'Enable the API for this connector (for example the Gmail API).',
  'On the OAuth consent screen, add your own Google address as a test user.',
  'Create an OAuth client of type "Desktop app".',
  'Paste its client ID and client secret here once; every Google connector reuses them.',
  'Press Connect, then approve the read-only access on Google\'s page.',
])
export const GOOGLE_HELP_URL = 'https://console.cloud.google.com/apis/credentials'

/** base64url without padding, as PKCE wants. */
const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** PKCE verifier (43 chars from 32 random bytes) and its S256 challenge. */
export function pkcePair(randomBytes = nodeRandomBytes) {
  const verifier = b64url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * The shared OAuth client the owner pastes once (task C05).
 * @param {{ get(k: string): string|null, set(k: string, v: string): void, delete(k: string): void }} store
 *        a credential view scoped to GOOGLE_CLIENT_ID
 */
export function createGoogleClient(store) {
  if (!store || typeof store.get !== 'function') throw new Error('The Google client needs a scoped credential view.')
  return Object.freeze({
    /** Save a pasted client. Throws ConnectorError('setup-needed') when it does not look right. */
    save({ clientId, clientSecret } = {}) {
      const id = typeof clientId === 'string' ? clientId.trim() : ''
      if (!CLIENT_ID_SHAPE.test(id)) throw new ConnectorError('setup-needed', { detail: 'client id shape' })
      store.set('client_id', id)
      const secret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
      if (secret) {
        if (secret.length > MAX_SECRET || /[\s\u0000-\u001f]/.test(secret)) throw new ConnectorError('setup-needed', { detail: 'client secret shape' })
        store.set('client_secret', secret)
      } else {
        store.delete('client_secret')
      }
    },
    /** The client, or null before the owner has pasted one. */
    get() {
      const clientId = store.get('client_id')
      if (!clientId) return null
      return { clientId, clientSecret: store.get('client_secret') ?? null }
    },
    /** For the card: is a client set? The ID is not secret; the secret is never shown. */
    describe() {
      const clientId = store.get('client_id')
      return { set: Boolean(clientId), clientId: clientId ?? null, hasSecret: Boolean(store.get('client_secret')) }
    },
    clear() {
      store.delete('client_id')
      store.delete('client_secret')
    },
  })
}

/** Is a Google token reply's `scope` covering every requested scope? */
export function missingScopes(requested, grantedText) {
  const granted = new Set(String(grantedText ?? '').split(/\s+/).filter(Boolean))
  return requested.filter((s) => !granted.has(s))
}

const PAGE = (title, line) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;background:#05080d;color:#cfe8ff;padding:3rem">` +
  `<h1 style="font-weight:400">${title}</h1><p>${line}</p></body>`

/**
 * Listen once on 127.0.0.1 for Google's redirect.
 * @returns {Promise<{ redirectUri: string, result: Promise<{ code?: string, error?: string }>, close(): void }>}
 */
function listenOnce({ state, timeoutMs, host = '127.0.0.1' }) {
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
      if (req.method !== 'GET' || req.headers.host !== `${host}:${port}`) return reply(400, 'Not here', 'This address only answers the JARVIS sign-in.')
      let u
      try {
        u = new URL(req.url, `http://${host}:${port}`)
      } catch {
        return reply(400, 'Not here', 'This address only answers the JARVIS sign-in.')
      }
      if (u.pathname !== '/') return reply(404, 'Not here', 'This address only answers the JARVIS sign-in.')
      const q = u.searchParams
      // A reply without the right state is not Google's answer to this sign-in: ignore it.
      if (q.get('state') !== state) return reply(400, 'Sign-in not recognised', 'Start again from Settings → Connectors in JARVIS.')
      if (q.get('error')) {
        reply(200, 'Sign-in cancelled', 'Nothing was connected. You can close this tab.')
        return finish({ error: q.get('error') === 'access_denied' ? 'access_denied' : 'other' })
      }
      const code = q.get('code')
      if (!code || code.length > 2048) return reply(400, 'Sign-in not recognised', 'Start again from Settings → Connectors in JARVIS.')
      reply(200, 'Signed in', 'JARVIS has what it needs. You can close this tab.')
      finish({ code })
    })
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs)
    server.on('error', (err) => {
      if (!server.listening) rejectListen(err)
    })
    server.listen(0, host, () => {
      port = server.address().port
      resolveListen({ redirectUri: `http://${host}:${port}`, result, close: () => finish({ error: 'cancelled' }) })
    })
  })
}

/**
 * Sign-in, refresh and revocation for one Google connector.
 * @param {{
 *   connectorId: keyof typeof GOOGLE_SCOPES,
 *   credentials: any,              the connector's own scoped credential view
 *   client: ReturnType<typeof createGoogleClient>,
 *   fetch?: typeof globalThis.fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   randomBytes?: (n: number) => Buffer,
 *   timeoutMs?: number,            how long to wait for the browser (default 5 min)
 * }} opts
 */
export function createGoogleOAuth({
  connectorId,
  credentials,
  client,
  fetch = globalThis.fetch,
  sleep,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const scopes = GOOGLE_SCOPES[connectorId]
  if (!scopes) throw new Error(`No Google scopes are defined for ${connectorId}.`)
  if (!credentials || typeof credentials.get !== 'function') throw new Error('Google OAuth needs the connector\'s credential view.')
  if (!client || typeof client.get !== 'function') throw new Error('Google OAuth needs the shared Google client.')
  const http = createHttp({ fetch, sleep, now, allowedHosts: [GOOGLE_OAUTH_HOST] })

  let pending = null // { listener, promise }
  let lastError = null // ConnectorError from the last sign-in or refresh
  let refreshing = null

  const form = (fields) => {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) body.set(k, v)
    return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }
  }

  const needClient = () => {
    const c = client.get()
    if (!c) throw new ConnectorError('setup-needed', { detail: 'no Google client' })
    return c
  }

  const forget = () => {
    for (const k of ['refresh_token', 'access_token', 'access_expires', 'granted_scopes']) credentials.delete(k)
  }

  /** Keep a token reply. Returns the access token. */
  const keep = (body, { refresh } = {}) => {
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new ConnectorError('bad-response', { detail: 'no access_token' })
    }
    const secs = Number(body.expires_in)
    const expires = now() + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : 3_600_000)
    if (typeof body.refresh_token === 'string' && body.refresh_token) credentials.set('refresh_token', body.refresh_token)
    else if (!refresh) throw new ConnectorError('bad-response', { detail: 'no refresh_token' })
    credentials.set('access_token', body.access_token)
    credentials.set('access_expires', String(expires))
    if (typeof body.scope === 'string' && body.scope) credentials.set('granted_scopes', body.scope.slice(0, 2000))
    return body.access_token
  }

  /** Best-effort revocation at Google. True when Google confirmed it. */
  const revokeAtGoogle = async (token) => {
    if (!token) return false
    try {
      // In the form body, not the query string, so the token is in no URL.
      await http.json(GOOGLE_REVOKE_URL, form({ token }))
      return true
    } catch {
      return false
    }
  }

  async function complete(listener, verifier) {
    const r = await listener.result
    if (r.error) {
      throw new ConnectorError('consent-denied', { detail: r.error })
    }
    const c = needClient()
    const body = await http.json(GOOGLE_TOKEN_URL, form({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code: r.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: listener.redirectUri,
    }))
    const missing = missingScopes(scopes, body?.scope)
    if (missing.length) {
      // Granular consent: the owner unticked what this connector needs. Do not
      // keep a token that cannot do the job; give it back.
      await revokeAtGoogle(body?.refresh_token ?? body?.access_token)
      throw new ConnectorError('consent-denied', { detail: `missing ${missing.length} scope(s)` })
    }
    keep(body)
  }

  const oauth = {
    connectorId,
    scopes,

    /**
     * Start a sign-in. Saves a pasted client first if one is given.
     * Returns `{ url, detail }` for the Settings card: the page opens `url`.
     */
    async begin({ clientId, clientSecret } = {}) {
      if (clientId !== undefined && clientId !== null && clientId !== '') client.save({ clientId, clientSecret })
      const c = needClient()
      oauth.cancel()
      const state = b64url(randomBytes(24))
      const { verifier, challenge } = pkcePair(randomBytes)
      const listener = await listenOnce({ state, timeoutMs })
      const url = new URL(GOOGLE_AUTH_URL)
      url.search = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: listener.redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
      }).toString()
      lastError = null
      const entry = { listener }
      // Only the current sign-in may set the card's state: a cancelled earlier
      // one finishing late must not overwrite it.
      entry.promise = complete(listener, verifier).then(
        () => { if (pending === entry) lastError = null },
        (err) => {
          const e = err instanceof ConnectorError ? err : new ConnectorError('other', { detail: err?.name })
          if (pending === entry) lastError = e
          throw e
        },
      ).finally(() => {
        if (pending === entry) pending = null
      })
      entry.promise.catch(() => {}) // the card reads lastError; no unhandled rejection
      pending = entry
      return { url: url.href, detail: 'Finish signing in on Google\'s page, then come back and press Test.' }
    },

    /** Resolves when the current sign-in finishes; rejects with its ConnectorError. */
    async waitForSignIn() {
      if (!pending) {
        if (lastError) throw lastError
        return
      }
      await pending.promise
    },

    /** Stop waiting for a sign-in in progress. */
    cancel() {
      if (pending) pending.listener.close()
    },

    connected: () => Boolean(credentials.get('refresh_token')),
    signingIn: () => Boolean(pending),

    /** A valid access token, refreshing it when it is about to expire. */
    async accessToken({ force = false } = {}) {
      const refreshToken = credentials.get('refresh_token')
      if (!refreshToken) throw new ConnectorError('not-connected')
      const token = credentials.get('access_token')
      const expires = Number(credentials.get('access_expires') ?? 0)
      if (!force && token && expires - REFRESH_EARLY_MS > now()) return token
      if (!refreshing) {
        refreshing = (async () => {
          const c = needClient()
          try {
            const body = await http.json(GOOGLE_TOKEN_URL, form({
              client_id: c.clientId,
              client_secret: c.clientSecret,
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
            }))
            const t = keep(body, { refresh: true })
            lastError = null
            return t
          } catch (err) {
            if (err instanceof ConnectorError && err.code === 'revoked') forget()
            if (err instanceof ConnectorError && ['revoked', 'auth'].includes(err.code)) lastError = err
            throw err
          }
        })().finally(() => { refreshing = null })
      }
      return refreshing
    },

    /**
     * Call a Google API with the access token. On a 401 the token is refreshed
     * once and the call retried. `api` is the adapter's own createHttp (its own
     * egress allow-list).
     */
    async authorizedJson(api, url, init = {}) {
      const call = (token) => api.json(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } })
      try {
        return await call(await oauth.accessToken())
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code !== 'auth' || err.status !== 401) throw err
        return call(await oauth.accessToken({ force: true }))
      }
    },

    /**
     * Disconnect: revoke at Google (best effort; offline still forgets) and
     * forget every token. The shared client stays for the other connectors.
     */
    async revoke() {
      oauth.cancel()
      const token = credentials.get('refresh_token') ?? credentials.get('access_token')
      const remote = await revokeAtGoogle(token)
      forget()
      lastError = null
      return { revokedAtGoogle: remote }
    },

    /** For the adapter's status(). */
    status() {
      if (pending) return { state: 'attention', detail: 'Waiting for you to finish signing in on Google\'s page.' }
      if (lastError) return { state: 'attention', detail: lastError.message }
      if (!client.get()) return { state: 'disconnected', detail: 'Paste your Google OAuth client to start.' }
      if (!credentials.get('refresh_token')) return { state: 'disconnected', detail: 'Not connected' }
      return { state: 'ok', detail: 'Connected to Google (read-only)' }
    },
  }
  return Object.freeze(oauth)
}

/**
 * The `setup` block a Google connector's card shows. `sees` is per connector.
 * @param {keyof typeof GOOGLE_SCOPES} connectorId
 * @param {string[]} sees
 * @param {string} [testQuestion]
 */
export function googleSetup(connectorId, sees, testQuestion) {
  const scopes = GOOGLE_SCOPES[connectorId]
  if (!scopes) throw new Error(`No Google scopes are defined for ${connectorId}.`)
  return {
    sees,
    scopes: [...scopes],
    steps: [...GOOGLE_SETUP_STEPS],
    helpUrl: GOOGLE_HELP_URL,
    clientLabel: 'Google OAuth client (Desktop app)',
    ...(testQuestion ? { testQuestion } : {}),
  }
}
