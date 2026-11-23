/**
 * The Discord channel adapter (task C48; plan 20, spec §3). Like the Telegram
 * and Slack adapters it translates and nothing else: authorisation, limits,
 * freeze, the reply filter and audit live in `index.mjs`.
 *
 * - Inbound is the Gateway: an outbound WebSocket, so the bridge still has no
 *   public endpoint. The gateway address comes from `GET /gateway/bot` and must
 *   be on discord.gg; the same check applies to `resume_gateway_url`.
 * - Intents are the minimum: `DIRECT_MESSAGES` only. No guild intents, no
 *   presence, no members, and not the privileged Message Content intent
 *   (Discord delivers the text of direct messages to a bot without it).
 * - Outbound is `POST /channels/{id}/messages` with `Authorization: Bot <token>`,
 *   to a direct-message channel the bot has heard from, as plain text with
 *   `allowed_mentions` empty (nothing can ping), embeds suppressed, and
 *   mention syntax broken up so text from a tool cannot become a mention, a
 *   channel link or a command (spec I6).
 * - The token is read through `getSecret` for each use, never kept on the
 *   object, and is redacted (by value and by shape) from every error, log
 *   line and `health()` field. It talks only to discord.com and follows no redirect.
 * - Only direct messages from real people are heard: bots, webhooks, the bot's
 *   own user, servers (any `guild_id`), group DMs are dropped (F3, D3, D5), and
 *   so is every message type except a plain message or a reply. Link embeds and
 *   forwarded messages are data, kept apart from the sender's own text (I2);
 *   attachments are described, never downloaded.
 * - It sends nothing of its own: no greeting. Replies never carry private
 *   answers (`noPrivate`): Discord can read direct messages.
 *
 * Facts used (Discord developer docs; discord.com was not reachable from the
 * build environment, so these are from memory and are re-checked in the live
 * check C49):
 *   - Gateway v10, JSON encoding: `wss://gateway.discord.gg/?v=10&encoding=json`.
 *     Opcodes: 0 dispatch, 1 heartbeat, 2 identify, 6 resume, 7 reconnect,
 *     9 invalid session (`d` true = resumable), 10 hello (`heartbeat_interval`
 *     ms), 11 heartbeat ack. The first heartbeat is sent after
 *     `interval * jitter`, jitter in [0, 1); a missed ack means a dead link.
 *   - Intent bits: DIRECT_MESSAGES = 1 << 12.
 *   - Close codes 4004 (authentication failed), 4010–4014 (bad shard, API
 *     version or intents) are not retried quickly; others resume.
 *   - READY carries `session_id`, `resume_gateway_url` and `user`.
 *   - MESSAGE_CREATE: `id`, `channel_id`, `author { id, bot }`, `content`,
 *     `type` (0 default, 19 reply), `attachments`, `embeds`, `webhook_id`,
 *     `message_snapshots`; `guild_id` is absent in a DM.
 *   - Create Message: `content` up to 2000 characters, `allowed_mentions`,
 *     `message_reference`, `flags` (SUPPRESS_EMBEDS = 4). HTTP 429 answers
 *     `{ retry_after }` in seconds and a Retry-After header.
 */
import { splitReply } from './telegram.mjs'

export const API_HOST = 'discord.com'
export const DISCORD_API = `https://${API_HOST}/api/v10`
export const BOT_SECRET = 'DISCORD_BOT_TOKEN'
/** Discord allows 2,000 characters; leave room for the splitter's marker. */
export const MAX_MESSAGE_CHARS = 1900
export const MAX_PARTS = 3
/** Same cap as `ChannelMessage.text`. */
export const MAX_INBOUND_CHARS = 16_000
export const PER_CHAT_INTERVAL_MS = 1000
export const HELLO_TIMEOUT_MS = 20_000
/** DIRECT_MESSAGES only. */
export const INTENTS = 1 << 12
export const FATAL_CLOSE_CODES = Object.freeze([4004, 4010, 4011, 4012, 4013, 4014])
const SEEN_LIMIT = 500
const DM_LIMIT = 200

/** `<id>.<time>.<hmac>`, each part base64url. */
export const BOT_TOKEN = /^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,100}$/
const TOKEN_ANYWHERE = /[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,100}/g
const SNOWFLAKE = /^\d{15,22}$/

const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' })

/** Remove the token (the real one, and anything shaped like one) from text. */
export function redact(text, ...secrets) {
  let s = String(text ?? '')
  for (const t of secrets) if (t) s = s.split(t).join('[redacted]')
  return s.replace(TOKEN_ANYWHERE, '[redacted]')
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

/**
 * Plain-text safety for what we send: break up everything Discord would turn
 * into a mention, channel link, role, custom emoji or slash-command link.
 */
export function escapeText(s) {
  return String(s ?? '')
    .replace(/@(everyone|here)/g, '@​$1')
    .replace(/<(@|#|\/|:|a:|t:|id:)/g, '<​$1')
}

/** A gateway address is accepted only on wss discord.gg hosts. */
export function isGatewayUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'wss:' && (u.hostname === 'discord.gg' || u.hostname.endsWith('.discord.gg'))
  } catch {
    return false
  }
}

/** Link previews and forwarded messages: data, not the sender's own words. */
function pastedText(m) {
  const parts = []
  for (const e of Array.isArray(m.embeds) ? m.embeds.slice(0, 5) : []) {
    if (!e || typeof e !== 'object') continue
    for (const k of ['title', 'description']) if (typeof e[k] === 'string' && e[k]) parts.push(e[k])
  }
  for (const s of Array.isArray(m.message_snapshots) ? m.message_snapshots.slice(0, 5) : []) {
    const c = s?.message?.content
    if (typeof c === 'string' && c) parts.push(c)
  }
  return clip(parts.join('\n')) || undefined
}

function filesOf(attachments) {
  if (!Array.isArray(attachments)) return []
  return attachments.slice(0, 10).map((f) => {
    const mime = typeof f?.content_type === 'string' ? f.content_type : undefined
    const kind = mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('image/') ? 'image' : 'file'
    // Never downloaded: an attachment is data from a stranger's CDN.
    return { kind, bytes: Number.isInteger(f?.size) ? f.size : null, mime, refused: 'not-downloaded' }
  })
}

/**
 * Turn one MESSAGE_CREATE payload into a RawInbound (spec §3), or null when it
 * is not something JARVIS listens to. Raw Discord objects never leave here.
 *
 * @param {object} m   the dispatch's `d`
 * @param {{ botUserId?: string, now?: number }} [ctx]
 */
export function normaliseMessage(m, { botUserId, now = Date.now() } = {}) {
  if (!m || typeof m !== 'object') return null
  if (m.guild_id) return null // D3: DMs only, never a server
  if (m.webhook_id) return null // F3: never webhooks
  if (m.type !== undefined && m.type !== 0 && m.type !== 19) return null // joins, pins, calls, commands…
  const a = m.author
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !SNOWFLAKE.test(a.id)) return null
  if (a.bot || a.system) return null // F3: never bots
  if (botUserId && a.id === botUserId) return null // never our own words
  if (typeof m.channel_id !== 'string' || !SNOWFLAKE.test(m.channel_id)) return null
  if (typeof m.id !== 'string' || !SNOWFLAKE.test(m.id)) return null

  const raw = {
    channel: 'discord',
    senderId: a.id,
    threadId: m.channel_id,
    providerMessageId: m.id,
    receivedAt: now,
  }
  const own = clip(m.content)
  if (own) raw.text = own
  const pasted = pastedText(m)
  if (pasted) raw.forwarded = { text: pasted, fromLabel: 'attachment' }
  const attachments = filesOf(m.attachments)
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
 * @param {() => number} [deps.random]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {Console} [deps.log]
 */
export function createAdapter({
  getSecret,
  fetch: doFetch = globalThis.fetch,
  WebSocket: WS = globalThis.WebSocket,
  now = () => Date.now(),
  random = Math.random,
  sleep = wait,
  log = console,
} = {}) {
  if (typeof getSecret !== 'function') throw new Error('discord: getSecret is required')

  let running = false
  let controller = null
  let loop = null
  let socket = null
  let botUserId
  let connectedAt
  let lastError
  let queued = 0
  // Resume state survives a dropped socket.
  let sessionId
  let resumeUrl
  let seq = null
  const lastSentTo = new Map()
  const seen = new Set()
  const dmChannels = new Set()

  const remember = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value)
    return true
  }

  async function token() {
    const t = await getSecret(BOT_SECRET)
    if (typeof t !== 'string' || !BOT_TOKEN.test(t)) throw new Error('Discord bot token is not set')
    return t
  }

  /** One REST call. Errors are redacted before they leave this function. */
  async function call(method, path, body, { signal, timeoutMs = 15_000 } = {}) {
    let t
    try {
      t = await token()
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await doFetch(`${DISCORD_API}${path}`, {
        method,
        headers: { authorization: `Bot ${t}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (https://github.com/dhananjay09892/JARVIS, 1)' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (res.url && new URL(res.url).host !== API_HOST) throw new Error('discord: answer came from another host')
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const err = new Error(`discord ${method} ${path.split('/')[1] ?? ''} failed: ${res.status}${typeof data?.message === 'string' ? ` ${data.message}` : ''}`.trim())
        err.status = res.status
        const ra = Number(data?.retry_after ?? res.headers?.get?.('retry-after'))
        err.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : undefined
        throw err
      }
      return data
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw abortError()
      const safe = new Error(redact(err?.message ?? String(err), t))
      safe.status = err?.status
      safe.retryAfter = err?.retryAfter
      throw safe
    }
  }

  async function gatewayAddress(signal) {
    const g = await call('GET', '/gateway/bot', undefined, { signal })
    if (!isGatewayUrl(g?.url)) throw new Error('discord: gateway address is not on discord.gg')
    return g.url
  }

  const withParams = (base) => `${base.replace(/\/+$/, '')}/?v=10&encoding=json`

  /**
   * Open one socket and resolve when it has closed, with whether the next
   * connection may resume and the close code (if any).
   */
  async function session(sink) {
    const base = resumeUrl && sessionId ? resumeUrl : await gatewayAddress(controller.signal)
    if (typeof WS !== 'function') throw new Error('discord: this Node has no WebSocket')
    const t = await token()
    const ws = new WS(withParams(base))
    socket = ws
    return await new Promise((resolve) => {
      let beat = null
      let acked = true
      let canResume = Boolean(sessionId)
      let closeCode
      let helloTimer = setTimeout(() => {
        lastError = 'no hello from Discord'
        try {
          ws.close()
        } catch {}
      }, HELLO_TIMEOUT_MS)
      const stopBeat = () => {
        if (beat) clearTimeout(beat)
        beat = null
      }
      const sendJson = (obj) => {
        try {
          ws.send(JSON.stringify(obj))
        } catch {}
      }
      const heartbeat = () => sendJson({ op: 1, d: seq })
      const schedule = (ms) => {
        beat = setTimeout(() => {
          if (!acked) {
            // No ack since the last beat: a dead link. Close and resume.
            lastError = 'Discord stopped answering'
            try {
              ws.close(4000)
            } catch {}
            return
          }
          acked = false
          heartbeat()
          schedule(ms)
        }, ms)
        beat.unref?.()
      }
      const done = (ev) => {
        clearTimeout(helloTimer)
        helloTimer = null
        stopBeat()
        if (socket === ws) socket = null
        connectedAt = undefined
        if (Number.isInteger(ev?.code)) closeCode = ev.code
        resolve({ resume: canResume && Boolean(sessionId), code: closeCode })
      }
      ws.addEventListener('close', done)
      ws.addEventListener('error', (ev) => {
        lastError = redact(ev?.message ?? 'socket error', t)
      })
      ws.addEventListener('message', (ev) => {
        let msg
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        } catch {
          return
        }
        if (Number.isInteger(msg?.s)) seq = msg.s
        switch (msg?.op) {
          case 10: {
            clearTimeout(helloTimer)
            const ms = Number(msg.d?.heartbeat_interval)
            if (!Number.isFinite(ms) || ms < 10) {
              lastError = 'Discord sent a bad heartbeat interval'
              try {
                ws.close()
              } catch {}
              return
            }
            stopBeat()
            acked = true
            // First beat after interval × jitter, then every interval.
            beat = setTimeout(() => {
              acked = false
              heartbeat()
              schedule(ms)
            }, Math.floor(ms * random()))
            beat.unref?.()
            if (sessionId && seq !== null) sendJson({ op: 6, d: { token: t, session_id: sessionId, seq } })
            else
              sendJson({
                op: 2,
                d: { token: t, intents: INTENTS, properties: { os: process.platform, browser: 'jarvis', device: 'jarvis' } },
              })
            return
          }
          case 11:
            acked = true
            return
          case 1:
            heartbeat()
            return
          case 7: // Discord asks us to reconnect (and resume)
            try {
              ws.close(4000)
            } catch {}
            return
          case 9: // invalid session: d true means it can be resumed
            if (msg.d !== true) {
              sessionId = undefined
              resumeUrl = undefined
              seq = null
              canResume = false
            }
            try {
              ws.close(4000)
            } catch {}
            return
          case 0:
            break
          default:
            return
        }
        if (msg.t === 'READY') {
          sessionId = typeof msg.d?.session_id === 'string' ? msg.d.session_id : undefined
          resumeUrl = isGatewayUrl(msg.d?.resume_gateway_url) ? msg.d.resume_gateway_url : undefined
          botUserId = typeof msg.d?.user?.id === 'string' ? msg.d.user.id : botUserId
          canResume = Boolean(sessionId)
          connectedAt = now()
          lastError = undefined
          return
        }
        if (msg.t === 'RESUMED') {
          connectedAt = now()
          lastError = undefined
          return
        }
        if (msg.t !== 'MESSAGE_CREATE') return
        const raw = normaliseMessage(msg.d, { botUserId, now: now() })
        if (!raw || !running) return
        if (!remember(`${raw.threadId}:${raw.providerMessageId}`)) return // a replay
        dmChannels.add(raw.threadId)
        if (dmChannels.size > DM_LIMIT) dmChannels.delete(dmChannels.values().next().value)
        Promise.resolve(sink(raw)).catch((err) => log?.error?.('[jarvis] discord: message not handled:', redact(err?.message ?? err, t)))
      })
    })
  }

  async function run(sink) {
    let backoff = 1000
    while (running) {
      try {
        const began = now()
        const r = await session(sink)
        if (!running) break
        if (FATAL_CLOSE_CODES.includes(r.code)) {
          lastError = r.code === 4004 ? 'Discord refused the bot token (authentication failed)' : `Discord closed the connection (code ${r.code})`
          sessionId = undefined
          resumeUrl = undefined
          seq = null
          await sleep(60_000, controller.signal)
          continue
        }
        if (!r.resume) {
          sessionId = undefined
          resumeUrl = undefined
          seq = null
        }
        // A socket that lived a while is a normal rotation: reconnect at once.
        backoff = now() - began > 10_000 ? 1000 : Math.min(backoff * 2, 60_000)
        await sleep(backoff, controller.signal)
      } catch (err) {
        if (!running) break
        lastError = redact(err?.message ?? String(err))
        log?.warn?.('[jarvis] discord gateway:', lastError)
        // A revoked or wrong token will not fix itself quickly.
        const ms = err?.retryAfter ? err.retryAfter * 1000 : err?.status === 401 ? 60_000 : backoff
        backoff = Math.min(backoff * 2, 60_000)
        try {
          await sleep(ms, controller.signal)
        } catch {
          break
        }
      }
    }
  }

  async function postText(channel, text, replyTo) {
    const last = lastSentTo.get(channel)
    if (last !== undefined) {
      const gap = PER_CHAT_INTERVAL_MS - (now() - last)
      if (gap > 0) await sleep(gap)
    }
    const body = { content: escapeText(text), allowed_mentions: { parse: [] }, flags: 4 }
    if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false }
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await call('POST', `/channels/${channel}/messages`, body)
        lastSentTo.set(channel, now())
        return r
      } catch (err) {
        const retryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600)
        if (!retryable || attempt >= 2) throw err
        await sleep(err.retryAfter ? err.retryAfter * 1000 : 500 * 2 ** attempt)
      }
    }
  }

  return {
    id: 'discord',
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
        threads: false,
        assurance: 'high',
        endToEnd: false, // Discord can read direct messages
        noPrivate: true, // so private answers never go here
        inbound: 'socket',
      }
    },

    /** Open the Gateway; `sink(raw)` is called once per message. */
    async start(sink) {
      if (running) return
      if (typeof sink !== 'function') throw new Error('discord: start needs a sink')
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
        socket?.close(1000)
      } catch {}
      await Promise.race([loop, wait(1000)]).catch(() => {})
      loop = null
      socket = null
      sessionId = undefined
      resumeUrl = undefined
      seq = null
    },

    /**
     * Send one reply to a direct-message channel the bot has heard from,
     * split at the limit; the first part replies to the message it answers.
     */
    async send(out) {
      if (!running) throw new Error('discord: stopped')
      const channel = String(out?.threadId ?? '')
      if (!SNOWFLAKE.test(channel) || !dmChannels.has(channel)) throw new Error('discord: replies go to direct messages only')
      const replyTo = SNOWFLAKE.test(String(out.inReplyTo ?? '')) ? String(out.inReplyTo) : undefined
      const parts = splitReply(out.text, { max: MAX_MESSAGE_CHARS, parts: MAX_PARTS })
      queued += 1
      try {
        const ids = []
        for (const [i, part] of parts.entries()) {
          if (!running) throw new Error('discord: stopped')
          const r = await postText(channel, part, i === 0 ? replyTo : undefined)
          ids.push(String(r?.id ?? ''))
        }
        return { ok: true, parts: parts.length, providerMessageIds: ids }
      } finally {
        queued -= 1
      }
    },

    /** Approval cards over chat are plan 20 phase 4. */
    async sendApproval() {
      throw new Error('discord: approvals over chat are not built yet')
    },

    async ackCallback() {},

    /** The Settings "test" button: is the token good? Returns names only. */
    async check() {
      const me = await call('GET', '/users/@me')
      await gatewayAddress()
      return { ok: true, username: typeof me?.username === 'string' ? me.username : undefined }
    },

    health() {
      return { ok: running && !lastError, running, connected: Boolean(connectedAt), lastPollAt: connectedAt, lastError, queued }
    },
  }
}
