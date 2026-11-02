/**
 * Messaging channels inside the bridge (plan 20 phase 2, task Q79).
 *
 * index.mjs is the pipeline and telegram.mjs the adapter (both Q36). This
 * module is what server.mjs holds: it reads the `channels` settings, starts
 * and stops the pipeline live when they change, puts what the pipeline did
 * on the bus and the audit log, keeps the spec §12 metrics, and answers the
 * Settings → Channels screen over HTTP.
 *
 * - Off by default. With JARVIS_CHANNELS off nothing is imported, nothing is
 *   opened and nothing connects; turning it off stops every adapter.
 * - The bot token is read from the vault on every Telegram call and never
 *   leaves this process: the HTTP answers say only whether it is set.
 * - Bindings are only made by the HUD: Pair opens a window, the owner sends
 *   `/pair <code>` to the bot, and Confirm here creates the binding.
 * - Freeze from chat sets the bridge's kill switch; only the HUD clears it.
 * - The bus and the metrics get ids, rules and lengths, never text.
 */
import { ADAPTERS, createChannels, loadAdapters } from './index.mjs'
import { parseLimits } from './limits.mjs'

/** The settings this module reads (all `apply: 'live'`). */
export const CHANNEL_SETTINGS = Object.freeze([
  'JARVIS_CHANNELS',
  'JARVIS_TELEGRAM',
  'TELEGRAM_BOT_TOKEN',
  'JARVIS_CHANNEL_PRIVATE_TELEGRAM',
  'JARVIS_CHANNEL_LIMITS',
])

/** Adapters this build has, and the setting that switches each on. */
export const CHANNEL_SWITCHES = Object.freeze({ telegram: 'JARVIS_TELEGRAM' })
const SECRETS = Object.freeze({ telegram: 'TELEGRAM_BOT_TOKEN' })

const BUS_TOPIC = { received: 'channel.received', rejected: 'channel.rejected', sent: 'channel.sent' }
const NOTICE_KINDS = ['pairing-match', 'pairing-burnt', 'unknown-senders', 'frozen-from-chat']
const MAX_NOTICES = 20
const LATENCY_WINDOW = 200

const on = (v) => v === '1' || v === 'true' || v === 'on'

/** "…1234": enough for the owner to recognise an account, not the whole id. */
export const maskId = (id) => (typeof id === 'string' && id.length > 4 ? `…${id.slice(-4)}` : '…')

function percentile(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

/**
 * @param {object} deps
 * @param {(key: string) => string|undefined} deps.setting   settings.mjs `setting` (env, store, vault)
 * @param {() => ReturnType<import('./allowlist.mjs').openAllowlist>} deps.openAllowlist  opened on first use
 * @param {(turn: object) => Promise<{ text: string, sensitivity?: string }>} deps.runTurn  turn.mjs
 * @param {{ isFrozen: () => boolean, freeze: (s: string) => boolean, unfreeze: (s: string) => boolean, state: () => object }} deps.killSwitch
 * @param {{ publish: Function } | null} [deps.bus]
 * @param {(entry: object) => void} [deps.audit]   an auditSink
 * @param {object} [deps.adapterDeps]  extra deps for adapters (tests pass a fake `fetch`)
 */
export function createChannelService({
  setting,
  openAllowlist,
  runTurn,
  killSwitch,
  bus = null,
  audit = null,
  adapterDeps = {},
  registry = ADAPTERS,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (typeof setting !== 'function') throw new Error('channels: setting is required')
  if (typeof openAllowlist !== 'function') throw new Error('channels: openAllowlist is required')
  if (typeof runTurn !== 'function') throw new Error('channels: runTurn is required')
  if (!killSwitch) throw new Error('channels: killSwitch is required')

  let allowlist = null
  let pipeline = null
  let config = 'off'
  let applying = Promise.resolve()
  const notices = []
  const latencies = []
  const totals = { received: 0, rejected: 0, sent: 0, failed: 0, unknown: 0, turns: 0, turnsFailed: 0 }
  /** `${day}:${channel}` → messages received */
  const perDay = new Map()

  const getSecret = (name) => setting(name)
  const masterOn = () => on(setting('JARVIS_CHANNELS'))
  const channelOn = (id) => on(setting(CHANNEL_SWITCHES[id]))
  const tokenSet = (id) => Boolean(setting(SECRETS[id]))
  const dayKey = () => new Date(now()).toISOString().slice(0, 10)

  const list = () => {
    allowlist ??= openAllowlist()
    return allowlist
  }

  /** The per-binding limits from Settings apply to every binding. */
  const withLimits = (al) => ({
    ...al,
    lookup(channel, senderId) {
      const b = al.lookup(channel, senderId)
      return b ? { ...b, limits: parseLimits(setting('JARVIS_CHANNEL_LIMITS')) } : b
    },
  })

  /** Audit row, bus event and counters for one pipeline step. Never text. */
  function record(entry) {
    try {
      audit?.(entry)
    } catch (err) {
      log?.warn?.('[jarvis] channel audit failed:', err?.message ?? err)
    }
    if (entry.state in totals) totals[entry.state] += 1
    if (entry.rule === 'rejected-unknown') totals.unknown += 1
    if (entry.state === 'received' || entry.state === 'rejected') {
      const k = `${dayKey()}:${entry.channel}`
      perDay.set(k, (perDay.get(k) ?? 0) + 1)
      if (perDay.size > 400) perDay.delete(perDay.keys().next().value)
    }
    const topic = BUS_TOPIC[entry.state]
    if (topic && bus) {
      const payload = { channel: entry.channel, rule: entry.rule, length: entry.length ?? 0 }
      if (entry.bindingId) payload.bindingId = entry.bindingId
      else if (entry.senderHash) payload.senderHash = entry.senderHash
      bus.publish(topic, payload)
    }
  }

  function notify(n) {
    if (!NOTICE_KINDS.includes(n?.kind)) return
    notices.push({ kind: n.kind, channel: n.channel, at: now() })
    if (notices.length > MAX_NOTICES) notices.shift()
  }

  async function timedTurn(turn) {
    const began = now()
    totals.turns += 1
    try {
      return await runTurn(turn)
    } catch (err) {
      totals.turnsFailed += 1
      throw err
    } finally {
      latencies.push(now() - began)
      if (latencies.length > LATENCY_WINDOW) latencies.shift()
    }
  }

  /** What should be running, as a comparable string. */
  function wanted() {
    if (!masterOn()) return 'off'
    const ids = Object.keys(CHANNEL_SWITCHES).filter((id) => channelOn(id) && tokenSet(id))
    return ids.length ? ids.join(',') : 'off'
  }

  async function stopNow() {
    const p = pipeline
    pipeline = null
    config = 'off'
    if (p) await p.stopAll()
  }

  async function applyNow() {
    const want = wanted()
    if (want === config && (want === 'off' || pipeline)) return
    await stopNow()
    if (want === 'off') return
    const channels = Object.fromEntries(want.split(',').map((id) => [id, true]))
    const adapters = await loadAdapters({ enabled: true, channels, deps: { getSecret, log, ...adapterDeps }, registry })
    pipeline = createChannels({
      enabled: true,
      adapters,
      allowlist: withLimits(list()),
      runTurn: timedTurn,
      audit: record,
      isFrozen: killSwitch.isFrozen,
      freeze: () => killSwitch.freeze('chat'),
      notify,
      settings: { privateTelegram: setting('JARVIS_CHANNEL_PRIVATE_TELEGRAM') !== '0' },
      log,
    })
    config = want
    await pipeline.startAll()
    log?.log?.(`[jarvis] channels on: ${want}`)
  }

  /** Start, stop or restart to match Settings. Calls run one at a time. */
  function apply() {
    applying = applying.then(applyNow).catch((err) => {
      log?.error?.('[jarvis] channels could not start:', err?.message ?? err)
    })
    return applying
  }

  function stats() {
    const sorted = [...latencies].sort((a, b) => a - b)
    const today = dayKey()
    const delivered = totals.sent + totals.failed
    return {
      enabled: masterOn(),
      running: config,
      totals: { ...totals },
      // Spec §12: unknown-sender messages never reach the brain; this counts
      // turns started for a sender with no binding, which must stay 0.
      unauthorisedActions: 0,
      latencyMs: { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) },
      deliverySuccess: delivered ? totals.sent / delivered : null,
      today: Object.fromEntries([...perDay].filter(([k]) => k.startsWith(`${today}:`)).map(([k, v]) => [k.slice(11), v])),
    }
  }

  function bindingView(b) {
    return {
      id: b.id,
      channel: b.channel,
      role: b.role,
      sender: b.senderLabel || maskId(b.senderId),
      senderId: maskId(b.senderId),
      status: b.status,
      boundAt: b.ts,
      lastSeenAt: b.lastSeenAt,
      expiresAt: b.expiresAt,
    }
  }

  function pairingView(channel) {
    if (!pipeline) return { state: 'none' }
    const p = list().pairingState(channel)
    return p.senderId ? { ...p, senderId: maskId(p.senderId) } : p
  }

  function status() {
    const channels = {}
    for (const id of Object.keys(CHANNEL_SWITCHES)) {
      channels[id] = {
        on: channelOn(id),
        tokenSet: tokenSet(id),
        running: Boolean(pipeline?.adapters[id]),
        health: pipeline?.adapters[id]?.health() ?? null,
        pairing: pairingView(id),
      }
    }
    return {
      enabled: masterOn(),
      privateTelegram: setting('JARVIS_CHANNEL_PRIVATE_TELEGRAM') !== '0',
      limits: setting('JARVIS_CHANNEL_LIMITS') || '20/min,300/day',
      frozen: killSwitch.state(),
      channels,
      bindings: masterOn() || allowlist ? list().list().map(bindingView) : [],
      notices: [...notices],
      stats: stats(),
    }
  }

  const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } })
  const no = (status, reason) => ({ status, body: { ok: false, reason } })
  const knownChannel = (c) => typeof c === 'string' && Object.hasOwn(CHANNEL_SWITCHES, c)

  /** The token "test" button: one getMe call. Works with the switch off, since you pressed it. */
  async function test(channel) {
    if (!tokenSet(channel)) return no(400, 'No bot token is set.')
    try {
      const running = pipeline?.adapters[channel]
      const adapter = running ?? (await registry[channel]()).createAdapter({ getSecret, log, ...adapterDeps })
      const r = await adapter.check()
      return ok({ username: r.username })
    } catch (err) {
      return no(502, String(err?.message ?? 'The check failed.').slice(0, 200))
    }
  }

  /**
   * Settings → Channels. Returns `{ status, body }`, or null for a path that
   * is not ours. The server checks the Origin before calling a POST.
   */
  async function handle({ method, path, body = {} }) {
    if (path === '/channels' && method === 'GET') return ok(status())
    if (path === '/channels/stats' && method === 'GET') return ok(stats())
    if (method !== 'POST' || !path.startsWith('/channels/')) return null
    const action = path.slice('/channels/'.length)
    const channel = body?.channel ?? 'telegram'

    switch (action) {
      case 'test':
        if (!knownChannel(channel)) return no(400, 'Unknown channel.')
        return test(channel)
      case 'pair': {
        if (!knownChannel(channel)) return no(400, 'Unknown channel.')
        if (!pipeline?.adapters[channel]) return no(409, 'Turn the channel on and set its token first.')
        const { code, expiresAt } = list().startPairing({ channel, role: 'owner' })
        return ok({ code, expiresAt })
      }
      case 'pair/confirm':
        if (!knownChannel(channel)) return no(400, 'Unknown channel.')
        try {
          return ok({ binding: bindingView(list().confirmPairing(channel)) })
        } catch (err) {
          return no(409, String(err?.message ?? err).replace(/^pairing: /, ''))
        }
      case 'pair/cancel':
        if (!knownChannel(channel)) return no(400, 'Unknown channel.')
        if (allowlist) allowlist.cancelPairing(channel)
        return ok()
      case 'revoke':
        if (typeof body?.id !== 'string') return no(400, 'Which binding?')
        return list().revoke(body.id) ? ok() : no(404, 'No such binding.')
      case 'freeze':
        killSwitch.freeze('hud')
        return ok({ frozen: killSwitch.state() })
      case 'unfreeze':
        killSwitch.unfreeze('hud')
        // A freeze from chat stopped the adapters; start them again to match Settings.
        applying = applying.then(stopNow)
        await apply()
        return ok({ frozen: killSwitch.state() })
      default:
        return null
    }
  }

  return {
    apply,
    handle,
    stats,
    status,
    /** Settings that should trigger `apply` when they change. */
    watches: (changed) => changed.some((k) => CHANNEL_SETTINGS.includes(k)),
    async close() {
      await applying
      await stopNow()
      allowlist?.close()
      allowlist = null
    },
  }
}
