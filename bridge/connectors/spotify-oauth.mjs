/**
 * The Spotify sign-in (task C34): OAuth 2 authorization code flow with PKCE
 * for a public (desktop) app, so there is no client secret to keep. Only the
 * `user-read-recently-played` scope is requested; playback control and
 * library changes are out of scope.
 *
 * NOTE: developer.spotify.com was not reachable from the build environment,
 * so these details are from the published API as known and need a check
 * against a real account (see the live-check task):
 *   1. Authorize at accounts.spotify.com/authorize with `response_type=code`,
 *      PKCE (S256), a random `state` and the one scope.
 *   2. Exchange the code at accounts.spotify.com/api/token with the PKCE
 *      verifier and the client ID; no secret.
 *   3. Refresh with grant_type=refresh_token and the client ID. Spotify may
 *      return a new refresh token; if it does, the new one replaces the old.
 *   4. Spotify only redirects to an address registered on the app, and
 *      accepts loopback IP addresses (http://127.0.0.1:<port>), not
 *      "localhost". The listener uses one fixed port (default 53683).
 *   5. Spotify has no token-revoke endpoint: disconnect forgets the tokens
 *      locally and points the owner to spotify.com/account/apps.
 *
 * Same shape as dropbox-oauth.mjs: the owner's own client ID (not a secret)
 * kept under the `spotify` credential id; tokens only in the connector's
 * scoped credential view; fixed owner-readable messages; nothing logged.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createHttp, ConnectorError } from './http.mjs'
import { listenOnce } from './oauth-loopback.mjs'
import { pkcePair } from './google-oauth.mjs'

export const SPOTIFY_ACCOUNTS_HOST = 'accounts.spotify.com'
export const SPOTIFY_AUTH_URL = `https://${SPOTIFY_ACCOUNTS_HOST}/authorize`
export const SPOTIFY_TOKEN_URL = `https://${SPOTIFY_ACCOUNTS_HOST}/api/token`

/** The credential-store id the owner's client ID is kept under. */
export const SPOTIFY_CLIENT_ID = 'spotify'
/** The one scope Spotify is asked for: the listening history. Nothing that plays, changes or reads the library. */
export const SPOTIFY_SCOPES = Object.freeze(['user-read-recently-played'])
export const SPOTIFY_REDIRECT_PORT = 53683
/** A client ID as Spotify issues it: 32 hex characters (a little slack allowed). */
export const SPOTIFY_APP_KEY_SHAPE = /^[a-f0-9]{16,64}$/i

const REFRESH_EARLY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const b64url = (buf) => Buffer.from(buf).toString('base64url')

export const spotifyRedirectUri = (port = SPOTIFY_REDIRECT_PORT) => `http://127.0.0.1:${port}`

export function spotifySetupSteps(port = SPOTIFY_REDIRECT_PORT) {
  return [
    'Open developer.spotify.com/dashboard → Create app.',
    `Add the redirect URI ${spotifyRedirectUri(port)} exactly, and tick "Web API" as the API used.`,
    'Save, open the app\'s Settings and copy the Client ID; there is no secret to paste.',
    'Paste the Client ID here, press Connect, then approve read-only access to your listening history on Spotify\'s page.',
  ]
}
export const SPOTIFY_HELP_URL = 'https://developer.spotify.com/dashboard'
/** Where the owner removes JARVIS's access on Spotify's side. */
export const SPOTIFY_CONNECTED_APPS_URL = 'https://www.spotify.com/account/apps/'

/**
 * The owner's own Spotify Client ID (public client), pasted once.
 * @param {{ get(k: string): string|null, set(k: string, v: string): void, delete(k: string): void }} store
 *        a credential view scoped to SPOTIFY_CLIENT_ID
 */
export function createSpotifyClient(store) {
  if (!store || typeof store.get !== 'function') throw new Error('The Spotify client needs a scoped credential view.')
  return Object.freeze({
    save({ clientId, clientSecret } = {}) {
      const id = typeof clientId === 'string' ? clientId.trim() : ''
      if (!SPOTIFY_APP_KEY_SHAPE.test(id)) throw new ConnectorError('setup-needed', { detail: 'client ID shape' })
      if (typeof clientSecret === 'string' && clientSecret.trim()) throw new ConnectorError('setup-needed', { detail: 'public client takes no secret' })
      store.set('client_id', id)
    },
    get() {
      const clientId = store.get('client_id')
      return clientId ? { clientId } : null
    },
    describe() {
      const clientId = store.get('client_id')
      return { set: Boolean(clientId), clientId: clientId ?? null, hasSecret: false }
    },
    clear() {
      store.delete('client_id')
    },
  })
}

/** Which of the requested scopes a token reply's space-separated `scope` does not cover. */
export function missingSpotifyScopes(requested, grantedText) {
  const granted = new Set(String(grantedText ?? '').split(/\s+/).filter(Boolean))
  return requested.filter((s) => !granted.has(s))
}

/**
 * Sign-in and refresh for the Spotify connector.
 * @param {{
 *   credentials: any, client: ReturnType<typeof createSpotifyClient>,
 *   fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   randomBytes?: (n: number) => Buffer, timeoutMs?: number, port?: number,
 * }} opts
 */
export function createSpotifyOAuth({
  credentials,
  client,
  fetch = globalThis.fetch,
  sleep,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  port = SPOTIFY_REDIRECT_PORT,
}) {
  if (!credentials || typeof credentials.get !== 'function') throw new Error('Spotify OAuth needs the connector\'s credential view.')
  if (!client || typeof client.get !== 'function') throw new Error('Spotify OAuth needs the shared Spotify client.')
  const http = createHttp({ fetch, sleep, now, allowedHosts: [SPOTIFY_ACCOUNTS_HOST] })
  const scope = SPOTIFY_SCOPES.join(' ')

  let pending = null
  let lastError = null
  let refreshing = null

  const form = (fields) => {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) body.set(k, v)
    return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }
  }
  const needClient = () => {
    const c = client.get()
    if (!c) throw new ConnectorError('setup-needed', { detail: 'no Spotify client ID' })
    return c
  }
  const forget = () => {
    for (const k of ['refresh_token', 'access_token', 'access_expires', 'granted_scopes']) credentials.delete(k)
  }
  const keep = (body, { refresh } = {}) => {
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new ConnectorError('bad-response', { detail: 'no access_token' })
    }
    const secs = Number(body.expires_in)
    const expires = now() + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : 4 * 3_600_000)
    if (typeof body.refresh_token === 'string' && body.refresh_token) credentials.set('refresh_token', body.refresh_token)
    else if (!refresh) throw new ConnectorError('bad-response', { detail: 'no refresh_token' })
    credentials.set('access_token', body.access_token)
    credentials.set('access_expires', String(expires))
    if (typeof body.scope === 'string' && body.scope) credentials.set('granted_scopes', body.scope.slice(0, 2000))
    return body.access_token
  }

  async function complete(listener, verifier) {
    const r = await listener.result
    if (r.error) throw new ConnectorError('consent-denied', { detail: r.error })
    const c = needClient()
    const body = await http.json(SPOTIFY_TOKEN_URL, form({
      client_id: c.clientId,
      code: r.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: listener.redirectUri,
    }))
    const missing = missingSpotifyScopes(SPOTIFY_SCOPES, body?.scope)
    if (missing.length) throw new ConnectorError('consent-denied', { detail: `missing ${missing.length} scope(s)` })
    keep(body)
  }

  const oauth = {
    connectorId: 'spotify',
    scopes: SPOTIFY_SCOPES,

    async begin({ clientId, clientSecret } = {}) {
      if (clientId !== undefined && clientId !== null && clientId !== '') client.save({ clientId, clientSecret })
      const c = needClient()
      oauth.cancel()
      const state = b64url(randomBytes(24))
      const { verifier, challenge } = pkcePair(randomBytes)
      let listener
      try {
        listener = await listenOnce({ state, timeoutMs, port })
      } catch (err) {
        // The registered port is busy: say so rather than send a redirect Spotify would refuse.
        throw new ConnectorError('other', { detail: err?.code ?? 'listen failed' })
      }
      const url = new URL(SPOTIFY_AUTH_URL)
      url.search = new URLSearchParams({
        client_id: c.clientId,
        response_type: 'code',
        redirect_uri: listener.redirectUri,
        scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString()
      lastError = null
      const entry = { listener }
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
      entry.promise.catch(() => {})
      pending = entry
      return { url: url.href, detail: 'Finish signing in on Spotify\'s page, then come back and press Test.' }
    },

    async waitForSignIn() {
      if (!pending) {
        if (lastError) throw lastError
        return
      }
      await pending.promise
    },

    cancel() {
      if (pending) pending.listener.close()
    },

    connected: () => Boolean(credentials.get('refresh_token')),
    signingIn: () => Boolean(pending),

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
            const body = await http.json(SPOTIFY_TOKEN_URL, form({
              client_id: c.clientId,
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

    /** Run `send(headers)` with a bearer token; after a 401 refresh once and retry. */
    async authorized(send, init = {}) {
      const call = (token) => send({ ...(init.headers ?? {}), authorization: `Bearer ${token}` })
      try {
        return await call(await oauth.accessToken())
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code !== 'auth' || err.status !== 401) throw err
        return call(await oauth.accessToken({ force: true }))
      }
    },

    /** Disconnect: Spotify has no revoke call, so forget every token locally; the owner can also remove the app on Spotify's side. */
    async revoke() {
      oauth.cancel()
      forget()
      lastError = null
      return { manageUrl: SPOTIFY_CONNECTED_APPS_URL }
    },

    status() {
      if (pending) return { state: 'attention', detail: 'Waiting for you to finish signing in on Spotify\'s page.' }
      if (lastError) return { state: 'attention', detail: lastError.message }
      if (!client.get()) return { state: 'disconnected', detail: 'Paste your Spotify client ID to start.' }
      if (!credentials.get('refresh_token')) return { state: 'disconnected', detail: 'Not connected' }
      return { state: 'ok', detail: 'Connected to Spotify (read-only)' }
    },
  }
  return Object.freeze(oauth)
}

/** The `setup` block the Spotify card shows. */
export function spotifySetup(sees, testQuestion, port = SPOTIFY_REDIRECT_PORT) {
  return {
    sees,
    scopes: [...SPOTIFY_SCOPES],
    steps: spotifySetupSteps(port),
    helpUrl: SPOTIFY_HELP_URL,
    clientLabel: 'Spotify Client ID (public client)',
    ...(testQuestion ? { testQuestion } : {}),
  }
}
