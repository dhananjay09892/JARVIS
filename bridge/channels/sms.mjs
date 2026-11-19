/**
 * The SMS channel adapter, over Twilio (task C45; plan 20, spec §3). It
 * translates and nothing else: authorisation, limits, freeze, the reply
 * filter and audit live in `index.mjs`.
 *
 * - Inbound is a webhook. The bridge has no public address, so the owner
 *   points Twilio at a relay or a tunnel they chose; whatever receives the
 *   request hands it to `receive()` (service.mjs → `POST /inbound/sms`).
 *   Nothing is listened on here.
 * - Every inbound request is checked with Twilio's `X-Twilio-Signature`
 *   (HMAC-SHA1 over the *configured* public URL plus the sorted form
 *   fields, keyed by the auth token) in constant time. The URL comes from
 *   Settings, never from the request's Host header. A bad or missing
 *   signature, a repeated field, another account's id or a message not sent
 *   to our number is refused before anything is parsed further. Replays
 *   (Twilio retries, or a captured request) are dropped by MessageSid.
 *   Twilio sends no timestamp, so there is no age window to check.
 * - Outbound is `POST /Messages.json` with HTTP Basic (account SID and auth
 *   token) to the one number the pipeline replies to, as plain text, with no
 *   media and no status callback. A required monthly message cap stops sends
 *   when reached (spec §8, F6). It talks only to api.twilio.com and follows
 *   no redirect.
 * - The auth token is read through `getSecret` for each use, never kept on
 *   the object, and is redacted from every error, log line and `health()`
 *   field, along with phone numbers.
 * - SMS is low assurance (spec §3, S3): the sender number can be spoofed, so
 *   the binding gets confidence 0.5, no freeze from chat, and never a private
 *   answer (`capabilities().noPrivate`). Media is described, never fetched.
 * - It answers Twilio with an empty TwiML `<Response/>` and sends nothing of
 *   its own: no greeting, no STOP/HELP text (Twilio handles opt-out itself).
 *
 * Facts used (Twilio docs; twilio.com was not reachable from the build
 * environment, so these are from memory and are re-checked in the live check C46):
 *   - X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl + for each POST
 *     parameter sorted by name: name + value)).
 *   - Inbound form fields: MessageSid (SM…/MM…), AccountSid (AC…), From, To
 *     (E.164), Body, NumMedia, MediaUrl0…, MediaContentType0…
 *   - Messages: POST https://api.twilio.com/2010-04-01/Accounts/{AC}/Messages.json,
 *     form To, From, Body; 201 with `sid`; errors are JSON `{ code, message, status }`;
 *     HTTP 429 when throttled; Body up to 1,600 characters.
 *   - A reply to a webhook may be empty TwiML: 200, `text/xml`, `<Response/>`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { splitReply } from './telegram.mjs'

export const API_HOST = 'api.twilio.com'
export const TWILIO_API = `https://${API_HOST}/2010-04-01`
export const SID_SECRET = 'TWILIO_ACCOUNT_SID'
export const TOKEN_SECRET = 'TWILIO_AUTH_TOKEN'
export const NUMBER_SETTING = 'TWILIO_PHONE_NUMBER'
export const URL_SETTING = 'TWILIO_WEBHOOK_URL'
export const CAP_SETTING = 'JARVIS_SMS_MONTHLY_CAP'
/** A few segments at most per part: SMS is paid by the segment. */
export const MAX_MESSAGE_CHARS = 600
export const MAX_PARTS = 3
/** Same cap as `ChannelMessage.text`. */
export const MAX_INBOUND_CHARS = 16_000
/** The form body of a webhook is small; anything bigger is not Twilio. */
export const MAX_WEBHOOK_BYTES = 16 * 1024
/** Twilio long codes send one message a second. */
export const PER_NUMBER_INTERVAL_MS = 1000
const SEEN_LIMIT = 500

export const ACCOUNT_SID = /^AC[0-9a-f]{32}$/
export const AUTH_TOKEN = /^[0-9a-f]{32}$/
export const E164 = /^\+[1-9]\d{6,14}$/
const MESSAGE_SID = /^(?:SM|MM)[0-9a-f]{32}$/
const HEX_TOKEN = /\b[0-9a-f]{32}\b/g
const NUMBER_ANYWHERE = /\+\d{7,15}/g

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>'
const xml = (status) => ({ status, contentType: 'text/xml; charset=utf-8', body: TWIML_EMPTY })
const refuse = (status) => ({ status, contentType: 'text/plain; charset=utf-8', body: '' })

const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' })

/** Remove the token (and anything token-shaped) and phone numbers from text. */
export function redact(text, ...secrets) {
  let s = String(text ?? '')
  for (const t of secrets) if (t) s = s.split(t).join('[redacted]')
  return s.replace(HEX_TOKEN, '[redacted]').replace(NUMBER_ANYWHERE, '[number]')
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

/** Twilio's signature for a form POST. `params` is a plain object of strings. */
export function computeSignature(url, params, authToken) {
  let data = String(url)
  for (const k of Object.keys(params).sort()) data += k + params[k]
  return createHmac('sha1', authToken).update(data).digest('base64')
}

/** Constant-time check of an `X-Twilio-Signature` header. */
export function verifySignature(url, params, signature, authToken) {
  if (typeof signature !== 'string' || !signature || !url || !authToken) return false
  const want = Buffer.from(computeSignature(url, params, authToken))
  const got = Buffer.from(signature)
  if (want.length !== got.length) {
    timingSafeEqual(want, want)
    return false
  }
  return timingSafeEqual(want, got)
}

/** A form body into a plain object; null when a field repeats or the body is not form data. */
export function parseForm(text) {
  const out = Object.create(null)
  let n = 0
  for (const [k, v] of new URLSearchParams(String(text ?? ''))) {
    if (k in out || ++n > 100) return null
    out[k] = v
  }
  return { ...out }
}

/** Media is described, never downloaded: a Twilio media URL is a fetch of attacker-chosen content. */
function mediaOf(params) {
  const count = Math.min(Number.parseInt(params.NumMedia, 10) || 0, 10)
  const out = []
  for (let i = 0; i < count; i++) {
    const mime = typeof params[`MediaContentType${i}`] === 'string' ? params[`MediaContentType${i}`] : undefined
    const kind = mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('image/') ? 'image' : 'file'
    out.push({ kind, bytes: null, mime: mime?.slice(0, 100), refused: 'not-downloaded' })
  }
  return out
}

/**
 * Turn one verified inbound form into a RawInbound (spec §3), or null when it
 * is not a plain message to us from a phone number.
 *
 * @param {Record<string, string>} params
 * @param {{ number?: string, now?: number }} [ctx]
 */
export function normaliseInbound(params, { number, now = Date.now() } = {}) {
  if (!params || typeof params !== 'object') return null
  if (typeof params.MessageSid !== 'string' || !MESSAGE_SID.test(params.MessageSid)) return null
  if (typeof params.From !== 'string' || !E164.test(params.From)) return null // alphanumeric sender ids and short codes are not people
  if (number && params.To !== number) return null
  const raw = { channel: 'sms', senderId: params.From, threadId: params.From, providerMessageId: params.MessageSid, receivedAt: now }
  const text = clip(params.Body)
  if (text) raw.text = text
  const attachments = mediaOf(params)
  if (attachments.length) raw.attachments = attachments
  if (!raw.text && !raw.attachments) return null
  return raw
}

const monthKey = (t) => new Date(t).toISOString().slice(0, 7)

/**
 * @param {object} deps
 * @param {(name: string) => Promise<string|undefined>|string|undefined} deps.getSecret  vault / settings read
 * @param {typeof fetch} [deps.fetch]
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {Console} [deps.log]
 */
export function createAdapter({ getSecret, fetch: doFetch = globalThis.fetch, now = () => Date.now(), sleep = wait, log = console } = {}) {
  if (typeof getSecret !== 'function') throw new Error('sms: getSecret is required')

  let running = false
  let sink = null
  let controller = null
  let lastError
  let lastInboundAt
  let queued = 0
  let sentMonth = monthKey(now())
  let sentCount = 0
  const lastSentTo = new Map()
  const seen = new Set()

  const remember = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value)
    return true
  }

  async function read(name, shape, label) {
    const v = await getSecret(name)
    if (typeof v !== 'string' || !shape.test(v)) throw new Error(`SMS ${label} is not set`)
    return v
  }
  const credentials = async () => ({
    sid: await read(SID_SECRET, ACCOUNT_SID, 'account SID'),
    token: await read(TOKEN_SECRET, AUTH_TOKEN, 'auth token'),
  })

  /** One REST call. Errors are redacted before they leave this function. */
  async function call(method, path, form, { signal, timeoutMs = 15_000 } = {}) {
    let token
    try {
      const c = await credentials()
      token = c.token
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await doFetch(`${TWILIO_API}/${path.replace('{sid}', c.sid)}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`,
          accept: 'application/json',
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (res.url && new URL(res.url).host !== API_HOST) throw new Error('sms: answer came from another host')
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const err = new Error(`twilio ${method} failed: ${res.status}${body?.code ? ` (${body.code})` : ''}`)
        err.status = res.status
        err.code = body?.code
        const ra = Number(res.headers?.get?.('retry-after'))
        err.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : undefined
        throw err
      }
      return body ?? {}
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw abortError()
      const safe = new Error(redact(err?.message ?? String(err), token))
      safe.status = err?.status
      safe.code = err?.code
      safe.retryAfter = err?.retryAfter
      throw safe
    }
  }

  /** The monthly cap is required (spec §8): no cap, no sends. Counts messages, not segments. */
  async function takeFromCap(parts) {
    const raw = await getSecret(CAP_SETTING)
    const cap = Number.parseInt(String(raw ?? ''), 10)
    if (!Number.isInteger(cap) || cap < 1) throw new Error('sms: set a monthly message cap first')
    const month = monthKey(now())
    if (month !== sentMonth) {
      sentMonth = month
      sentCount = 0
    }
    if (sentCount + parts > cap) {
      lastError = 'monthly message cap reached'
      throw new Error('sms: monthly message cap reached')
    }
    sentCount += parts
  }

  async function post(to, from, text) {
    const last = lastSentTo.get(to)
    if (last !== undefined) {
      const gap = PER_NUMBER_INTERVAL_MS - (now() - last)
      if (gap > 0) await sleep(gap)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await call('POST', 'Accounts/{sid}/Messages.json', { To: to, From: from, Body: text })
        lastSentTo.set(to, now())
        return r
      } catch (err) {
        const retryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600)
        if (!retryable || attempt >= 2) throw err
        await sleep(err.retryAfter ? err.retryAfter * 1000 : 500 * 2 ** attempt)
      }
    }
  }

  return {
    id: 'sms',
    capabilities() {
      return {
        text: true,
        maxTextChars: MAX_MESSAGE_CHARS,
        markup: 'none',
        voiceIn: false,
        voiceOut: false,
        imagesIn: false,
        imagesOut: false,
        buttons: false,
        threads: false,
        assurance: 'low', // the sender number can be spoofed (spec S3)
        endToEnd: false,
        noPrivate: true, // never private answers over SMS (spec §5.5)
        inbound: 'webhook',
      }
    },

    /** Start accepting webhooks; `sink(raw)` is called once per message. */
    async start(handler) {
      if (running) return
      if (typeof handler !== 'function') throw new Error('sms: start needs a sink')
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
     * One inbound webhook request: `{ headers, body }` with the raw form body.
     * Resolves to `{ status, contentType, body }` for the caller to write.
     * Nothing about why a request was refused goes back to the caller.
     */
    async receive({ headers = {}, body = '' } = {}) {
      if (!running || !sink) return refuse(503)
      try {
        if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) return refuse(413)
        const params = parseForm(body)
        const signature = headers['x-twilio-signature']
        const url = await getSecret(URL_SETTING)
        const token = await getSecret(TOKEN_SECRET)
        if (!params || typeof url !== 'string' || !/^https:\/\//.test(url) || typeof token !== 'string' || !AUTH_TOKEN.test(token)) return refuse(403)
        if (!verifySignature(url, params, Array.isArray(signature) ? signature[0] : signature, token)) {
          lastError = 'a webhook with a bad signature was refused'
          return refuse(403)
        }
        // Signed, so Twilio sent it. From here on nothing is an error for Twilio: answer 200 and move on.
        const sid = await getSecret(SID_SECRET)
        if (params.AccountSid !== sid) return refuse(403) // signed by this token but for another account
        const number = await getSecret(NUMBER_SETTING)
        const raw = normaliseInbound(params, { number: typeof number === 'string' ? number : undefined, now: now() })
        if (!raw) return xml(200)
        if (!remember(raw.providerMessageId)) return xml(200) // a replay
        lastInboundAt = now()
        lastError = undefined
        // Twilio waits about 15 seconds for the answer; a chat turn can take longer, so do not hold the request.
        Promise.resolve(sink(raw)).catch((err) => log?.error?.('[jarvis] sms: message not handled:', redact(err?.message ?? err)))
        return xml(200)
      } catch (err) {
        lastError = redact(err?.message ?? String(err))
        log?.warn?.('[jarvis] sms webhook:', lastError)
        return refuse(500)
      }
    },

    /**
     * Send one reply to the sender's number, split at the limit. `out.threadId`
     * is that number; nothing else is a valid recipient.
     */
    async send(out) {
      if (!running) throw new Error('sms: stopped')
      const to = String(out?.threadId ?? '')
      if (!E164.test(to)) throw new Error('sms: replies go to a phone number only')
      const from = await getSecret(NUMBER_SETTING)
      if (typeof from !== 'string' || !E164.test(from)) throw new Error('SMS phone number is not set')
      const parts = splitReply(out.text, { max: MAX_MESSAGE_CHARS, parts: MAX_PARTS })
      queued += 1
      try {
        await takeFromCap(parts.length)
        const ids = []
        for (const part of parts) {
          if (!running) throw new Error('sms: stopped')
          const r = await post(to, from, part)
          ids.push(String(r?.sid ?? ''))
        }
        return { ok: true, parts: parts.length, providerMessageIds: ids }
      } finally {
        queued -= 1
      }
    },

    /** Approval cards over SMS are refused: R2 and above is HUD only on a low-assurance channel (spec §5.4). */
    async sendApproval() {
      throw new Error('sms: approvals are not offered over SMS')
    },

    async ackCallback() {},

    /** The Settings "test" button: credentials good, and the number is on the account. Names only. */
    async check() {
      const account = await call('GET', 'Accounts/{sid}.json')
      const number = await getSecret(NUMBER_SETTING)
      if (typeof number !== 'string' || !E164.test(number)) throw new Error('SMS phone number is not set')
      const owned = await call('GET', `Accounts/{sid}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: number, PageSize: '1' })}`)
      if (!Array.isArray(owned?.incoming_phone_numbers) || owned.incoming_phone_numbers.length < 1) throw new Error('That phone number is not on this Twilio account')
      return { ok: true, username: typeof account?.friendly_name === 'string' ? account.friendly_name.slice(0, 64) : undefined }
    },

    health() {
      return { ok: running && !lastError, running, connected: running, lastPollAt: lastInboundAt, lastError, queued }
    },
  }
}
