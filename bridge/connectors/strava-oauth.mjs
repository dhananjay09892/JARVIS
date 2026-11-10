/**
 * The Strava sign-in (task C35): OAuth 2 authorization code flow. Strava has
 * no PKCE and no public clients, so the owner's own API application (client ID
 * and client secret) is used; both are kept in the credential store under the
 * `strava` id and never leave the machine. Only `activity:read` is requested.
 *
 * NOTE: developers.strava.com was not reachable from the build environment,
 * so these details are from the published API as known and need a check
 * against a real account (see the live-check task):
 *   1. Authorize at www.strava.com/oauth/authorize (response_type=code,
 *      scope=activity:read, a random `state`). The app's "Authorization
 *      Callback Domain" must be `localhost`; the redirect is
 *      http://localhost:<port>.
 *   2. Exchange the code at www.strava.com/api/v3/oauth/token with client ID
 *      and secret. Access tokens last 6 hours; refresh with
 *      grant_type=refresh_token. Strava rotates the refresh token: a new one,
 *      when returned, replaces the old.
 *   3. The owner can untick the activity permission on Strava's page; the
 *      scope is only in the redirect, so a missing permission shows up as a
 *      401 from the activities call and is reported as "reconnect".
 *   4. Disconnect calls POST /oauth/deauthorize (best effort) and forgets the
 *      tokens locally.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createHttp, ConnectorError } from './http.mjs'
import { listenOnce } from './oauth-loopback.mjs'

export const STRAVA_ACCOUNTS_HOST = 'www.strava.com'
export const STRAVA_AUTH_URL = `https://${STRAVA_ACCOUNTS_HOST}/oauth/authorize`
export const STRAVA_TOKEN_URL = `https://${STRAVA_ACCOUNTS_HOST}/api/v3/oauth/token`
export const STRAVA_DEAUTH_URL = `https://${STRAVA_ACCOUNTS_HOST}/oauth/deauthorize`

/** The credential-store id the owner's client ID is kept under. */
export const STRAVA_CLIENT_ID = 'strava'
/** The one scope Strava is asked for: read activities. No writes, no private activities. */
export const STRAVA_SCOPES = Object.freeze(['activity:read'])
export const STRAVA_REDIRECT_PORT = 0
/** A Strava client ID is a number; the secret is 40 hex characters. */
export const STRAVA_APP_KEY_SHAPE = /^[0-9]{3,12}$/
export const STRAVA_SECRET_SHAPE = /^[a-f0-9]{32,64}$/i

const REFRESH_EARLY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const b64url = (buf) => Buffer.from(buf).toString('base64url')

export const stravaRedirectUri = (port = STRAVA_REDIRECT_PORT) => `http://localhost:${port}`

export function stravaSetupSteps() {
  return [
    'Open strava.com/settings/api and create an API application (any name and website).',
    'Set "Authorization Callback Domain" to localhost.',
    'Copy the Client ID and the Client Secret from that page and paste both here.',
    'Press Connect, then approve read access to your activities on Strava\'s page.',
  ]
}
export const STRAVA_HELP_URL = 'https://www.strava.com/settings/api'
/** Where the owner removes JARVIS's access on Strava's side. */
export const STRAVA_CONNECTED_APPS_URL = 'https://www.strava.com/account/apps/'

/**
 * The owner's own Strava Client ID (public client), pasted once.
 * @param {{ get(k: string): string|null, set(k: string, v: string): void, delete(k: string): void }} store
 *        a credential view scoped to STRAVA_CLIENT_ID
 */
export function createStravaClient(store) {
  if (!store || typeof store.get !== 'function') throw new Error('The Strava client needs a scoped credential view.')
  return Object.freeze({
    save({ clientId, clientSecret } = {}) {
      const id = typeof clientId === 'string' ? clientId.trim() : ''
      const secret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
      if (!STRAVA_APP_KEY_SHAPE.test(id)) throw new ConnectorError('setup-needed', { detail: 'client ID shape' })
      if (!STRAVA_SECRET_SHAPE.test(secret)) throw new ConnectorError('setup-needed', { detail: 'client secret shape' })
      store.set('client_id', id)
      store.set('client_secret', secret)
    },
    get() {
      const clientId = store.get('client_id')
      const clientSecret = store.get('client_secret')
      return clientId && clientSecret ? { clientId, clientSecret } : null
    },
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

/**
 * Sign-in and refresh for the Strava connector.
 * @param {{
 *   credentials: any, client: ReturnType<typeof createStravaClient>,
 *   fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   randomBytes?: (n: number) => Buffer, timeoutMs?: number, port?: number,
 * }} opts
 */
export function createStravaOAuth({
  credentials,
  client,
  fetch = globalThis.fetch,
  sleep,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  port = STRAVA_REDIRECT_PORT,
}) {
  if (!credentials || typeof credentials.get !== 'function') throw new Error('Strava OAuth needs the connector\'s credential view.')
  if (!client || typeof client.get !== 'function') throw new Error('Strava OAuth needs the shared Strava client.')
  const http = createHttp({ fetch, sleep, now, allowedHosts: [STRAVA_ACCOUNTS_HOST] })
  const scope = STRAVA_SCOPES.join(' ')

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
    if (!c) throw new ConnectorError('setup-needed', { detail: 'no Strava client ID and secret' })
    return c
  }
  const forget = () => {
    for (const k of ['refresh_token', 'access_token', 'access_expires']) credentials.delete(k)
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
    return body.access_token
  }

  async function complete(listener) {
    const r = await listener.result
    if (r.error) throw new ConnectorError('consent-denied', { detail: r.error })
    const c = needClient()
    const body = await http.json(STRAVA_TOKEN_URL, form({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code: r.code,
      grant_type: 'authorization_code',
      redirect_uri: listener.redirectUri,
    }))
    keep(body)
  }

  const oauth = {
    connectorId: 'strava',
    scopes: STRAVA_SCOPES,

    async begin({ clientId, clientSecret } = {}) {
      if (clientId !== undefined && clientId !== null && clientId !== '') client.save({ clientId, clientSecret })
      const c = needClient()
      oauth.cancel()
      const state = b64url(randomBytes(24))
            let listener
      try {
        listener = await listenOnce({ state, timeoutMs, port, publicHost: 'localhost' })
      } catch (err) {
        // The registered port is busy: say so rather than send a redirect Strava would refuse.
        throw new ConnectorError('other', { detail: err?.code ?? 'listen failed' })
      }
      const url = new URL(STRAVA_AUTH_URL)
      url.search = new URLSearchParams({
        client_id: c.clientId,
        response_type: 'code',
        redirect_uri: listener.redirectUri,
        scope,
        approval_prompt: 'auto',
        state,
      }).toString()
      lastError = null
      const entry = { listener }
      entry.promise = complete(listener).then(
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
      return { url: url.href, detail: 'Finish signing in on Strava\'s page, then come back and press Test.' }
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
            const body = await http.json(STRAVA_TOKEN_URL, form({
              client_id: c.clientId,
              client_secret: c.clientSecret,
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
            }))
            const t = keep(body, { refresh: true })
            lastError = null
            return t
          } catch (err) {
            // Strava answers a dead refresh token with a plain 400 (no `invalid_grant`).
            if (err instanceof ConnectorError && (err.code === 'revoked' || err.status === 400)) forget()
            if (err instanceof ConnectorError && ['revoked', 'auth'].includes(err.code) || err?.status === 400) lastError = err
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

    /** Disconnect: tell Strava to drop the grant (best effort), then forget every token locally. */
    async revoke() {
      oauth.cancel()
      const token = credentials.get('access_token')
      forget()
      lastError = null
      if (token) {
        try {
          await http.json(STRAVA_DEAUTH_URL, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
        } catch {
          // Already expired or unreachable: the owner can remove the app on Strava's side.
        }
      }
      return { manageUrl: STRAVA_CONNECTED_APPS_URL }
    },

    status() {
      if (pending) return { state: 'attention', detail: 'Waiting for you to finish signing in on Strava\'s page.' }
      if (lastError) return { state: 'attention', detail: lastError.message }
      if (!client.get()) return { state: 'disconnected', detail: 'Paste your Strava client ID and secret to start.' }
      if (!credentials.get('refresh_token')) return { state: 'disconnected', detail: 'Not connected' }
      return { state: 'ok', detail: 'Connected to Strava (read-only)' }
    },
  }
  return Object.freeze(oauth)
}

/** The `setup` block the Strava card shows. */
export function stravaSetup(sees, testQuestion, port = STRAVA_REDIRECT_PORT) {
  return {
    sees,
    scopes: [...STRAVA_SCOPES],
    steps: stravaSetupSteps(port),
    helpUrl: STRAVA_HELP_URL,
    clientLabel: 'Strava Client ID',
    ...(testQuestion ? { testQuestion } : {}),
  }
}
