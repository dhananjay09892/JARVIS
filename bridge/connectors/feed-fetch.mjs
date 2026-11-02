/**
 * Fetching addresses the owner typed (task C25, News / RSS). Every other
 * connector calls one vendor, so createHttp's fixed host list fits them; a feed
 * can be on any host, so the rules here are different and stricter about where
 * a request may land (the rule OpenJarvis keeps too: no private addresses).
 *
 *   checkFeedUrl(raw)      is this address allowed at all? https, default port,
 *                          no credentials, a public-looking host name
 *   isBlockedAddress(ip)   loopback, private, link-local, metadata, CGNAT,
 *                          multicast, reserved, and the IPv6 forms that wrap them
 *   createGuardedFetch()   a fetch whose DNS answers are checked at connection
 *                          time, on the address actually dialled, so a name that
 *                          resolves public once and private later (DNS rebinding)
 *                          gets nowhere
 *   fetchFeed()            the budgeted request: size cap, timeout, a few
 *                          same-site redirects (each one re-checked), Retry-After
 *
 * No cookies, no credentials, no referrer: a feed host learns the bridge's IP
 * address and that someone asked for that feed, nothing else.
 */
import dns from 'node:dns'
import https from 'node:https'
import net from 'node:net'
import { pipeline, Readable } from 'node:stream'
import zlib from 'node:zlib'
import { ConnectorError, errorForResponse, isNetworkError } from './http.mjs'

export const MAX_FEED_BYTES = 5 * 1024 * 1024
export const MAX_REDIRECTS = 3
const MAX_URL = 500
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1'
const USER_AGENT = 'JARVIS-feed-reader/1.0'

const BLOCKED = new net.BlockList()
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(ip, bits, 'ipv4')
for (const [ip, bits] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: wraps any IPv4 address
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(ip, bits, 'ipv6')

/** Should a feed never be fetched from this address? Unreadable counts as yes. */
export function isBlockedAddress(ip) {
  const family = net.isIP(String(ip ?? ''))
  if (family === 4) return BLOCKED.check(ip, 'ipv4')
  // BlockList also matches an IPv4-mapped address (::ffff:a.b.c.d) against the IPv4 rules.
  if (family === 6) return BLOCKED.check(ip, 'ipv6')
  return true
}

const LOCAL_SUFFIX = /\.(localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/i

/**
 * Check a feed address. Returns `{ url }` (normalised, no fragment) or
 * `{ error }` in plain words.
 */
export function checkFeedUrl(raw) {
  if (typeof raw !== 'string') return { error: 'A feed address must be text.' }
  const s = raw.trim()
  if (!s || s.length > MAX_URL) return { error: 'That feed address is empty or too long.' }
  let u
  try {
    u = new URL(s)
  } catch {
    return { error: `Not a web address: ${s.slice(0, 80)}` }
  }
  if (u.protocol !== 'https:') return { error: `Feeds must use https://, not ${u.protocol.slice(0, 20)}` }
  if (u.username || u.password) return { error: 'A feed address cannot hold a user name or password.' }
  if (u.port) return { error: 'Feeds must use the normal https port.' }
  // URL has already turned decimal, octal and hex hosts into dotted form.
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const literal = net.isIP(host) !== 0
  if (literal ? isBlockedAddress(host) : !host.includes('.') || LOCAL_SUFFIX.test(host)) {
    return { error: `That address is on this computer or your local network: ${host.slice(0, 80)}` }
  }
  u.hash = ''
  return { url: u.href }
}

const bareHost = (host) => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')

/**
 * A lookup for node:net that refuses a name if any address it resolves to is
 * blocked. Runs at connection time, on the addresses about to be dialled.
 */
export function createGuardedLookup({ lookup = dns.lookup, blocked = isBlockedAddress } = {}) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'function' ? {} : options
    const done = typeof options === 'function' ? options : callback
    lookup(hostname, { ...(typeof opts === 'number' ? { family: opts } : opts), all: true }, (err, addresses) => {
      if (err) return done(err)
      const list = Array.isArray(addresses) ? addresses : []
      if (!list.length || list.some((a) => blocked(a.address))) {
        return done(Object.assign(new Error('feed host resolves to a private address'), { code: 'EJARVISBLOCKED' }))
      }
      if (opts?.all) return done(null, list)
      done(null, list[0].address, list[0].family)
    })
  }
}

const decoded = (res) => {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim()
  if (!enc || enc === 'identity') return res
  // pipeline, not pipe: a connection lost mid-body must end the reader too.
  if (enc === 'gzip' || enc === 'x-gzip') return pipeline(res, zlib.createGunzip(), () => {})
  res.destroy()
  throw new ConnectorError('bad-response', { detail: `content-encoding ${enc.slice(0, 20)}` })
}

/**
 * A fetch for feeds: Node's https client with the guarded lookup, gzip only,
 * redirects returned rather than followed, nothing kept between calls. The
 * decompressed body is a stream, so `readCapped` also stops a gzip bomb.
 * `tls` is for tests that run a local server.
 */
export function createGuardedFetch({ lookup, blocked, tls = {} } = {}) {
  const guarded = createGuardedLookup({ lookup, blocked })
  return (url, init = {}) => new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { ...(init.headers ?? {}), 'accept-encoding': 'gzip' },
      lookup: guarded,
      signal: init.signal,
      agent: false,
      ...tls,
    }, (res) => {
      try {
        const status = res.statusCode ?? 502
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === 'set-cookie' || v === undefined) continue
          headers.set(k, Array.isArray(v) ? v.join(', ') : v)
        }
        if (status === 304 || status === 204 || status === 205) {
          res.resume()
          return resolve(new Response(null, { status, headers }))
        }
        const body = decoded(res)
        body.on('error', () => {})
        resolve(new Response(Readable.toWeb(body), { status, headers }))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
    req.end()
  })
}

/** A response body as bytes; stops reading at `max`. Throws bad-response when over. */
export async function readCapped(res, max = MAX_FEED_BYTES) {
  const tooBig = () => new ConnectorError('bad-response', { detail: 'feed too large' })
  if (Number(res.headers?.get?.('content-length')) > max) {
    await res.body?.cancel().catch(() => {})
    throw tooBig()
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw tooBig()
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof ConnectorError) throw err
    if (isNetworkError(err)) throw new ConnectorError('offline', { detail: err.name })
    throw new ConnectorError('offline', { detail: 'body interrupted' })
  }
  return Buffer.concat(chunks)
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** Where a redirect may go: an allowed address on the same site (www. aside). */
function nextHop(location, from) {
  if (!location) throw new ConnectorError('bad-response', { detail: 'redirect without a location' })
  let target
  try {
    target = new URL(location, from).href
  } catch {
    throw new ConnectorError('bad-response', { detail: 'bad redirect' })
  }
  const checked = checkFeedUrl(target)
  if (checked.error) throw new ConnectorError('egress', { detail: 'redirect to a refused address' })
  if (bareHost(new URL(checked.url).hostname) !== bareHost(new URL(from).hostname)) {
    throw new ConnectorError('egress', { detail: 'feed moved to another site' })
  }
  return checked.url
}

/**
 * One feed. Returns `{ status: 304 }` or
 * `{ status: 200, bytes, contentType, etag, lastModified }`; throws ConnectorError.
 *
 * @param {string} url an address that passed checkFeedUrl
 * @param {{
 *   fetch: typeof globalThis.fetch,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   etag?: string, lastModified?: string,
 *   timeoutMs?: number, maxBytes?: number, maxRetries?: number, maxWaitMs?: number,
 * }} o
 */
export async function fetchFeed(url, {
  fetch, sleep, now, etag, lastModified,
  timeoutMs = 15_000, maxBytes = MAX_FEED_BYTES, maxRetries = 2, maxWaitMs = 60_000,
}) {
  const headers = {
    accept: FEED_ACCEPT,
    'user-agent': USER_AGENT,
    ...(etag ? { 'if-none-match': etag } : {}),
    ...(lastModified ? { 'if-modified-since': lastModified } : {}),
  }
  let current = url
  let hops = 0
  for (let attempt = 0; ;) {
    const checked = checkFeedUrl(current)
    if (checked.error) throw new ConnectorError('egress', { detail: 'refused address' })
    let res
    try {
      res = await fetch(checked.url, { headers, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err instanceof ConnectorError) throw err
      if ((err?.code ?? err?.cause?.code) === 'EJARVISBLOCKED') throw new ConnectorError('egress', { detail: 'private address' })
      if (isNetworkError(err)) throw new ConnectorError('offline', { detail: err.cause?.code ?? err.code ?? err.name })
      throw new ConnectorError('other', { detail: err?.name })
    }
    if (REDIRECTS.has(res.status)) {
      await res.body?.cancel().catch(() => {})
      if (++hops > MAX_REDIRECTS) throw new ConnectorError('bad-response', { detail: 'too many redirects' })
      current = nextHop(res.headers.get('location'), checked.url)
      continue
    }
    if (res.status === 304) return { status: 304 }
    if (!res.ok) {
      const text = await readCapped(res, 64 * 1024).then((b) => Buffer.from(b).toString('utf8')).catch(() => '')
      const err = errorForResponse(res.status, text, res.headers, now())
      if (err.code !== 'rate-limit') throw err
      const wait = err.retryAfterMs ?? 1000 * 2 ** attempt
      if (attempt >= maxRetries || wait > maxWaitMs) throw err
      attempt++
      await sleep(wait)
      continue
    }
    return {
      status: 200,
      bytes: await readCapped(res, maxBytes),
      contentType: res.headers.get('content-type') ?? '',
      etag: res.headers.get('etag') ?? '',
      lastModified: res.headers.get('last-modified') ?? '',
    }
  }
}

