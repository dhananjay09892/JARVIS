/**
 * The shared Google OAuth module (task C04): a mocked consent → token →
 * refresh → revoke round trip, with readable errors for denied consent,
 * partial consent, revoked tokens, a missing client and a sign-in left
 * unfinished. Google's token and revoke endpoints are a fake fetch; the
 * loopback listener is real but only on 127.0.0.1, and the "browser" is a
 * plain local HTTP request.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import {
  createGoogleOAuth, createGoogleClient, pkcePair, missingScopes, googleSetup,
  GOOGLE_SCOPES, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_CLIENT_ID,
} from './google-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry, scrubSecrets } from './registry.mjs'
import { createConnectorRoutes } from './routes.mjs'
import { setupProblems } from './interface.mjs'
import { ConnectorError, createHttp } from './http.mjs'
import { createFakeFetch, captureLog, offlineError } from './testpack.mjs'

const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-test-client-secret-value'
const REFRESH = '1//refresh-token-abcdefghijklmnopqrstuvwxyz'
const ACCESS1 = 'ya29.access-one-abcdefghijklmnop'
const ACCESS2 = 'ya29.access-two-abcdefghijklmnop'
const GMAIL = GOOGLE_SCOPES.gmail.join(' ')

/** A browser following Google's redirect to the loopback address. */
function visit(url, { host } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'GET', headers: { host: host ?? u.host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Google's token and revoke endpoints, as a fake fetch. */
function fakeGoogle({ scope = GMAIL, refreshError = null, revokeOffline = false } = {}) {
  const seen = { exchanges: [], refreshes: [], revokes: [], bodies: [] }
  let n = 0
  const { fetch, calls } = createFakeFetch((url, init) => {
    const body = new URLSearchParams(init.body ?? '')
    seen.bodies.push(String(init.body ?? ''))
    if (url === GOOGLE_TOKEN_URL && body.get('grant_type') === 'authorization_code') {
      seen.exchanges.push(Object.fromEntries(body))
      if (body.get('code') !== 'good-code') return { status: 400, body: { error: 'invalid_grant' } }
      return { body: { access_token: ACCESS1, expires_in: 3599, refresh_token: REFRESH, scope, token_type: 'Bearer' } }
    }
    if (url === GOOGLE_TOKEN_URL && body.get('grant_type') === 'refresh_token') {
      seen.refreshes.push(Object.fromEntries(body))
      if (refreshError) return refreshError
      n++
      return { body: { access_token: n === 1 ? ACCESS2 : `${ACCESS2}-${n}`, expires_in: 3599, scope, token_type: 'Bearer' } }
    }
    if (url === GOOGLE_REVOKE_URL) {
      if (revokeOffline) throw offlineError()
      seen.revokes.push(Object.fromEntries(body))
      return { status: 200, body: '' }
    }
    return { status: 404, body: {} }
  })
  return { fetch, calls, seen }
}

function setup({ google = fakeGoogle(), withClient = true, timeoutMs = 10_000, clock = { t: 1_800_000_000_000 } } = {}) {
  const store = createMemoryCredentialStore()
  const client = createGoogleClient(store.scoped(GOOGLE_CLIENT_ID))
  if (withClient) client.save({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  const credentials = store.scoped('gmail')
  const oauth = createGoogleOAuth({ connectorId: 'gmail', credentials, client, fetch: google.fetch, now: () => clock.t, timeoutMs, sleep: async () => {} })
  return { store, client, credentials, oauth, google, clock }
}

const errCode = (code) => (err) => err instanceof ConnectorError && err.code === code

test('PKCE: S256 challenge of a 43-character verifier (RFC 7636 appendix B vector)', () => {
  const rfcBytes = Buffer.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121])
  const { verifier, challenge } = pkcePair(() => rfcBytes)
  assert.equal(verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  const random = pkcePair()
  assert.match(random.verifier, /^[A-Za-z0-9_-]{43}$/)
})

test('only read-only scopes are defined, one set per Google connector', () => {
  assert.deepEqual(Object.keys(GOOGLE_SCOPES).sort(), ['gcalendar', 'gcontacts', 'gdrive', 'gmail', 'google_tasks'])
  for (const list of Object.values(GOOGLE_SCOPES)) {
    for (const s of list) assert.match(s, /^https:\/\/www\.googleapis\.com\/auth\/[a-z.]+\.readonly$/)
  }
  assert.throws(() => createGoogleOAuth({ connectorId: 'youtube', credentials: createMemoryCredentialStore().scoped('youtube'), client: { get: () => null } }))
  assert.deepEqual(missingScopes(['a', 'b'], 'b c'), ['a'])
  assert.deepEqual(setupProblems(googleSetup('gmail', ['Your mail (read-only).'], 'Any new mail?')), [])
})

test('the shared client: checked when pasted, secret never described', () => {
  const store = createMemoryCredentialStore()
  const client = createGoogleClient(store.scoped(GOOGLE_CLIENT_ID))
  assert.equal(client.get(), null)
  assert.throws(() => client.save({ clientId: 'not-a-client' }), errCode('setup-needed'))
  assert.throws(() => client.save({ clientId: CLIENT_ID, clientSecret: 'has space' }), errCode('setup-needed'))
  client.save({ clientId: ` ${CLIENT_ID} `, clientSecret: CLIENT_SECRET })
  assert.deepEqual(client.get(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  const d = client.describe()
  assert.deepEqual(d, { set: true, clientId: CLIENT_ID, hasSecret: true })
  assert.ok(!JSON.stringify(d).includes(CLIENT_SECRET))
  client.save({ clientId: CLIENT_ID }) // secret is optional for Google desktop clients
  assert.equal(client.get().clientSecret, null)
  client.clear()
  assert.equal(client.get(), null)
})

test('consent → token → refresh → revoke round trip', async () => {
  const { oauth, credentials, client, google, clock } = setup()
  assert.equal(oauth.status().state, 'disconnected')

  const { url } = await oauth.begin()
  const auth = new URL(url)
  assert.equal(`${auth.origin}${auth.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth')
  const q = auth.searchParams
  assert.equal(q.get('client_id'), CLIENT_ID)
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('scope'), GMAIL)
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('include_granted_scopes'), null)
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(q.get('state').length >= 32)
  assert.ok(!url.includes(CLIENT_SECRET), 'the client secret is never in the consent link')
  assert.equal(oauth.status().state, 'attention')

  // A reply with the wrong state is ignored, the right one completes.
  const wrong = await visit(`${q.get('redirect_uri')}/?code=good-code&state=forged`)
  assert.equal(wrong.status, 400)
  assert.equal(google.seen.exchanges.length, 0)
  assert.equal(oauth.signingIn(), true)
  const ok = await visit(`${q.get('redirect_uri')}/?code=good-code&state=${encodeURIComponent(q.get('state'))}&scope=x`)
  assert.equal(ok.status, 200)
  assert.ok(!ok.body.includes('good-code'), 'the page does not echo the code')
  await oauth.waitForSignIn()

  const ex = google.seen.exchanges[0]
  assert.equal(ex.client_id, CLIENT_ID)
  assert.equal(ex.client_secret, CLIENT_SECRET)
  assert.equal(ex.redirect_uri, q.get('redirect_uri'))
  assert.equal(createHash('sha256').update(ex.code_verifier).digest('base64url'), q.get('code_challenge'))
  assert.equal(credentials.get('refresh_token'), REFRESH)
  assert.equal(oauth.status().state, 'ok')
  assert.equal(oauth.connected(), true)

  // Fresh token is reused; near expiry it is refreshed, and the refresh token kept.
  assert.equal(await oauth.accessToken(), ACCESS1)
  assert.equal(google.seen.refreshes.length, 0)
  clock.t += 3_560_000
  const [a, b] = await Promise.all([oauth.accessToken(), oauth.accessToken()])
  assert.equal(a, ACCESS2)
  assert.equal(b, ACCESS2)
  assert.equal(google.seen.refreshes.length, 1, 'two callers share one refresh')
  assert.equal(google.seen.refreshes[0].refresh_token, REFRESH)
  assert.equal(credentials.get('refresh_token'), REFRESH)

  // Revoke: at Google (token in the body, never in a URL), then forget.
  const r = await oauth.revoke()
  assert.equal(r.revokedAtGoogle, true)
  assert.equal(google.seen.revokes[0].token, REFRESH)
  assert.ok(google.calls.every((c) => !c.url.includes(REFRESH) && !c.url.includes(CLIENT_SECRET)))
  for (const k of ['refresh_token', 'access_token', 'access_expires', 'granted_scopes']) assert.equal(credentials.get(k), null)
  assert.equal(oauth.status().state, 'disconnected')
  assert.ok(client.get(), 'the shared client stays for the other Google connectors')
  await assert.rejects(oauth.accessToken(), errCode('not-connected'))
})

test('denied consent gives a readable error and keeps nothing', async () => {
  const { oauth, credentials, google } = setup()
  const { url } = await oauth.begin()
  const q = new URL(url).searchParams
  await visit(`${q.get('redirect_uri')}/?error=access_denied&state=${encodeURIComponent(q.get('state'))}`)
  await assert.rejects(oauth.waitForSignIn(), (err) => errCode('consent-denied')(err) && /cancelled|not given/.test(err.message))
  assert.equal(google.seen.exchanges.length, 0)
  assert.equal(credentials.get('refresh_token'), null)
  assert.equal(oauth.status().state, 'attention')
  assert.match(oauth.status().detail, /Press Connect/)
})

test('partial consent (a needed box unticked) is refused and the token given back', async () => {
  const { oauth, credentials, google } = setup({ google: fakeGoogle({ scope: 'openid' }) })
  const { url } = await oauth.begin()
  const q = new URL(url).searchParams
  await visit(`${q.get('redirect_uri')}/?code=good-code&state=${encodeURIComponent(q.get('state'))}`)
  await assert.rejects(oauth.waitForSignIn(), errCode('consent-denied'))
  assert.equal(google.seen.revokes.length, 1)
  assert.equal(credentials.get('refresh_token'), null)
})

test('a revoked refresh token says reconnect, and the dead tokens are dropped', async () => {
  const google = fakeGoogle({ refreshError: { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } })
  const { oauth, credentials, clock } = setup({ google })
  credentials.set('refresh_token', REFRESH)
  credentials.set('access_token', ACCESS1)
  credentials.set('access_expires', String(clock.t - 1))
  await assert.rejects(oauth.accessToken(), (err) => errCode('revoked')(err) && /Reconnect/.test(err.message))
  assert.equal(credentials.get('refresh_token'), null)
  assert.equal(oauth.status().state, 'attention')
  assert.match(oauth.status().detail, /Reconnect/)
})

test('a wrong client (invalid_client) is an auth error, not a crash', async () => {
  const google = fakeGoogle({ refreshError: { status: 401, body: { error: 'invalid_client' } } })
  const { oauth, credentials, clock } = setup({ google })
  credentials.set('refresh_token', REFRESH)
  credentials.set('access_expires', String(clock.t - 1))
  await assert.rejects(oauth.accessToken(), errCode('auth'))
  assert.equal(credentials.get('refresh_token'), REFRESH, 'a client problem does not throw away the grant')
})

test('no client pasted yet: setup-needed, and no listener is opened', async () => {
  const { oauth } = setup({ withClient: false })
  await assert.rejects(oauth.begin(), (err) => errCode('setup-needed')(err) && /client ID/.test(err.message))
  assert.equal(oauth.signingIn(), false)
  assert.equal(oauth.status().state, 'disconnected')
})

test('a sign-in left unfinished times out and closes the listener', async () => {
  const { oauth } = setup({ timeoutMs: 30 })
  const { url } = await oauth.begin()
  await assert.rejects(oauth.waitForSignIn(), errCode('consent-denied'))
  const q = new URL(url).searchParams
  await new Promise((r) => setTimeout(r, 10))
  // Closed: the connection is refused (or, in a race, told the sign-in is over).
  const late = await visit(`${q.get('redirect_uri')}/?code=good-code&state=${q.get('state')}`).catch(() => ({ status: 'refused' }))
  assert.ok(['refused', 410].includes(late.status))
  assert.equal(oauth.signingIn(), false)
})

test('the listener answers only 127.0.0.1 with its own port (no DNS rebinding) and one path', async () => {
  const { oauth, google } = setup()
  const { url } = await oauth.begin()
  const q = new URL(url).searchParams
  const redirect = q.get('redirect_uri')
  const state = encodeURIComponent(q.get('state'))
  assert.equal((await visit(`${redirect}/?code=good-code&state=${state}`, { host: 'evil.example' })).status, 400)
  assert.equal((await visit(`${redirect}/other?code=good-code&state=${state}`)).status, 404)
  assert.equal(google.seen.exchanges.length, 0)
  oauth.cancel()
  await assert.rejects(oauth.waitForSignIn(), errCode('consent-denied'))
})

test('a new Connect replaces a sign-in in progress without the old one leaking into status', async () => {
  const { oauth } = setup()
  await oauth.begin()
  const { url } = await oauth.begin()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(oauth.status().state, 'attention')
  assert.match(oauth.status().detail, /Waiting/)
  const q = new URL(url).searchParams
  await visit(`${q.get('redirect_uri')}/?code=good-code&state=${encodeURIComponent(q.get('state'))}`)
  await oauth.waitForSignIn()
  assert.equal(oauth.status().state, 'ok')
})

test('revoke while offline still forgets the tokens locally', async () => {
  const { oauth, credentials } = setup({ google: fakeGoogle({ revokeOffline: true }) })
  credentials.set('refresh_token', REFRESH)
  const r = await oauth.revoke()
  assert.equal(r.revokedAtGoogle, false)
  assert.equal(credentials.get('refresh_token'), null)
})

test('authorizedJson sends the bearer token and refreshes once on a 401', async () => {
  const google = fakeGoogle()
  const { oauth, credentials, clock } = setup({ google })
  credentials.set('refresh_token', REFRESH)
  credentials.set('access_token', ACCESS1)
  credentials.set('access_expires', String(clock.t + 3_600_000))
  const seen = []
  const api = createHttp({
    allowedHosts: ['gmail.googleapis.com'],
    fetch: createFakeFetch((url, init) => {
      seen.push(init.headers.authorization)
      return init.headers.authorization === `Bearer ${ACCESS2}` ? { body: { ok: 1 } } : { status: 401, body: { error: { message: 'Invalid Credentials' } } }
    }).fetch,
  })
  assert.deepEqual(await oauth.authorizedJson(api, 'https://gmail.googleapis.com/gmail/v1/users/me/profile'), { ok: 1 })
  assert.deepEqual(seen, [`Bearer ${ACCESS1}`, `Bearer ${ACCESS2}`])
  assert.equal(google.seen.refreshes.length, 1)
})

test('Google secrets are scrubbed from anything an adapter says', () => {
  const text = `client ${CLIENT_SECRET} refresh ${REFRESH}`
  const out = scrubSecrets(text)
  assert.ok(!out.includes(CLIENT_SECRET))
  assert.ok(!out.includes(REFRESH))
})

/**
 * A Google-shaped connector built only from this module, the way the Gmail,
 * Calendar and Drive tasks will build theirs: proves the Settings route,
 * the registry and the module fit together.
 */
function googleShapedConnector({ client, onOAuth }) {
  return {
    id: 'gmail',
    create({ credentials, fetch, sleep, now }) {
      const oauth = createGoogleOAuth({ connectorId: 'gmail', credentials, client, fetch, sleep, now, timeoutMs: 10_000 })
      onOAuth(oauth)
      return {
        id: 'gmail',
        name: 'Gmail (test shape)',
        kind: 'data',
        auth: 'oauth',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        setup: googleSetup('gmail', ['Your mail, read-only.']),
        connect: (opts) => oauth.begin(opts),
        disconnect: () => oauth.revoke(),
        status: () => oauth.status(),
        async *sync() { /* the real adapters (C06–C08) sync; this shape only signs in */ },
        async test() {
          await oauth.accessToken()
          return { detail: 'Google access works.' }
        },
      }
    },
  }
}

test('from Settings: paste the client, sign in, test, disconnect — no secret in replies or logs', async () => {
  const google = fakeGoogle()
  const store = createMemoryCredentialStore()
  const client = createGoogleClient(store.scoped(GOOGLE_CLIENT_ID))
  const { log, lines } = captureLog()
  let oauth
  const registry = createConnectorRegistry({ credentials: store, fetch: google.fetch, log })
  assert.equal(registry.register(googleShapedConnector({ client, onOAuth: (o) => { oauth = o } })).ok, true)
  const routes = createConnectorRoutes({ registry, persist: () => {}, log })
  const call = (method, path, body) => routes.handle({ method, path, body })

  const listed = await call('GET', '/connectors')
  const card = listed.body.connectors.find((c) => c.id === 'gmail')
  assert.equal(card.pattern, 'oauth')
  assert.equal(card.setup.clientLabel, 'Google OAuth client (Desktop app)')
  assert.deepEqual(card.setup.scopes, [...GOOGLE_SCOPES.gmail])

  // Without a client: a readable setup error.
  const none = await call('POST', '/connectors/gmail/connect', {})
  assert.equal(none.body.ok, false)
  assert.equal(none.body.code, 'setup-needed')

  const bad = await call('POST', '/connectors/gmail/connect', { clientId: 'with space', clientSecret: CLIENT_SECRET })
  assert.equal(bad.status, 400)

  const r = await call('POST', '/connectors/gmail/connect', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(r.body.ok, true)
  assert.ok(r.body.result.url.startsWith('https://accounts.google.com/'))
  assert.ok(!JSON.stringify(r.body).includes(CLIENT_SECRET))
  assert.equal(client.get().clientSecret, CLIENT_SECRET)
  assert.equal(store.get('gmail', 'client_secret'), null, 'the client is not kept in the connector\'s own entries')

  const q = new URL(r.body.result.url).searchParams
  await visit(`${q.get('redirect_uri')}/?code=good-code&state=${encodeURIComponent(q.get('state'))}`)
  await oauth.waitForSignIn()

  const t = await call('POST', '/connectors/gmail/test', {})
  assert.equal(t.body.ok, true)
  const after = (await call('GET', '/connectors')).body.connectors.find((c) => c.id === 'gmail')
  assert.equal(after.status.state, 'ok')
  assert.ok(!JSON.stringify(after).includes(REFRESH))

  const d = await call('POST', '/connectors/gmail/disconnect', {})
  assert.equal(d.body.ok, true)
  assert.equal(google.seen.revokes.length, 1)
  assert.deepEqual(store.describe('gmail').keys, [])
  assert.ok(client.get(), 'the shared client survives a disconnect')

  const all = lines.join('\n')
  for (const s of [CLIENT_SECRET, REFRESH, ACCESS1]) assert.ok(!all.includes(s), 'no secret in the log')
})
