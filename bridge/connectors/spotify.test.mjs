/**
 * Spotify (task C34): the shared connector test pack plus Spotify's own
 * acceptance tests: recent-plays sync, incremental `after` cursor, malformed
 * items, the PKCE sign-in through the loopback listener, refresh (including a
 * rotated refresh token), a missing scope, disconnect, and the read-only tool.
 * Spotify is a fake fetch; no real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  spotifyConnector, playToDocument, parseSpotifyCursor, spotifyCursor, RECENTLY_PLAYED, SPOTIFY_API_HOST,
} from './spotify.mjs'
import { createSpotifyClient, SPOTIFY_CLIENT_ID, SPOTIFY_TOKEN_URL, SPOTIFY_ACCOUNTS_HOST, SPOTIFY_SCOPES } from './spotify-oauth.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { createConnectorRegistry } from './registry.mjs'
import { connectorTestPack, createFakeFetch, captureLog } from './testpack.mjs'
import { setupProblems } from './interface.mjs'

const CLIENT = '0123456789abcdef0123456789abcdef'
const REFRESH = 'spot-refresh-abcdefghijklmnopqrstuvwxyz0123456789'
const ACCESS = 'BQ-spot-access-abcdefghijklmnop'
const NOW = 1_800_000_000_000

function spotifyClient() {
  const c = createSpotifyClient(createMemoryCredentialStore().scoped(SPOTIFY_CLIENT_ID))
  c.save({ clientId: CLIENT })
  return c
}

const play = (n, { at = `2026-11-0${n}T10:00:00.000Z`, name = `Song ${n}` } = {}) => ({
  played_at: at,
  track: { id: `T${n}abc`, name, duration_ms: 200000, artists: [{ name: `Artist ${n}` }, { name: 'Guest' }], album: { name: `Album ${n}` } },
})

/** Newest first, as Spotify returns them. Honours `after`. */
function fakeSpotify({ plays = [play(3), play(2), play(1)], injection, seen = { urls: [], refreshes: 0, auth: [] } } = {}) {
  const respond = ({ url, init }) => {
    seen.urls.push(url)
    if (url === SPOTIFY_TOKEN_URL) {
      seen.refreshes++
      return { body: { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: SPOTIFY_SCOPES.join(' ') } }
    }
    if (url.startsWith(RECENTLY_PLAYED)) {
      seen.auth.push(init.headers?.authorization)
      const u = new URL(url)
      const after = Number(u.searchParams.get('after') ?? 0)
      let items = plays.filter((p) => Date.parse(p.played_at) > after)
      if (injection) items = items.map((p, i) => (i === 0 ? { ...p, track: { ...p.track, name: `${p.track.name} ${injection}` } } : p))
      return { body: { items, cursors: null } }
    }
    return { status: 404, body: {} }
  }
  return { respond, seen }
}

const factory = spotifyConnector({ spotifyClient: spotifyClient() })

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'refresh_token', value: REFRESH },
  respond: ({ url, init, injection }) => fakeSpotify({ injection }).respond({ url, init }),
  onlyHosts: [SPOTIFY_API_HOST, SPOTIFY_ACCOUNTS_HOST],
})) test(name, run)

function setup(box = fakeSpotify(), { connected = true } = {}) {
  const credentials = createMemoryCredentialStore()
  if (connected) credentials.set('spotify', 'refresh_token', REFRESH)
  const { fetch, calls } = createFakeFetch((url, init) => box.respond({ url, init }))
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log: captureLog().log, now: () => NOW })
  assert.equal(registry.register(factory).ok, true)
  return { registry, credentials, calls, seen: box.seen }
}

test('spotify: card is a read-only sign-in with the one history scope', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'spotify')
  assert.equal(card.pattern, 'oauth')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(card.setup.scopes, ['user-read-recently-played'])
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'list_recent_plays', capability: 'read' }])
  assert.throws(() => spotifyConnector({}), /shared Spotify client/)
})

test('spotify: first sync turns plays into documents and keeps the newest time as cursor', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('spotify')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 3)
  const d = r.documents[0]
  assert.equal(d.title, 'Song 3 — Artist 3, Guest')
  assert.equal(d.sensitivity, 'personal')
  assert.equal(d.updatedAt, Date.parse('2026-11-03T10:00:00.000Z'))
  assert.match(d.text, /Album: Album 3/)
  assert.equal(parseSpotifyCursor(r.cursor), Date.parse('2026-11-03T10:00:00.000Z'))
  assert.match(seen.urls.find((u) => u.startsWith(RECENTLY_PLAYED)), /limit=50/)
  assert.equal(seen.auth[0], `Bearer ${ACCESS}`)
  assert.ok(!r.documents.some((x) => x.text.includes(ACCESS)))
})

test('spotify: incremental sync asks only for plays after the cursor', async () => {
  const box = fakeSpotify()
  const { registry, seen } = setup(box)
  const first = await registry.sync('spotify')
  const r = await registry.sync('spotify', { cursor: first.cursor })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.documents.length, 0)
  const last = seen.urls.filter((u) => u.startsWith(RECENTLY_PLAYED)).pop()
  assert.equal(new URL(last).searchParams.get('after'), String(Date.parse('2026-11-03T10:00:00.000Z')))
})

test('spotify: a new play after the cursor is the only one returned', async () => {
  const plays = [play(2), play(1)]
  const box = fakeSpotify({ plays })
  const { registry } = setup(box)
  const first = await registry.sync('spotify')
  plays.unshift(play(5))
  const r = await registry.sync('spotify', { cursor: first.cursor })
  assert.deepEqual(r.documents.map((d) => d.title), ['Song 5 — Artist 5, Guest'])
})

test('spotify: malformed items are skipped, names are cleaned, bad cursors ignored', () => {
  assert.equal(playToDocument({ played_at: 'x', track: { id: 'A1', name: 'n' } }), null)
  assert.equal(playToDocument({ played_at: '2026-11-01T00:00:00Z', track: { id: 'bad id!', name: 'n' } }), null)
  assert.equal(playToDocument({ played_at: '2026-11-01T00:00:00Z', track: { id: 'A1', name: '' } }), null)
  assert.equal(playToDocument(null), null)
  const d = playToDocument({ played_at: '2026-11-01T00:00:00Z', track: { id: 'A1', name: 'a\u0000b\nc', artists: [] } })
  assert.equal(d.title, 'a b c')
  assert.equal(parseSpotifyCursor('nope'), null)
  assert.equal(parseSpotifyCursor(JSON.stringify({ v: 2, after: 5 })), null)
  assert.equal(parseSpotifyCursor(spotifyCursor(12345)), 12345)
})

test('spotify: a reply that is not a play list is a bad-response error', async () => {
  const box = fakeSpotify()
  const inner = box.respond
  box.respond = (a) => (a.url.startsWith(RECENTLY_PLAYED) ? { body: { oops: true } } : inner(a))
  const { registry } = setup(box)
  const r = await registry.sync('spotify')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
})

test('spotify: list_recent_plays tool is read-only and lists plays', async () => {
  const { registry, seen } = setup()
  const tool = registry.tools().find((t) => t.name.endsWith('list_recent_plays'))
  assert.ok(tool?.readOnly)
  const res = await registry.callTool(tool.name, { limit: 2 }, {})
  assert.notEqual(res.isError, true, JSON.stringify(res))
  assert.match(JSON.stringify(res), /Song 3/)
  assert.match(seen.urls.filter((u) => u.startsWith(RECENTLY_PLAYED)).pop(), /limit=2/)
})

test('spotify: refresh uses the client ID and no secret, is reused, and a rotated refresh token is kept', async () => {
  const bodies = []
  const box = fakeSpotify()
  const inner = box.respond
  box.respond = (a) => {
    if (a.url === SPOTIFY_TOKEN_URL) {
      bodies.push(new URLSearchParams(a.init.body))
      return { body: { access_token: ACCESS, expires_in: 3600, refresh_token: 'rotated-refresh-token-0123456789' } }
    }
    return inner(a)
  }
  const { registry, credentials } = setup(box)
  await registry.sync('spotify')
  await registry.sync('spotify')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].get('grant_type'), 'refresh_token')
  assert.equal(bodies[0].get('client_id'), CLIENT)
  assert.equal(bodies[0].get('client_secret'), null)
  assert.equal(credentials.get('spotify', 'refresh_token'), 'rotated-refresh-token-0123456789')
})

test('spotify: a 401 refreshes once and retries', async () => {
  const box = fakeSpotify()
  const inner = box.respond
  let first = true
  box.respond = (a) => {
    if (a.url.startsWith(RECENTLY_PLAYED) && first) {
      first = false
      return { status: 401, body: { error: { status: 401, message: 'Invalid access token' } } }
    }
    return inner(a)
  }
  const { registry, seen } = setup(box)
  const r = await registry.sync('spotify')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(seen.refreshes, 2)
})

test('spotify: a revoked refresh token forgets the tokens and asks to reconnect', async () => {
  const box = fakeSpotify()
  const inner = box.respond
  box.respond = (a) => (a.url === SPOTIFY_TOKEN_URL ? { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } } : inner(a))
  const { registry, credentials } = setup(box)
  const r = await registry.sync('spotify')
  assert.equal(r.ok, false)
  assert.equal(credentials.get('spotify', 'refresh_token'), null)
})

test('spotify: not connected asks the owner to connect; nothing is called', async () => {
  const { registry, calls } = setup(fakeSpotify(), { connected: false })
  const r = await registry.sync('spotify')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'not-connected')
  assert.equal(calls.length, 0)
})

test('spotify: disconnect forgets every token locally without calling Spotify', async () => {
  const { registry, credentials, calls } = setup()
  const r = await registry.disconnect('spotify', { eraseData: false })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 0)
  assert.deepEqual(credentials.describe('spotify').keys, [])
})

test('spotify: sign-in uses PKCE, the one scope, a checked state, and stores the tokens', async () => {
  const credentials = createMemoryCredentialStore()
  const bodies = []
  const { fetch } = createFakeFetch((url, init) => {
    bodies.push(new URLSearchParams(init.body))
    return { body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: SPOTIFY_SCOPES.join(' ') } }
  })
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log: captureLog().log, now: () => NOW })
  assert.equal(registry.register(spotifyConnector({ spotifyClient: spotifyClient(), port: 0 })).ok, true)
  const started = await registry.connect('spotify', {})
  assert.equal(started.ok, true, JSON.stringify(started))
  const u = new URL(started.result.url)
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize')
  assert.equal(u.searchParams.get('client_id'), CLIENT)
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('scope'), 'user-read-recently-played')
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  assert.equal(redirect.hostname, '127.0.0.1')
  const bad = await globalThis.fetch(`${redirect.origin}/?code=x&state=wrong`)
  assert.equal(bad.status, 400)
  const ok = await globalThis.fetch(`${redirect.origin}/?code=thecode&state=${u.searchParams.get('state')}`)
  assert.equal(ok.status, 200)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(bodies[0].get('grant_type'), 'authorization_code')
  assert.equal(bodies[0].get('code'), 'thecode')
  assert.ok(bodies[0].get('code_verifier').length >= 43)
  assert.equal(bodies[0].get('client_secret'), null)
  assert.equal(credentials.get('spotify', 'refresh_token'), REFRESH)
})

test('spotify: a sign-in that did not grant the scope keeps nothing', async () => {
  const credentials = createMemoryCredentialStore()
  const { fetch } = createFakeFetch(() => ({ body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: '' } }))
  const registry = createConnectorRegistry({ credentials, fetch, sleep: async () => {}, log: captureLog().log, now: () => NOW })
  registry.register(spotifyConnector({ spotifyClient: spotifyClient(), port: 0 }))
  const started = await registry.connect('spotify', {})
  const u = new URL(started.result.url)
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  await globalThis.fetch(`${redirect.origin}/?code=c&state=${u.searchParams.get('state')}`)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(credentials.get('spotify', 'refresh_token'), null)
  assert.equal(registry.status('spotify').state, 'attention')
})

test('spotify: the client ID must look like one and takes no secret', () => {
  const c = createSpotifyClient(createMemoryCredentialStore().scoped(SPOTIFY_CLIENT_ID))
  assert.throws(() => c.save({ clientId: 'not a key!' }), /Finish the setup/)
  assert.throws(() => c.save({ clientId: CLIENT, clientSecret: 'shh' }), /Finish the setup/)
  c.save({ clientId: CLIENT })
  assert.deepEqual(c.describe(), { set: true, clientId: CLIENT, hasSecret: false })
})
