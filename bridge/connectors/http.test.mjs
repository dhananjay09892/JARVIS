import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHttp, ConnectorError, errorForResponse, retryAfterMs, isNetworkError, ERROR_CODES, ERROR_MESSAGES } from './http.mjs'
import { createFakeFetch, offlineError } from './testpack.mjs'

const host = 'api.example.test'

test('an adapter must name its hosts, and other hosts are refused before any request', async () => {
  assert.throws(() => createHttp({ allowedHosts: [] }), /rule 7/)
  const { fetch, calls } = createFakeFetch(() => ({ body: { ok: true } }))
  const http = createHttp({ fetch, allowedHosts: [host] })
  assert.deepEqual(await http.json(`https://${host}/x`), { ok: true })
  for (const url of ['https://evil.example/x', `http://${host}/x`, 'not a url', `https://${host}.evil.example/`]) {
    await assert.rejects(http.json(url), (e) => e instanceof ConnectorError && e.code === 'egress', url)
  }
  assert.equal(calls.length, 1)
})

test('redirects are refused, not followed', async () => {
  let seen
  const http = createHttp({ fetch: async (url, init) => { seen = init; return new Response('{}') }, allowedHosts: [host] })
  await http.json(`https://${host}/x`, { redirect: 'follow' })
  assert.equal(seen.redirect, 'error')
})

test('responses are classified into readable errors', () => {
  const cases = [
    [401, '{"error":"invalid_token"}', {}, 'auth'],
    [403, '{"error":"insufficient_scope"}', {}, 'auth'],
    [400, '{"error":"invalid_grant"}', {}, 'revoked'],
    [401, '{"ok":false,"error":"token_revoked"}', {}, 'revoked'],
    [400, '{"error":"bad_request"}', {}, 'bad-response'],
    [429, '', { 'retry-after': '3' }, 'rate-limit'],
    [503, '', { 'retry-after': '3' }, 'rate-limit'],
    [503, '', {}, 'server'],
    [500, '', {}, 'server'],
    [404, '', {}, 'bad-response'],
    [403, '{"error":{"code":403,"errors":[{"domain":"usageLimits","reason":"userRateLimitExceeded"}]}}', {}, 'rate-limit'],
    [403, '{"error":{"errors":[{"reason": "rateLimitExceeded"}]}}', {}, 'rate-limit'],
    [403, '{"error":{"errors":[{"reason":"exportSizeLimitExceeded"}]}}', {}, 'auth'],
  ]
  for (const [status, body, headers, code] of cases) {
    assert.equal(errorForResponse(status, body, new Headers(headers)).code, code, `${status} ${body}`)
  }
  assert.equal(errorForResponse(429, '', new Headers({ 'retry-after': '3' })).retryAfterMs, 3000)
})

test('Retry-After: seconds, dates, junk', () => {
  assert.equal(retryAfterMs('2'), 2000)
  assert.equal(retryAfterMs('0.5'), 500)
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000)
  assert.equal(retryAfterMs('soon'), null)
  assert.equal(retryAfterMs(undefined), null)
})

test('rate limits retry with backoff, within limits', async () => {
  let n = 0
  const { fetch } = createFakeFetch(() => (++n < 3 ? { status: 429, body: {} } : { body: { n } }))
  const sleeps = []
  const http = createHttp({ fetch, sleep: async (ms) => sleeps.push(ms), allowedHosts: [host], defaultWaitMs: 100 })
  assert.deepEqual(await http.json(`https://${host}/`), { n: 3 })
  assert.deepEqual(sleeps, [100, 200])

  const long = createHttp({
    fetch: createFakeFetch(() => ({ status: 429, headers: { 'retry-after': '3600' } })).fetch,
    sleep: async () => assert.fail('must not wait an hour'),
    allowedHosts: [host],
  })
  await assert.rejects(long.json(`https://${host}/`), (e) => e.code === 'rate-limit' && e.retryAfterMs === 3_600_000)
})

test('network failures are offline; bad JSON is a bad response', async () => {
  assert.equal(isNetworkError(offlineError()), true)
  assert.equal(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true)
  assert.equal(isNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true)
  assert.equal(isNetworkError(new Error('nope')), false)
  const off = createHttp({ fetch: async () => { throw offlineError() }, allowedHosts: [host] })
  await assert.rejects(off.json(`https://${host}/`), (e) => e.code === 'offline')
  const junk = createHttp({ fetch: async () => new Response('<html>'), allowedHosts: [host] })
  await assert.rejects(junk.json(`https://${host}/`), (e) => e.code === 'bad-response')
  const empty = createHttp({ fetch: async () => new Response(''), allowedHosts: [host] })
  assert.equal(await empty.json(`https://${host}/`), null)
})

test('every error code has an owner-facing message with no provider text', () => {
  for (const code of ERROR_CODES) assert.ok(ERROR_MESSAGES[code], code)
  const e = new ConnectorError('not-a-code', { detail: 'x'.repeat(1000) })
  assert.equal(e.code, 'other')
  assert.equal(e.detail.length, 300)
})

test('text() returns a plain body, shortened, with the same host rules and retries (C08)', async () => {
  let n = 0
  const http = createHttp({
    fetch: async () => (n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : new Response('line one\nline two')),
    sleep: async () => {},
    allowedHosts: [host],
  })
  assert.equal(await http.text(`https://${host}/export`, {}, { maxChars: 8 }), 'line one')
  assert.equal(n, 2)
  await assert.rejects(http.text('https://evil.example/x'), (e) => e.code === 'egress')
  const empty = createHttp({ fetch: async () => new Response(null, { status: 204 }), allowedHosts: [host] })
  assert.equal(await empty.text(`https://${host}/x`), '')
})

test('a 403 that says it is a rate limit is not a refused token (GitHub, task C23)', () => {
  const at = Date.parse('2026-11-02T00:00:00Z')
  const primary = errorForResponse(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at / 1000 + 120) }, at)
  assert.equal(primary.code, 'rate-limit')
  assert.equal(primary.retryAfterMs, 120_000)
  const retry = errorForResponse(403, '{}', { 'retry-after': '30' }, at)
  assert.equal(retry.code, 'rate-limit')
  assert.equal(retry.retryAfterMs, 30_000)
  const secondary = errorForResponse(403, '{"message":"You have exceeded a secondary rate limit."}', {}, at)
  assert.equal(secondary.code, 'rate-limit')
  assert.equal(secondary.retryAfterMs, 60_000)
  assert.equal(errorForResponse(429, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at / 1000 + 5) }, at).retryAfterMs, 5000)
  assert.equal(errorForResponse(403, '{"message":"Forbidden"}', { 'x-ratelimit-remaining': '4999' }, at).code, 'auth')
})

test('response() gives status and headers, and a 304 is an answer', async () => {
  const replies = [
    { status: 200, headers: { 'last-modified': 'then' }, body: [1] },
    { status: 304 },
  ]
  const { fetch } = createFakeFetch(() => replies.shift())
  const http = createHttp({ fetch, allowedHosts: [host] })
  const ok = await http.response(`https://${host}/x`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('last-modified'), 'then')
  assert.deepEqual(ok.body, [1])
  const same = await http.response(`https://${host}/x`)
  assert.equal(same.status, 304)
  assert.equal(same.body, null)
  // Everywhere else a 304 is still not something an adapter expects.
  const { fetch: f2 } = createFakeFetch(() => ({ status: 304 }))
  await assert.rejects(createHttp({ fetch: f2, allowedHosts: [host] }).json(`https://${host}/x`), (e) => e.code === 'bad-response')
})
