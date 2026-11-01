/**
 * Messaging channels: the shared pipeline (plan 20, spec §2). Adapters
 * translate; everything that decides lives here, in this order:
 *
 *   ① adapter.receive → ② freeze → (pairing) → ③ allow-list → ④ limits →
 *   ⑤ identity → ⑥ request/data split → ⑦ chat turn → ⑧ reply filter →
 *   ⑨ adapter.send
 *
 * Rules that hold throughout:
 * - Nothing before ③ answers the sender or touches the brain. A stranger
 *   costs one lookup and one audit row, and gets no bytes back.
 * - The sender's own typed words are the request; forwarded, quoted and
 *   caption text is wrapped as untrusted data. Every chat turn starts with
 *   taint on (spec §5.3), and `via: 'chat'` goes to the policy engine.
 * - Audit rows carry ids, lengths and the rule. Never message text, never a
 *   stranger's raw id (a salted hash instead), never a token.
 * - With the master switch off nothing is constructed and nothing connects.
 *
 * Not in this slice (follow-up tasks in plans/QUEUE.md): wiring into
 * server.mjs and the bus, the Settings → Channels screen, voice notes, and
 * approval cards over chat (plan 20 phase 4).
 */
import { createHash, randomBytes } from 'node:crypto'
import { stripHiddenText, wrapUntrusted } from '../untrusted.mjs'
import { createLimits } from './limits.mjs'

/** Adapters by id. An adapter is imported and constructed only when enabled. */
export const ADAPTERS = Object.freeze({
  telegram: () => import('./telegram.mjs'),
})

export const REPLIES = Object.freeze({
  slowDown: 'Slow down a little — I will answer again in a minute.',
  frozen: 'Frozen. Unfreeze from the HUD.',
  vault: 'That is in the vault. Details in the app.',
  private: 'That is private. Details in the app.',
  privateLead: "Here's what you asked.",
  textOnly: 'I can only read typed messages here for now.',
  busy: 'Something went wrong on my side. Try again, or ask in the app.',
})

/** `/freeze` or `freeze`, alone. Unfreeze is HUD-only (spec §5.7). */
const FREEZE = /^\s*\/?freeze\s*$/i
const PAIR = /^\s*\/pair(?:@\w+)?\s+(\S{1,32})\s*$/i
/** Loop guard: at most this many sends to a thread without an inbound message (spec §6). */
export const MAX_CONSECUTIVE_SENDS = 3

/**
 * What a role may do over chat until plan 30 (spec §4.1): children and guests
 * only chat, with read-only public tools. The policy engine still decides
 * every tool call; this narrows what the turn is offered.
 */
export function chatScope(binding) {
  const full = binding.role === 'owner' || binding.role === 'member'
  return {
    tools: full ? 'role' : 'public-read',
    // Spec §5.5: private items to the owner on Telegram when the setting is
    // on; members get their own private items only (the turn is theirs).
    privateReplies: full,
  }
}

/** A short salted hash of a sender, for audit rows about strangers. */
export function senderHasher(salt = randomBytes(16)) {
  return (channel, senderId) => createHash('sha256').update(salt).update(`${channel}\u0000${senderId}`).digest('hex').slice(0, 16)
}

/**
 * Build the pipeline.
 *
 * @param {object} deps
 * @param {boolean} deps.enabled                 master switch (JARVIS_CHANNELS)
 * @param {Record<string, object>} [deps.adapters]  constructed adapters by id (see `loadAdapters`)
 * @param {ReturnType<import('./allowlist.mjs').openAllowlist>} deps.allowlist
 * @param {(turn: object) => Promise<{ text: string, sensitivity?: 'public'|'private'|'vault' }>} deps.runTurn
 * @param {(entry: object) => void} [deps.audit]  an `auditSink`
 * @param {() => boolean} [deps.isFrozen]
 * @param {() => void} [deps.freeze]              sets the kill switch (bus `freeze.on`)
 * @param {(n: { kind: string, channel: string, [k: string]: unknown }) => void} [deps.notify]  HUD notices
 * @param {{ privateTelegram?: boolean }} [deps.settings]
 */
export function createChannels({
  enabled = false,
  adapters = {},
  allowlist,
  runTurn,
  audit = () => {},
  isFrozen = () => false,
  freeze = () => {},
  notify = () => {},
  settings = {},
  limits = createLimits(),
  hashSender = senderHasher(),
  log = console,
} = {}) {
  const active = enabled ? adapters : {}
  /** threadKey → sends since the last inbound */
  const consecutive = new Map()
  const stats = { received: 0, rejected: 0, sent: 0, failed: 0, turns: 0 }

  const frozenNow = () => {
    try {
      return isFrozen() === true
    } catch {
      return true // a reading that cannot be taken counts as frozen
    }
  }
  const lengthOf = (raw) => (raw.text?.length ?? 0) + (raw.forwarded?.text?.length ?? 0) + (raw.quoted?.text?.length ?? 0)
  const record = (state, raw, who, rule, length = 0) => {
    stats[state] = (stats[state] ?? 0) + 1
    audit({ type: 'channel', actor: 'chat', state, channel: raw.channel, ...who, rule, length })
  }

  async function send(adapter, binding, raw, text, rule, { force = false } = {}) {
    const key = `${adapter.id}:${raw.threadId}`
    const n = consecutive.get(key) ?? 0
    if (n >= MAX_CONSECUTIVE_SENDS) return false
    if (!force && frozenNow()) return false
    consecutive.set(key, n + 1)
    try {
      await adapter.send({ threadId: raw.threadId, text, markup: 'none', inReplyTo: raw.providerMessageId, sensitivity: 'public' })
      record('sent', raw, { bindingId: binding.id }, rule, text.length)
      return true
    } catch (err) {
      record('failed', raw, { bindingId: binding.id }, rule, text.length)
      log?.warn?.('[jarvis] channel send failed:', err?.message ?? err)
      return false
    }
  }

  /** ⑥ The sender's own words are the request; everything else is data. */
  function splitContent(raw) {
    const request = raw.text ? stripHiddenText(raw.text).text.trim() : ''
    const untrusted = []
    if (raw.forwarded?.text) untrusted.push(wrapUntrusted(raw.forwarded.text, `channel:${raw.channel}:forwarded`))
    if (raw.quoted?.text) untrusted.push(wrapUntrusted(raw.quoted.text, `channel:${raw.channel}:quoted`))
    return { request, untrusted }
  }

  /** ⑧ What a reply may contain (spec §5.5). */
  function filterReply(adapter, binding, reply) {
    const sensitivity = reply?.sensitivity ?? 'private'
    const text = stripHiddenText(String(reply?.text ?? '')).text.trim()
    if (sensitivity === 'vault') return REPLIES.vault
    if (sensitivity === 'private') {
      const scope = chatScope(binding)
      const allowed = scope.privateReplies && (adapter.capabilities().endToEnd || (binding.role === 'owner' ? settings.privateTelegram !== false : true))
      if (!allowed) return REPLIES.private
      // A bland first line, so a lock-screen preview shows nothing (D2).
      return `${REPLIES.privateLead}\n\n${text}`
    }
    return text
  }

  /** ①–⑨ for one message from one adapter. Never throws. */
  async function handle(adapter, raw) {
    try {
      return await handleInner(adapter, raw)
    } catch (err) {
      log?.error?.('[jarvis] channel message not handled:', err?.message ?? err)
      return { outcome: 'error' }
    }
  }

  async function handleInner(adapter, raw) {
    if (!raw || raw.channel !== adapter.id || typeof raw.senderId !== 'string') return { outcome: 'malformed' }
    const length = lengthOf(raw)
    const stranger = () => ({ senderHash: hashSender(raw.channel, raw.senderId) })

    // ② Frozen: drop in silence. "unfreeze" from chat therefore does nothing.
    if (frozenNow()) {
      record('rejected', raw, stranger(), 'frozen', length)
      return { outcome: 'frozen' }
    }

    // Channel-wide flood limit, before anything else is looked up.
    if (limits.channel(raw.channel) !== 'ok') {
      record('rejected', raw, stranger(), 'channel-limit', length)
      return { outcome: 'channel-limit' }
    }

    // Pairing: a `/pair <code>` from anyone. Never answered (spec §4.2).
    const pair = raw.text && !raw.forwarded ? PAIR.exec(raw.text) : null
    if (pair && allowlist.pairingState(raw.channel).state !== 'none') {
      const { result } = allowlist.tryPair(raw.channel, raw.senderId, raw.senderLabel, pair[1])
      record(result === 'match' ? 'received' : 'rejected', raw, stranger(), `pair-${result}`, length)
      if (result === 'match' || result === 'burnt') notify({ kind: `pairing-${result}`, channel: raw.channel })
      return { outcome: `pair-${result}` }
    }

    // ③ Allow-list. A stranger gets nothing back.
    const binding = allowlist.lookup(raw.channel, raw.senderId)
    if (!binding) {
      record('rejected', raw, stranger(), 'rejected-unknown', length)
      if (limits.unknown(raw.channel)) notify({ kind: 'unknown-senders', channel: raw.channel })
      return { outcome: 'rejected-unknown' }
    }
    const who = { bindingId: binding.id }
    consecutive.delete(`${adapter.id}:${raw.threadId}`)

    // ④ Per-binding limits: one "slow down", then silence.
    const limit = limits.binding(binding.id, binding.limits)
    if (limit !== 'ok') {
      record('rejected', raw, who, 'binding-limit', length)
      if (limit === 'warn') await send(adapter, binding, raw, REPLIES.slowDown, 'slow-down')
      return { outcome: 'binding-limit' }
    }

    // Approval buttons are plan 20 phase 4. Typed "approve" is just chat (S7).
    if (raw.callback) {
      await adapter.ackCallback?.(raw.callbackQueryId)
      record('rejected', raw, who, 'approvals-not-built', 0)
      return { outcome: 'callback-ignored' }
    }

    if (!binding.allow.chat) {
      record('rejected', raw, who, 'chat-not-allowed', length)
      return { outcome: 'chat-not-allowed' }
    }

    // Freeze from chat: the owner, on a high-assurance channel (spec §5.7).
    if (raw.text && !raw.forwarded && FREEZE.test(raw.text)) {
      if (binding.role === 'owner' && binding.assurance === 'high') {
        record('received', raw, who, 'freeze', length)
        freeze()
        notify({ kind: 'frozen-from-chat', channel: raw.channel })
        await send(adapter, binding, raw, REPLIES.frozen, 'frozen', { force: true })
        await stopAll()
        return { outcome: 'frozen-by-owner' }
      }
    }

    // ⑥ Split. Media without text is not understood yet.
    const { request, untrusted } = splitContent(raw)
    if (!request && !untrusted.length) {
      record('rejected', raw, who, 'unsupported-media', 0)
      await send(adapter, binding, raw, REPLIES.textOnly, 'text-only')
      return { outcome: 'unsupported-media' }
    }
    record('received', raw, who, 'chat-turn', length)

    // ⑤ + ⑦ Identity and the chat turn.
    const scope = chatScope(binding)
    const identity = {
      personId: binding.personId,
      role: binding.role,
      confidence: binding.assurance === 'high' ? 0.9 : 0.5,
      sources: ['channel'],
    }
    let reply
    try {
      stats.turns += 1
      reply = await runTurn({
        via: 'chat',
        modality: 'text',
        channel: raw.channel,
        threadId: raw.threadId,
        identity,
        presence: [],
        request,
        untrusted,
        taintStart: true,
        toolScope: scope.tools,
        assurance: binding.assurance,
      })
    } catch (err) {
      log?.warn?.('[jarvis] chat turn failed:', err?.message ?? err)
      await send(adapter, binding, raw, REPLIES.busy, 'turn-failed')
      return { outcome: 'turn-failed' }
    }

    // ⑧ + ⑨
    const text = filterReply(adapter, binding, reply)
    if (text) await send(adapter, binding, raw, text, `reply-${reply?.sensitivity ?? 'private'}`)
    return { outcome: 'answered' }
  }

  async function startAll() {
    for (const adapter of Object.values(active)) {
      await adapter.start((raw) => handle(adapter, raw))
    }
  }

  async function stopAll() {
    await Promise.all(Object.values(active).map((a) => a.stop().catch(() => {})))
  }

  return {
    enabled: Boolean(enabled),
    adapters: active,
    handle,
    startAll,
    stopAll,
    stats: () => ({ ...stats }),
    health: () => Object.fromEntries(Object.entries(active).map(([id, a]) => [id, a.health()])),
  }
}

/**
 * Construct only the adapters that are switched on. With the master switch
 * off this imports nothing and constructs nothing (spec §10).
 */
export async function loadAdapters({ enabled, channels = {}, deps = {}, registry = ADAPTERS }) {
  const out = {}
  if (!enabled) return out
  for (const [id, on] of Object.entries(channels)) {
    if (!on || !registry[id]) continue
    const mod = await registry[id]()
    out[id] = mod.createAdapter(deps)
  }
  return out
}
