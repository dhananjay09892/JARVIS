/**
 * The shared Microsoft sign-in (task C21): a mocked consent → token →
 * refresh (with rotation) → forget round trip, and readable errors for denied
 * consent, missing Mail.Read, a revoked refresh token, no client, a pasted
 * secret, and a sign-in left unfinished. Microsoft's token endpoint is a fake
 * fetch; the loopback listener is real (127.0.0.1 only), and the "browser" is
 * a local HTTP request carrying the `localhost` Host header a browser sends.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import {
  createMicrosoftOAuth, createMicrosoftClient, missingMicrosoftScopes, microsoftSetup,
  MICROSOFT_SCOPES, MICROSOFT_TOKEN_URL, MICROSOFT_AUTH_URL, MICROSOFT_CLIENT_ID,
} from './microsoft-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { setupProblems } from './interface.mjs'
import { ConnectorError } from './http.mjs'
import { createFakeFetch } from './testpack.mjs'

const CLIENT_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const REFRESH1 = 'M.C5-refresh-one-abcdefghijklmnopqrstuvwxyz'
const REFRESH2 = 'M.C5-refresh-two-abcdefghijklmnopqrstuvwxyz'
const ACCESS1 = 'EwB-access-one-abcdefghijklmnop'
const ACCESS2 = 'EwB-access-two-abcdefghijklmnop'
const MAIL_READ = 'https://graph.microsoft.com/Mail.Read'

/** A browser following Microsoft's redirect to http://localhost:<port>. */
function visit(url, { host } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    // The listener is 127.0.0.1 only; the browser says Host: localhost:<port>.
    const req = request({ hostname: '127.0.0.1', port: u.port, path: `${u.pathname}${u.search}`, method: 'GET', headers: { host: host ?? u.host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function fakeMicrosoft({ scope = `${MAIL_READ} https://graph.microsoft.com/User.Read`, refreshError = null } = {}) {
  const seen = { exchanges: [], refreshes: [] }
  const { fetch, calls } = createFakeFetch((url, init) => {
    const body = new URLSearchParams(init.body ?? '')
    if (url === MICROSOFT_TOKEN_URL && body.get('grant_type') === 'authorization_code') {
      seen.exchanges.push(Object.fromEntries(body))
      if (body.get('code') !== 'good-code') return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000' } }
      return { body: { token_type: 'Bearer', scope, expires_in: 3600, access_token: ACCESS1, refresh_token: REFRESH1 } }
    }
    if (url === MICROSOFT_TOKEN_URL && body.get('grant_type') === 'refresh_token') {
      seen.refreshes.push(Object.fromEntries(body))
      if (refreshError) return refreshError
      return { body: { token_type: 'Bearer', scope, expires_in: 3600, access_token: ACCESS2, refresh_token: REFRESH2 } }
    }
    return { status: 404, body: {} }
  })
  return { fetch, calls, seen }
}

function setup({ ms = fakeMicrosoft(), withClient = true, timeoutMs = 10_000, clock = { t: 1_800_000_000_000 } } = {}) {
  const store = createMemoryCredentialStore()
  const client = createMicrosoftClient(store.scoped(MICROSOFT_CLIENT_ID))
  if (withClient) client.save({ clientId: CLIENT_ID })
  const credentials = store.scoped('outlook')
  const oauth = createMicrosoftOAuth({ connectorId: 'outlook', credentials, client, fetch: ms.fetch, now: () => clock.t, timeoutMs, sleep: async () => {} })
  return { store, client, credentials, oauth, ms, clock }
}

const errCode = (code) => (err) => err instanceof ConnectorError && err.code === code

async function signIn(oauth) {
  const { url } = await oauth.begin()
  const q = new URL(url).searchParams
  const r = await visit(`${q.get('redirect_uri')}/?code=good-code&state=${encodeURIComponent(q.get('state'))}`)
  return { q, r }
}

test('microsoft: only Mail.Read is defined for Outlook, and the card setup is valid', () => {
  assert.deepEqual([...MICROSOFT_SCOPES.outlook], [MAIL_READ])
  for (const scopes of Object.values(MICROSOFT_SCOPES)) {
    for (const s of scopes) assert.ok(!/ReadWrite|Send|AccessAsUser|\.All$/i.test(s), `${s} must be read-only`)
  }
  const s = microsoftSetup('outlook', ['Your inbox.'])
  assert.deepEqual(setupProblems(s), [])
  assert.deepEqual(s.scopes, [MAIL_READ, 'offline_access'])
  assert.ok(s.clientLabel)
})

test('microsoft: the client is a GUID, and a pasted secret is refused, not stored', () => {
  const store = createMemoryCredentialStore()
  const client = createMicrosoftClient(store.scoped(MICROSOFT_CLIENT_ID))
  assert.throws(() => client.save({ clientId: 'not-a-guid' }), errCode('setup-needed'))
  assert.throws(() => client.save({ clientId: CLIENT_ID, clientSecret: 'abc~secret' }), errCode('setup-needed'))
  assert.equal(client.get(), null)
  client.save({ clientId: CLIENT_ID.toUpperCase() })
  assert.deepEqual(client.get(), { clientId: CLIENT_ID })
  assert.deepEqual(client.describe(), { set: true, clientId: CLIENT_ID, hasSecret: false })
})

test('microsoft: granted scopes are compared with or without the Graph prefix', () => {
  assert.deepEqual(missingMicrosoftScopes([MAIL_READ], 'Mail.Read User.Read'), [])
  assert.deepEqual(missingMicrosoftScopes([MAIL_READ], 'https://graph.microsoft.com/mail.read'), [])
  assert.deepEqual(missingMicrosoftScopes([MAIL_READ], 'Mail.ReadBasic'), [MAIL_READ])
  assert.deepEqual(missingMicrosoftScopes([MAIL_READ], undefined), [MAIL_READ])
})

test('microsoft: consent → token → refresh with rotation → forget', async () => {
  const { oauth, credentials, client, ms, clock } = setup()
  assert.equal(oauth.status().state, 'disconnected')
  const { url } = await oauth.begin()
  const auth = new URL(url)
  assert.equal(`${auth.origin}${auth.pathname}`, MICROSOFT_AUTH_URL)
  const q = auth.searchParams
  assert.equal(q.get('client_id'), CLIENT_ID)
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('scope'), `${MAIL_READ} offline_access`)
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.match(q.get('redirect_uri'), /^http:\/\/localhost:\d+$/)
  assert.ok(q.get('state').length >= 32)
  assert.equal(oauth.status().state, 'attention')

  const forged = await visit(`${q.get('redirect_uri')}/?code=good-code&state=forged`)
  assert.equal(forged.status, 400)
  const ok = await visit(`${q.get('redirect_uri')}/?code=good-code&state=${encodeURIComponent(q.get('state'))}`)
  assert.equal(ok.status, 200)
  assert.ok(!ok.body.includes('good-code'))
  await oauth.waitForSignIn()

  const ex = ms.seen.exchanges[0]
  assert.equal(ex.client_id, CLIENT_ID)
  assert.equal(ex.client_secret, undefined, 'a public client sends no secret')
  assert.equal(ex.redirect_uri, q.get('redirect_uri'))
  assert.equal(createHash('sha256').update(ex.code_verifier).digest('base64url'), q.get('code_challenge'))
  assert.equal(credentials.get('refresh_token'), REFRESH1)
  assert.equal(oauth.status().state, 'ok')

  assert.equal(await oauth.accessToken(), ACCESS1)
  clock.t += 3_560_000
  const [a, b] = await Promise.all([oauth.accessToken(), oauth.accessToken()])
  assert.equal(a, ACCESS2)
  assert.equal(b, ACCESS2)
  assert.equal(ms.seen.refreshes.length, 1, 'two callers share one refresh')
  assert.equal(ms.seen.refreshes[0].refresh_token, REFRESH1)
  assert.equal(credentials.get('refresh_token'), REFRESH2, 'the rotated refresh token replaces the old one')
  assert.ok(ms.calls.every((c) => !c.url.includes(REFRESH1) && !c.url.includes(ACCESS1)), 'no token in any URL')

  const r = await oauth.revoke()
  assert.equal(r.revokedAtMicrosoft, false)
  assert.match(r.manageUrl, /^https:\/\//)
  for (const k of ['refresh_token', 'access_token', 'access_expires', 'granted_scopes']) assert.equal(credentials.get(k), null)
  assert.equal(oauth.status().state, 'disconnected')
  assert.ok(client.get(), 'the app registration stays')
  await assert.rejects(oauth.accessToken(), errCode('not-connected'))
})

test('microsoft: denied consent keeps nothing and says so', async () => {
  const { oauth, credentials, ms } = setup()
  const { url } = await oauth.begin()
  const q = new URL(url).searchParams
  await visit(`${q.get('redirect_uri')}/?error=access_denied&error_description=x&state=${encodeURIComponent(q.get('state'))}`)
  await assert.rejects(oauth.waitForSignIn(), errCode('consent-denied'))
  assert.equal(ms.seen.exchanges.length, 0)
  assert.equal(credentials.get('refresh_token'), null)
  assert.equal(oauth.status().state, 'attention')
})

test('microsoft: a token without Mail.Read (tenant policy, wrong registration) is not kept', async () => {
  const { oauth, credentials } = setup({ ms: fakeMicrosoft({ scope: 'https://graph.microsoft.com/User.Read' }) })
  await signIn(oauth)
  await assert.rejects(oauth.waitForSignIn(), errCode('consent-denied'))
  assert.equal(credentials.get('refresh_token'), null)
  assert.equal(credentials.get('access_token'), null)
})

test('microsoft: a revoked refresh token says reconnect and drops the dead tokens', async () => {
  const ms = fakeMicrosoft({ refreshError: { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired due to inactivity.' } } })
  const { oauth, credentials, clock } = setup({ ms })
  await signIn(oauth)
  await oauth.waitForSignIn()
  clock.t += 4_000_000
  await assert.rejects(oauth.accessToken(), errCode('revoked'))
  assert.equal(credentials.get('refresh_token'), null)
  assert.match(oauth.status().detail, /Reconnect/)
})

test('microsoft: no client pasted yet is setup-needed, and no listener opens', async () => {
  const { oauth } = setup({ withClient: false })
  await assert.rejects(oauth.begin(), errCode('setup-needed'))
  assert.equal(oauth.signingIn(), false)
  assert.equal(oauth.status().state, 'disconnected')
})

test('microsoft: the listener refuses another Host (DNS rebinding) and other paths', async () => {
  const { oauth, ms } = setup()
  const { url } = await oauth.begin()
  const q = new URL(url).searchParams
  const redirect = q.get('redirect_uri')
  const state = encodeURIComponent(q.get('state'))
  assert.equal((await visit(`${redirect}/?code=good-code&state=${state}`, { host: 'evil.example' })).status, 400)
  assert.equal((await visit(`${redirect}/?code=good-code&state=${state}`, { host: `127.0.0.1:${new URL(redirect).port}` })).status, 400)
  assert.equal((await visit(`${redirect}/x?code=good-code&state=${state}`)).status, 404)
  assert.equal(ms.seen.exchanges.length, 0)
  oauth.cancel()
  await assert.rejects(oauth.waitForSignIn(), errCode('consent-denied'))
})

test('microsoft: a sign-in left unfinished times out', async () => {
  const { oauth } = setup({ timeoutMs: 30 })
  await oauth.begin()
  await assert.rejects(oauth.waitForSignIn(), errCode('consent-denied'))
  assert.equal(oauth.signingIn(), false)
})
