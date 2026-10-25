import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { createServer } from 'node:http'
import {
  createSiwcAuth, authorizeUrl, verifyIdToken, hasPlanScope, checkAuthUrl, pkcePair, decodeJwt,
  SIWC_SCOPES, SIWC_RESOURCE, PLAN_SCOPE, DYNAMIC_CLIENT, AGENT_NAME, CALLBACK_PATH, PRIVACY_NOTICE, MANAGE_USAGE_URL, SiwcError,
} from './siwc.mjs'

const servers = []
after(() => Promise.all(servers.map((s) => new Promise((resolve) => {
  s.closeAllConnections?.()
  s.close(() => resolve())
}))))

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })

function jwt(payload, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = `${enc({ alg, kid, typ: 'JWT' })}.${enc(payload)}`
  const sig = alg === 'none' ? '' : cryptoSign('sha256', Buffer.from(head), key).toString('base64url')
  return `${head}.${sig}`
}

function memStore(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    map: m,
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, String(v)) },
    delete: (k) => { m.delete(k) },
  }
}

/**
 * A stand-in for auth.openai.com: OpenID configuration, JWKS, token and
 * revocation endpoints. `opts` shapes the replies for each case.
 */
async function mockAuth(opts = {}) {
  const state = { requests: [], challenge: null, nonce: null, refreshes: 0, sub: opts.sub ?? 'user-1', issued: opts.issued ?? 'client-issued-1' }
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const url = new URL(req.url, 'http://x')
    const form = Object.fromEntries(new URLSearchParams(raw))
    state.requests.push({ path: url.pathname, form })
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const origin = `http://127.0.0.1:${server.address().port}`
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: 'https://auth.openai.com', jwks_uri: opts.jwksUri ?? `${origin}/.well-known/jwks.json`, revocation_endpoint: `${origin}/oauth/revoke` })
    }
    if (url.pathname === '/.well-known/jwks.json') return json(200, { keys: [JWK] })
    if (url.pathname === '/oauth/revoke') return opts.revokeStatus ? json(opts.revokeStatus, { error: 'x' }) : json(200)
    if (url.pathname !== '/api/accounts/oauth/token') return json(404, {})
    if (form.resource !== SIWC_RESOURCE) return json(400, { error: 'invalid_target' })
    if (form.grant_type === 'authorization_code') {
      if (opts.exchangeError) return json(400, { error: opts.exchangeError })
      const ok = createHash('sha256').update(form.code_verifier ?? '').digest('base64url') === state.challenge
      if (!ok || form.code !== 'the-code') return json(400, { error: 'invalid_grant' })
      const now = Math.floor(Date.now() / 1000)
      return json(200, {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: opts.scope ?? SIWC_SCOPES.join(' '),
        id_token: opts.idToken ?? jwt({ iss: 'https://auth.openai.com', aud: form.client_id, sub: state.sub, email: 'tony@example.com', exp: now + 600, iat: now, nonce: state.nonce }),
      })
    }
    if (form.grant_type === 'refresh_token') {
      state.refreshes++
      if (opts.refreshDelayMs) await new Promise((r) => setTimeout(r, opts.refreshDelayMs))
      if (opts.refreshError) return json(opts.refreshStatus ?? 400, { error: opts.refreshError })
      return json(200, { access_token: `at-r${state.refreshes}`, refresh_token: `rt-r${state.refreshes}`, expires_in: 3600 })
    }
    return json(400, { error: 'unsupported_grant_type' })
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.origin = `http://127.0.0.1:${server.address().port}`
  return state
}

/** Run a sign-in to the end, playing the browser: OpenAI redirects back with a code. */
async function signIn(auth, mock, { callback = {} } = {}) {
  const { url } = await auth.begin()
  const u = new URL(url)
  mock.challenge = u.searchParams.get('code_challenge')
  mock.nonce = u.searchParams.get('nonce')
  const back = new URL(u.searchParams.get('redirect_uri'))
  const q = { code: 'the-code', state: u.searchParams.get('state'), scope: SIWC_SCOPES.join(' '), ...(u.searchParams.get('client_id') === DYNAMIC_CLIENT && { client_id: mock.issued }), ...callback }
  for (const [k, v] of Object.entries(q)) if (v !== null) back.searchParams.set(k, v)
  const page = await fetch(back)
  await page.text()
  return { url: u, page }
}

test('the authorize URL carries OpenAI\'s fields for a first sign-in', () => {
  const url = new URL(authorizeUrl({ hostId: 'urn:uuid:1', redirectUri: `http://127.0.0.1:1455${CALLBACK_PATH}`, state: 's', nonce: 'n', challenge: 'c' }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize')
  const q = Object.fromEntries(url.searchParams)
  assert.equal(q.client_id, DYNAMIC_CLIENT)
  assert.equal(q.agent_name_hint, AGENT_NAME)
  assert.equal(q.ext_agent_host_id, 'urn:uuid:1')
  assert.equal(q.response_type, 'code')
  assert.equal(q.scope, 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
  assert.equal(q.resource, 'https://api.openai.com/v1')
  assert.equal(q.code_challenge_method, 'S256')
  assert.equal(q.id_token_hint, undefined)
})

test('a later sign-in reuses the issued client, drops the name hint and sends the ID token hint', () => {
  const q = new URL(authorizeUrl({ clientId: 'client-9', hostId: 'urn:uuid:1', redirectUri: 'http://127.0.0.1:2/auth/callback', state: 's', nonce: 'n', challenge: 'c', idTokenHint: 'idt' })).searchParams
  assert.equal(q.get('client_id'), 'client-9')
  assert.equal(q.get('agent_name_hint'), null)
  assert.equal(q.get('id_token_hint'), 'idt')
})

test('PKCE challenge is the unpadded base64url SHA-256 of the verifier', () => {
  const { verifier, challenge } = pkcePair()
  assert.ok(verifier.length >= 43)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.ok(!challenge.includes('='))
})

test('sign-in end to end: registers, verifies the ID token, keeps the tokens and checks plan scope', async () => {
  const mock = await mockAuth()
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin, uuid: () => '0b5c2d4e-1f2a-4b3c-8d9e-0123456789ab' })
  const { url, page } = await signIn(auth, mock)
  assert.equal(page.status, 200)
  await auth.waitForSignIn()
  assert.match(url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:0b5c2d4e-1f2a-4b3c-8d9e-0123456789ab')
  const exchange = mock.requests.find((r) => r.form.grant_type === 'authorization_code')
  assert.equal(exchange.form.client_id, 'client-issued-1', 'the code is exchanged with the issued client id')
  assert.equal(exchange.form.redirect_uri, url.searchParams.get('redirect_uri'))
  assert.equal(exchange.form.client_secret, undefined, 'no client secret')
  assert.equal(store.get('client_id'), 'client-issued-1')
  assert.equal(store.get('refresh_token'), 'rt-1')
  assert.equal(store.get('sub'), 'user-1')
  const s = auth.status()
  assert.equal(s.signedIn, true)
  assert.equal(s.planUsage, true)
  assert.equal(s.account, 'tony@example.com')
  assert.equal(s.backgroundConsent, false)
  assert.equal(s.manageUsageUrl, MANAGE_USAGE_URL)
  assert.equal(JSON.stringify(s).includes('at-1'), false, 'status never carries a token')
  assert.equal(await auth.accessToken(), 'at-1')
})

test('the host id is made once and reused, and a second sign-in reuses the issued client', async () => {
  const mock = await mockAuth()
  const store = memStore()
  let n = 0
  const auth = createSiwcAuth({ store, authBase: mock.origin, uuid: () => `0b5c2d4e-1f2a-4b3c-8d9e-00000000000${++n}` })
  await signIn(auth, mock)
  await auth.waitForSignIn()
  const { url } = await signIn(auth, mock)
  await auth.waitForSignIn()
  assert.equal(n, 1)
  assert.equal(url.searchParams.get('client_id'), 'client-issued-1')
  assert.equal(url.searchParams.get('agent_name_hint'), null)
  assert.ok(url.searchParams.get('id_token_hint'))
})

test('a sign-in without the plan-usage scope keeps the sign-in but plan usage stays off', async () => {
  const mock = await mockAuth({ scope: 'openid profile email offline_access' })
  const auth = createSiwcAuth({ store: memStore(), authBase: mock.origin })
  await signIn(auth, mock)
  await assert.rejects(auth.waitForSignIn(), (e) => e instanceof SiwcError && e.code === 'plan_usage_off')
  assert.equal(auth.status().signedIn, true)
  assert.equal(auth.status().planUsage, false)
  await assert.rejects(auth.accessToken(), (e) => e.code === 'plan_usage_off')
})

test('access_denied stops without exchanging a code', async () => {
  const mock = await mockAuth()
  const auth = createSiwcAuth({ store: memStore(), authBase: mock.origin })
  await signIn(auth, mock, { callback: { code: null, error: 'access_denied' } })
  await assert.rejects(auth.waitForSignIn(), (e) => e.code === 'consent_denied')
  assert.equal(mock.requests.some((r) => r.form.grant_type), false)
  assert.equal(auth.signedIn(), false)
})

test('a callback with the wrong state is ignored', async () => {
  const mock = await mockAuth()
  const auth = createSiwcAuth({ store: memStore(), authBase: mock.origin, timeoutMs: 300 })
  const { url } = await auth.begin()
  const back = new URL(new URL(url).searchParams.get('redirect_uri'))
  back.searchParams.set('code', 'the-code')
  back.searchParams.set('state', 'forged')
  const page = await fetch(back)
  await page.text()
  assert.equal(page.status, 400)
  await assert.rejects(auth.waitForSignIn(), (e) => e.code === 'timeout')
  assert.equal(mock.requests.some((r) => r.form.grant_type), false)
})

test('an ID token that does not verify is refused', () => {
  const now = Math.floor(Date.now() / 1000)
  const good = { iss: 'https://auth.openai.com', aud: 'client-issued-1', sub: 'u', exp: now + 600, nonce: 'n1' }
  const jwks = { keys: [JWK] }
  const check = (token) => verifyIdToken(token, { jwks, issuer: 'https://auth.openai.com', audience: 'client-issued-1', nonce: 'n1' })
  assert.equal(check(jwt(good)).sub, 'u')
  assert.equal(check(jwt({ ...good, aud: ['other', 'client-issued-1'] })).sub, 'u')
  const cases = {
    'wrong key': jwt(good, { key: other.privateKey }),
    'unknown kid': jwt(good, { kid: 'k2' }),
    'wrong issuer': jwt({ ...good, iss: 'https://evil.example' }),
    'wrong audience': jwt({ ...good, aud: 'someone-else' }),
    expired: jwt({ ...good, exp: now - 3600 }),
    'wrong nonce': jwt({ ...good, nonce: 'replayed' }),
    'no subject': jwt({ ...good, sub: '' }),
  }
  for (const [name, token] of Object.entries(cases)) {
    assert.throws(() => check(token), (e) => e instanceof SiwcError && e.code === 'bad_token', name)
  }
})

test('the flow refuses a bad ID token from the token endpoint', async () => {
  const now = Math.floor(Date.now() / 1000)
  const mock = await mockAuth({ idToken: jwt({ iss: 'https://auth.openai.com', aud: 'client-issued-1', sub: 'u', exp: now + 600, nonce: 'x' }, { key: other.privateKey }) })
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin })
  await signIn(auth, mock)
  await assert.rejects(auth.waitForSignIn(), (e) => e.code === 'bad_token')
  assert.equal(store.get('refresh_token'), null)
  assert.equal(store.get('access_token'), null)
})

test('verifyIdToken refuses alg none and tokens that are not JWTs', () => {
  const jwks = { keys: [JWK] }
  const none = jwt({ iss: 'https://auth.openai.com', aud: 'a', sub: 'u', exp: 9e9, nonce: 'n' }, { alg: 'none' })
  assert.throws(() => verifyIdToken(none, { jwks, issuer: 'https://auth.openai.com', audience: 'a', nonce: 'n' }), (e) => e.code === 'bad_token')
  assert.throws(() => verifyIdToken('nope', { jwks, issuer: 'x', audience: 'a', nonce: 'n' }), (e) => e.code === 'bad_token')
  assert.equal(decodeJwt('a.b'), null)
})

test('refresh: early, with the issued client id and resource, and serialized', async () => {
  const mock = await mockAuth({ refreshDelayMs: 30 })
  let clock = Date.now()
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin, now: () => clock })
  await signIn(auth, mock)
  await auth.waitForSignIn()
  clock += 3600_000 - 30_000 // inside the refresh-early window
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()])
  assert.equal(a, 'at-r1')
  assert.equal(b, 'at-r1')
  assert.equal(mock.refreshes, 1, 'two callers, one refresh: the refresh token rotates')
  const r = mock.requests.find((x) => x.form.grant_type === 'refresh_token')
  assert.equal(r.form.client_id, 'client-issued-1')
  assert.equal(r.form.resource, SIWC_RESOURCE)
  assert.equal(r.form.scope, undefined, 'scope left out to keep the grant')
  assert.equal(store.get('refresh_token'), 'rt-r1', 'the rotated refresh token replaces the old one')
  assert.ok(hasPlanScope(store.get('scopes')), 'the grant is kept when refresh omits scope')
})

test('an unusable refresh token means sign in again; the client and host id stay', async () => {
  const mock = await mockAuth({ refreshError: 'refresh_token_reused' })
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin })
  await signIn(auth, mock)
  await auth.waitForSignIn()
  await assert.rejects(auth.accessToken({ force: true }), (e) => e.code === 'reauth')
  assert.equal(store.get('refresh_token'), null)
  assert.equal(store.get('client_id'), 'client-issued-1')
  assert.ok(store.get('host_id'))
  assert.equal(auth.status().error.code, 'reauth')
})

test('a temporary refresh failure keeps every credential', async () => {
  const mock = await mockAuth({ refreshError: 'server_error', refreshStatus: 503 })
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin })
  await signIn(auth, mock)
  await auth.waitForSignIn()
  await assert.rejects(auth.accessToken({ force: true }), (e) => e.code === 'network' && e.retryable)
  assert.equal(store.get('refresh_token'), 'rt-1')
})

test('background use needs express consent, and sign-out forgets it', async () => {
  const mock = await mockAuth()
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin })
  assert.throws(() => auth.setBackgroundConsent(true), (e) => e.code === 'not_signed_in')
  await signIn(auth, mock)
  await auth.waitForSignIn()
  await assert.rejects(auth.accessToken({ background: true }), (e) => e.code === 'consent_needed')
  auth.setBackgroundConsent(true)
  assert.equal(await auth.accessToken({ background: true }), 'at-1')
  await auth.signOut()
  await signIn(auth, mock)
  await auth.waitForSignIn()
  await assert.rejects(auth.accessToken({ background: true }), (e) => e.code === 'consent_needed')
})

test('sign-out revokes the refresh token at OpenAI and keeps the registration', async () => {
  const mock = await mockAuth()
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin })
  await signIn(auth, mock)
  await auth.waitForSignIn()
  const r = await auth.signOut()
  assert.equal(r.revokedRemotely, true)
  const rev = mock.requests.find((x) => x.path === '/oauth/revoke')
  assert.deepEqual(rev.form, { token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'client-issued-1' })
  assert.equal(auth.signedIn(), false)
  assert.equal(store.get('access_token'), null)
  assert.equal(store.get('id_token'), null)
  assert.equal(store.get('client_id'), 'client-issued-1')
  await assert.rejects(auth.accessToken(), (e) => e.code === 'not_signed_in')
})

test('sign-out says so when OpenAI did not confirm the revocation', async () => {
  const mock = await mockAuth({ revokeStatus: 503 })
  const auth = createSiwcAuth({ store: memStore(), authBase: mock.origin })
  await signIn(auth, mock)
  await auth.waitForSignIn()
  const r = await auth.signOut()
  assert.equal(r.revokedRemotely, false)
  assert.match(r.detail, /ChatGPT settings/)
  assert.equal(auth.signedIn(), false)
})

test('a JWKS URL off the auth service is refused', async () => {
  const mock = await mockAuth({ jwksUri: 'https://evil.example/jwks.json' })
  const store = memStore()
  const auth = createSiwcAuth({ store, authBase: mock.origin })
  await signIn(auth, mock)
  await assert.rejects(auth.waitForSignIn(), (e) => e.code === 'bad_response')
  assert.equal(store.get('refresh_token'), null)
  assert.throws(() => checkAuthUrl('https://evil.example/x'), (e) => e.code === 'bad_response')
  assert.throws(() => checkAuthUrl('http://auth.openai.com/x'), (e) => e.code === 'bad_response')
  assert.equal(checkAuthUrl('https://auth.openai.com/.well-known/jwks.json'), 'https://auth.openai.com/.well-known/jwks.json')
})

test('the auth service must be auth.openai.com outside the tests', () => {
  assert.throws(() => createSiwcAuth({ store: memStore(), authBase: 'https://evil.example' }), /auth\.openai\.com/)
  assert.throws(() => createSiwcAuth({ store: memStore(), authBase: 'http://10.0.0.1' }), /auth\.openai\.com/)
  assert.ok(createSiwcAuth({ store: memStore() }))
})

test('the loopback listener answers only its path', async () => {
  const mock = await mockAuth()
  const auth = createSiwcAuth({ store: memStore(), authBase: mock.origin, timeoutMs: 2000 })
  const { url } = await auth.begin()
  const back = new URL(new URL(url).searchParams.get('redirect_uri'))
  const page = await fetch(`${back.origin}/other`)
  await page.text()
  assert.equal(page.status, 404)
  auth.cancel()
  await assert.rejects(auth.waitForSignIn(), (e) => e.code === 'cancelled')
})

test('plan scope check, privacy notice and manage-usage link are there for Settings', () => {
  assert.equal(hasPlanScope(`openid ${PLAN_SCOPE}`), true)
  assert.equal(hasPlanScope('openid email'), false)
  assert.equal(hasPlanScope([PLAN_SCOPE]), true)
  assert.ok(PRIVACY_NOTICE.length >= 3)
  assert.ok(PRIVACY_NOTICE.some((l) => /not made or endorsed by OpenAI/.test(l)))
  assert.ok(PRIVACY_NOTICE.some((l) => /Raw audio/.test(l)))
  assert.match(MANAGE_USAGE_URL, /^https:\/\/chatgpt\.com\//)
})
