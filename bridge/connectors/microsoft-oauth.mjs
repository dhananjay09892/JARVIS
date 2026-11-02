/**
 * The shared Microsoft sign-in (task C21) for Outlook mail, and later for any
 * other Microsoft Graph connector (Calendar, OneDrive). Each adapter builds
 * one of these in its `create(ctx)`, as the Google ones do with C04.
 *
 * Why OAuth and not an app password (checked 2026-11-02): Microsoft turned
 * basic authentication off for Exchange Online (work and school) in October
 * 2022, and for Outlook.com personal accounts on 16 September 2024; app
 * passwords stopped working for IMAP with it. So the only way left to read an
 * Outlook mailbox is modern auth. Of the two modern-auth routes, Microsoft
 * Graph with the delegated `Mail.Read` permission is read-only, while IMAP
 * with XOAUTH2 needs `IMAP.AccessAsUser.All`, which can also change and
 * delete mail. Graph is the smaller scope, so JARVIS uses it.
 *
 * Microsoft identity platform, authorization code flow with PKCE for a public
 * (desktop) client (learn.microsoft.com/entra/identity-platform/
 * v2-oauth2-auth-code-flow, checked 2026-11-02):
 *   1. Authorize at login.microsoftonline.com/common/oauth2/v2.0/authorize
 *      with PKCE (S256), a random `state`, and redirect http://localhost:<port>
 *      (Microsoft ignores the port for localhost redirects; the socket is
 *      bound to 127.0.0.1 only — see oauth-loopback.mjs).
 *      `common` lets both personal (Outlook.com) and work or school accounts
 *      sign in to one app registration.
 *   2. Exchange the code at …/oauth2/v2.0/token. A public client sends no
 *      client secret; the PKCE verifier proves it is the same app.
 *      `offline_access` is asked for so a refresh token comes back.
 *   3. Refresh with the refresh token. Microsoft *rotates* refresh tokens: a
 *      new one usually comes back and replaces the old. `invalid_grant` means
 *      it was revoked, expired or consent was withdrawn: reconnect.
 *   4. There is no token revocation endpoint a public client can call
 *      (Graph's revokeSignInSessions needs a write permission). Disconnect
 *      forgets every token locally, and the card tells the owner where to
 *      remove the app's access on Microsoft's side.
 *
 * Choices mirrored from google-oauth.mjs: one grant per connector, scopes
 * only from MICROSOFT_SCOPES (read-only), the owner's own app registration
 * (client ID only: a GUID, not a secret) kept under the `microsoft`
 * credential id apart from every connector, tokens only in the connector's
 * own scoped view (OS keychain since Q20), nothing logged, fixed messages.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createHttp, ConnectorError } from './http.mjs'
import { listenOnce } from './oauth-loopback.mjs'
import { pkcePair } from './google-oauth.mjs'

export const MICROSOFT_LOGIN_HOST = 'login.microsoftonline.com'
export const MICROSOFT_TENANT = 'common'
export const MICROSOFT_AUTH_URL = `https://${MICROSOFT_LOGIN_HOST}/${MICROSOFT_TENANT}/oauth2/v2.0/authorize`
export const MICROSOFT_TOKEN_URL = `https://${MICROSOFT_LOGIN_HOST}/${MICROSOFT_TENANT}/oauth2/v2.0/token`
export const GRAPH_RESOURCE = 'https://graph.microsoft.com/'

/** The credential-store id the owner's app registration is kept under. */
export const MICROSOFT_CLIENT_ID = 'microsoft'

/**
 * The smallest read-only Graph permissions per connector. `offline_access`
 * (for a refresh token) is added to every request and is not listed here.
 * Mail.Read, not Mail.ReadBasic: ReadBasic leaves out the message body.
 */
export const MICROSOFT_SCOPES = Object.freeze({
  outlook: Object.freeze([`${GRAPH_RESOURCE}Mail.Read`]),
})

/** An application (client) ID as Microsoft Entra issues it: a GUID. */
export const MS_CLIENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REFRESH_EARLY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export const MICROSOFT_SETUP_STEPS = Object.freeze([
  'Open the Microsoft Entra admin centre → App registrations → New registration.',
  'Supported accounts: "Any Entra ID tenant + personal Microsoft accounts".',
  'Under Authentication, add a "Mobile and desktop applications" redirect URI: http://localhost',
  'Under API permissions, add Microsoft Graph → Delegated → Mail.Read (nothing else).',
  'Copy the Application (client) ID and paste it here; leave the secret empty.',
  'Press Connect, then approve read-only mail access on Microsoft\'s page.',
])
export const MICROSOFT_HELP_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
/** Where the owner removes JARVIS's access on Microsoft's side after a disconnect. */
export const MICROSOFT_CONSENT_URL = 'https://account.live.com/consent/Manage'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * The owner's own app registration (public client), pasted once.
 * @param {{ get(k: string): string|null, set(k: string, v: string): void, delete(k: string): void }} store
 *        a credential view scoped to MICROSOFT_CLIENT_ID
 */
export function createMicrosoftClient(store) {
  if (!store || typeof store.get !== 'function') throw new Error('The Microsoft client needs a scoped credential view.')
  return Object.freeze({
    /**
     * Save a pasted client ID. A public client has no secret: one pasted by
     * mistake is refused rather than stored.
     */
    save({ clientId, clientSecret } = {}) {
      const id = typeof clientId === 'string' ? clientId.trim().toLowerCase() : ''
      if (!MS_CLIENT_ID_SHAPE.test(id)) throw new ConnectorError('setup-needed', { detail: 'client id shape' })
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

/**
 * Which requested Graph permissions a token reply's `scope` does not cover.
 * Microsoft may answer with full URIs ("https://graph.microsoft.com/Mail.Read")
 * or short names ("Mail.Read"); both are accepted, case-insensitively.
 */
export function missingMicrosoftScopes(requested, grantedText) {
  const short = (s) => String(s).toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '')
  const granted = new Set(String(grantedText ?? '').split(/\s+/).filter(Boolean).map(short))
  return requested.filter((s) => !granted.has(short(s)))
}

/**
 * Sign-in and refresh for one Microsoft Graph connector.
 * @param {{
 *   connectorId: keyof typeof MICROSOFT_SCOPES,
 *   credentials: any,
 *   client: ReturnType<typeof createMicrosoftClient>,
 *   fetch?: typeof globalThis.fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   randomBytes?: (n: number) => Buffer,
 *   timeoutMs?: number,
 * }} opts
 */
export function createMicrosoftOAuth({
  connectorId,
  credentials,
  client,
  fetch = globalThis.fetch,
  sleep,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const scopes = MICROSOFT_SCOPES[connectorId]
  if (!scopes) throw new Error(`No Microsoft scopes are defined for ${connectorId}.`)
  if (!credentials || typeof credentials.get !== 'function') throw new Error('Microsoft OAuth needs the connector\'s credential view.')
  if (!client || typeof client.get !== 'function') throw new Error('Microsoft OAuth needs the shared Microsoft client.')
  const http = createHttp({ fetch, sleep, now, allowedHosts: [MICROSOFT_LOGIN_HOST] })
  const requestScope = [...scopes, 'offline_access'].join(' ')

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
    if (!c) throw new ConnectorError('setup-needed', { detail: 'no Microsoft client' })
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
    const expires = now() + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : 3_600_000)
    // Microsoft rotates refresh tokens: keep the new one when it comes.
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
    const body = await http.json(MICROSOFT_TOKEN_URL, form({
      client_id: c.clientId,
      code: r.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: listener.redirectUri,
      scope: requestScope,
    }))
    const missing = missingMicrosoftScopes(scopes, body?.scope)
    if (missing.length) {
      // Not what this connector needs (a tenant policy, or an app registration
      // without Mail.Read): keep nothing. Microsoft has no revoke endpoint for
      // a public client; the unused tokens simply expire.
      throw new ConnectorError('consent-denied', { detail: `missing ${missing.length} scope(s)` })
    }
    keep(body)
  }

  const oauth = {
    connectorId,
    scopes,

    async begin({ clientId, clientSecret } = {}) {
      if (clientId !== undefined && clientId !== null && clientId !== '') client.save({ clientId, clientSecret })
      const c = needClient()
      oauth.cancel()
      const state = b64url(randomBytes(24))
      const { verifier, challenge } = pkcePair(randomBytes)
      const listener = await listenOnce({ state, timeoutMs, publicHost: 'localhost' })
      const url = new URL(MICROSOFT_AUTH_URL)
      url.search = new URLSearchParams({
        client_id: c.clientId,
        response_type: 'code',
        redirect_uri: listener.redirectUri,
        response_mode: 'query',
        scope: requestScope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
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
      return { url: url.href, detail: 'Finish signing in on Microsoft\'s page, then come back and press Test.' }
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
            const body = await http.json(MICROSOFT_TOKEN_URL, form({
              client_id: c.clientId,
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              scope: requestScope,
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

    async authorizedJson(api, url, init = {}) {
      return oauth.authorized((headers) => api.json(url, { ...init, headers }), init)
    },

    async authorized(send, init = {}) {
      const call = (token) => send({ ...(init.headers ?? {}), authorization: `Bearer ${token}` })
      try {
        return await call(await oauth.accessToken())
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code !== 'auth' || err.status !== 401) throw err
        return call(await oauth.accessToken({ force: true }))
      }
    },

    /** Disconnect: forget every token. Nothing to call at Microsoft (see the header). */
    async revoke() {
      oauth.cancel()
      forget()
      lastError = null
      return { revokedAtMicrosoft: false, manageUrl: MICROSOFT_CONSENT_URL }
    },

    status() {
      if (pending) return { state: 'attention', detail: 'Waiting for you to finish signing in on Microsoft\'s page.' }
      if (lastError) return { state: 'attention', detail: lastError.message }
      if (!client.get()) return { state: 'disconnected', detail: 'Paste your Microsoft app\'s client ID to start.' }
      if (!credentials.get('refresh_token')) return { state: 'disconnected', detail: 'Not connected' }
      return { state: 'ok', detail: 'Connected to Microsoft (read-only)' }
    },
  }
  return Object.freeze(oauth)
}

/** The `setup` block a Microsoft connector's card shows. */
export function microsoftSetup(connectorId, sees, testQuestion) {
  const scopes = MICROSOFT_SCOPES[connectorId]
  if (!scopes) throw new Error(`No Microsoft scopes are defined for ${connectorId}.`)
  return {
    sees,
    scopes: [...scopes, 'offline_access'],
    steps: [...MICROSOFT_SETUP_STEPS],
    helpUrl: MICROSOFT_HELP_URL,
    clientLabel: 'Microsoft app registration (public client)',
    ...(testQuestion ? { testQuestion } : {}),
  }
}
