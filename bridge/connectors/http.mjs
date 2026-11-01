/**
 * HTTP for connector adapters: one place that turns the ways a remote API can
 * fail into errors a person can read, and that keeps every adapter to its own
 * hosts.
 *
 *   createHttp({ fetch, sleep, allowedHosts, maxRetries })
 *     .json(url, init) → parsed JSON, or throws ConnectorError
 *     .text(url, init, { maxChars }) → the body as text (shortened to maxChars),
 *       for APIs that answer with a plain-text or CSV export (task C08)
 *
 * Failure codes (ConnectorError.code), each with an owner-facing message:
 *   auth        401/403: the key or token is wrong or lacks a scope
 *   revoked     the token was revoked or the grant expired: reconnect
 *   rate-limit  429 (or 503 with Retry-After, or Google's 403 rateLimitExceeded /
 *               userRateLimitExceeded) still failing after retries
 *   offline     no network, DNS failure, connection refused, timeout
 *   server      5xx from the provider
 *   bad-response  a reply that is not the JSON the adapter expects
 *   egress      the adapter asked for a host outside its allow-list (rule 7)
 *   consent-denied  the owner cancelled a guided sign-in or did not grant what it needs
 *   setup-needed    a setup step on the card is not done (e.g. no OAuth client pasted)
 *   folder-missing  a local connector's folder is gone, moved or not usable (task C13)
 *   not-granted / disabled / frozen / other  — set by the registry
 *
 * Retry-After is honoured (seconds or an HTTP date), capped, and retried at
 * most `maxRetries` times; `sleep` is injected so tests take no time.
 */

export const ERROR_CODES = Object.freeze([
  'auth', 'revoked', 'rate-limit', 'offline', 'server', 'bad-response', 'egress',
  'consent-denied', 'setup-needed', 'folder-missing',
  'not-granted', 'disabled', 'frozen', 'not-connected', 'other',
])

/** What the owner is told for each code. No provider text, no secrets. */
export const ERROR_MESSAGES = Object.freeze({
  'auth': 'The sign-in or key was refused. Check it in Settings → Connectors.',
  'revoked': 'Access was revoked or has expired. Reconnect it in Settings → Connectors.',
  'rate-limit': 'The service is limiting requests. JARVIS will try again later.',
  'offline': 'The service could not be reached. Check the internet connection.',
  'server': 'The service had a problem on its side. JARVIS will try again later.',
  'bad-response': 'The service sent something JARVIS did not understand.',
  'egress': 'The connector tried to reach a site it is not allowed to.',
  'consent-denied': 'The sign-in was cancelled, or the permission it needs was not given. Press Connect to try again.',
  'setup-needed': 'Finish the setup steps on this card first (for example: paste the Google OAuth client ID, type a location Weather can find, or enter a mail server JARVIS can use over TLS).',
  'folder-missing': 'The folder could not be found or read. Check the folder path in Settings → Connectors.',
  'not-granted': 'That permission has not been granted for this connector.',
  'disabled': 'This connector is turned off.',
  'frozen': 'All connectors are frozen by the kill switch.',
  'not-connected': 'This connector is not connected yet.',
  'other': 'Something went wrong in this connector.',
})

export class ConnectorError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {{ status?: number, retryAfterMs?: number, detail?: string }} [extra]
   */
  constructor(code, { status, retryAfterMs, detail } = {}) {
    const known = ERROR_CODES.includes(code) ? code : 'other'
    super(ERROR_MESSAGES[known])
    this.name = 'ConnectorError'
    this.code = known
    if (status !== undefined) this.status = status
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
    // Developer detail for logs; the registry scrubs it before it goes anywhere.
    if (detail) this.detail = String(detail).slice(0, 300)
  }
}

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH',
  'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
])

/** Is this thrown value a network failure (fetch's TypeError, a Node socket error, an abort)? */
export function isNetworkError(err) {
  if (!err) return false
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true
  const code = err.code ?? err.cause?.code
  if (code && NETWORK_CODES.has(code)) return true
  return err instanceof TypeError && /fetch failed|network/i.test(String(err.message))
}

/** Retry-After in ms: seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null
  const s = String(value).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  const at = Date.parse(s)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

const REVOKED = /invalid_grant|token[_ ]?(has been )?(revoked|expired)|revoked|unauthorized_client|account_inactive|token_expired/i
/** Google APIs (Drive, Calendar) also say "slow down" as a 403 with one of these reasons. */
const GOOGLE_RATE_LIMIT = /"reason"\s*:\s*"(rateLimitExceeded|userRateLimitExceeded)"/

/**
 * Classify a non-OK response. `bodyText` is the response body, read once.
 * @returns {ConnectorError}
 */
export function errorForResponse(status, bodyText, headers, now = Date.now()) {
  const header = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k])
  if (status === 401 || status === 400 || status === 403) {
    if (REVOKED.test(bodyText ?? '')) return new ConnectorError('revoked', { status })
    if (status === 403 && GOOGLE_RATE_LIMIT.test(bodyText ?? '')) {
      const wait = retryAfterMs(header('retry-after'), now)
      return new ConnectorError('rate-limit', { status, retryAfterMs: wait ?? undefined })
    }
    if (status !== 400) return new ConnectorError('auth', { status })
  }
  if (status === 429 || (status === 503 && header('retry-after'))) {
    const wait = retryAfterMs(header('retry-after'), now)
    return new ConnectorError('rate-limit', { status, retryAfterMs: wait ?? undefined })
  }
  if (status >= 500) return new ConnectorError('server', { status })
  return new ConnectorError('bad-response', { status })
}

/**
 * @param {{
 *   fetch?: typeof globalThis.fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   allowedHosts: string[],            exact host names this adapter may call
 *   maxRetries?: number,               rate-limit retries (default 2)
 *   maxWaitMs?: number,                longest single wait honoured (default 60 s)
 *   defaultWaitMs?: number,            wait when 429 has no Retry-After (default 1 s)
 *   timeoutMs?: number,                per request (default 30 s)
 *   now?: () => number,
 * }} opts
 */
export function createHttp({
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  allowedHosts,
  maxRetries = 2,
  maxWaitMs = 60_000,
  defaultWaitMs = 1_000,
  timeoutMs = 30_000,
  now = Date.now,
} = {}) {
  if (!Array.isArray(allowedHosts) || !allowedHosts.length) {
    throw new Error('An adapter must name the hosts it may call (vetting rule 7).')
  }
  const hosts = new Set(allowedHosts.map((h) => String(h).toLowerCase()))

  const checkHost = (url) => {
    let u
    try {
      u = new URL(url)
    } catch {
      throw new ConnectorError('egress', { detail: 'unparseable URL' })
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
      throw new ConnectorError('egress', { detail: `protocol ${u.protocol}` })
    }
    if (!hosts.has(u.hostname.toLowerCase())) throw new ConnectorError('egress', { detail: `host ${u.hostname}` })
  }

  async function once(url, init, raw = false, maxChars = Infinity) {
    let res
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
      // Redirects are refused, not followed: a redirect is a way off the allow-list.
      res = await fetch(url, { ...init, redirect: 'error', ...(signal && !init?.signal ? { signal } : {}) })
    } catch (err) {
      if (err instanceof ConnectorError) throw err
      if (isNetworkError(err)) throw new ConnectorError('offline', { detail: err.cause?.code ?? err.name })
      throw new ConnectorError('other', { detail: err?.name })
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) throw errorForResponse(res.status, text, res.headers, now())
    if (raw) return text.length > maxChars ? text.slice(0, maxChars) : text
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new ConnectorError('bad-response', { status: res.status, detail: 'not JSON' })
    }
  }

  async function withRetries(url, init, raw, maxChars) {
    checkHost(url)
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(url, init, raw, maxChars)
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code !== 'rate-limit' || attempt >= maxRetries) throw err
        const wait = err.retryAfterMs ?? defaultWaitMs * 2 ** attempt
        if (wait > maxWaitMs) throw err
        await sleep(wait)
      }
    }
  }

  return {
    /** Fetch JSON, retrying rate limits. Throws ConnectorError on any failure. */
    json: (url, init = {}) => withRetries(url, init, false),
    /**
     * Fetch a body as text (an export, a CSV), retrying rate limits; '' when
     * empty, shortened to `maxChars`. Throws ConnectorError on any failure.
     */
    text: (url, init = {}, { maxChars = 1_000_000 } = {}) => withRetries(url, init, true, Math.max(0, maxChars)),
    allowedHosts: [...hosts],
  }
}
