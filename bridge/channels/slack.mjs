/**
 * The Slack channel adapter (task C43; plan 20, spec §3). Like the Telegram
 * adapter it translates and nothing else: authorisation, limits, freeze, the
 * reply filter and audit live in `index.mjs`.
 *
 * - Inbound is Socket Mode: an outbound WebSocket that Slack hands out through
 *   `apps.connections.open` (app-level token, `connections:write`). The bridge
 *   still has no public endpoint. The socket URL must be on *.slack.com.
 * - Outbound is `chat.postMessage` with the bot token (`chat:write`), to a
 *   direct-message channel only (`D…`), as plain text: `mrkdwn` off, link
 *   unfurling off, and `&`, `<`, `>` escaped so text from a tool cannot become
 *   a mention (`<!channel>`), a link or hidden markup (spec I6).
 * - Both tokens are read through `getSecret` for each use, never kept on the
 *   object, and are redacted (with the socket ticket) from every error, log
 *   line and `health()` field. It talks only to slack.com and follows no redirect.
 * - Only direct messages from real people are heard: bots (`bot_id`, the bot's
 *   own user), channels, group DMs, edits, deletions and every message subtype
 *   except a plain message or a file share are dropped (F3, D3, D5). Pasted
 *   attachments and unfurls are data, kept apart from the sender's own text (I2);
 *   files are described, never downloaded.
 * - Each Socket Mode envelope is acknowledged at once, and a replayed
 *   envelope or message is dropped (retries are normal on Socket Mode).
 * - It sends nothing of its own: no greeting, nothing on `app_home_opened`.
 *
 * Facts used (Slack docs; docs.slack.dev was not reachable from the build
 * environment, so these are from memory and are re-checked in the live check C44):
 *   - apps.connections.open: POST, `Authorization: Bearer xapp-…`, answers
 *     `{ ok, url }` with a `wss://wss-….slack.com/link/?ticket=…` URL. The URL
 *     is single-use and short-lived. HTTP 200 with `{ ok: false, error }` on failure.
 *   - Socket frames: `hello`, `events_api` (`envelope_id`, `payload`), and
 *     `disconnect` (`reason`: warning, refresh_requested, link_disabled). An
 *     envelope is acknowledged by sending `{ "envelope_id": "…" }` back.
 *   - message.im needs `im:history`; the Events API subscription is `message.im`.
 *   - chat.postMessage: about one message a second per channel; HTTP 429 with
 *     Retry-After in seconds.
 */
import { splitReply } from './telegram.mjs'

export const API_HOST = 'slack.com'
export const SLACK_API = `https://${API_HOST}/api`
export const BOT_SECRET = 'SLACK_BOT_TOKEN'
export const APP_SECRET = 'SLACK_APP_TOKEN'
/** Slack asks for messages under 4,000 characters. */
export const MAX_MESSAGE_CHARS = 3900
export const MAX_PARTS = 3
/** Same cap as `ChannelMessage.text`. */
export const MAX_INBOUND_CHARS = 16_000
export const PER_CHAT_INTERVAL_MS = 1000
export const HELLO_TIMEOUT_MS = 20_000
const SEEN_LIMIT = 500

export const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{20,300}$/
export const APP_TOKEN = /^xapp-[A-Za-z0-9-]{20,300}$/
const USER_ID = /^[UW][A-Z0-9]{2,20}$/
const DM_ID = /^D[A-Z0-9]{2,20}$/
const TS = /^\d{9,11}\.\d{1,6}$/
const TOKEN_ANYWHERE = /xox[a-z]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}/g
const TICKET = /ticket=[^&\s"']+/g

const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' })

/** Remove tokens (the real ones, and anything shaped like one) and socket tickets from text. */
export function redact(text, ...secrets) {
  let s = String(text ?? '')
  for (const t of secrets) if (t) s = s.split(t).join('[redacted]')
  return s.replace(TOKEN_ANYWHERE, '[redacted]').replace(TICKET, 'ticket=[redacted]')
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

/** Slack's required escaping for plain text. */
export const escapeText = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A socket URL is accepted only on https/wss slack.com hosts. */
export function isSlackSocketUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'wss:' && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'))
  } catch {
    return false
  }
}

/** Text pasted or unfurled into a message (legacy attachments): data, not the sender's words. */
function attachmentText(attachments) {
  if (!Array.isArray(attachments)) return undefined
  const parts = []
  for (const a of attachments.slice(0, 5)) {
    if (!a || typeof a !== 'object') continue
    for (const k of ['pretext', 'title', 'text', 'fallback']) if (typeof a[k] === 'string' && a[k]) parts.push(a[k])
  }
  return clip(parts.join('\n')) || undefined
}

function filesOf(files) {
  if (!Array.isArray(files)) return []
  return files.slice(0, 10).map((f) => {
    const kind = typeof f?.mimetype === 'string' && f.mimetype.startsWith('audio/') ? 'audio' : f?.mimetype?.startsWith?.('image/') ? 'image' : 'file'
    // Never downloaded: Slack file URLs need the bot token, and a file is data.
    return { kind, bytes: Number.isInteger(f?.size) ? f.size : null, mime: typeof f?.mimetype === 'string' ? f.mimetype : undefined, refused: 'not-downloaded' }
  })
}

/**
 * Turn one `events_api` payload into a RawInbound (spec §3), or null when it
 * is not something JARVIS listens to. Raw Slack objects never leave here.
 *
 * @param {object} payload   the envelope's `payload`
 * @param {{ botUserId?: string, teamId?: string, now?: number }} [ctx]
 */
export function normaliseEvent(payload, { botUserId, teamId, now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'event_callback') return null
  // Events from another workspace (Slack Connect, a re-used token) are not ours.
  if (teamId && typeof payload.team_id === 'string' && payload.team_id !== teamId) return null
  const e = payload.event
  if (!e || e.type !== 'message' || e.channel_type !== 'im') return null // D3: DMs only
  if (e.bot_id || e.bot_profile || e.app_id) return null // F3: never bots
  if (e.subtype && e.subtype !== 'file_share') return null // edits, deletes, joins, bot messages…
  if (typeof e.user !== 'string' || !USER_ID.test(e.user)) return null
  if (botUserId && e.user === botUserId) return null // never our own words
  if (typeof e.channel !== 'string' || !DM_ID.test(e.channel)) return null
  if (typeof e.ts !== 'string' || !TS.test(e.ts)) return null

  const inThread = typeof e.thread_ts === 'string' && TS.test(e.thread_ts) && e.thread_ts !== e.ts
  const raw = {
    channel: 'slack',
    senderId: e.user,
    threadId: inThread ? `${e.channel}/${e.thread_ts}` : e.channel,
    providerMessageId: e.ts,
    receivedAt: now,
  }
  const own = clip(e.text)
  if (own) raw.text = own
  const pasted = attachmentText(e.attachments)
  if (pasted) raw.forwarded = { text: pasted, fromLabel: 'attachment' }
  const attachments = filesOf(e.files)
  if (attachments.length) raw.attachments = attachments
  if (!raw.text && !raw.forwarded && !raw.attachments) return null
  return raw
}

/**
 * @param {object} deps
 * @param {(name: string) => Promise<string|undefined>|string|undefined} deps.getSecret  vault read
 * @param {typeof fetch} [deps.fetch]
 * @param {typeof WebSocket} [deps.WebSocket]
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {Console} [deps.log]
 */
export function createAdapter({
  getSecret,
  fetch: doFetch = globalThis.fetch,
  WebSocket: WS = globalThis.WebSocket,
  now = () => Date.now(),
  sleep = wait,
  log = console,
} = {}) {
  if (typeof getSecret !== 'function') throw new Error('slack: getSecret is required')

  let running = false
  let controller = null
  let loop = null
  let socket = null
  let botUserId
  let teamId
  let connectedAt
  let lastError
  let queued = 0
  const lastSentTo = new Map()
  const seen = new Set()

  const remember = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value)
    return true
  }

  async function secret(name, shape, label) {
    const t = await getSecret(name)
    if (typeof t !== 'string' || !shape.test(t)) throw new Error(`Slack ${label} is not set`)
    return t
  }

  /** One Web API call. Errors are redacted before they leave this function. */
  async function call(method, params, tokenName, { signal, timeoutMs = 15_000 } = {}) {
    let t
    try {
      t = tokenName === APP_SECRET ? await secret(APP_SECRET, APP_TOKEN, 'app-level token') : await secret(BOT_SECRET, BOT_TOKEN, 'bot token')
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await doFetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(params ?? {}),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (res.url && new URL(res.url).host !== API_HOST) throw new Error('slack: answer came from another host')
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        const err = new Error(`slack ${method} failed: ${res.ok ? '' : `${res.status} `}${body?.error ?? ''}`.trim())
        err.status = res.status
        err.code = body?.error
        const ra = Number(res.headers?.get?.('retry-after'))
        err.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : undefined
        throw err
      }
      return body
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw abortError()
      const safe = new Error(redact(err?.message ?? String(err), t))
      safe.status = err?.status
      safe.code = err?.code
      safe.retryAfter = err?.retryAfter
      throw safe
    }
  }

  async function identify(signal) {
    const me = await call('auth.test', {}, BOT_SECRET, { signal })
    botUserId = typeof me.user_id === 'string' ? me.user_id : undefined
    teamId = typeof me.team_id === 'string' ? me.team_id : undefined
    return me
  }

  /** Open one socket and resolve when it has closed. */
  async function session(sink) {
    const { url } = await call('apps.connections.open', {}, APP_SECRET, { signal: controller.signal })
    if (!isSlackSocketUrl(url)) throw new Error('slack: socket address is not on slack.com')
    if (typeof WS !== 'function') throw new Error('slack: this Node has no WebSocket')
    const ws = new WS(url)
    socket = ws
    await new Promise((resolve) => {
      let helloTimer = setTimeout(() => {
        lastError = 'no hello from Slack'
        try {
          ws.close()
        } catch {}
      }, HELLO_TIMEOUT_MS)
      const done = () => {
        clearTimeout(helloTimer)
        helloTimer = null
        if (socket === ws) socket = null
        connectedAt = undefined
        resolve()
      }
      ws.addEventListener('close', done)
      ws.addEventListener('error', (ev) => {
        lastError = redact(ev?.message ?? 'socket error')
      })
      ws.addEventListener('message', (ev) => {
        let msg
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        } catch {
          return
        }
        if (msg?.type === 'hello') {
          clearTimeout(helloTimer)
          connectedAt = now()
          lastError = undefined
          return
        }
        if (msg?.type === 'disconnect') {
          try {
            ws.close()
          } catch {}
          return
        }
        // Acknowledge first, so Slack does not redeliver while we think.
        if (typeof msg?.envelope_id === 'string') {
          try {
            ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
          } catch {}
        }
        if (msg?.type !== 'events_api') return
        const raw = normaliseEvent(msg.payload, { botUserId, teamId, now: now() })
        if (!raw || !running) return
        if (!remember(`${raw.threadId.split('/')[0]}:${raw.providerMessageId}`)) return // a replay
        Promise.resolve(sink(raw)).catch((err) => log?.error?.('[jarvis] slack: message not handled:', redact(err?.message ?? err)))
      })
    })
  }

  async function run(sink) {
    let backoff = 1000
    while (running) {
      try {
        await identify(controller.signal)
        const began = now()
        await session(sink)
        if (!running) break
        // A socket that lived a while is a normal rotation: reconnect at once.
        backoff = now() - began > 10_000 ? 1000 : Math.min(backoff * 2, 60_000)
        await sleep(backoff, controller.signal)
      } catch (err) {
        if (!running) break
        lastError = redact(err?.message ?? String(err))
        log?.warn?.('[jarvis] slack socket:', lastError)
        // A revoked or wrong token will not fix itself quickly.
        const dead = ['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive', 'not_authed'].includes(err?.code)
        const ms = err?.retryAfter ? err.retryAfter * 1000 : dead ? 60_000 : backoff
        backoff = Math.min(backoff * 2, 60_000)
        try {
          await sleep(ms, controller.signal)
        } catch {
          break
        }
      }
    }
  }

  async function postText(channel, text, extra) {
    const last = lastSentTo.get(channel)
    if (last !== undefined) {
      const gap = PER_CHAT_INTERVAL_MS - (now() - last)
      if (gap > 0) await sleep(gap)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await call(
          'chat.postMessage',
          { channel, text: escapeText(text), mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false, ...extra },
          BOT_SECRET,
        )
        lastSentTo.set(channel, now())
        return r
      } catch (err) {
        const retryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600) || err?.code === 'ratelimited'
        if (!retryable || attempt >= 2) throw err
        await sleep(err.retryAfter ? err.retryAfter * 1000 : 500 * 2 ** attempt)
      }
    }
  }

  return {
    id: 'slack',
    capabilities() {
      return {
        text: true,
        maxTextChars: MAX_MESSAGE_CHARS,
        markup: 'none',
        voiceIn: false,
        voiceOut: false,
        imagesIn: false,
        imagesOut: false,
        buttons: false, // approval cards are plan 20 phase 4
        threads: true,
        assurance: 'high',
        endToEnd: false, // workspace admins and Slack can read DMs
        inbound: 'socket',
      }
    },

    /** Open Socket Mode; `sink(raw)` is called once per message. */
    async start(sink) {
      if (running) return
      if (typeof sink !== 'function') throw new Error('slack: start needs a sink')
      running = true
      controller = new AbortController()
      loop = run(sink)
    },

    /** Close the socket and stop sending. Resolves within a second (freeze). */
    async stop() {
      if (!running) return
      running = false
      controller?.abort()
      try {
        socket?.close()
      } catch {}
      await Promise.race([loop, wait(1000)]).catch(() => {})
      loop = null
      socket = null
    },

    /**
     * Send one reply to a DM, split at the limit. `out.threadId` is the DM
     * channel id, optionally `D…/<thread_ts>`; the reply goes into that
     * thread, or starts one under the message it answers.
     */
    async send(out) {
      if (!running) throw new Error('slack: stopped')
      const [channel, threadTs] = String(out?.threadId ?? '').split('/')
      if (!DM_ID.test(channel ?? '')) throw new Error('slack: replies go to direct messages only')
      const parent = threadTs && TS.test(threadTs) ? threadTs : out.inReplyTo && TS.test(String(out.inReplyTo)) ? String(out.inReplyTo) : undefined
      const parts = splitReply(out.text, { max: MAX_MESSAGE_CHARS, parts: MAX_PARTS })
      queued += 1
      try {
        const ids = []
        for (const part of parts) {
          if (!running) throw new Error('slack: stopped')
          const r = await postText(channel, part, parent ? { thread_ts: parent } : {})
          ids.push(String(r?.ts ?? ''))
        }
        return { ok: true, parts: parts.length, providerMessageIds: ids }
      } finally {
        queued -= 1
      }
    },

    /** Approval cards over chat are plan 20 phase 4. */
    async sendApproval() {
      throw new Error('slack: approvals over chat are not built yet')
    },

    async ackCallback() {},

    /** The Settings "test" button: both tokens good? Returns names only. */
    async check() {
      const me = await call('auth.test', {}, BOT_SECRET)
      await call('apps.connections.open', {}, APP_SECRET) // the URL is single-use and never connected to
      return { ok: true, username: typeof me?.user === 'string' ? me.user : undefined, workspace: typeof me?.team === 'string' ? me.team : undefined }
    },

    health() {
      return { ok: running && !lastError, running, connected: Boolean(connectedAt), lastPollAt: connectedAt, lastError, queued }
    },
  }
}
