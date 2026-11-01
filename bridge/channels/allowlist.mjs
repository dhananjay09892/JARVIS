/**
 * The sender allow-list and pairing (plan 20, spec §4).
 *
 * A binding ties one provider sender id to a person in JARVIS. The key is
 * `(channel, senderId)` — the provider's stable numeric id, never a display
 * name or username, which change and can be copied. Bindings are personal
 * data, not secrets: they live in a local SQLite table and never leave this
 * computer.
 *
 * Pairing (spec §4.2) runs the other way round from "the bot gives you a
 * code", so the bot never has to talk to strangers:
 *   1. the HUD asks for a code (`startPairing`), shows it, valid 10 minutes;
 *   2. the owner sends `/pair <code>` to the bot (`tryPair`);
 *   3. a match does not bind: it waits for a click in the HUD naming the
 *      account (`confirmPairing`). Only that creates the binding.
 * Wrong codes get no reply; five of them burn the code.
 *
 * Node built-ins only, so it can be tested on its own.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DEFAULT_LIMITS } from './limits.mjs'

export const ROLES = ['owner', 'member', 'child', 'guest']
export const CHANNELS = ['telegram', 'sms', 'whatsapp', 'signal', 'email']
/** No 0/O, 1/I/L: the code is read off a screen and typed on a phone. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8
export const PAIRING_TTL_MS = 10 * 60_000
export const PAIRING_MAX_MISSES = 5
export const GUEST_TTL_MS = 7 * 24 * 60 * 60_000

const SENDER_ID = /^[^\s\u0000-\u001f]{1,256}$/
const PERSON_ID = /^[\w.-]{1,64}$/

/** A fresh code, uniformly drawn (rejection sampling, no modulo bias). */
export function newPairingCode(random = randomBytes) {
  let out = ''
  const limit = 256 - (256 % CODE_ALPHABET.length)
  while (out.length < CODE_LENGTH) {
    for (const b of random(16)) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
    }
  }
  return out
}

/** Constant-time compare of two codes, after normalising case and spaces. */
export function sameCode(a, b) {
  const x = Buffer.from(String(a ?? '').replace(/[\s-]/g, '').toUpperCase())
  const y = Buffer.from(String(b ?? '').replace(/[\s-]/g, '').toUpperCase())
  if (x.length !== y.length) {
    timingSafeEqual(y, y)
    return false
  }
  return timingSafeEqual(x, y)
}

/** Defaults by role (spec §4.1): approvals and proactive messages are the owner's only. */
function defaultAllow(role) {
  const owner = role === 'owner'
  return { chat: true, voiceNotes: true, approvals: owner, proactive: owner }
}

/**
 * Build and check a binding. Throws naming the field (never the value).
 */
export function makeBinding(input, { now = Date.now(), newId = () => `bind-${randomUUID()}` } = {}) {
  const b = input ?? {}
  if (!CHANNELS.includes(b.channel)) throw new Error('binding: unknown channel')
  if (typeof b.senderId !== 'string' || !SENDER_ID.test(b.senderId)) throw new Error('binding: bad senderId')
  if (!ROLES.includes(b.role)) throw new Error('binding: unknown role')
  const personId = b.personId ?? (b.role === 'guest' ? 'guest' : null)
  if (typeof personId !== 'string' || !PERSON_ID.test(personId)) throw new Error('binding: bad personId')
  if (!['high', 'low'].includes(b.assurance)) throw new Error('binding: assurance must be high or low')
  const limits = {
    perMinute: Number.isInteger(b.limits?.perMinute) && b.limits.perMinute > 0 ? b.limits.perMinute : DEFAULT_LIMITS.perMinute,
    perDay: Number.isInteger(b.limits?.perDay) && b.limits.perDay > 0 ? b.limits.perDay : DEFAULT_LIMITS.perDay,
  }
  const allow = { ...defaultAllow(b.role), ...(b.allow ?? {}) }
  // A low-assurance channel (SMS) never answers approval cards (spec §4.1, S3).
  if (b.assurance === 'low') allow.approvals = false
  // Children and guests may only chat until plan 30 (spec §4.1).
  if (b.role === 'child' || b.role === 'guest') {
    allow.approvals = false
    allow.proactive = false
  }
  const binding = {
    v: 1,
    id: b.id ?? newId(),
    ts: b.ts ?? now,
    channel: b.channel,
    senderId: b.senderId,
    personId,
    role: b.role,
    assurance: b.assurance,
    boundVia: b.boundVia === 'pairing' ? 'pairing' : 'manual',
    limits,
    allow: {
      chat: allow.chat === true,
      voiceNotes: allow.voiceNotes === true,
      approvals: allow.approvals === true,
      proactive: allow.proactive === true,
    },
    status: b.status === 'revoked' ? 'revoked' : 'active',
  }
  if (typeof b.senderLabel === 'string' && b.senderLabel) binding.senderLabel = b.senderLabel.slice(0, 80)
  const expiresAt = b.expiresAt ?? (b.role === 'guest' ? now + GUEST_TTL_MS : undefined)
  if (expiresAt !== undefined) binding.expiresAt = expiresAt
  if (b.lastSeenAt !== undefined) binding.lastSeenAt = b.lastSeenAt
  return binding
}

/**
 * Open the allow-list. `file` is a SQLite path; the default `:memory:` is for
 * tests. `random` and `now` are for tests too.
 */
export function openAllowlist({ file = ':memory:', now = () => Date.now(), random = randomBytes } = {}) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE IF NOT EXISTS channel_bindings (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    data TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS channel_bindings_sender ON channel_bindings (channel, sender_id)')
  const stmt = {
    put: db.prepare('INSERT OR REPLACE INTO channel_bindings (id, channel, sender_id, data) VALUES (?, ?, ?, ?)'),
    bySender: db.prepare('SELECT data FROM channel_bindings WHERE channel = ? AND sender_id = ?'),
    byId: db.prepare('SELECT data FROM channel_bindings WHERE id = ?'),
    all: db.prepare('SELECT data FROM channel_bindings ORDER BY channel, id'),
  }
  const parse = (row) => (row ? JSON.parse(row.data) : null)
  const save = (b) => stmt.put.run(b.id, b.channel, b.senderId, JSON.stringify(b))
  const isLive = (b) => b.status === 'active' && (b.expiresAt === undefined || now() < b.expiresAt)

  /** The one pairing window that may be open per channel. */
  const pairing = new Map()

  const api = {
    /** The active binding for a sender, or null. Updates its last-seen time. */
    lookup(channel, senderId) {
      if (typeof senderId !== 'string' || !SENDER_ID.test(senderId)) return null
      const live = stmt.bySender.all(channel, senderId).map(parse).filter(isLive)
      if (!live.length) return null
      const b = live[0]
      b.lastSeenAt = now()
      save(b)
      return b
    },

    /** Add a binding. One active owner per channel until plan 30. */
    add(input) {
      const b = makeBinding(input, { now: now() })
      const others = stmt.bySender.all(b.channel, b.senderId).map(parse).filter(isLive)
      if (others.length) throw new Error('binding: this sender is already bound')
      if (b.role === 'owner' && api.list().some((x) => x.channel === b.channel && x.role === 'owner' && isLive(x))) {
        throw new Error('binding: this channel already has an owner')
      }
      save(b)
      return b
    },

    /** Revoke at once: the sender's next message is treated as a stranger's. */
    revoke(id) {
      const b = parse(stmt.byId.get(id))
      if (!b) return false
      b.status = 'revoked'
      save(b)
      return true
    },

    list() {
      return stmt.all.all().map(parse)
    },

    /**
     * Open a pairing window (HUD → Settings → Channels → Pair). Replaces any
     * window already open on that channel.
     */
    startPairing({ channel, role = 'owner', personId = role === 'owner' ? 'owner' : undefined, assurance = 'high' }) {
      if (!CHANNELS.includes(channel)) throw new Error('pairing: unknown channel')
      if (!ROLES.includes(role)) throw new Error('pairing: unknown role')
      const code = newPairingCode(random)
      const expiresAt = now() + PAIRING_TTL_MS
      pairing.set(channel, { code, role, personId, assurance, expiresAt, misses: 0, pending: null, state: 'open' })
      return { code, expiresAt }
    },

    /**
     * Called by the pipeline for `/pair <code>` from any sender. Never
     * produces a reply. Returns `{ result }`, one of: 'none' (no window),
     * 'expired', 'miss', 'burnt', 'match' (now waiting for the HUD).
     */
    tryPair(channel, senderId, senderLabel, code) {
      const p = pairing.get(channel)
      if (!p || p.state === 'used') return { result: 'none' }
      if (p.state === 'burnt') return { result: 'burnt' }
      if (now() >= p.expiresAt) {
        pairing.delete(channel)
        return { result: 'expired' }
      }
      if (p.pending) return { result: 'miss' } // a match is already waiting; no second candidate
      if (!sameCode(code, p.code)) {
        p.misses += 1
        if (p.misses >= PAIRING_MAX_MISSES) {
          p.state = 'burnt'
          return { result: 'burnt' }
        }
        return { result: 'miss' }
      }
      p.pending = { senderId, senderLabel: typeof senderLabel === 'string' ? senderLabel.slice(0, 80) : '' }
      return { result: 'match' }
    },

    /** What the HUD shows: the open window, and who is waiting to be confirmed. Never the code once matched. */
    pairingState(channel) {
      const p = pairing.get(channel)
      if (!p) return { state: 'none' }
      if (p.state === 'open' && now() >= p.expiresAt) return { state: 'expired' }
      if (p.pending) return { state: 'confirm', role: p.role, senderId: p.pending.senderId, senderLabel: p.pending.senderLabel }
      return { state: p.state, role: p.role, expiresAt: p.expiresAt, misses: p.misses }
    },

    /** The HUD's Confirm click. The only way pairing creates a binding. */
    confirmPairing(channel) {
      const p = pairing.get(channel)
      if (!p?.pending || p.state !== 'open') throw new Error('pairing: nothing to confirm')
      if (now() >= p.expiresAt) {
        pairing.delete(channel)
        throw new Error('pairing: the code expired')
      }
      p.state = 'used'
      const binding = api.add({
        channel,
        senderId: p.pending.senderId,
        senderLabel: p.pending.senderLabel,
        role: p.role,
        personId: p.personId,
        assurance: p.assurance,
        boundVia: 'pairing',
      })
      pairing.delete(channel)
      return binding
    },

    /** The HUD's Cancel click, or closing the pairing screen. */
    cancelPairing(channel) {
      pairing.delete(channel)
    },

    close() {
      db.close()
    },
  }
  return api
}
