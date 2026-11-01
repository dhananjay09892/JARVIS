/**
 * The Telegram adapter (plan 20 phase 2, spec §3). It translates and nothing
 * else: authorisation, limits, freeze, the reply filter and audit live in
 * `index.mjs`, so this file cannot forget them.
 *
 * - Inbound is `getUpdates` long-polling: an outbound connection, so the
 *   bridge still has no public endpoint.
 * - It talks only to https://api.telegram.org, never follows a redirect, and
 *   reads the bot token through `getSecret` for each call. The token is never
 *   kept on the object and is redacted from every error, log line and
 *   `health()` field (Telegram puts it in the URL path: `/bot<token>/...`).
 * - Bot senders, group chats and channel posts are dropped here (F3, D3).
 * - Forwarded text, quoted replies and media captions are kept apart from
 *   the sender's own text so the pipeline can wrap them as untrusted (I2).
 * - Replies are plain text (no parse_mode), with link previews off, so text
 *   from a tool cannot become a link or hidden markup (I6).
 * - It sends nothing of its own: not even a greeting on /start.
 * - `stop()` aborts the poll in flight and returns within a second (freeze).
 *
 * Voice notes, images and approval buttons are recognised but not acted on
 * in this slice: attachments are described (kind, size, mime) and never
 * downloaded; `sendApproval` refuses (plan 20 phase 4).
 */

export const API_HOST = 'api.telegram.org'
export const SECRET_NAME = 'TELEGRAM_BOT_TOKEN'
/** Telegram's limit per message. */
export const MAX_MESSAGE_CHARS = 4096
/** At most this many parts per reply; the rest is "more in the app" (spec §5.5). */
export const MAX_PARTS = 3
/** Same cap as `ChannelMessage.text`. */
export const MAX_INBOUND_CHARS = 16_000
export const CAPS = Object.freeze({ audio: 20 * 1024 * 1024, image: 10 * 1024 * 1024 })
export const MORE_IN_APP = '… more in the app.'
/** At most one message per second to a chat (spec §6). */
export const PER_CHAT_INTERVAL_MS = 1000

const TOKEN_SHAPE = /^\d{5,16}:[\w-]{30,64}$/
/** Anything that looks like a token or a token-bearing path. */
const TOKEN_ANYWHERE = /\d{5,16}:[\w-]{30,64}/g
const BOT_PATH = /\/bot[^/\s]+/g

/** Remove a token (the real one, and anything shaped like one) from text. */
export function redact(text, token) {
  let s = String(text ?? '')
  if (token) s = s.split(token).join('[redacted]')
  return s.replace(BOT_PATH, '/bot[redacted]').replace(TOKEN_ANYWHERE, '[redacted]')
}

const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' })

/** A sleep that ends early when `signal` aborts. */
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

function senderLabel(from) {
  const name = [from.first_name, from.last_name].filter((x) => typeof x === 'string' && x).join(' ')
  const user = typeof from.username === 'string' && from.username ? `@${from.username}` : ''
  return [name, user].filter(Boolean).join(' ').slice(0, 80) || undefined
}

function forwardLabel(m) {
  const o = m.forward_origin
  if (o?.sender_user) return senderLabel(o.sender_user)
  if (typeof o?.sender_user_name === 'string') return o.sender_user_name.slice(0, 80)
  if (o?.chat?.title) return String(o.chat.title).slice(0, 80)
  if (m.forward_from) return senderLabel(m.forward_from)
  return undefined
}

function attachmentsOf(m) {
  const out = []
  const add = (kind, file, mime) => {
    if (!file) return
    const bytes = Number.isInteger(file.file_size) ? file.file_size : null
    const cap = CAPS[kind]
    const item = { kind, bytes, mime: typeof mime === 'string' ? mime : undefined }
    // Not downloaded in this slice. Anything without a cap, or over it, or of
    // unknown size, is refused and never fetched (spec §3, F4).
    if (!cap) item.refused = 'file-type'
    else if (bytes === null || bytes > cap) item.refused = 'too-large'
    else item.ref = `telegram-file:${String(file.file_id ?? '').slice(0, 200)}`
    out.push(item)
  }
  add('audio', m.voice, m.voice?.mime_type)
  add('audio', m.audio, m.audio?.mime_type)
  if (Array.isArray(m.photo) && m.photo.length) {
    const biggest = [...m.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]
    add('image', biggest, 'image/jpeg')
  }
  if (m.document) add(m.document.mime_type?.startsWith?.('image/') ? 'image' : 'file', m.document, m.document.mime_type)
  for (const k of ['video', 'video_note', 'animation', 'sticker']) if (m[k]) add('file', m[k], m[k].mime_type)
  return out
}

/**
 * Turn one Telegram update into a RawInbound (spec §3), or null when it is
 * not something JARVIS listens to. Raw Telegram objects never leave here.
 */
export function normaliseUpdate(update, { now = Date.now() } = {}) {
  if (!update || typeof update !== 'object') return null

  const cb = update.callback_query
  if (cb) {
    const from = cb.from
    if (!from || from.is_bot || !Number.isSafeInteger(from.id)) return null
    if (cb.message?.chat && cb.message.chat.type !== 'private') return null
    const m = /^a:([\w-]{1,24}):([\w-]{1,24}):(y|n|d)$/.exec(String(cb.data ?? ''))
    return {
      channel: 'telegram',
      senderId: String(from.id),
      senderLabel: senderLabel(from),
      threadId: String(cb.message?.chat?.id ?? from.id),
      providerMessageId: `cb:${String(cb.id ?? '').slice(0, 64)}`,
      callback: m ? { approvalId: m[1], nonce: m[2], answer: { y: 'approve', n: 'deny', d: 'details' }[m[3]] } : { malformed: true },
      callbackQueryId: String(cb.id ?? ''),
      receivedAt: now,
    }
  }

  const edited = !update.message && update.edited_message
  const m = update.message ?? update.edited_message
  if (!m) return null // channel posts, inline queries, member updates: not listened to
  const from = m.from
  if (!from || from.is_bot || !Number.isSafeInteger(from.id)) return null // F3: never bots
  if (m.chat?.type !== 'private') return null // D3: groups unsupported
  if (m.sender_chat) return null // a message sent "as a channel"

  const isForward = Boolean(m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_date || m.forward_sender_name)
  const raw = {
    channel: 'telegram',
    senderId: String(from.id),
    senderLabel: senderLabel(from),
    threadId: String(m.chat.id),
    // An edit is a new message; it never re-runs an earlier one (D5).
    providerMessageId: edited ? `${m.message_id}:edit:${m.edit_date ?? 0}` : String(m.message_id),
    receivedAt: now,
  }
  const own = clip(m.text)
  const caption = clip(m.caption)
  if (isForward) {
    const text = [own, caption].filter(Boolean).join('\n') || undefined
    raw.forwarded = { text: clip(text), fromLabel: forwardLabel(m) }
  } else {
    if (own) raw.text = own
    // Captions on media are data, like forwarded text (spec §3).
    if (caption) raw.forwarded = { text: caption, fromLabel: 'caption' }
  }
  const quoted = clip(m.quote?.text) ?? clip(m.reply_to_message?.text) ?? clip(m.reply_to_message?.caption)
  if (quoted) raw.quoted = { text: quoted }
  const attachments = attachmentsOf(m)
  if (attachments.length) raw.attachments = attachments
  if (!raw.text && !raw.forwarded && !raw.quoted && !raw.attachments) return null
  return raw
}

/**
 * Split a reply at Telegram's limit, at most MAX_PARTS parts; the rest is cut
 * and the last part says so. Prefers to break at a newline or space.
 */
export function splitReply(text, { max = MAX_MESSAGE_CHARS, parts = MAX_PARTS } = {}) {
  const s = String(text ?? '')
  if (s.length <= max) return [s]
  const out = []
  let rest = s
  while (rest.length && out.length < parts) {
    const last = out.length === parts - 1
    const room = last && rest.length > max ? max - MORE_IN_APP.length : max
    if (rest.length <= room) {
      out.push(rest)
      rest = ''
      break
    }
    let cut = Math.max(rest.lastIndexOf('\n', room), rest.lastIndexOf(' ', room))
    if (cut < room / 2) cut = room
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length) out[out.length - 1] += MORE_IN_APP
  return out
}

/**
 * @param {object} deps
 * @param {(name: string) => Promise<string|undefined>|string|undefined} deps.getSecret  vault read
 * @param {typeof fetch} [deps.fetch]
 * @param {number} [deps.pollTimeoutSec]  long-poll timeout Telegram holds the request open for
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {Console} [deps.log]
 */
export function createAdapter({
  getSecret,
  fetch: doFetch = globalThis.fetch,
  pollTimeoutSec = 25,
  now = () => Date.now(),
  sleep = wait,
  log = console,
} = {}) {
  if (typeof getSecret !== 'function') throw new Error('telegram: getSecret is required')

  let running = false
  let controller = null
  let loop = null
  let offset = 0
  let lastPollAt
  let lastError
  let queued = 0
  /** chat id → time the last message to it was sent */
  const lastSentTo = new Map()

  async function token() {
    const t = await getSecret(SECRET_NAME)
    if (typeof t !== 'string' || !TOKEN_SHAPE.test(t)) throw new Error('Telegram bot token is not set')
    return t
  }

  /** One Bot API call. Errors are redacted before they leave this function. */
  async function call(method, params, { signal, timeoutMs = 15_000 } = {}) {
    let t
    try {
      t = await token()
      const url = `https://${API_HOST}/bot${t}/${method}`
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params ?? {}),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (res.url && new URL(res.url).host !== API_HOST) throw new Error('telegram: answer came from another host')
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        const err = new Error(`telegram ${method} failed: ${res.status} ${body?.description ?? ''}`.trim())
        err.status = res.status
        err.retryAfter = body?.parameters?.retry_after
        throw err
      }
      return body.result
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw abortError()
      const safe = new Error(redact(err?.message ?? String(err), t))
      safe.status = err?.status
      safe.retryAfter = err?.retryAfter
      throw safe
    }
  }

  async function pollOnce(sink) {
    const updates = await call(
      'getUpdates',
      { offset, timeout: pollTimeoutSec, allowed_updates: ['message', 'edited_message', 'callback_query'] },
      { signal: controller.signal, timeoutMs: (pollTimeoutSec + 10) * 1000 },
    )
    lastPollAt = now()
    lastError = undefined
    for (const u of Array.isArray(updates) ? updates : []) {
      if (Number.isSafeInteger(u?.update_id)) offset = Math.max(offset, u.update_id + 1)
      if (!running) return
      const raw = normaliseUpdate(u, { now: now() })
      if (raw) {
        try {
          await sink(raw)
        } catch (err) {
          log?.error?.('[jarvis] telegram: message not handled:', redact(err?.message ?? err))
        }
      }
    }
  }

  async function run(sink) {
    let backoff = 1000
    while (running) {
      try {
        await pollOnce(sink)
        backoff = 1000
      } catch (err) {
        if (!running) break
        lastError = redact(err?.message ?? String(err))
        log?.warn?.('[jarvis] telegram poll:', lastError)
        // A bad token (401) or a second poller (409) will not fix itself quickly.
        const ms = err?.retryAfter ? err.retryAfter * 1000 : err?.status === 401 || err?.status === 409 ? 60_000 : backoff
        backoff = Math.min(backoff * 2, 60_000)
        try {
          await sleep(ms, controller.signal)
        } catch {
          break
        }
      }
    }
  }

  async function sendText(chatId, text, extra = {}) {
    const last = lastSentTo.get(chatId)
    if (last !== undefined) {
      const gap = PER_CHAT_INTERVAL_MS - (now() - last)
      if (gap > 0) await sleep(gap)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await call('sendMessage', {
          chat_id: chatId,
          text,
          link_preview_options: { is_disabled: true },
          ...extra,
        })
        lastSentTo.set(chatId, now())
        return result
      } catch (err) {
        const retryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600)
        if (!retryable || attempt >= 2) throw err
        await sleep(err.retryAfter ? err.retryAfter * 1000 : 500 * 2 ** attempt)
      }
    }
  }

  return {
    id: 'telegram',
    capabilities() {
      return {
        text: true,
        maxTextChars: MAX_MESSAGE_CHARS,
        markup: 'none',
        voiceIn: false, // recognised, not transcribed yet
        voiceOut: false,
        imagesIn: false,
        imagesOut: false,
        buttons: false, // approval cards are plan 20 phase 4
        threads: false,
        assurance: 'high',
        endToEnd: false, // bot chats are Telegram cloud chats
        inbound: 'poll',
      }
    },

    /** Begin long-polling; `sink(raw)` is called once per message. */
    async start(sink) {
      if (running) return
      if (typeof sink !== 'function') throw new Error('telegram: start needs a sink')
      running = true
      controller = new AbortController()
      loop = run(sink)
    },

    /** Stop polling and sending. Resolves once the poll in flight is aborted. */
    async stop() {
      if (!running) return
      running = false
      controller?.abort()
      await Promise.race([loop, wait(1000)]).catch(() => {})
      loop = null
    },

    /**
     * Send one reply, split at the limit. `out.text` is sent as plain text.
     * Returns `{ ok, parts, providerMessageIds }`; throws a redacted error.
     */
    async send(out) {
      if (!running) throw new Error('telegram: stopped')
      const chatId = String(out?.threadId ?? '')
      if (!/^-?\d{1,20}$/.test(chatId)) throw new Error('telegram: bad thread id')
      const parts = splitReply(out.text)
      queued += 1
      try {
        const ids = []
        for (const [i, part] of parts.entries()) {
          if (!running) throw new Error('telegram: stopped')
          const extra = i === 0 && out.inReplyTo && /^\d{1,20}$/.test(String(out.inReplyTo))
            ? { reply_parameters: { message_id: Number(out.inReplyTo), allow_sending_without_reply: true } }
            : {}
          const r = await sendText(chatId, part, extra)
          ids.push(String(r?.message_id ?? ''))
        }
        return { ok: true, parts: parts.length, providerMessageIds: ids }
      } finally {
        queued -= 1
      }
    },

    /** Approval cards over chat are plan 20 phase 4. */
    async sendApproval() {
      throw new Error('telegram: approvals over chat are not built yet')
    },

    /** Clear a button press so the phone stops spinning. No text is shown. */
    async ackCallback(callbackQueryId) {
      if (!running || !callbackQueryId) return
      await call('answerCallbackQuery', { callback_query_id: String(callbackQueryId) }).catch(() => {})
    },

    /** The Settings "test" button: is the token good? Returns the bot's username only. */
    async check() {
      const me = await call('getMe', {})
      return { ok: true, username: typeof me?.username === 'string' ? me.username : undefined }
    },

    health() {
      return { ok: running && !lastError, running, lastPollAt, lastError, queued }
    },
  }
}
