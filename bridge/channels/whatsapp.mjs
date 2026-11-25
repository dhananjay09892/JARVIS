/**
 * The WhatsApp channel adapter, over Meta's WhatsApp Cloud API (task C52;
 * plan 20, spec §3). It translates and nothing else: authorisation, limits,
 * freeze, the reply filter and audit live in `index.mjs`.
 *
 * - Inbound is a webhook. The bridge has no public address, so the owner
 *   points Meta at a relay or tunnel they chose; whatever receives the
 *   request hands it to `receive()` (service.mjs → `/inbound/whatsapp`).
 *   Nothing is listened on here.
 * - Meta's one-time address check (GET with hub.mode, hub.verify_token and
 *   hub.challenge) is answered only when the token matches the one in
 *   Settings, compared in constant time; the challenge is echoed only if it
 *   is a plain number.
 * - Every POST is checked with `X-Hub-Signature-256` (`sha256=` plus the
 *   HMAC-SHA256 of the *raw* body, keyed by the app secret) in constant time
 *   before the JSON is parsed. A bad or missing signature, a body for another
 *   phone-number id, or anything that is not a plain text message is dropped.
 *   Replays (Meta retries, or a captured request) are dropped by message id,
 *   and a message older than five minutes is dropped as a replay.
 * - Outbound is `POST /{phone-number-id}/messages` on graph.facebook.com with
 *   a Bearer token, plain text only, to the one number the pipeline replies
 *   to, and only inside the 24-hour window that opens when that person writes
 *   to us. There are no templates and no unsolicited sends: outside the window
 *   a send is refused. A daily send cap (a Settings value, default 100) bounds
 *   cost. It talks only to graph.facebook.com and follows no redirect.
 * - The access token and app secret are read through `getSecret` for each use,
 *   never kept on the object, and are redacted from every error, log line and
 *   `health()` field, along with phone numbers.
 * - WhatsApp is treated as low assurance for now and never carries private
 *   answers (Meta's cloud decrypts the messages). Media is described, never
 *   fetched. Voice notes are recognised, not transcribed.
 *
 * Facts used, *verify* in the live check C53 (the Meta docs were not reachable
 * from the build environment; the signature and handshake were cross-checked
 * against third-party write-ups of Meta's webhook guide):
 *   - GET verify: hub.mode=subscribe, hub.verify_token, hub.challenge → 200 with
 *     the challenge as the body.
 *   - POST: header `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret, rawBody)>`;
 *     body `{ object: 'whatsapp_business_account', entry: [{ changes: [{ field:
 *     'messages', value: { metadata: { phone_number_id }, messages: [{ from, id,
 *     timestamp, type, text: { body } }], statuses: [...] } }] }] }`.
 *   - Send: `POST https://graph.facebook.com/v{N}/{phone_number_id}/messages`,
 *     JSON `{ messaging_product: 'whatsapp', recipient_type: 'individual', to,
 *     type: 'text', text: { body, preview_url: false } }`; answer `{ messages:
 *     [{ id }] }`; text up to 4,096 characters; free-form text only within 24 hours
 *     of the user's last message (error 131047 otherwise); HTTP 429 / error
 *     130429 when throttled.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { splitReply } from './telegram.mjs'

export const API_HOST = 'graph.facebook.com'
export const GRAPH_VERSION = 'v21.0'
export const GRAPH_API = `https://${API_HOST}/${GRAPH_VERSION}`
export const TOKEN_SECRET = 'WHATSAPP_ACCESS_TOKEN'
export const PHONE_ID_SECRET = 'WHATSAPP_PHONE_NUMBER_ID'
export const APP_SECRET = 'WHATSAPP_APP_SECRET'
export const VERIFY_SECRET = 'WHATSAPP_VERIFY_TOKEN'
export const CAP_SETTING = 'JARVIS_WHATSAPP_DAILY_CAP'
export const DEFAULT_DAILY_CAP = 100
export const MAX_MESSAGE_CHARS = 1500
export const MAX_PARTS = 3
export const MAX_INBOUND_CHARS = 16_000
/** A webhook body is a small JSON document; anything bigger is not Meta. */
export const MAX_WEBHOOK_BYTES = 256 * 1024
/** Free-form replies are allowed for 24 hours after the person's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000
/** A signed message older than this is treated as a replay. */
export const MAX_AGE_MS = 5 * 60 * 1000
const SEEN_LIMIT = 500
const WINDOW_LIMIT = 200

export const ACCESS_TOKEN = /^[A-Za-z0-9_-]{20,400}$/
export const PHONE_NUMBER_ID = /^\d{5,20}$/
export const APP_SECRET_SHAPE = /^[0-9a-f]{32}$/
export const VERIFY_TOKEN = /^[A-Za-z0-9_-]{8,100}$/
/** WhatsApp ids are phone numbers without the plus. */
export const WA_ID = /^[1-9]\d{6,14}$/
const MESSAGE_ID = /^wamid\.[A-Za-z0-9+/=_-]{8,300}$/
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g
const NUMBER_ANYWHERE = /\+?\d{9,15}/g

const text = (status, body = '') => ({ status, contentType: 'text/plain; charset=utf-8', body })
const refuse = (status) => text(status)
const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' })

/** Remove secrets (and anything secret-shaped) and phone numbers from text. */
export function redact(value, ...secrets) {
  let s = String(value ?? '')
  for (const t of secrets) if (t) s = s.split(t).join('[redacted]')
  return s.replace(LONG_TOKEN, '[redacted]').replace(NUMBER_ANYWHERE, '[number]')
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const clip = (s, n = MAX_INBOUND_CHARS) => (typeof s === 'string' && s ? s.slice(0, n) : undefined)

function equal(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) {
    timingSafeEqual(x, x)
    return false
  }
  return timingSafeEqual(x, y)
}

/** Meta's signature header value for a raw body. */
export function computeSignature(rawBody, appSecret) {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
}

/** Constant-time check of an `X-Hub-Signature-256` header against the raw body. */
export function verifySignature(rawBody, signature, appSecret) {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=') || !appSecret) return false
  return equal(computeSignature(rawBody, appSecret), signature)
}

/**
 * Every text message in one verified payload, as RawInbound objects.
 * Statuses, other fields, other phone-number ids and non-person senders are skipped.
 */
export function normaliseInbound(payload, { phoneNumberId, now = Date.now() } = {}) {
  const out = []
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return out
  for (const entry of payload.entry.slice(0, 20)) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes.slice(0, 20) : []) {
      if (change?.field !== 'messages') continue
      const value = change.value
      if (phoneNumberId && value?.metadata?.phone_number_id !== phoneNumberId) continue
      for (const m of Array.isArray(value?.messages) ? value.messages.slice(0, 50) : []) {
        if (typeof m?.id !== 'string' || !MESSAGE_ID.test(m.id)) continue
        if (typeof m.from !== 'string' || !WA_ID.test(m.from)) continue
        const ts = Number(m.timestamp) * 1000
        if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_AGE_MS) continue
        const raw = { channel: 'whatsapp', senderId: m.from, threadId: m.from, providerMessageId: m.id, receivedAt: ts }
        if (m.type === 'text') {
          const body = clip(m.text?.body)
          if (body) raw.text = body
        } else if (['audio', 'image', 'video', 'document', 'sticker'].includes(m.type)) {
          const mime = typeof m[m.type]?.mime_type === 'string' ? m[m.type].mime_type.slice(0, 100) : undefined
          const kind = m.type === 'audio' ? 'audio' : m.type === 'image' || m.type === 'sticker' ? 'image' : 'file'
          raw.attachments = [{ kind, bytes: null, mime, refused: 'not-downloaded' }]
          const caption = clip(m[m.type]?.caption)
          if (caption) raw.text = caption
        }
        if (!raw.text && !raw.attachments) continue
        out.push(raw)
      }
    }
  }
  return out
}

/**
 * @param {object} deps
 * @param {(name: string) => Promise<string|undefined>|string|undefined} deps.getSecret  vault / settings read
 * @param {typeof fetch} [deps.fetch]
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {Console} [deps.log]
 */
export function createAdapter({ getSecret, fetch: doFetch = globalThis.fetch, now = () => Date.now(), sleep = wait, log = console } = {}) {
  if (typeof getSecret !== 'function') throw new Error('whatsapp: getSecret is required')

  let running = false
  let sink = null
  let controller = null
  let lastError
  let lastInboundAt
  let queued = 0
  let sentDay = new Date(now()).toISOString().slice(0, 10)
  let sentCount = 0
  /** sender id → when they last wrote to us (opens the 24-hour window) */
  const lastInbound = new Map()
  const seen = new Set()

  const remember = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value)
    return true
  }

  async function read(name, shape, label) {
    const v = await getSecret(name)
    if (typeof v !== 'string' || !shape.test(v)) throw new Error(`WhatsApp ${label} is not set`)
    return v
  }

  /** One Graph API call. Errors are redacted before they leave this function. */
  async function call(method, path, json, { timeoutMs = 15_000 } = {}) {
    let token
    try {
      token = await read(TOKEN_SECRET, ACCESS_TOKEN, 'access token')
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await doFetch(`${GRAPH_API}/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : undefined,
        redirect: 'error',
        signal: controller ? AbortSignal.any([controller.signal, timeout]) : timeout,
      })
      if (res.url && new URL(res.url).host !== API_HOST) throw new Error('whatsapp: answer came from another host')
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const code = body?.error?.code
        const err = new Error(`whatsapp ${method} failed: ${res.status}${code ? ` (${code})` : ''}`)
        err.status = res.status
        err.code = code
        const ra = Number(res.headers?.get?.('retry-after'))
        err.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : undefined
        throw err
      }
      return body ?? {}
    } catch (err) {
      if (err?.name === 'AbortError' && controller?.signal.aborted) throw abortError()
      const safe = new Error(redact(err?.message ?? String(err), token))
      safe.status = err?.status
      safe.code = err?.code
      safe.retryAfter = err?.retryAfter
      throw safe
    }
  }

  /** Daily send cap (cost control). The setting may lower or raise it; none set means the default. */
  async function takeFromCap(parts) {
    const raw = await getSecret(CAP_SETTING)
    const parsed = Number.parseInt(String(raw ?? ''), 10)
    const cap = Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_DAILY_CAP
    const day = new Date(now()).toISOString().slice(0, 10)
    if (day !== sentDay) {
      sentDay = day
      sentCount = 0
    }
    if (sentCount + parts > cap) {
      lastError = 'daily message cap reached'
      throw new Error('whatsapp: daily message cap reached')
    }
    sentCount += parts
  }

  async function post(phoneId, to, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call('POST', `${phoneId}/messages`, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body },
        })
      } catch (err) {
        const retryable = err?.status === 429 || err?.code === 130429 || (err?.status >= 500 && err?.status < 600)
        if (!retryable || attempt >= 2) throw err
        await sleep(err.retryAfter ? err.retryAfter * 1000 : 500 * 2 ** attempt, controller?.signal)
      }
    }
  }

  return {
    id: 'whatsapp',
    capabilities() {
      return {
        text: true,
        maxTextChars: MAX_MESSAGE_CHARS,
        markup: 'none',
        voiceIn: false, // recognised, not transcribed yet
        voiceOut: false,
        imagesIn: false,
        imagesOut: false,
        buttons: false,
        threads: false,
        assurance: 'low', // first slice: no approvals or chat freeze over WhatsApp
        endToEnd: false, // the Cloud API is decrypted at Meta
        noPrivate: true,
        inbound: 'webhook',
      }
    },

    /** Start accepting webhooks; `sink(raw)` is called once per message. */
    async start(handler) {
      if (running) return
      if (typeof handler !== 'function') throw new Error('whatsapp: start needs a sink')
      running = true
      sink = handler
      controller = new AbortController()
    },

    /** Stop accepting webhooks and sending. Immediate (freeze). */
    async stop() {
      running = false
      sink = null
      controller?.abort()
    },

    /**
     * One inbound webhook request: `{ method, query, headers, body }` with the
     * raw body. Resolves to `{ status, contentType, body }` for the caller to
     * write. Nothing about why a request was refused goes back.
     */
    async receive({ method = 'POST', query = {}, headers = {}, body = '' } = {}) {
      if (!running || !sink) return refuse(503)
      try {
        if (method === 'GET') {
          const want = await getSecret(VERIFY_SECRET)
          const challenge = query['hub.challenge']
          if (query['hub.mode'] !== 'subscribe' || typeof want !== 'string' || !VERIFY_TOKEN.test(want) || !equal(query['hub.verify_token'] ?? '', want) || typeof challenge !== 'string' || !/^\d{1,20}$/.test(challenge)) return refuse(403)
          return text(200, challenge)
        }
        if (method !== 'POST') return refuse(405)
        if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) return refuse(413)
        const secret = await getSecret(APP_SECRET)
        const signature = headers['x-hub-signature-256']
        if (typeof secret !== 'string' || !APP_SECRET_SHAPE.test(secret) || !verifySignature(body, Array.isArray(signature) ? signature[0] : signature, secret)) {
          lastError = 'a webhook with a bad signature was refused'
          return refuse(403)
        }
        // Signed, so Meta sent it. From here on nothing is an error for Meta: answer 200 and move on.
        let payload
        try {
          payload = JSON.parse(body)
        } catch {
          return refuse(200)
        }
        const phoneId = await getSecret(PHONE_ID_SECRET)
        const t = now()
        for (const raw of normaliseInbound(payload, { phoneNumberId: typeof phoneId === 'string' ? phoneId : undefined, now: t })) {
          if (!remember(raw.providerMessageId)) continue // a replay
          lastInbound.delete(raw.senderId)
          lastInbound.set(raw.senderId, t)
          if (lastInbound.size > WINDOW_LIMIT) lastInbound.delete(lastInbound.keys().next().value)
          lastInboundAt = t
          lastError = undefined
          // Meta expects a quick answer; a chat turn can take longer, so do not hold the request.
          Promise.resolve(sink(raw)).catch((err) => log?.error?.('[jarvis] whatsapp: message not handled:', redact(err?.message ?? err)))
        }
        return refuse(200)
      } catch (err) {
        lastError = redact(err?.message ?? String(err))
        log?.warn?.('[jarvis] whatsapp webhook:', lastError)
        return refuse(500)
      }
    },

    /**
     * Send one reply to the sender, split at the limit, inside their 24-hour
     * window. `out.threadId` is their WhatsApp id; nothing else is a valid recipient.
     */
    async send(out) {
      if (!running) throw new Error('whatsapp: stopped')
      const to = String(out?.threadId ?? '')
      if (!WA_ID.test(to)) throw new Error('whatsapp: replies go to a phone number only')
      const last = lastInbound.get(to)
      if (last === undefined || now() - last > WINDOW_MS) throw new Error('whatsapp: outside the 24-hour window, so nothing was sent')
      const phoneId = await read(PHONE_ID_SECRET, PHONE_NUMBER_ID, 'phone number id')
      const parts = splitReply(out.text, { max: MAX_MESSAGE_CHARS, parts: MAX_PARTS })
      queued += 1
      try {
        await takeFromCap(parts.length)
        const ids = []
        for (const part of parts) {
          if (!running) throw new Error('whatsapp: stopped')
          const r = await post(phoneId, to, part)
          ids.push(String(r?.messages?.[0]?.id ?? ''))
        }
        return { ok: true, parts: parts.length, providerMessageIds: ids }
      } finally {
        queued -= 1
      }
    },

    /** Approval cards over WhatsApp are refused in this slice (spec §5.4). */
    async sendApproval() {
      throw new Error('whatsapp: approvals are not offered over WhatsApp')
    },

    async ackCallback() {},

    /** The Settings "test" button: token good and the phone number id is ours. Names only. */
    async check() {
      const phoneId = await read(PHONE_ID_SECRET, PHONE_NUMBER_ID, 'phone number id')
      const r = await call('GET', `${phoneId}?${new URLSearchParams({ fields: 'verified_name' })}`)
      return { ok: true, username: typeof r?.verified_name === 'string' ? r.verified_name.slice(0, 64) : undefined }
    },

    health() {
      const today = new Date(now()).toISOString().slice(0, 10) === sentDay
      return { ok: running && !lastError, running, connected: running, lastPollAt: lastInboundAt, lastError, queued, sentToday: today ? sentCount : 0 }
    },
  }
}
