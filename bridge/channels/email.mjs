/**
 * The email channel adapter (task C50; plan 20, spec §3). Like the other
 * adapters it translates and nothing else: authorisation, limits, freeze, the
 * reply filter and audit live in `index.mjs`.
 *
 * - Inbound is IMAP polling through the shared read-only reader (task C09), so
 *   the bridge still has no public endpoint. The mailbox is opened with EXAMINE
 *   and read with BODY.PEEK: JARVIS never marks, moves or deletes your mail.
 *   When it starts it takes a bookmark at the end of the mailbox and hears only
 *   mail that arrives afterwards, never what was already there.
 * - Outbound is SMTP (smtp.mjs), plain text, encrypted only, to the address a
 *   message came from and nowhere else. `Reply-To` is ignored, so a forged
 *   header cannot send a reply to someone else. A daily cap on sends is kept
 *   across restarts and fails closed.
 * - Email is slow and the sender is easy to fake, so the channel's assurance
 *   is low: no private answers, no approvals, no freeze from chat (spec §3,
 *   plan 20). The mailbox's own `Authentication-Results` (SPF, DKIM, DMARC) is
 *   read, shown in `health()`, and a message that fails it is dropped. A
 *   message with no result is allowed through as low assurance, and counted.
 * - Mail from automated senders is ignored (auto-replies, bulk and list mail,
 *   mail-daemon, no-reply addresses, JARVIS's own mailbox), so two robots
 *   cannot answer each other forever.
 * - Everything in a message is data. Only the sender's own new text is the
 *   request; the quoted thread underneath is passed on as untrusted data.
 *   Attachments are described, never opened. The subject is used as the
 *   request only when the body is empty.
 * - The mailbox password is read through `getSecret` for each use, never kept
 *   on the object, and is redacted from every error, log line and `health()`.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { createImapReader } from '../connectors/imap-reader.mjs'
import { guardedTlsSocket, parseServer, cleanPassword } from '../connectors/imap.mjs'
import { parseMessage } from '../connectors/mime.mjs'
import { cleanAddress, headerText, messageIds, parseSmtpServer, sendMail } from './smtp.mjs'

export const USER_SECRET = 'EMAIL_USERNAME'
export const PASS_SECRET = 'EMAIL_PASSWORD'
export const IMAP_SECRET = 'EMAIL_IMAP_SERVER'
export const SMTP_SECRET = 'EMAIL_SMTP_SERVER'
export const MAX_INBOUND_CHARS = 16_000
export const MAX_REPLY_CHARS = 20_000
export const DEFAULT_POLL_MS = 60_000
export const MIN_POLL_MS = 15_000
export const DEFAULT_DAILY_CAP = 50
export const PER_RECIPIENT_INTERVAL_MS = 5_000
const SEEN_LIMIT = 500
const THREAD_LIMIT = 200

const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' })

/** Remove the password (and anything that looks like a mailbox address) from text. */
export function redact(text, ...secrets) {
  let s = String(text ?? '')
  for (const t of secrets) if (t) s = s.split(t).join('[redacted]')
  return s.replace(/[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g, '[address]')
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

const clip = (s, n = MAX_INBOUND_CHARS) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined)

/** The one address in a From header, or null (none, malformed, or several). */
export function fromAddress(header) {
  const h = String(header ?? '')
  const angle = [...h.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1])
  if (angle.length > 1) return null
  if (angle.length === 1) return cleanAddress(angle[0])
  if ((h.match(/@/g) ?? []).length !== 1 || /[,;]/.test(h)) return null
  return cleanAddress(h.trim())
}

/**
 * What the receiving mailbox says about the sender (its topmost
 * `Authentication-Results` header, which the provider adds; lower ones may be
 * forged). `'pass'`, `'fail'` or `'none'` (no result at all or nothing useful).
 * Fail: DMARC failed, or no DMARC result and SPF or DKIM failed without the
 * other passing. Shown, not trusted: it only ever makes JARVIS more careful.
 */
export function authVerdict(headers) {
  const h = (headers ?? []).find((x) => String(x?.name).toLowerCase() === 'authentication-results')
  if (!h) return { verdict: 'none' }
  const res = {}
  for (const m of String(h.value).matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) res[m[1].toLowerCase()] ??= m[2].toLowerCase()
  const { spf, dkim, dmarc } = res
  if (dmarc === 'fail') return { verdict: 'fail', spf, dkim, dmarc }
  if (dmarc === 'pass') return { verdict: 'pass', spf, dkim, dmarc }
  const bad = spf === 'fail' || dkim === 'fail'
  const good = spf === 'pass' || dkim === 'pass'
  if (bad && !good) return { verdict: 'fail', spf, dkim, dmarc }
  return { verdict: good ? 'pass' : 'none', spf, dkim, dmarc }
}

/** Auto-replies, bulk and list mail, bounces and robots: never answered. */
export function isAutomated(mail, address, own) {
  const header = (n) => mail.header(n)
  if (address === own) return true
  if (/^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce[s+-]?.*|notifications?)@/i.test(address)) return true
  const auto = header('auto-submitted').trim().toLowerCase()
  if (auto && auto !== 'no') return true
  if (/\b(bulk|junk|list|auto_reply)\b/i.test(header('precedence'))) return true
  if (header('list-id') || header('list-unsubscribe') || header('x-auto-response-suppress') || header('x-autoreply') || header('x-autorespond')) return true
  if (/^(?:multipart\/report|message\/delivery-status)/i.test(header('content-type').trim())) return true
  return false
}

/**
 * The sender's own new text, and the quoted thread under it (data). Cuts at
 * the first quote marker: a ">" line, "On … wrote:", an "Original Message"
 * line or the signature delimiter ("-- ").
 */
export function splitBody(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^>/.test(l) || /^-{2,}\s*(?:original message|forwarded message)\s*-{2,}\s*$/i.test(l) || /^On .{5,300}wrote:\s*$/i.test(l) || /^-- ?$/.test(l) || /^_{10,}\s*$/.test(l)) {
      cut = i
      break
    }
    // "On Mon, … <a@b> wrote:" wrapped over two lines.
    if (/^On .{5,300}$/i.test(l) && /wrote:\s*$/i.test(lines[i + 1] ?? '')) {
      cut = i
      break
    }
  }
  return { fresh: lines.slice(0, cut).join('\n').trim(), quoted: lines.slice(cut).join('\n').trim() }
}

/**
 * Turn one fetched message into a RawInbound (spec §3), or `{ drop: reason }`
 * for mail that must not reach the pipeline at all.
 */
export function normaliseMail(msg, { own, now = Date.now() } = {}) {
  let mail
  try {
    mail = parseMessage(msg.raw)
  } catch {
    return { drop: 'unreadable' }
  }
  const address = fromAddress(mail.header('from'))
  if (!address) return { drop: 'no-sender' }
  if (isAutomated(mail, address, own)) return { drop: 'automated', address }
  const auth = authVerdict(mail.headers)
  if (auth.verdict === 'fail') return { drop: 'auth-failed', address, auth }
  const ids = messageIds(mail.header('message-id'))
  const messageId = ids[0]
  if (!messageId) return { drop: 'no-message-id', address }
  const subject = headerText(mail.header('subject'), 200)
  const { fresh, quoted } = splitBody(mail.text)
  const text = clip(fresh) ?? (/^(?:re|fwd?|aw)\s*:/i.test(subject) ? undefined : clip(subject))
  const raw = {
    channel: 'email',
    senderId: address,
    threadId: address,
    providerMessageId: messageId,
    receivedAt: Number.isFinite(msg.internalDate) ? msg.internalDate : now,
  }
  if (text) raw.text = text
  const q = clip(quoted)
  if (q) raw.quoted = { text: q }
  if (mail.attachments.length) {
    raw.attachments = mail.attachments.slice(0, 10).map((a) => ({
      kind: /^audio\//i.test(a.type) ? 'audio' : /^image\//i.test(a.type) ? 'image' : 'file',
      mime: typeof a.type === 'string' ? a.type.slice(0, 100) : undefined,
      bytes: null,
      refused: 'not-downloaded',
    }))
  }
  if (!raw.text && !raw.quoted && !raw.attachments) return { drop: 'empty', address }
  return {
    raw,
    auth,
    thread: { subject, messageId, references: messageIds(mail.header('references')) },
  }
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10)

/**
 * The day's sent-message count in one small JSON file so the cap survives a
 * restart. Only a date and a number: no addresses, no text. A file we cannot
 * write makes the cap fail closed (sending stops).
 */
export function createDailyUsageStore(file) {
  return {
    load() {
      try {
        const v = JSON.parse(readFileSync(file, 'utf8'))
        if (typeof v?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.day) && Number.isInteger(v.count) && v.count >= 0) return { day: v.day, count: v.count }
      } catch {
        // no file yet, or not ours
      }
      return null
    },
    save({ day, count }) {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ day, count }), { mode: 0o600 })
      renameSync(tmp, file)
    },
  }
}

/**
 * @param {object} deps
 * @param {(name: string) => Promise<string|undefined>|string|undefined} deps.getSecret  vault / settings read
 * @param {(name: string) => string|undefined} [deps.getSetting]  plain settings (poll seconds, daily cap)
 * @param {object} [deps.usage]  `{ load, save }` for the daily send count
 * @param {string} [deps.emailUsageFile]  where the day's send count is kept
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {Console} [deps.log]
 * @param {object} [deps.imap]  test hooks for the reader: `openSocket`, `allowedHosts`
 * @param {object} [deps.smtp]  test hooks for sending: `openSocket`, `startTls`
 */
export function createAdapter({
  getSecret,
  getSetting = () => undefined,
  usage = null,
  emailUsageFile: usageFile,
  now = () => Date.now(),
  sleep = wait,
  log = console,
  imap = {},
  smtp = {},
} = {}) {
  if (typeof getSecret !== 'function') throw new Error('email: getSecret is required')

  const store = usage ?? (usageFile ? createDailyUsageStore(usageFile) : null)
  let running = false
  let controller = null
  let loop = null
  let lastError
  let lastPollAt
  let lastInboundAt
  let queued = 0
  let cursor
  const counts = { heard: 0, dropped: 0, authFailed: 0, authNone: 0, automated: 0 }
  let lastAuth
  const seen = new Set()
  /** address → what the last message from them looked like, so a reply threads. */
  const threads = new Map()
  const lastSentTo = new Map()
  let sentToday = { day: dayKey(now()), count: 0 }
  let usageBroken = false

  if (store) {
    try {
      const v = store.load()
      if (v && v.day === sentToday.day) sentToday = v
    } catch {
      usageBroken = true
    }
  }

  const remember = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value)
    return true
  }

  const dailyCap = () => {
    const n = Number.parseInt(String(getSetting('JARVIS_EMAIL_DAILY_CAP') ?? ''), 10)
    return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : DEFAULT_DAILY_CAP
  }
  const pollMs = () => {
    const n = Number.parseInt(String(getSetting('JARVIS_EMAIL_POLL_SECONDS') ?? ''), 10)
    return Number.isInteger(n) && n > 0 ? Math.max(MIN_POLL_MS, Math.min(n * 1000, 3_600_000)) : DEFAULT_POLL_MS
  }

  /** Read and check the four settings. Throws a readable error. */
  async function config() {
    const user = cleanAddress(String((await getSecret(USER_SECRET)) ?? '').trim())
    if (!user) throw new Error('Email: set the mailbox address')
    const pass = cleanPassword(await getSecret(PASS_SECRET))
    if (!pass) throw new Error('Email: set the mailbox password')
    let imapServer
    let smtpServer
    try {
      imapServer = parseServer(await getSecret(IMAP_SECRET))
      smtpServer = parseSmtpServer(await getSecret(SMTP_SECRET))
    } catch (err) {
      throw new Error(`Email: ${err?.detail ?? err?.message}`)
    }
    return { user, pass, imapServer, smtpServer }
  }

  const readerFor = (c) =>
    createImapReader({
      host: c.imapServer.host,
      port: c.imapServer.port,
      allowedHosts: [c.imapServer.host],
      openSocket: guardedTlsSocket,
      sleep,
      ...imap,
    })

  const clean = (err, c) => redact(err?.detail ?? err?.message ?? String(err), c?.pass, c?.user)

  /** One pass over the mailbox. Returns how many messages went to the pipeline. */
  async function poll(sink, c) {
    const reader = readerFor(c)
    const creds = { user: c.user, pass: c.pass }
    if (cursor === undefined) {
      cursor = await reader.baseline(creds) // mail from before now is never acted on
      return 0
    }
    const got = []
    for await (const item of reader.sync({ ...creds, cursor, perSync: 10, maxInitial: 10 })) {
      if (item.cursor !== undefined) cursor = item.cursor
      else if (item.message) got.push(item.message)
    }
    got.sort((a, b) => a.uid - b.uid)
    let delivered = 0
    for (const msg of got) {
      if (!running) break
      const out = normaliseMail(msg, { own: c.user, now: now() })
      if (out.drop) {
        counts.dropped += 1
        if (out.drop === 'auth-failed') counts.authFailed += 1
        if (out.drop === 'automated') counts.automated += 1
        continue
      }
      if (!remember(out.raw.providerMessageId)) continue
      if (out.auth.verdict === 'none') counts.authNone += 1
      lastAuth = { verdict: out.auth.verdict, at: now() }
      threads.set(out.raw.threadId, out.thread)
      if (threads.size > THREAD_LIMIT) threads.delete(threads.keys().next().value)
      counts.heard += 1
      lastInboundAt = now()
      delivered += 1
      try {
        await sink(out.raw)
      } catch (err) {
        log?.warn?.('[jarvis] email message not handled:', clean(err, c))
      }
    }
    return delivered
  }

  async function run(sink) {
    let backoff = pollMs()
    while (running) {
      let c
      try {
        c = await config()
        await poll(sink, c)
        lastError = undefined
        lastPollAt = now()
        backoff = pollMs()
        await sleep(backoff, controller.signal)
      } catch (err) {
        if (!running) break
        lastError = clean(err, c)
        log?.warn?.('[jarvis] email poll:', lastError)
        // A refused password will not fix itself quickly; back off, and never hammer the login.
        const dead = err?.code === 'auth'
        backoff = Math.min(Math.max(backoff * 2, dead ? 600_000 : 0), 3_600_000)
        try {
          await sleep(backoff, controller.signal)
        } catch {
          break
        }
      }
    }
  }

  function takeSlot() {
    const t = now()
    const d = dayKey(t)
    if (sentToday.day !== d) sentToday = { day: d, count: 0 }
    if (usageBroken) throw new Error('email: the send count cannot be saved, so sending is stopped')
    if (sentToday.count >= dailyCap()) throw new Error('email: the daily send limit is reached')
    sentToday = { day: sentToday.day, count: sentToday.count + 1 }
    try {
      store?.save(sentToday)
    } catch {
      usageBroken = true
      throw new Error('email: the send count cannot be saved, so sending is stopped')
    }
  }

  return {
    id: 'email',
    capabilities() {
      return {
        text: true,
        maxTextChars: MAX_REPLY_CHARS,
        markup: 'none',
        voiceIn: false,
        voiceOut: false,
        imagesIn: false,
        imagesOut: false,
        buttons: false,
        threads: true,
        assurance: 'low', // the sender address can be faked (spec §3)
        noPrivate: true, // never a private answer, an approval or a freeze (spec §5.5)
        endToEnd: false,
        inbound: 'poll',
      }
    },

    /** Start polling; `sink(raw)` is called once per message. */
    async start(sink) {
      if (running) return
      if (typeof sink !== 'function') throw new Error('email: start needs a sink')
      running = true
      cursor = undefined
      controller = new AbortController()
      loop = run(sink)
    },

    /** Stop polling and sending. Resolves within a second (freeze). */
    async stop() {
      if (!running) return
      running = false
      controller?.abort()
      await Promise.race([loop, wait(1000)]).catch(() => {})
      loop = null
    },

    /**
     * Reply to a sender we heard from since the bridge started. `out.threadId`
     * is their address; `out.inReplyTo` the Message-Id we answer. Nothing else
     * is ever an address JARVIS writes to.
     */
    async send(out) {
      if (!running) throw new Error('email: stopped')
      const to = cleanAddress(String(out?.threadId ?? ''))
      const thread = to ? threads.get(to) : undefined
      if (!to || !thread) throw new Error('email: replies go only to a sender who has just written')
      const c = await config()
      const gap = PER_RECIPIENT_INTERVAL_MS - (now() - (lastSentTo.get(to) ?? -Infinity))
      if (gap > 0) await sleep(gap)
      if (!running) throw new Error('email: stopped')
      takeSlot()
      const subject = /^re\s*:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject || 'your message'}`
      queued += 1
      try {
        const r = await sendMail({
          server: c.smtpServer,
          user: c.user,
          pass: c.pass,
          to,
          subject,
          text: String(out.text ?? '').slice(0, MAX_REPLY_CHARS),
          inReplyTo: thread.messageId,
          references: thread.references,
          date: new Date(now()),
          ...smtp,
        })
        lastSentTo.set(to, now())
        return { ok: true, parts: 1, providerMessageIds: [r.id] }
      } catch (err) {
        lastError = clean(err, c)
        throw new Error(lastError)
      } finally {
        queued -= 1
      }
    },

    /** Approval cards are not offered over email (low assurance). */
    async sendApproval() {
      throw new Error('email: approvals are not offered over email')
    },

    async ackCallback() {},

    /** The Settings "test" button: can we sign in to both servers? Returns no secrets. */
    async check() {
      const c = await config()
      try {
        const r = await readerFor(c).check({ user: c.user, pass: c.pass })
        return { ok: true, username: c.user.replace(/^[^@]{1,3}[^@]*@/, '…@'), mailbox: r.mailbox }
      } catch (err) {
        throw new Error(clean(err, c))
      }
    },

    health() {
      return {
        ok: running && !lastError,
        running,
        connected: lastPollAt !== undefined && !lastError,
        lastPollAt,
        lastInboundAt,
        lastError,
        queued,
        heard: counts.heard,
        dropped: counts.dropped,
        authFailed: counts.authFailed,
        authNone: counts.authNone,
        automated: counts.automated,
        lastAuth,
        sentToday: sentToday.day === dayKey(now()) ? sentToday.count : 0,
        dailyCap: dailyCap(),
      }
    },
  }
}
