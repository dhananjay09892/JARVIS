/**
 * Strava (task C35): the shared connector test pack plus Strava's own
 * acceptance tests: activity sync as health documents, incremental cursor,
 * paging, private and malformed activities, sign-in through the loopback
 * listener with the client secret, refresh (rotated token), a missing
 * permission, disconnect, and the read-only tool. Strava is a fake fetch.
 */
import { test } from 'node:test'
import { request } from 'node:http'
import assert from 'node:assert/strict'
import { stravaConnector, activityToDocument, parseStravaCursor, stravaCursor, ACTIVITIES_URL, STRAVA_API_HOST } from './strava.mjs'
import { createStravaClient, STRAVA_CLIENT_ID, STRAVA_TOKEN_URL, STRAVA_DEAUTH_URL, STRAVA_ACCOUNTS_HOST, STRAVA_SCOPES } from './strava-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'

const CLIENT = '123456'
const SECRET = '0123456789abcdef0123456789abcdef01234567'
const REFRESH = 'strava-refresh-abcdefghijklmnopqrstuvwxyz0123456789'
const ACCESS = 'strava-access-abcdefghijklmnop'
const NOW = 1_800_000_000_000

function stravaClient() {
  const c = createStravaClient(createMemoryCredentialStore().scoped(STRAVA_CLIENT_ID))
  c.save({ clientId: CLIENT, clientSecret: SECRET })
  return c
}

const act = (n, extra = {}) => ({
  id: 1000 + n,
  name: `Run ${n}`,
  sport_type: 'Run',
  start_date: `2026-11-0${n}T07:00:00Z`,
  distance: 5000 + n,
  moving_time: 1500,
  elapsed_time: 1600,
  total_elevation_gain: 42,
  average_heartrate: 151.2,
  max_heartrate: 178,
  map: { summary_polyline: 'SECRET_ROUTE' },
  start_latlng: [51.5, -0.12],
  ...extra,
})

function fakeStrava({ acts = [act(3), act(2), act(1)], injection, seen = { urls: [], refreshes: 0, auth: [] } } = {}) {
  const respond = ({ url, init }) => {
    seen.urls.push(url)
    if (url === STRAVA_TOKEN_URL) {
      seen.refreshes++
      return { body: { access_token: ACCESS, token_type: 'Bearer', expires_in: 21600, refresh_token: REFRESH } }
    }
    if (url === STRAVA_DEAUTH_URL) return { body: { access_token: ACCESS } }
    if (url.startsWith(ACTIVITIES_URL)) {
      seen.auth.push(init.headers?.authorization)
      const u = new URL(url)
      const after = Number(u.searchParams.get('after') ?? 0)
      const per = Number(u.searchParams.get('per_page'))
      const pageNo = Number(u.searchParams.get('page'))
      let items = acts.filter((a) => Date.parse(a.start_date) / 1000 > after)
      if (injection) items = items.map((a, i) => (i === 0 ? { ...a, name: `${a.name} ${injection}` } : a))
      return { body: items.slice((pageNo - 1) * per, pageNo * per) }
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = stravaConnector({ stravaClient: stravaClient() })

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeStrava({ injection }).respond({ url, init }),
  onlyHosts: [STRAVA_API_HOST, STRAVA_ACCOUNTS_HOST],
})) test(name, run)

function setup(box = fakeStrava(), { connected = true } = {}) {
  const credentials = createMemoryCredentialStore()
  if (connected) credentials.set('strava', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => box.respond({ url, init }))
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log: captureLog().log, now: () => NOW })
  assert.equal(registry.register(factory).ok, true)
  return { registry, credentials, calls, seen: box.seen }
}

test('strava: card is a read-only sign-in with the one activity scope, health by default', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'strava')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['activity:read'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'list_recent_activities', capability: 'read' }])
  assert.throws(() => stravaConnector({}), /shared Strava client/)
})

test('strava: first sync yields health documents without routes or coordinates, and a cursor', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('strava')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 3)
  const d = r.documents[0]
  assert.equal(d.sensitivity, 'health')
  assert.equal(d.title, 'Run 3 (Run)')
  assert.match(d.text, /Distance: 5\.00 km/)
  assert.match(d.text, /Average heart rate: 151 bpm/)
  assert.ok(!JSON.stringify(r.documents).match(/SECRET_ROUTE|51\.5|latlng/))
  assert.equal(parseStravaCursor(r.cursor), Date.parse('2026-11-03T07:00:00Z') / 1000)
  assert.equal(seen.auth[0], `Bearer ${ACCESS}`)
})

test('strava: incremental sync asks only for activities after the cursor', async () => {
  const acts = [act(2), act(1)]
  const { registry, seen } = setup(fakeStrava({ acts }))
  const first = await registry.sync('strava')
  acts.unshift(act(5))
  const r = await registry.sync('strava', { cursor: first.cursor })
  assert.deepEqual(r.documents.map((d) => d.title), ['Run 5 (Run)'])
  const last = seen.urls.filter((u) => u.startsWith(ACTIVITIES_URL)).pop()
  assert.equal(new URL(last).searchParams.get('after'), String(Date.parse('2026-11-02T07:00:00Z') / 1000))
})

test('strava: sync pages until a short page', async () => {
  const acts = Array.from({ length: 130 }, (_, i) => act(1, { id: 5000 + i, start_date: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 60000).toISOString() }))
  const { registry, seen } = setup(fakeStrava({ acts }))
  const r = await registry.sync('strava')
  assert.equal(r.documents.length, 130)
  assert.equal(seen.urls.filter((u) => u.startsWith(ACTIVITIES_URL)).length, 2)
})

test('strava: private and malformed activities are skipped, names cleaned, bad cursors ignored', () => {
  assert.equal(activityToDocument(act(1, { private: true })), null)
  assert.equal(activityToDocument({ id: 'x', start_date: '2026-11-01T00:00:00Z' }), null)
  assert.equal(activityToDocument({ id: 7, start_date: 'nope' }), null)
  assert.equal(activityToDocument(null), null)
  assert.equal(activityToDocument(act(1, { name: 'a\u0000b\nc' })).title, 'a b c (Run)')
  assert.equal(parseStravaCursor('nope'), null)
  assert.equal(parseStravaCursor(JSON.stringify({ v: 2, after: 5 })), null)
  assert.equal(parseStravaCursor(stravaCursor(12345)), 12345)
})

test('strava: a reply that is not a list is a bad-response error', async () => {
  const box = fakeStrava()
  const inner = box.respond
  box.respond = (a) => (a.url.startsWith(ACTIVITIES_URL) ? { body: { message: 'oops' } } : inner(a))
  const { registry } = setup(box)
  const r = await registry.sync('strava')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
})

test('strava: list_recent_activities is read-only', async () => {
  const { registry, seen } = setup()
  const tool = registry.tools().find((t) => t.name.endsWith('list_recent_activities'))
  assert.ok(tool?.readOnly)
  const res = await registry.callTool(tool.name, { limit: 2 }, {})
  assert.notEqual(res.isError, true, JSON.stringify(res))
  assert.match(JSON.stringify(res), /Run 3/)
  assert.match(seen.urls.filter((u) => u.startsWith(ACTIVITIES_URL)).pop(), /per_page=2/)
})

test('strava: refresh sends the client ID and secret, is reused, and the rotated token is kept', async () => {
  const bodies = []
  const box = fakeStrava()
  const inner = box.respond
  box.respond = (a) => {
    if (a.url === STRAVA_TOKEN_URL) {
      bodies.push(new URLSearchParams(a.init.body))
      return { body: { access_token: ACCESS, expires_in: 21600, refresh_token: 'rotated-refresh-token-0123456789' } }
    }
    return inner(a)
  }
  const { registry, credentials } = setup(box)
  await registry.sync('strava')
  await registry.sync('strava')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].get('grant_type'), 'refresh_token')
  assert.equal(bodies[0].get('client_id'), CLIENT)
  assert.equal(bodies[0].get('client_secret'), SECRET)
  assert.equal(credentials.get('strava', 'refresh_token'), 'rotated-refresh-token-0123456789')
})

test('strava: a 401 (for example the activity permission was unticked) refreshes once, then asks to reconnect', async () => {
  const box = fakeStrava()
  const inner = box.respond
  box.respond = (a) => (a.url.startsWith(ACTIVITIES_URL)
    ? { status: 401, body: { message: 'Authorization Error', errors: [{ resource: 'AccessToken', field: 'activity:read_permission', code: 'missing' }] } }
    : inner(a))
  const { registry, seen } = setup(box)
  const r = await registry.sync('strava')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'auth')
  assert.equal(seen.refreshes, 2)
})

test('strava: a revoked refresh token forgets the tokens', async () => {
  const box = fakeStrava()
  const inner = box.respond
  box.respond = (a) => (a.url === STRAVA_TOKEN_URL ? { status: 400, body: { message: 'Bad Request', errors: [{ resource: 'RefreshToken', field: 'refresh_token', code: 'invalid' }] } } : inner(a))
  const { registry, credentials } = setup(box)
  const r = await registry.sync('strava')
  assert.equal(r.ok, false)
  assert.notEqual(r.error.code, undefined)
  assert.equal(credentials.get('strava', 'refresh_token'), null)
})

test('strava: not connected asks the owner to connect; nothing is called', async () => {
  const { registry, calls } = setup(fakeStrava(), { connected: false })
  const r = await registry.sync('strava')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'not-connected')
  assert.equal(calls.length, 0)
})

test('strava: disconnect deauthorizes and forgets every token', async () => {
  const { registry, credentials, calls } = setup()
  await registry.sync('strava')
  const r = await registry.disconnect('strava', { eraseData: false })
  assert.equal(r.ok, true)
  assert.ok(calls.some((c) => c.url === STRAVA_DEAUTH_URL))
  assert.deepEqual(credentials.describe('strava').keys.filter((k) => k !== 'client_id' && k !== 'client_secret'), [])
  assert.equal(credentials.get('strava', 'refresh_token'), null)
})

test('strava: disconnect still forgets tokens when Strava cannot be reached', async () => {
  const box = fakeStrava()
  const inner = box.respond
  box.respond = (a) => (a.url === STRAVA_DEAUTH_URL ? { status: 500, body: {} } : inner(a))
  const { registry, credentials } = setup(box)
  await registry.sync('strava')
  const r = await registry.disconnect('strava', { eraseData: false })
  assert.equal(r.ok, true)
  assert.equal(credentials.get('strava', 'refresh_token'), null)
})

/** GET the loopback listener the way the browser would: Host is `localhost:<port>`. */
const browse = (port, path) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', reject)
  req.end()
})

async function signIn(fetchFn, credentials = createMemoryCredentialStore()) {
  const { fetch } = createFakeFetch(fetchFn)
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log: captureLog().log, now: () => NOW })
  assert.equal(registry.register(stravaConnector({ stravaClient: stravaClient(), port: 0 })).ok, true)
  const started = await registry.connect('strava', {})
  assert.equal(started.ok, true, JSON.stringify(started))
  return { registry, credentials, u: new URL(started.result.url) }
}

test('strava: sign-in asks for the one scope, checks state, sends the secret, stores the tokens', async () => {
  const bodies = []
  const { credentials, u } = await signIn((url, init) => {
    bodies.push(new URLSearchParams(init.body))
    return { body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 21600 } }
  })
  assert.equal(u.origin + u.pathname, 'https://www.strava.com/oauth/authorize')
  assert.equal(u.searchParams.get('client_id'), CLIENT)
  assert.equal(u.searchParams.get('scope'), STRAVA_SCOPES.join(','))
  assert.equal(u.searchParams.get('code_challenge'), null)
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  assert.equal(redirect.hostname, 'localhost')
  const bad = { status: await browse(redirect.port, `/?code=x&state=wrong`) }
  assert.equal(bad.status, 400)
  const ok = { status: await browse(redirect.port, `/?code=thecode&state=${u.searchParams.get('state')}`) }
  assert.equal(ok.status, 200)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(bodies[0].get('grant_type'), 'authorization_code')
  assert.equal(bodies[0].get('code'), 'thecode')
  assert.equal(bodies[0].get('client_secret'), SECRET)
  assert.equal(credentials.get('strava', 'refresh_token'), REFRESH)
})

test('strava: a denied sign-in keeps no tokens', async () => {
  const { registry, credentials, u } = await signIn(() => ({ body: {} }))
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  await browse(redirect.port, `/?error=access_denied&state=${u.searchParams.get('state')}`)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(credentials.get('strava', 'refresh_token'), null)
  assert.equal(registry.status('strava').state, 'attention')
})

test('strava: the client needs a numeric ID and a secret', () => {
  const c = createStravaClient(createMemoryCredentialStore().scoped(STRAVA_CLIENT_ID))
  assert.throws(() => c.save({ clientId: 'abc', clientSecret: SECRET }), /Finish the setup/)
  assert.throws(() => c.save({ clientId: CLIENT }), /Finish the setup/)
  assert.throws(() => c.save({ clientId: CLIENT, clientSecret: 'short' }), /Finish the setup/)
  c.save({ clientId: CLIENT, clientSecret: SECRET })
  assert.deepEqual(c.describe(), { set: true, clientId: CLIENT, hasSecret: true })
})
