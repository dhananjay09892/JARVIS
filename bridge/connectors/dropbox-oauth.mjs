/**
 * The Dropbox sign-in (task C31): OAuth 2 authorization code flow with PKCE
 * for a public (desktop) app, so there is no client secret to keep. Dropbox
 * short-lived access tokens last about four hours; JARVIS asks for a refresh
 * token (`token_access_type=offline`) and renews on its own instead of making
 * the owner paste a new token every few hours.
 *
 * Written against Dropbox's OAuth guide and HTTP documentation. NOTE: the
 * Dropbox developer site was not reachable from the build environment, so the
 * details below are from the published API as known and still need a check
 * against a real account:
 *   1. Authorize at www.dropbox.com/oauth2/authorize with `response_type=code`,
 *      PKCE (S256), `token_access_type=offline`, a random `state` and an
 *      explicit `scope` (only files.metadata.read and files.content.read).
 *   2. Exchange the code at api.dropboxapi.com/oauth2/token with the PKCE
 *      verifier and the app key; no secret.
 *   3. Refresh with grant_type=refresh_token and the app key. Dropbox does not
 *      rotate the refresh token; a new access token comes back.
 *   4. Dropbox only redirects to an address registered on the app, port
 *      included, so the loopback listener uses one fixed port (default 53682)
 *      and the card tells the owner to register http://127.0.0.1:53682.
 *   5. Disconnect calls /2/auth/token/revoke (best effort) and always forgets
 *      the tokens locally.
 *
 * Same shape as microsoft-oauth.mjs: the owner's own app key (not a secret)
 * kept under the `dropbox` credential id; tokens only in the connector's own
 * scoped credential view; fixed owner-readable messages; nothing logged.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createHttp, ConnectorError } from './http.mjs'
import { listenOnce } from './oauth-loopback.mjs'
import { pkcePair } from './google-oauth.mjs'

export const DROPBOX_API_HOST = 'api.dropboxapi.com'
export const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize'
export const DROPBOX_TOKEN_URL = `https://${DROPBOX_API_HOST}/oauth2/token`
export const DROPBOX_REVOKE_URL = `https://${DROPBOX_API_HOST}/2/auth/token/revoke`

/** The credential-store id the owner's app key is kept under. */
export const DROPBOX_CLIENT_ID = 'dropbox'
/** The scopes Dropbox is asked for: read file metadata and content, nothing that writes. */
export const DROPBOX_SCOPES = Object.freeze(['files.metadata.read', 'files.content.read'])
export const DROPBOX_REDIRECT_PORT = 53682
/** An app key as Dropbox issues it: 15 letters and digits (a little slack allowed). */
export const DROPBOX_APP_KEY_SHAPE = /^[a-z0-9]{8,40}$/i

const REFRESH_EARLY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const b64url = (buf) => Buffer.from(buf).toString('base64url')

export const dropboxRedirectUri = (port = DROPBOX_REDIRECT_PORT) => `http://127.0.0.1:${port}`

export function dropboxSetupSteps(port = DROPBOX_REDIRECT_PORT) {
  return [
    'Open dropbox.com/developers/apps → Create app → Scoped access.',
    'Choose "App folder" to limit JARVIS to one folder, or "Full Dropbox" to let it read everything.',
    'On the Permissions tab tick files.metadata.read and files.content.read (nothing else), then Submit.',
    `On the Settings tab add the redirect URI ${dropboxRedirectUri(port)} exactly.`,
    'Copy the App key and paste it here; leave the secret empty.',
    'Press Connect, then approve read-only access on Dropbox\'s page.',
  ]
}
export const DROPBOX_HELP_URL = 'https://www.dropbox.com/developers/apps'
/** Where the owner removes JARVIS's access on Dropbox's side. */
export const DROPBOX_CONNECTED_APPS_URL = 'https://www.dropbox.com/account/connected_apps'

/**
 * The owner's own Dropbox app key (public client), pasted once.
 * @param {{ get(k: string): string|null, set(k: string, v: string): void, delete(k: string): void }} store
 *        a credential view scoped to DROPBOX_CLIENT_ID
 */
export function createDropboxClient(store) {
  if (!store || typeof store.get !== 'function') throw new Error('The Dropbox client needs a scoped credential view.')
  return Object.freeze({
    save({ clientId, clientSecret } = {}) {
      const id = typeof clientId === 'string' ? clientId.trim() : ''
      if (!DROPBOX_APP_KEY_SHAPE.test(id)) throw new ConnectorError('setup-needed', { detail: 'app key shape' })
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
export function missingDropboxScopes(requested, grantedText) {
  const granted = new Set(String(grantedText ?? '').split(/\s+/).filter(Boolean))
  return requested.filter((s) => !granted.has(s))
}

/**
 * Sign-in and refresh for the Dropbox connector.
 * @param {{
 *   credentials: any, client: ReturnType<typeof createDropboxClient>,
 *   fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   randomBytes?: (n: number) => Buffer, timeoutMs?: number, port?: number,
 * }} opts
 */
export function createDropboxOAuth({
  credentials,
  client,
  fetch = globalThis.fetch,
  sleep,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  port = DROPBOX_REDIRECT_PORT,
}) {
  if (!credentials || typeof credentials.get !== 'function') throw new Error('Dropbox OAuth needs the connector\'s credential view.')
  if (!client || typeof client.get !== 'function') throw new Error('Dropbox OAuth needs the shared Dropbox client.')
  const http = createHttp({ fetch, sleep, now, allowedHosts: [DROPBOX_API_HOST] })
  const scope = DROPBOX_SCOPES.join(' ')

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
    if (!c) throw new ConnectorError('setup-needed', { detail: 'no Dropbox app key' })
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
    const body = await http.json(DROPBOX_TOKEN_URL, form({
      client_id: c.clientId,
      code: r.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: listener.redirectUri,
    }))
    const missing = missingDropboxScopes(DROPBOX_SCOPES, body?.scope)
    if (missing.length) throw new ConnectorError('consent-denied', { detail: `missing ${missing.length} scope(s)` })
    keep(body)
  }

  const oauth = {
    connectorId: 'dropbox',
    scopes: DROPBOX_SCOPES,

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
        // The registered port is busy: say so rather than send a redirect Dropbox would refuse.
        throw new ConnectorError('other', { detail: err?.code ?? 'listen failed' })
      }
      const url = new URL(DROPBOX_AUTH_URL)
      url.search = new URLSearchParams({
        client_id: c.clientId,
        response_type: 'code',
        redirect_uri: listener.redirectUri,
        scope,
        token_access_type: 'offline',
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
      return { url: url.href, detail: 'Finish signing in on Dropbox\'s page, then come back and press Test.' }
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
            const body = await http.json(DROPBOX_TOKEN_URL, form({
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

    /** Disconnect: tell Dropbox to end the token (best effort), then forget every token locally. */
    async revoke() {
      oauth.cancel()
      let revokedAtDropbox = false
      if (credentials.get('refresh_token')) {
        try {
          const token = await oauth.accessToken()
          await http.json(DROPBOX_REVOKE_URL, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
          revokedAtDropbox = true
        } catch {
          // Offline or already dead: the local copy is forgotten either way.
        }
      }
      forget()
      lastError = null
      return { revokedAtDropbox, manageUrl: DROPBOX_CONNECTED_APPS_URL }
    },

    status() {
      if (pending) return { state: 'attention', detail: 'Waiting for you to finish signing in on Dropbox\'s page.' }
      if (lastError) return { state: 'attention', detail: lastError.message }
      if (!client.get()) return { state: 'disconnected', detail: 'Paste your Dropbox app key to start.' }
      if (!credentials.get('refresh_token')) return { state: 'disconnected', detail: 'Not connected' }
      return { state: 'ok', detail: 'Connected to Dropbox (read-only)' }
    },
  }
  return Object.freeze(oauth)
}

/** The `setup` block the Dropbox card shows. */
export function dropboxSetup(sees, testQuestion, port = DROPBOX_REDIRECT_PORT) {
  return {
    sees,
    scopes: [...DROPBOX_SCOPES],
    steps: dropboxSetupSteps(port),
    helpUrl: DROPBOX_HELP_URL,
    clientLabel: 'Dropbox app key (public client)',
    ...(testQuestion ? { testQuestion } : {}),
  }
}
