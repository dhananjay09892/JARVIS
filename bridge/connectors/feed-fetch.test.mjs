/**
 * Address rules and the guarded fetch (task C25). No network: the end-to-end
 * test talks to a local TLS server through a fake DNS answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import {
  checkFeedUrl, createGuardedFetch, createGuardedLookup, fetchFeed, isBlockedAddress, MAX_REDIRECTS, readCapped,
} from './feed-fetch.mjs'
import { createFakeFetch, offlineError } from './testpack.mjs'

const opts = (fetch, extra = {}) => ({ fetch, sleep: async () => {}, now: () => 0, ...extra })
const fails = (code) => (err) => {
  assert.equal(err.code, code, err.detail)
  return true
}

test('private, local and reserved addresses are blocked', () => {
  for (const ip of [
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', 'nonsense', '', undefined,
  ]) assert.equal(isBlockedAddress(ip), true, String(ip))
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '151.101.1.69', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
    assert.equal(isBlockedAddress(ip), false, ip)
  }
})

test('feed addresses: https, default port, no credentials, nothing local', () => {
  assert.equal(checkFeedUrl(' https://Example.com/feed.xml?a=1#top ').url, 'https://example.com/feed.xml?a=1')
  assert.ok(checkFeedUrl('https://1.1.1.1/rss').url)
  for (const bad of [
    'http://example.com/feed', 'ftp://example.com/feed', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', 42, null,
    'https://user:pw@example.com/feed', 'https://example.com:8443/feed',
    'https://localhost/feed', 'https://intranet/feed', 'https://nas.local/feed', 'https://box.internal/feed',
    'https://foo.localhost/feed', 'https://127.0.0.1/feed', 'https://[::1]/feed', 'https://[::ffff:7f00:1]/feed',
    'https://169.254.169.254/latest/meta-data', 'https://192.168.1.1/feed',
    'https://2130706433/feed', 'https://0x7f.0.0.1/feed', 'https://0177.0.0.1/feed', 'https://127.1/feed',
    `https://example.com/${'x'.repeat(600)}`,
  ]) assert.ok(checkFeedUrl(bad).error, String(bad).slice(0, 60))
})

test('the guarded lookup refuses a name with any private address', async () => {
  const run = (addresses, options = {}) => new Promise((resolve) => {
    const lookup = (_h, o, cb) => cb(null, addresses)
    createGuardedLookup({ lookup })('feed.example', options, (err, a, f) => resolve({ err, a, f }))
  })
  assert.deepEqual(await run([{ address: '1.1.1.1', family: 4 }]), { err: null, a: '1.1.1.1', f: 4 })
  const all = [{ address: '1.1.1.1', family: 4 }]
  assert.deepEqual((await run(all, { all: true })).a, all)
  for (const list of [
    [{ address: '10.0.0.1', family: 4 }],
    [{ address: '1.1.1.1', family: 4 }, { address: '::1', family: 6 }],
    [],
  ]) assert.equal((await run(list, { all: true })).err?.code, 'EJARVISBLOCKED')
})

test('DNS rebinding: the real transport never connects to a private answer', async () => {
  let connections = 0
  const server = https.createServer(() => { connections++ })
  const fetch = createGuardedFetch({ lookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) })
  await assert.rejects(fetchFeed('https://feed.example/rss', opts(fetch)), fails('egress'))
  assert.equal(connections, 0)
  server.close()
})

test('a redirect stays on the site; each hop is checked; hops are limited', async () => {
  const hop = (location) => ({ status: 301, headers: { location }, body: null })
  const ok = { body: '<rss/>' }
  const run = (handler) => fetchFeed('https://news.example/a', opts(createFakeFetch(handler).fetch))

  const same = createFakeFetch((u) => (u.endsWith('/a') ? hop('/b') : ok))
  assert.equal((await fetchFeed('https://news.example/a', opts(same.fetch))).status, 200)
  assert.deepEqual(same.calls.map((c) => c.url), ['https://news.example/a', 'https://news.example/b'])

  const www = createFakeFetch((u) => (u.endsWith('/a') ? hop('https://www.news.example/a2') : ok))
  assert.equal((await fetchFeed('https://news.example/a', opts(www.fetch))).status, 200)

  for (const location of [
    'https://other.example/a', 'http://news.example/a', 'https://127.0.0.1/a', 'https://169.254.169.254/latest/meta-data',
    'https://news.example:8443/a', 'file:///etc/passwd',
  ]) await assert.rejects(run(() => hop(location)), fails('egress'), location)

  await assert.rejects(run(() => ({ status: 302, body: null })), fails('bad-response'))
  let n = 0
  const loop = createFakeFetch(() => hop(`/${n++}`))
  await assert.rejects(fetchFeed('https://news.example/a', opts(loop.fetch)), fails('bad-response'))
  assert.equal(loop.calls.length, MAX_REDIRECTS + 1)
})

test('a refused address is never requested', async () => {
  const { fetch, calls } = createFakeFetch(() => ({ body: '' }))
  await assert.rejects(fetchFeed('http://news.example/a', opts(fetch)), fails('egress'))
  assert.equal(calls.length, 0)
})

test('oversized feeds stop at the cap, with or without Content-Length', async () => {
  const stated = createFakeFetch(() => ({ headers: { 'content-length': '999999' }, body: 'x' }))
  await assert.rejects(fetchFeed('https://news.example/a', opts(stated.fetch, { maxBytes: 100 })), fails('bad-response'))
  let pulled = 0
  const endless = async () => new Response(new ReadableStream({
    pull(c) {
      pulled++
      c.enqueue(new Uint8Array(1024))
    },
  }))
  await assert.rejects(fetchFeed('https://news.example/a', opts(endless, { maxBytes: 4096 })), fails('bad-response'))
  assert.ok(pulled < 20, 'stopped reading')
  assert.equal((await readCapped(new Response('abc'), 3)).length, 3)
})

test('Retry-After is honoured, and offline is named', async () => {
  const sleeps = []
  let first = true
  const { fetch } = createFakeFetch(() => {
    if (first) {
      first = false
      return { status: 429, headers: { 'retry-after': '3' }, body: 'slow down' }
    }
    return { body: '<rss/>' }
  })
  await fetchFeed('https://news.example/a', opts(fetch, { sleep: async (ms) => { sleeps.push(ms) } }))
  assert.deepEqual(sleeps, [3000])
  const long = createFakeFetch(() => ({ status: 429, headers: { 'retry-after': '3600' }, body: '' }))
  await assert.rejects(fetchFeed('https://news.example/a', opts(long.fetch)), (e) => e.code === 'rate-limit' && e.retryAfterMs === 3_600_000)
  const off = createFakeFetch(() => { throw offlineError() })
  await assert.rejects(fetchFeed('https://news.example/a', opts(off.fetch)), fails('offline'))
})

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('the real transport end to end: TLS, gzip, 304, gzip bomb', { skip: !hasOpenssl }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-feed-'))
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=feed.example',
      '-addext', 'subjectAltName=DNS:feed.example', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    ], { stdio: 'ignore' })
    const cert = readFileSync(join(dir, 'c.pem'))
    const seen = []
    const server = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert }, (req, res) => {
      seen.push({ url: req.url, headers: req.headers })
      if (req.url === '/gz') {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/rss+xml', etag: '"v1"', 'set-cookie': 'a=1' })
        return res.end(zlib.gzipSync('<rss/>'))
      }
      if (req.url === '/same') {
        res.writeHead(304)
        return res.end()
      }
      if (req.url === '/bomb') {
        res.writeHead(200, { 'content-encoding': 'gzip' })
        return res.end(zlib.gzipSync(Buffer.alloc(5_000_000)))
      }
      if (req.url === '/br') {
        res.writeHead(200, { 'content-encoding': 'br' })
        return res.end('x')
      }
      res.writeHead(200)
      res.end('<rss/>')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const fetch = createGuardedFetch({
      lookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
      blocked: () => false,
      tls: { port: server.address().port, ca: cert },
    })
    const get = (path, extra = {}) => fetchFeed(`https://feed.example${path}`, opts(fetch, extra))
    try {
      const gz = await get('/gz', { etag: '"old"' })
      assert.equal(Buffer.from(gz.bytes).toString(), '<rss/>')
      assert.equal(gz.etag, '"v1"')
      assert.equal(seen[0].headers['if-none-match'], '"old"')
      assert.equal(seen[0].headers.cookie, undefined)
      assert.equal(seen[0].headers['accept-encoding'], 'gzip')
      assert.equal((await get('/same')).status, 304)
      await assert.rejects(get('/bomb', { maxBytes: 100_000 }), fails('bad-response'))
      await assert.rejects(get('/br'), fails('bad-response'))
    } finally {
      server.close()
      server.closeAllConnections()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
