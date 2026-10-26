/**
 * Sign in with ChatGPT (SIWC) for the OpenAI profile (plan 22, ADR 001, task Q43).
 *
 * ADR 001 chose SIWC plan usage on the Responses API for the OpenAI line, not
 * the Codex CLI's login. This module is the auth half: sign-in, token refresh,
 * sign-out and the checks the SIWC terms ask for. The brain adapter
 * (openai-compatible.mjs, `auth: 'chatgpt'`) asks it for an access token per
 * request and never sees the refresh token.
 *
 * OpenAI's flow for open-source local apps (developers.openai.com/siwc,
 * "token sharing for open source", checked 2026-10-25):
 *   1. A stable, opaque host id (`urn:uuid:<v4>`), made once per computer.
 *   2. The system browser opens auth.openai.com/api/accounts/authorize with
 *      PKCE (S256), fresh state and nonce, a loopback redirect
 *      http://127.0.0.1:<port>/auth/callback, `resource` = the API, and the
 *      plan-usage scopes. The first time, `client_id=dynamic_agent_client`
 *      plus `agent_name_hint` registers a client; the callback hands back the
 *      issued `client_id`, which is kept and reused (no client secret).
 *   3. The code is exchanged at auth.openai.com/api/accounts/oauth/token. The
 *      ID token is checked against OpenAI's published keys (issuer, audience =
 *      issued client id, expiry, nonce) and the granted scopes must include
 *      `chatgpt.tokens.use.direct`, or plan usage is off for this sign-in.
 *   4. Refresh shortly before expiry with the issued client id; the refresh
 *      token rotates, so refreshes are serialized and the whole set is
 *      replaced together. An unusable refresh token means sign in again.
 *   5. Sign-out revokes at the `revocation_endpoint` from OpenAI's OpenID
 *      configuration, then forgets the tokens (the registered client stays).
 *
 * The SIWC terms (openai.com/policies/sign-in-with-chatgpt-terms) this
 * module holds the app to:
 *   - Tokens are only got through OpenAI's sign-in, never from a password or
 *     a cookie, and are stored locally under the user's control: here, the
 *     OS keychain store the bridge passes in (secrets.mjs, Q20). Never in the
 *     browser, a URL, a log or an error message.
 *   - Express consent before background use: a token for a background
 *     (worker) request is refused until the user has said yes
 *     (`setBackgroundConsent`), and the answer is forgotten on sign-out.
 *   - JARVIS's own name at sign-in (`agent_name_hint`), no implied endorsement.
 *   - A privacy notice before any data is processed, and a link to manage
 *     usage (`PRIVACY_NOTICE`, `MANAGE_USAGE_URL`), for the Settings screen.
 *
 * Every network call goes to auth.openai.com only (the JWKS and revocation
 * URLs from the OpenID configuration are checked too), and `fetch` is passed
 * in, so the tests run the whole flow against a mock.
 */
import { createHash, createPublicKey, randomBytes as nodeRandomBytes, randomUUID, verify as cryptoVerify } from 'node:crypto'
import { createServer } from 'node:http'

export const SIWC_AUTH_BASE = 'https://auth.openai.com'
export const SIWC_AUTHORIZE_URL = `${SIWC_AUTH_BASE}/api/accounts/authorize`
export const SIWC_TOKEN_URL = `${SIWC_AUTH_BASE}/api/accounts/oauth/token`
export const SIWC_OIDC_CONFIG_URL = `${SIWC_AUTH_BASE}/.well-known/openid-configuration`
/** The API the plan-usage token is for. */
export const SIWC_RESOURCE = 'https://api.openai.com/v1'
/** Client id that asks OpenAI to register a new client on first sign-in. */
export const DYNAMIC_CLIENT = 'dynamic_agent_client'
/** The scope without which a sign-in carries no plan usage. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const SIWC_SCOPES = Object.freeze(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE])
/** The name OpenAI shows on its consent page (the terms: "use your app's own name"). */
export const AGENT_NAME = 'JARVIS'
export const CALLBACK_PATH = '/auth/callback'

/**
 * Where the user sets or checks this app's plan usage: the "Manage usage"
 * link. OpenAI's SIWC UI guidelines (developers.openai.com/siwc/ui-ux-guidelines,
 * checked 2026-10-26, task Q55) name this page as its destination.
 */
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage'

/**
 * Shown before sign-in (the terms: a privacy notice before processing data).
 * Settings shows it with the Sign in button.
 */
export const PRIVACY_NOTICE = Object.freeze([
  'Signing in with ChatGPT lets JARVIS use your own ChatGPT plan to answer you. JARVIS is not made or endorsed by OpenAI.',
  'What you say to JARVIS (as text), the instructions JARVIS adds, and the output of tools JARVIS runs for you are sent to OpenAI to get each answer. Raw audio, video and voiceprints never leave this computer.',
  'Your sign-in is kept in this computer\'s protected credential store and is used only for your own requests. JARVIS never asks for your ChatGPT password and never shares your plan with anyone else in the house.',
  'JARVIS asks you separately before background tasks may use your plan. You can set a usage limit for JARVIS, or disconnect it, in your ChatGPT settings, and sign out here at any time.',
])

/** Store keys, all under the one scoped store the bridge passes in. */
const K = Object.freeze({
  hostId: 'host_id',
  clientId: 'client_id',
  sub: 'sub',
  email: 'email',
  idToken: 'id_token',
  access: 'access_token',
  refresh: 'refresh_token',
  expires: 'expires_at',
  scopes: 'scopes',
  savedAt: 'saved_at',
  consent: 'background_consent',
})
const TOKEN_KEYS = [K.sub, K.email, K.idToken, K.access, K.refresh, K.expires, K.scopes, K.savedAt, K.consent]

const REFRESH_EARLY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const CLOCK_SKEW_S = 120
const MAX_TOKEN = 16_000
/** Refresh errors that mean the refresh token is no good: sign in again. */
export const REAUTH_ERRORS = Object.freeze(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])

/** A sign-in problem with a fixed, owner-readable message. Never carries a token. */
export class SiwcError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message ?? SIWC_MESSAGES[code] ?? 'Sign in with ChatGPT failed.')
    this.name = 'SiwcError'
    this.code = code
    this.retryable = retryable
  }
}

export const SIWC_MESSAGES = Object.freeze({
  not_signed_in: 'Not signed in with ChatGPT. Sign in from Settings → Brains.',
  consent_denied: 'Sign-in was cancelled on OpenAI\'s page. Nothing was connected.',
  plan_usage_off: 'Signed in, but ChatGPT plan usage was not allowed for JARVIS. Sign in again and allow plan usage, or use an API key instead.',
  reauth: 'Your ChatGPT sign-in has expired or was disconnected. Sign in again from Settings → Brains.',
  consent_needed: 'Background tasks may not use your ChatGPT plan until you allow it in Settings → Brains.',
  bad_token: 'OpenAI\'s sign-in reply could not be verified, so it was not used. Try signing in again.',
  bad_response: 'OpenAI\'s sign-in service sent a reply JARVIS did not understand. Try again later.',
  client_invalid: 'OpenAI no longer recognises JARVIS\'s registration on this computer. Sign in again to register it afresh.',
  network: 'Could not reach OpenAI\'s sign-in service. Check the internet connection and try again.',
  timeout: 'Sign-in timed out before it was finished on OpenAI\'s page.',
  cancelled: 'Sign-in was stopped.',
})

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** PKCE verifier (43 chars from 32 random bytes) and its S256 challenge. */
export function pkcePair(randomBytes = nodeRandomBytes) {
  const verifier = b64url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Are the granted scopes (space-separated or a list) carrying plan usage? */
export function hasPlanScope(granted) {
  const list = Array.isArray(granted) ? granted : String(granted ?? '').split(/\s+/)
  return list.includes(PLAN_SCOPE)
}

/** Only auth.openai.com over https: the token, JWKS and revocation URLs must all be here. */
export function checkAuthUrl(href) {
  let u
  try {
    u = new URL(href)
  } catch {
    throw new SiwcError('bad_response')
  }
  if (u.protocol !== 'https:' || u.hostname !== new URL(SIWC_AUTH_BASE).hostname) throw new SiwcError('bad_response')
  return u.href
}

/** The authorization URL. Pure, so the tests can read every field. */
export function authorizeUrl({ clientId, hostId, redirectUri, state, nonce, challenge, idTokenHint = null }) {
  const first = !clientId || clientId === DYNAMIC_CLIENT
  const q = new URLSearchParams({
    client_id: first ? DYNAMIC_CLIENT : clientId,
    ...(first && { agent_name_hint: AGENT_NAME }),
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SIWC_SCOPES.join(' '),
    resource: SIWC_RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ...(!first && idTokenHint && { id_token_hint: idTokenHint }),
  })
  return `${SIWC_AUTHORIZE_URL}?${q}`
}

/** The parts of a JWT, or null when it is not one. */
export function decodeJwt(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!isRecord(header) || !isRecord(payload)) return null
    return { header, payload, signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') }
  } catch {
    return null
  }
}

const ALGS = Object.freeze({ RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' })

/**
 * Check an ID token: signature against the JWKS (RS256/384/512 only, never
 * `none`), issuer, audience, expiry and nonce. Returns its claims or throws
 * SiwcError('bad_token').
 */
export function verifyIdToken(idToken, { jwks, issuer, audience, nonce, now = Date.now }) {
  const jwt = decodeJwt(idToken)
  if (!jwt) throw new SiwcError('bad_token')
  const hash = ALGS[jwt.header.alg]
  if (!hash) throw new SiwcError('bad_token')
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : []
  const jwk = keys.find((k) => k?.kty === 'RSA' && (!jwt.header.kid || k.kid === jwt.header.kid))
  if (!jwk) throw new SiwcError('bad_token')
  let ok = false
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' })
    ok = cryptoVerify(hash, Buffer.from(jwt.signed), key, jwt.signature)
  } catch {
    ok = false
  }
  if (!ok) throw new SiwcError('bad_token')
  const c = jwt.payload
  const nowS = Math.floor(now() / 1000)
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud]
  if (c.iss !== issuer) throw new SiwcError('bad_token')
  if (!aud.includes(audience)) throw new SiwcError('bad_token')
  if (!Number.isFinite(c.exp) || c.exp + CLOCK_SKEW_S < nowS) throw new SiwcError('bad_token')
  if (c.nonce !== nonce) throw new SiwcError('bad_token')
  if (typeof c.sub !== 'string' || !c.sub) throw new SiwcError('bad_token')
  return c
}

const PAGE = (title, line) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;background:#05080d;color:#cfe8ff;padding:3rem">` +
  `<h1 style="font-weight:400">${title}</h1><p>${line}</p></body>`

/**
 * Listen once on 127.0.0.1 for OpenAI's redirect to CALLBACK_PATH. The
 * listener starts before the browser opens (OpenAI's rule), answers one path,
 * checks the Host header and `state`, and closes after one result.
 */
function listenOnce({ state, timeoutMs, port: wantPort = 0, host = '127.0.0.1' }) {
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
      setImmediate(() => server.close())
    }
    const server = createServer((req, res) => {
      const reply = (status, title, line) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(PAGE(title, line))
      }
      const notHere = () => reply(404, 'Not here', 'This address only answers the JARVIS sign-in.')
      if (done) return reply(410, 'Already finished', 'This sign-in is over. Start again from Settings → Brains in JARVIS.')
      if (req.method !== 'GET' || req.headers.host !== `${host}:${port}`) return notHere()
      let u
      try {
        u = new URL(req.url, `http://${host}:${port}`)
      } catch {
        return notHere()
      }
      if (u.pathname !== CALLBACK_PATH) return notHere()
      const q = u.searchParams
      // Validate state first: anything else is not OpenAI's answer to this sign-in.
      if (q.get('state') !== state) return reply(400, 'Sign-in not recognised', 'Start again from Settings → Brains in JARVIS.')
      if (q.get('error')) {
        reply(200, 'Sign-in cancelled', 'Nothing was connected. You can close this tab.')
        return finish({ error: q.get('error') === 'access_denied' ? 'access_denied' : 'other' })
      }
      const code = q.get('code')
      const clientId = q.get('client_id')
      if (!code || code.length > 4096 || (clientId !== null && !/^[\w.:-]{1,200}$/.test(clientId))) {
        return reply(400, 'Sign-in not recognised', 'Start again from Settings → Brains in JARVIS.')
      }
      reply(200, 'Signed in', 'JARVIS has what it needs. You can close this tab.')
      finish({ code, clientId, scope: q.get('scope') })
    })
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs)
    server.on('error', (err) => {
      if (!server.listening) rejectListen(err)
    })
    server.listen(wantPort, host, () => {
      port = server.address().port
      resolveListen({ redirectUri: `http://${host}:${port}${CALLBACK_PATH}`, result, close: () => finish({ error: 'cancelled' }) })
    })
  })
}

/**
 * Sign in with ChatGPT for one user on this computer.
 *
 * @param {{
 *   store: { get(k: string): string|null, set(k: string, v: string): void, delete(k: string): void },
 *          a credential view scoped to this sign-in (the OS keychain, secrets.mjs)
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   randomBytes?: (n: number) => Buffer,
 *   uuid?: () => string,
 *   timeoutMs?: number,      how long to wait for the browser (default 5 min)
 *   port?: number,           loopback port (default: any free one)
 *   authBase?: string,       tests only: where the auth service is (must be loopback or auth.openai.com)
 * }} opts
 */
export function createSiwcAuth({
  store,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  uuid = randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  port = 0,
  authBase = SIWC_AUTH_BASE,
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new Error('Sign in with ChatGPT needs a credential store.')
  if (typeof fetchImpl !== 'function') throw new Error('Sign in with ChatGPT needs fetch().')
  const base = new URL(authBase)
  const testBase = base.protocol === 'http:' && base.hostname === '127.0.0.1'
  if (!testBase && base.href !== `${SIWC_AUTH_BASE}/`) throw new Error('The ChatGPT sign-in service must be auth.openai.com.')
  // In tests the mock stands in for auth.openai.com; the paths stay OpenAI's.
  const at = (href) => (testBase ? href.replace(SIWC_AUTH_BASE, base.origin) : href)
  const checkUrl = (href) => {
    if (testBase) {
      const u = new URL(href)
      if (u.origin !== base.origin) throw new SiwcError('bad_response')
      return u.href
    }
    return checkAuthUrl(href)
  }

  let pending = null // { listener, promise }
  let lastError = null
  let refreshing = null
  let oidc = null // cached OpenID configuration + JWKS

  const form = (fields) => {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) body.set(k, v)
    return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }
  }

  /** POST/GET to the auth service. Returns { status, body } (body parsed or null). Throws only on network failure. */
  async function call(url, init = {}) {
    let res
    try {
      res = await fetchImpl(url, { ...init, redirect: 'error' })
    } catch {
      throw new SiwcError('network', undefined, { retryable: true })
    }
    let body = null
    try {
      const text = await res.text()
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: res.status, body }
  }

  async function discovery() {
    if (oidc) return oidc
    const conf = await call(at(SIWC_OIDC_CONFIG_URL), { headers: { accept: 'application/json' } })
    if (conf.status !== 200 || !isRecord(conf.body) || typeof conf.body.issuer !== 'string' || typeof conf.body.jwks_uri !== 'string') {
      throw new SiwcError('bad_response', undefined, { retryable: true })
    }
    const jwksUrl = checkUrl(conf.body.jwks_uri)
    const keys = await call(jwksUrl, { headers: { accept: 'application/json' } })
    if (keys.status !== 200 || !Array.isArray(keys.body?.keys)) throw new SiwcError('bad_response', undefined, { retryable: true })
    const revocation = typeof conf.body.revocation_endpoint === 'string' ? checkUrl(conf.body.revocation_endpoint) : null
    oidc = { issuer: conf.body.issuer, jwks: keys.body, revocation }
    return oidc
  }

  const hostId = () => {
    let id = store.get(K.hostId)
    if (!id || !/^urn:uuid:[0-9a-f-]{36}$/i.test(id)) {
      // Chosen once per computer, before its first sign-in; opaque, not an identity.
      id = `urn:uuid:${uuid()}`
      store.set(K.hostId, id)
    }
    return id
  }

  const forget = () => {
    for (const k of TOKEN_KEYS) store.delete(k)
  }

  const tokenText = (v) => (typeof v === 'string' && v && v.length <= MAX_TOKEN ? v : null)

  /** Keep a token reply, replacing the whole set together. */
  function keep(body, { claims = null, refresh = false } = {}) {
    const access = tokenText(body?.access_token)
    if (!access) throw new SiwcError('bad_response')
    const refreshToken = tokenText(body.refresh_token)
    if (!refreshToken && !refresh) throw new SiwcError('bad_response')
    const secs = Number(body.expires_in)
    const expires = now() + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : 3_600_000)
    // On refresh, `scope` may be left out: the grant stays what it was.
    const scopes = typeof body.scope === 'string' ? body.scope.slice(0, 2000) : (store.get(K.scopes) ?? '')
    store.set(K.access, access)
    if (refreshToken) store.set(K.refresh, refreshToken)
    store.set(K.expires, String(expires))
    store.set(K.scopes, scopes)
    store.set(K.savedAt, new Date(now()).toISOString())
    const idToken = tokenText(body.id_token)
    if (idToken && claims) {
      store.set(K.idToken, idToken)
      store.set(K.sub, String(claims.sub).slice(0, 200))
      if (typeof claims.email === 'string') store.set(K.email, claims.email.slice(0, 200))
      else store.delete(K.email)
    }
    return access
  }

  async function complete(listener, { verifier, nonce, requestedClient }) {
    const r = await listener.result
    if (r.error === 'timeout') throw new SiwcError('timeout')
    if (r.error === 'cancelled') throw new SiwcError('cancelled')
    if (r.error) throw new SiwcError('consent_denied') // access_denied: stop, exchange nothing
    // A new registration names the issued client id in the callback.
    const clientId = r.clientId || (requestedClient !== DYNAMIC_CLIENT ? requestedClient : null)
    if (!clientId || clientId === DYNAMIC_CLIENT) throw new SiwcError('bad_response')
    const { issuer, jwks } = await discovery()
    const ex = await call(at(SIWC_TOKEN_URL), form({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: r.code,
      code_verifier: verifier,
      redirect_uri: listener.redirectUri,
      resource: SIWC_RESOURCE,
    }))
    if (ex.status !== 200) {
      const code = ex.body?.error
      if (code === 'invalid_client') {
        store.delete(K.clientId)
        throw new SiwcError('client_invalid')
      }
      // invalid_grant: the code is spent; the user starts again.
      throw new SiwcError(code === 'invalid_grant' ? 'reauth' : 'bad_response', undefined, { retryable: ex.status >= 500 })
    }
    if (!isRecord(ex.body)) throw new SiwcError('bad_response')
    const claims = verifyIdToken(ex.body.id_token, { jwks, issuer, audience: clientId, nonce, now })
    // A different account than the one on this registration: never mix them.
    const knownSub = store.get(K.sub)
    if (knownSub && store.get(K.clientId) === clientId && knownSub !== claims.sub) forget()
    store.set(K.clientId, clientId)
    keep(ex.body, { claims })
    if (!hasPlanScope(store.get(K.scopes))) throw new SiwcError('plan_usage_off')
  }

  const auth = {
    /**
     * Start a sign-in. The listener is up before the URL is handed out; the
     * caller opens `url` in the system browser. `waitForSignIn()` resolves
     * when it is finished.
     */
    async begin() {
      auth.cancel()
      const state = b64url(randomBytes(24))
      const nonce = b64url(randomBytes(24))
      const { verifier, challenge } = pkcePair(randomBytes)
      const listener = await listenOnce({ state, timeoutMs, port })
      const requestedClient = store.get(K.clientId) || DYNAMIC_CLIENT
      const url = authorizeUrl({
        clientId: requestedClient,
        hostId: hostId(),
        redirectUri: listener.redirectUri,
        state,
        nonce,
        challenge,
        idTokenHint: store.get(K.idToken),
      })
      lastError = null
      const entry = { listener }
      entry.promise = complete(listener, { verifier, nonce, requestedClient }).then(
        () => { if (pending === entry) lastError = null },
        (err) => {
          const e = err instanceof SiwcError ? err : new SiwcError('bad_response')
          if (pending === entry) lastError = e
          throw e
        },
      ).finally(() => {
        if (pending === entry) pending = null
      })
      entry.promise.catch(() => {})
      pending = entry
      return { url: at(url), privacyNotice: PRIVACY_NOTICE, manageUsageUrl: MANAGE_USAGE_URL }
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

    signedIn: () => Boolean(store.get(K.refresh)),
    planUsage: () => Boolean(store.get(K.refresh)) && hasPlanScope(store.get(K.scopes)),
    backgroundConsent: () => store.get(K.consent) === 'yes',

    /** The user's express yes (or no) to background tasks using their plan. */
    setBackgroundConsent(yes) {
      if (!store.get(K.refresh)) throw new SiwcError('not_signed_in')
      if (yes) store.set(K.consent, 'yes')
      else store.delete(K.consent)
    },

    /**
     * A valid access token for one request, refreshed when about to expire.
     * `background: true` (a worker, not the user talking) needs consent.
     */
    async accessToken({ background = false, force = false } = {}) {
      const refreshToken = store.get(K.refresh)
      if (!refreshToken) throw new SiwcError('not_signed_in')
      if (!hasPlanScope(store.get(K.scopes))) throw new SiwcError('plan_usage_off')
      if (background && !auth.backgroundConsent()) throw new SiwcError('consent_needed')
      const token = store.get(K.access)
      const expires = Number(store.get(K.expires) ?? 0)
      if (!force && token && expires - REFRESH_EARLY_MS > now()) return token
      // One refresh at a time: the refresh token rotates, so two would race.
      if (!refreshing) {
        refreshing = (async () => {
          const clientId = store.get(K.clientId)
          if (!clientId) {
            forget()
            throw new SiwcError('reauth')
          }
          const r = await call(at(SIWC_TOKEN_URL), form({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
            resource: SIWC_RESOURCE,
          }))
          if (r.status === 200 && isRecord(r.body)) {
            const t = keep(r.body, { refresh: true })
            lastError = null
            return t
          }
          const code = r.body?.error
          if (REAUTH_ERRORS.includes(code)) {
            forget() // keep the client id and host id: sign in again reuses them
            lastError = new SiwcError('reauth')
            throw lastError
          }
          if (code === 'invalid_client') {
            forget()
            store.delete(K.clientId)
            lastError = new SiwcError('client_invalid')
            throw lastError
          }
          // A temporary failure: keep every credential.
          throw new SiwcError('network', undefined, { retryable: true })
        })().finally(() => { refreshing = null })
      }
      return refreshing
    },

    /** A request was refused as a revoked or invalid user: stop using this token set. */
    revoked() {
      forget()
      lastError = new SiwcError('reauth')
    },

    /**
     * Sign out: revoke the refresh token at OpenAI (best effort), then forget
     * the tokens and the background consent. The registered client and host
     * id stay, so signing in again reuses them.
     */
    async signOut() {
      auth.cancel()
      const token = store.get(K.refresh)
      const clientId = store.get(K.clientId)
      let revokedRemotely = false
      if (token && clientId) {
        try {
          const { revocation } = await discovery()
          if (revocation) {
            const r = await call(revocation, form({ token, token_type_hint: 'refresh_token', client_id: clientId }))
            revokedRemotely = r.status === 200
          }
        } catch {
          revokedRemotely = false
        }
      }
      forget()
      lastError = null
      return {
        revokedRemotely,
        // The terms: tell the user when OpenAI did not confirm it.
        ...(token && !revokedRemotely && { detail: 'Signed out here, but OpenAI did not confirm it. You can also disconnect JARVIS in your ChatGPT settings.' }),
      }
    },

    /** For Settings and the brain's status(). Never includes a token. */
    status() {
      const signedIn = auth.signedIn()
      return {
        signedIn,
        signingIn: Boolean(pending),
        planUsage: auth.planUsage(),
        backgroundConsent: signedIn && auth.backgroundConsent(),
        account: signedIn ? (store.get(K.email) ?? null) : null,
        manageUsageUrl: MANAGE_USAGE_URL,
        ...(lastError && { error: { code: lastError.code, message: lastError.message } }),
      }
    },
  }
  return Object.freeze(auth)
}
