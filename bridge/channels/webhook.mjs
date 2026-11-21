/**
 * The generic outbound webhook channel (task C47; plan 20). It is a sender
 * only: nothing is listened on, nothing inbound is parsed, and what a
 * receiver answers is never read into a prompt.
 *
 * - Targets are owner-configured (`getTargets`): an id, a name and an https
 *   URL. The set of targets *is* the egress allow-list: a send names a
 *   target id, never a URL, and a URL that is not a listed target is
 *   refused. Plain http, userinfo in the URL, local names and private
 *   addresses are refused (the shared SSRF gate in net.mjs, which resolves
 *   once and connects to the vetted address). Redirects are never followed.
 * - Every send is approval-gated: `approve()` must say yes for that send,
 *   unless the owner pre-approved that one target (`preApproved: true`).
 *   With no `approve` function and no pre-approval, nothing is sent.
 * - Payloads are small JSON, signed with HMAC-SHA256 under a per-target
 *   secret (`X-Jarvis-Signature: t=<unix>,v1=<hex>` over `<t>.<body>`), with
 *   a delivery id that stays the same across retries so a receiver can
 *   de-duplicate. The secret is read through `getSecret` per use and is
 *   redacted from every error and result.
 * - Only `public` text leaves: private and vault content is "details in the
 *   app" (the same rule as the chat channels). Hidden-text characters are
 *   stripped.
 * - Retries with exponential backoff on network errors, 429 and 5xx (honouring
 *   a short Retry-After); never on other 4xx. A freeze stops a send before
 *   the first attempt and between attempts.
 * - Per-target flood and daily caps; both fail closed.
 * - Audit rows carry ids, lengths and the rule. Never the text, the URL's path
 *   or query, or a secret.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { guardedLookup, vetTarget } from '../net.mjs'
import { stripHiddenText } from '../untrusted.mjs'

export const CHANNEL_ID = 'webhook'
export const SIGNATURE_HEADER = 'x-jarvis-signature'
export const DELIVERY_HEADER = 'x-jarvis-delivery'
export const SECRET_PREFIX = 'WEBHOOK_SECRET_'
export const MAX_TEXT_CHARS = 4000
export const MAX_ATTEMPTS = 4
export const BACKOFF_MS = Object.freeze([1000, 2000, 4000])
export const MAX_RETRY_AFTER_MS = 30_000
export const REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_PER_MINUTE = 10
export const DEFAULT_PER_DAY = 200
export const SIGNATURE_TOLERANCE_S = 300
const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const HEX_SECRET = /\b[0-9a-f]{64}\b/g

/** A new signing secret for a target: 256 random bits, hex. Shown to the owner once. */
export const generateSecret = () => randomBytes(32).toString('hex')

/** The vault name a target's secret is kept under. */
export const secretNameFor = (targetId) => `${SECRET_PREFIX}${String(targetId).toUpperCase().replace(/-/g, '_')}`

/** Remove the signing secret (and anything secret-shaped) from text. */
export function redact(text, ...secrets) {
  let s = String(text ?? '')
  for (const t of secrets) if (t) s = s.split(t).join('[redacted]')
  return s.replace(HEX_SECRET, '[redacted]')
}

/** The signature header value for a body at a time. */
export function sign(secret, timestamp, body) {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${mac}`
}

/**
 * What a receiver does: check a signature header against the raw body in
 * constant time, and reject a stale timestamp. Exported for receivers we
 * ship (n8n, tests) and for the owner's own scripts.
 */
export function verifySignature(secret, header, body, { now = Date.now(), toleranceS = SIGNATURE_TOLERANCE_S } = {}) {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(header ?? ''))
  if (!m || !secret) return false
  if (Math.abs(Math.floor(now / 1000) - Number(m[1])) > toleranceS) return false
  const want = Buffer.from(sign(secret, m[1], body).split('v1=')[1], 'hex')
  return timingSafeEqual(want, Buffer.from(m[2], 'hex'))
}

/** A target as stored, checked. Returns the clean target or null. */
export function normaliseTarget(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !TARGET_ID.test(t.id)) return null
  let url
  try {
    url = vetTarget(t.url)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  return {
    id: t.id,
    name: String(t.name ?? t.id).slice(0, 60),
    url: url.toString(),
    host: url.host,
    preApproved: t.preApproved === true,
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The real transport: one POST, vetted address, no redirect, body ignored. */
export function postOnce(url, headers, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = vetTarget(url)
    } catch (err) {
      return reject(Object.assign(new Error('blocked target'), { status: err.status ?? 403, blocked: true }))
    }
    const req = httpsRequest(target, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, lookup: guardedLookup })
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs)
    req.on('response', (res) => {
      clearTimeout(timer)
      const ra = Number(res.headers['retry-after'])
      res.resume() // the answer is never read
      resolve({ status: res.statusCode ?? 0, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(Object.assign(new Error(err.code === 'EBLOCKEDADDRESS' ? 'blocked target' : 'unreachable'), { blocked: err.code === 'EBLOCKEDADDRESS' }))
    })
    req.end(body)
  })
}

/**
 * @param {object} deps
 * @param {() => Array<object>} deps.getTargets            owner-configured targets (id, name, url, preApproved)
 * @param {(name: string) => Promise<string|undefined>|string|undefined} deps.getSecret
 * @param {(ask: { targetId: string, name: string, host: string, length: number, preview: string }) => Promise<boolean>} [deps.approve]
 * @param {(url: string, headers: Record<string,string>, body: string) => Promise<{ status: number, retryAfter?: number }>} [deps.post]
 * @param {() => boolean} [deps.isFrozen]
 * @param {(entry: object) => void} [deps.audit]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {{ perMinute?: number, perDay?: number }} [deps.limits]
 * @param {Console} [deps.log]
 */
export function createWebhookSender({
  getTargets,
  getSecret,
  approve,
  post = postOnce,
  isFrozen = () => false,
  audit = () => {},
  now = () => Date.now(),
  sleep = wait,
  limits = {},
  log = console,
} = {}) {
  if (typeof getTargets !== 'function') throw new Error('webhook: getTargets is required')
  if (typeof getSecret !== 'function') throw new Error('webhook: getSecret is required')
  const perMinute = limits.perMinute ?? DEFAULT_PER_MINUTE
  const perDay = limits.perDay ?? DEFAULT_PER_DAY
  /** targetId → send times in the last day */
  const history = new Map()
  const stats = { sent: 0, refused: 0, failed: 0 }
  let lastError

  const frozenNow = () => {
    try {
      return isFrozen() === true
    } catch {
      return true
    }
  }
  const record = (state, targetId, rule, length = 0, extra = {}) => {
    if (state === 'sent') stats.sent++
    else if (state === 'failed') stats.failed++
    else stats.refused++
    try {
      audit({ type: 'channel', actor: 'webhook', state, channel: CHANNEL_ID, targetId, rule, length, ...extra })
    } catch {
      // an audit sink that throws must not change what was sent
    }
  }

  function findTarget(id) {
    let list
    try {
      list = getTargets()
    } catch {
      return null
    }
    if (!Array.isArray(list)) return null
    for (const raw of list) if (raw?.id === id) return normaliseTarget(raw)
    return null
  }

  /** Count this send against the caps, or say which one it hit. Failed deliveries count too. */
  function takeFromCaps(id) {
    const t = now()
    const times = (history.get(id) ?? []).filter((x) => t - x < 86_400_000)
    if (times.length >= perDay) return 'day-cap'
    if (times.filter((x) => t - x < 60_000).length >= perMinute) return 'minute-cap'
    times.push(t)
    history.set(id, times)
    return null
  }

  /**
   * Send one message to one target.
   * @param {string} targetId
   * @param {{ text: string, sensitivity?: 'public'|'private'|'vault', kind?: 'message'|'alert' }} message
   * @returns {Promise<{ ok: boolean, outcome: string, attempts?: number, deliveryId?: string }>}
   */
  async function send(targetId, message) {
    const length = typeof message?.text === 'string' ? message.text.length : 0
    const refuse = (outcome) => {
      record('refused', typeof targetId === 'string' ? targetId.slice(0, 40) : '?', outcome, length)
      return { ok: false, outcome }
    }
    if (frozenNow()) return refuse('frozen')
    const target = findTarget(targetId)
    if (!target) return refuse('unlisted-target')
    if (typeof message?.text !== 'string' || !message.text.trim()) return refuse('empty')
    // Private and vault content never leaves over a webhook.
    if ((message.sensitivity ?? 'private') !== 'public') return refuse('not-public')
    const text = stripHiddenText(message.text).text.trim().slice(0, MAX_TEXT_CHARS)
    if (!text) return refuse('empty')

    const secret = await getSecret(secretNameFor(target.id))
    if (typeof secret !== 'string' || secret.length < 32) return refuse('no-secret')

    if (!target.preApproved) {
      let yes = false
      try {
        yes = typeof approve === 'function' && (await approve({ targetId: target.id, name: target.name, host: target.host, length: text.length, preview: text.slice(0, 200) })) === true
      } catch {
        yes = false
      }
      if (!yes) return refuse('not-approved')
    }
    if (frozenNow()) return refuse('frozen') // frozen while the owner was deciding

    const capped = takeFromCaps(target.id)
    if (capped) return refuse(capped)

    const deliveryId = randomUUID()
    let attempts = 0
    let lastRetryAfterMs = 0
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (i > 0) {
        const backoff = BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)]
        await sleep(Math.max(backoff, lastRetryAfterMs))
        if (frozenNow()) return refuse('frozen')
      }
      attempts++
      // A fresh timestamp and signature each attempt, so a slow retry is not "stale".
      const ts = Math.floor(now() / 1000)
      const body = JSON.stringify({ id: deliveryId, ts, source: 'jarvis', kind: message.kind === 'alert' ? 'alert' : 'message', text })
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'jarvis-webhook/1',
        [SIGNATURE_HEADER]: sign(secret, ts, body),
        [DELIVERY_HEADER]: deliveryId,
      }
      lastRetryAfterMs = 0
      let res
      try {
        res = await post(target.url, headers, body)
      } catch (err) {
        lastError = redact(err?.message, secret)
        if (err?.blocked) {
          record('refused', target.id, 'blocked-address', text.length)
          return { ok: false, outcome: 'blocked-address' }
        }
        continue // network failure: retry
      }
      const status = res?.status ?? 0
      if (status >= 200 && status < 300) {
        lastError = undefined
        record('sent', target.id, 'delivered', text.length, { attempts })
        return { ok: true, outcome: 'delivered', attempts, deliveryId }
      }
      lastError = `receiver answered ${status}`
      if (status === 429 || status >= 500) {
        lastRetryAfterMs = Math.min((res.retryAfter ?? 0) * 1000, MAX_RETRY_AFTER_MS)
        continue
      }
      // 3xx (never followed) and other 4xx: retrying will not change the answer.
      record('failed', target.id, `status-${status}`, text.length, { attempts })
      return { ok: false, outcome: 'rejected-by-receiver', attempts }
    }
    log?.warn?.(`[jarvis] webhook ${target.id} unreachable after ${attempts} attempts`)
    record('failed', target.id, 'unreachable', text.length, { attempts })
    return { ok: false, outcome: 'unreachable', attempts }
  }

  return {
    id: CHANNEL_ID,
    send,
    capabilities: () => ({ inbound: false, noPrivate: true, endToEnd: false }),
    health: () => ({ ...stats, targets: (() => { try { return getTargets().length } catch { return 0 } })(), lastError }),
  }
}
