/**
 * Rate limits for messaging channels (plan 20, spec §6). Fixed windows,
 * counted in memory. A limit never answers anyone by itself: it says whether
 * a message is handled (`ok`), is the first one over the limit in this window
 * (`warn`, the pipeline sends one "slow down"), or is dropped in silence
 * (`drop`).
 *
 * Node built-ins only, so it can be tested on its own.
 */

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Spec §6 defaults. */
export const DEFAULT_LIMITS = Object.freeze({
  perMinute: 20,
  perDay: 300,
  channelPerMinute: 60,
  unknownNoticePerHour: 20,
})

/**
 * Parse the `JARVIS_CHANNEL_LIMITS` shape, "20/min,300/day". Anything that
 * does not parse gives the defaults: a typo must not switch limits off.
 */
export function parseLimits(text) {
  const out = { perMinute: DEFAULT_LIMITS.perMinute, perDay: DEFAULT_LIMITS.perDay }
  const m = /^\s*(\d{1,4})\s*\/\s*min\s*,\s*(\d{1,6})\s*\/\s*day\s*$/i.exec(String(text ?? ''))
  if (!m) return out
  const perMinute = Number(m[1])
  const perDay = Number(m[2])
  if (perMinute >= 1 && perDay >= perMinute) return { perMinute, perDay }
  return out
}

/**
 * One fixed-window counter per key. `check(key, limit)` counts the message
 * and returns 'ok' | 'warn' | 'drop'.
 */
export function createWindow({ size, now = () => Date.now(), maxKeys = 10_000 }) {
  /** key → { start, count } */
  const counts = new Map()
  return {
    check(key, limit) {
      const t = now()
      let c = counts.get(key)
      if (!c || t - c.start >= size) {
        if (!c && counts.size >= maxKeys) counts.delete(counts.keys().next().value)
        c = { start: t - (t % size), count: 0 }
        counts.set(key, c)
      }
      c.count += 1
      if (c.count <= limit) return 'ok'
      return c.count === limit + 1 ? 'warn' : 'drop'
    },
    count(key) {
      const c = counts.get(key)
      return c && now() - c.start < size ? c.count : 0
    },
  }
}

/**
 * The limits the pipeline applies, in order: the whole channel, then the
 * binding (per minute and per day). Over the channel limit is silent; the
 * first message over a binding's limit gets one "slow down".
 */
export function createLimits({ now = () => Date.now(), channelPerMinute = DEFAULT_LIMITS.channelPerMinute } = {}) {
  const minute = createWindow({ size: MINUTE, now })
  const day = createWindow({ size: DAY, now })
  const channel = createWindow({ size: MINUTE, now })
  const unknown = createWindow({ size: HOUR, now })
  return {
    /** Every inbound message on a channel, known sender or not. */
    channel(channelId) {
      return channel.check(channelId, channelPerMinute)
    },
    /** A bound sender's message. `limits` is the binding's `{ perMinute, perDay }`. */
    binding(bindingId, limits = DEFAULT_LIMITS) {
      const a = minute.check(bindingId, limits.perMinute ?? DEFAULT_LIMITS.perMinute)
      const b = day.check(bindingId, limits.perDay ?? DEFAULT_LIMITS.perDay)
      if (a === 'drop' || b === 'drop') return 'drop'
      if (a === 'warn' || b === 'warn') return 'warn'
      return 'ok'
    },
    /**
     * Count one message from a stranger. True exactly once per hour, when the
     * count passes the notice threshold, so the HUD is told once.
     */
    unknown(channelId, threshold = DEFAULT_LIMITS.unknownNoticePerHour) {
      return unknown.check(channelId, threshold) === 'warn'
    },
    unknownCount(channelId) {
      return unknown.count(channelId)
    },
  }
}
