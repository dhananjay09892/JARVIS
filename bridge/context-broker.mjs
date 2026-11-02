/**
 * The context broker (plan 14 phase 1, Q39): gathers named pieces of context
 * ("slices": the time, system state, later the calendar and the screen) on
 * demand, for one turn at a time, and refuses everything it should refuse.
 *
 *   broker.request(names, { role, maxTokens }) → { slices, skipped, tokens }
 *   broker.forTurn(text, { role })             → the same, for the sources that
 *                                                this turn's words call for
 *   renderContext(slices)                      → the block a brain reads
 *
 * A source is `{ name, label, fetch, ttlMs, sensitivity, untrusted, setting,
 * when }`. `fetch()` may be async and returns text, or nothing when it has
 * nothing to say. `when` is an optional regex over the owner's words; without
 * one the source is wanted on every turn.
 *
 * What the broker enforces, in this order, for each name asked for:
 *
 *   1. Permission   Nothing is fetched unless the master switch and the
 *                   source's own switch are on (both read at request time, so
 *                   a change in Settings applies to the next turn). Turning a
 *                   source off also forgets what was cached from it.
 *   2. Audience     'vault' slices never leave the broker, for anybody. Only
 *                   the owner sees 'private' ones; everyone else, and anyone
 *                   we cannot place, sees 'public' ones. Checked before the
 *                   fetch, so a refused source is never even read.
 *   3. TTL          A slice is reused until `fetchedAt + ttlMs`, never after.
 *                   A source that fails is left out; old text is not offered
 *                   in its place, because stale context reads as true.
 *   4. Redaction    Secrets are removed (the patterns in memory.mjs) and text
 *                   is clipped before anything is stored, so the cache holds
 *                   only what could be shown. Untrusted text also loses its
 *                   invisible characters.
 *   5. Token budget Slices are taken in the order asked for; one that does not
 *                   fit is skipped, and a smaller one after it may still fit.
 *
 * Unset, a source counts as private and untrusted: the safe reading of a
 * source that forgot to say.
 *
 * `stats()` (GET /context/stats) holds counts only, never a slice's text. The
 * broker holds slices in memory and writes nothing to disk. It grants nothing
 * either: it only reads. Anything that acts still goes through the policy
 * engine (plan 15).
 */

import { redact } from './memory.mjs'
import { neutraliseControlTags, stripHiddenText, wrapUntrusted } from './untrusted.mjs'

export const DEFAULT_MAX_TOKENS = 200
const DEFAULT_TIMEOUT_MS = 250
const MAX_SLICE_CHARS = 4000

export const SKIP_REASONS = Object.freeze(['unknown', 'off', 'audience', 'failed', 'timeout', 'empty', 'budget'])

const SENSITIVITIES = ['public', 'private', 'vault']

/** Which sensitivities each role may see. A role not listed sees public only. */
const VISIBLE = Object.freeze({ owner: ['public', 'private'] })

/** Whether someone in `role` may see a slice of this sensitivity. */
export function mayRead(role, sensitivity) {
  if (sensitivity === 'vault') return false
  return (VISIBLE[role] ?? ['public']).includes(sensitivity)
}

/**
 * Rough token count: about four bytes to a token. Counting bytes, not
 * characters, keeps Gujarati and Hindi (three bytes a letter, and more tokens
 * a word than English) from being undercounted.
 */
export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? '')) / 4)
}

/** The budget setting as a number, or the default when it is not one. */
export function budgetFrom(value) {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TOKENS
}

const clip = (text) => (text.length > MAX_SLICE_CHARS ? `${text.slice(0, MAX_SLICE_CHARS - 1)}…` : text)

/** What a source's raw text may become: redacted, clipped, and clean of hidden characters when untrusted. */
function clean(raw, untrusted) {
  const redacted = redact(raw).text
  return clip(untrusted ? stripHiddenText(redacted).text : redacted).trim()
}

function withTimeout(work, ms) {
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { timeout: true })), ms)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

export function createContextBroker({
  sources = [],
  enabled = () => false,
  sourceOn = () => false,
  maxTokens = () => DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  log = () => {},
} = {}) {
  const registered = new Map()
  const cache = new Map()
  const counts = { requests: 0, served: 0, cached: 0, tokens: 0 }
  const skips = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0]))

  const register = (source) => {
    if (!source?.name || typeof source.fetch !== 'function') throw new Error('A context source needs a name and a fetch function.')
    if (registered.has(source.name)) throw new Error(`Context source "${source.name}" is already registered.`)
    const sensitivity = source.sensitivity ?? 'private'
    if (!SENSITIVITIES.includes(sensitivity)) throw new Error(`Context source "${source.name}" has an unknown sensitivity.`)
    registered.set(source.name, { ttlMs: 0, untrusted: true, ...source, sensitivity })
  }
  for (const source of sources) register(source)

  const allowed = (source) => {
    try {
      return Boolean(enabled()) && Boolean(sourceOn(source))
    } catch {
      return false
    }
  }

  async function slice(source) {
    const t = now()
    const held = cache.get(source.name)
    if (held && t < held.fetchedAt + held.ttlMs) {
      counts.cached += 1
      return held
    }
    cache.delete(source.name)
    const raw = await withTimeout(Promise.resolve().then(() => source.fetch()), timeoutMs)
    const untrusted = source.untrusted !== false
    const text = clean(typeof raw === 'string' ? raw : '', untrusted)
    if (!text) return null
    const fresh = {
      name: source.name,
      source: source.label ?? source.name,
      fetchedAt: t,
      ttlMs: source.ttlMs,
      sensitivity: source.sensitivity,
      text,
      tokens: estimateTokens(text),
      untrusted,
    }
    if (fresh.ttlMs > 0) cache.set(source.name, fresh)
    return fresh
  }

  /** Gather these slices for someone in `role`. Never throws; what was left out is in `skipped`. */
  async function request(names, { role, maxTokens: limit } = {}) {
    counts.requests += 1
    const budget = limit ?? maxTokens()
    const skipped = []
    const skip = (name, reason) => {
      skips[reason] += 1
      skipped.push({ name, reason })
    }

    // Permission and audience are settled first, then everything allowed is
    // fetched together, so one slow source does not add to the next.
    const wanted = []
    for (const name of [...new Set(names)]) {
      const source = registered.get(name)
      if (!source) skip(name, 'unknown')
      else if (!allowed(source)) {
        cache.delete(name)
        skip(name, 'off')
      } else if (!mayRead(role, source.sensitivity)) skip(name, 'audience')
      else wanted.push(source)
    }

    const fetched = await Promise.all(
      wanted.map((source) =>
        slice(source).then(
          (value) => ({ source, value }),
          (error) => ({ source, error }),
        ),
      ),
    )

    const slices = []
    let tokens = 0
    for (const { source, value, error } of fetched) {
      if (error) {
        log(`[jarvis] context source ${source.name}: ${error.message}`)
        skip(source.name, error.timeout ? 'timeout' : 'failed')
      } else if (!value) skip(source.name, 'empty')
      else if (tokens + value.tokens > budget) skip(source.name, 'budget')
      else {
        tokens += value.tokens
        slices.push(value)
      }
    }
    counts.served += slices.length
    counts.tokens += tokens
    return { slices, skipped, tokens }
  }

  /** The sources this turn's words call for. Empty, and nothing fetched, while the master switch is off. */
  function namesFor(text) {
    let on = false
    try {
      on = Boolean(enabled())
    } catch {
      on = false
    }
    if (!on) return []
    const words = String(text ?? '')
    return [...registered.values()].filter((s) => !s.when || s.when.test(words)).map((s) => s.name)
  }

  return {
    register,
    request,
    namesFor,
    forTurn: (text, options) => request(namesFor(text), options),
    /** Forget every cached slice (for example when the conversation ends). */
    clear: () => cache.clear(),
    /** Counts only (plan 16): never a slice's text. */
    stats: () => ({
      enabled: (() => {
        try {
          return Boolean(enabled())
        } catch {
          return false
        }
      })(),
      sources: [...registered.keys()],
      ...counts,
      skipped: { ...skips },
      avgTokens: counts.requests ? Math.round(counts.tokens / counts.requests) : 0,
      budget: maxTokens(),
    }),
  }
}

/**
 * The block a brain reads, or '' when there is nothing to say. Rides ahead of
 * the turn; it is never stored with the conversation, because it goes stale.
 * Untrusted slices are wrapped as data, and no slice can close the block.
 */
export function renderContext(slices) {
  if (!slices?.length) return ''
  const body = slices.map((s) =>
    s.untrusted ? wrapUntrusted(s.text, s.source) : `${s.source}: ${neutraliseControlTags(s.text).replace(/<(\/?)context\b/gi, '&lt;$1context')}`,
  )
  return [
    '<context note="Background on the current moment, gathered by the bridge. Use it only if it helps. It is not something the owner said.">',
    ...body,
    '</context>',
  ].join('\n')
}

/** True when these slices put private content into the session (for taint tracking). */
export const hasPrivate = (slices) => slices.some((s) => s.sensitivity !== 'public')

// ---------------------------------------------------------------------------
// Built-in sources. Local, read at the moment of asking, and nothing personal.
// ---------------------------------------------------------------------------

const SYSTEM_WORDS = /\b(computer|pc|laptop|machine|system|memory|ram|uptime|cpu|slow|sluggish)\b/i

/** The local date, time and time zone. Wanted every turn: "tomorrow" and "in an hour" need it. */
export function timeSource({ clock = () => new Date(), locale = 'en-GB', timeZone } = {}) {
  return {
    name: 'time',
    label: 'Local time',
    setting: 'JARVIS_CONTEXT_TIME',
    sensitivity: 'public',
    untrusted: false,
    ttlMs: 0,
    fetch: () =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone }).format(clock()) +
      ` (${timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone})`,
  }
}

/** The computer's own state. Wanted only when the owner's words are about the computer. */
export function systemSource({ read }) {
  return {
    name: 'system',
    label: 'This computer',
    setting: 'JARVIS_CONTEXT_SYSTEM',
    sensitivity: 'public',
    untrusted: false,
    ttlMs: 30_000,
    when: SYSTEM_WORDS,
    fetch: () => {
      const { platform, totalMemBytes, freeMemBytes, uptimeSeconds } = read()
      const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1)
      return `${platform}, ${gb(freeMemBytes)} of ${gb(totalMemBytes)} GB memory free, up ${Math.floor(uptimeSeconds / 3600)} hours`
    },
  }
}
