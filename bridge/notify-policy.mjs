/**
 * Notification policy engine (plan 12, building block 2; task Q33).
 *
 * Every candidate alert is a `Notification` (shared/contracts.ts, plan 38)
 * published on the event bus as `notification.created`. This module decides,
 * for each one, whether JARVIS should tell someone now, hold it for later, or
 * drop it, and through which channel:
 *
 *   decide(notification, context) → { verdict, channels, redact, rule, reason, holdUntil? }
 *
 *   verdict   'deliver' | 'hold' | 'suppress'
 *   channels  for 'deliver': 'speak' (out loud in the room) and/or 'hud' (a card)
 *   redact    true: show or say the title only; the body waits until asked
 *   rule      machine-readable name of the rule that decided (for stats and tests)
 *   reason    one plain sentence, so every alert can say why it fired or waited
 *   holdUntil when a held alert may be looked at again (end of quiet hours)
 *
 * The decision is f(urgency, privacy, audience, quiet hours, presence,
 * activity). Rules, first match wins:
 *
 *   1. Alerts switched off (JARVIS_ALERTS=0)              → suppress
 *   2. Past its `expiresAt`                               → suppress
 *   3. Urgent                                             → deliver, speak + hud,
 *      always, including in quiet hours; redacted when a private alert would
 *      be heard by someone outside its audience, or nobody knows who is there
 *   4. Quiet hours (JARVIS_QUIET_HOURS), or someone asleep → hold until they end
 *   5. Presence known and nobody it is for is here       → hold ("while you were away")
 *   6. Private and someone outside its audience is here   → hold until they leave
 *   7. In a meeting, on a call or in focus                → important: silent hud card;
 *                                                           normal and info: hold
 *   8. Mid-conversation                                   → important and normal: hud card
 *                                                           (never talk over you); info: hold
 *   9. Otherwise: important → speak + hud; normal → hud; info → hold for the
 *      next briefing or wake
 *   A private alert delivered while presence is unknown is redacted.
 *
 * Conservative on purpose (plan 12 "Risks": annoyance is the failure mode):
 * only `urgent` ever breaks quiet hours or a meeting, and only `important`
 * speaks unprompted.
 *
 * Today nothing tells the bridge who is in the room (speaker ID, plan 01, is
 * Q28) or what you are doing (plan 14), so the bridge passes presence
 * `undefined` and activity 'unknown'; the rules for them are built and tested
 * so they apply as soon as those signals arrive. There is no delivery channel
 * yet either (block 3): until one is attached, an alert the policy would
 * deliver is kept in the held list with rule 'no-channel', so nothing is lost
 * and nothing is said.
 *
 * Privacy: the engine keeps held alerts in memory only, at most `maxHeld`.
 * `stats()` (GET /notifications/stats) holds counts per verdict and rule,
 * never a title or body. The engine grants nothing: a delivery channel that
 * acts (speaks, pushes) still answers to its own settings and the policy
 * engine (plan 15).
 */

export const URGENCY = Object.freeze(['info', 'normal', 'important', 'urgent'])
export const ACTIVITIES = Object.freeze(['unknown', 'idle', 'conversation', 'meeting', 'call', 'focus', 'sleep'])
export const CHANNELS = Object.freeze(['speak', 'hud'])

const DAY = 24 * 60
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** The JARVIS_QUIET_HOURS pattern: "HH:MM-HH:MM" (local time, may cross midnight) or "off". */
export const QUIET_HOURS_PATTERN = /^(off|([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)$/
export const DEFAULT_QUIET_HOURS = '22:00-07:00'

/** Whether the JARVIS_ALERTS setting is on (default on). */
export function alertsOn(value) {
  return value !== '0'
}

/**
 * Parses a quiet-hours setting into minutes of the day, or null for "off",
 * an empty window (start = end) or anything malformed.
 */
export function parseQuietHours(value) {
  if (typeof value !== 'string' || !QUIET_HOURS_PATTERN.test(value) || value === 'off') return null
  const [a, b] = value.split('-').map((t) => {
    const [, h, m] = HHMM.exec(t)
    return Number(h) * 60 + Number(m)
  })
  return a === b ? null : { start: a, end: b }
}

/** Whether `minute` (0–1439, local) falls inside the window; the end minute is outside. */
export function inQuietHours(window, minute) {
  if (!window) return false
  const { start, end } = window
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** Minutes from `minute` until the window ends (only meaningful inside it). */
export function minutesUntilEnd(window, minute) {
  return (window.end - minute + DAY) % DAY || DAY
}

/** Minutes since local midnight, from the bridge computer's clock. */
export function localMinute(ts) {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

/** Whether someone in `presence` is in the alert's audience. */
function audienceHere(n, presence) {
  const household = n.audience.includes('household')
  return presence.some((p) => n.audience.includes(p.personId) || (household && p.role !== 'guest'))
}

/** Whether someone in `presence` is outside the alert's audience. */
function outsiderHere(n, presence) {
  const household = n.audience.includes('household')
  return presence.some((p) => !(n.audience.includes(p.personId) || (household && p.role !== 'guest')))
}

const deliver = (channels, rule, reason, redact = false) => ({ verdict: 'deliver', channels, redact, rule, reason })
const hold = (rule, reason, holdUntil) => ({ verdict: 'hold', channels: [], redact: false, rule, reason, ...(holdUntil !== undefined && { holdUntil }) })
const suppress = (rule, reason) => ({ verdict: 'suppress', channels: [], redact: false, rule, reason })

/**
 * Decides one alert. Pure: everything it depends on is in `ctx`.
 *
 *   ctx.now          timestamp (ms)
 *   ctx.minute       minutes since local midnight at `now` (default from `now`)
 *   ctx.enabled      alerts on (default true)
 *   ctx.quietHours   parsed window or null (see parseQuietHours)
 *   ctx.presence     Identity-like `{ personId, role }[]`, or undefined when unknown
 *   ctx.activity     one of ACTIVITIES (default 'unknown')
 */
export function decide(n, ctx) {
  const now = ctx.now
  const minute = ctx.minute ?? localMinute(now)
  const presence = Array.isArray(ctx.presence) ? ctx.presence : undefined
  const activity = ACTIVITIES.includes(ctx.activity) ? ctx.activity : 'unknown'
  const isPrivate = n.privacy === 'private'
  const overheard = presence ? outsiderHere(n, presence) : true

  if (ctx.enabled === false) return suppress('alerts-off', 'Alerts are switched off in Settings.')
  if (n.expiresAt !== undefined && n.expiresAt <= now) return suppress('expired', 'It was no longer relevant by the time it could be given.')

  if (n.urgency === 'urgent') {
    const redact = isPrivate && overheard
    return deliver(['speak', 'hud'], 'urgent', redact
      ? 'Urgent, so it is given at once; details are held back because others may hear.'
      : 'Urgent, so it is given at once.', redact)
  }

  const quiet = ctx.quietHours ?? null
  if (inQuietHours(quiet, minute)) {
    const holdUntil = now - (now % 60_000) + minutesUntilEnd(quiet, minute) * 60_000
    return hold('quiet-hours', 'It is quiet hours; it will wait until they end.', holdUntil)
  }
  if (activity === 'sleep') return hold('asleep', 'You are asleep; it will wait until you are up.')

  if (presence && !audienceHere(n, presence)) return hold('away', 'Nobody it is for is here; it will wait until they are.')
  if (isPrivate && presence && overheard) return hold('private-company', 'It is private and someone else is here; it will wait.')

  const redact = isPrivate && !presence
  if (activity === 'meeting' || activity === 'call' || activity === 'focus') {
    return n.urgency === 'important'
      ? deliver(['hud'], 'busy-silent', 'Important, shown silently because you are busy.', redact)
      : hold('busy', 'You are busy; it will wait until you are free.')
  }
  if (activity === 'conversation') {
    return n.urgency === 'info'
      ? hold('low-priority', 'Low priority; it will wait for the next briefing.')
      : deliver(['hud'], 'in-conversation', 'Shown on screen so it does not talk over you.', redact)
  }
  switch (n.urgency) {
    case 'important':
      return deliver(['speak', 'hud'], 'important', 'Important, so it is said now.', redact)
    case 'normal':
      return deliver(['hud'], 'normal', 'Shown on screen; not worth interrupting for.', redact)
    default:
      return hold('low-priority', 'Low priority; it will wait for the next briefing.')
  }
}

const RANK = Object.fromEntries(URGENCY.map((u, i) => [u, i]))

/**
 * The bridge's notifier: listens for `notification.created` on the bus,
 * decides each alert, hands deliverable ones to the attached channels and
 * keeps held ones in memory for `tick()` to look at again.
 *
 * Options:
 *   bus          the event bus (bridge/bus.mjs); required
 *   enabled      () => boolean, read on every decision (live setting)
 *   quietHours   () => string, the JARVIS_QUIET_HOURS value (live setting)
 *   context      () => ({ presence?, activity? }), current signals
 *   now          () => ms
 *   minute       (ts) => minutes since local midnight
 *   maxHeld      cap on held alerts; the least urgent, oldest goes first
 */
export function createNotifier({
  bus,
  enabled = () => true,
  quietHours = () => DEFAULT_QUIET_HOURS,
  context = () => ({}),
  now = () => Date.now(),
  minute = localMinute,
  maxHeld = 100,
  log = console,
} = {}) {
  if (!bus) throw new TypeError('The notifier needs the event bus.')
  const since = new Date(now()).toISOString()
  const channels = new Set()
  /** id → { n, decision, heldAt } */
  const held = new Map()
  const verdicts = { deliver: 0, hold: 0, suppress: 0 }
  const rules = {}
  let delivered = 0
  let channelErrors = 0

  const count = (d) => {
    verdicts[d.verdict] += 1
    rules[d.rule] = (rules[d.rule] ?? 0) + 1
  }

  function ctxNow() {
    const t = now()
    let c = {}
    try {
      c = context() ?? {}
    } catch (err) {
      log.error?.('[jarvis] notification context failed:', err?.message ?? String(err))
    }
    return { now: t, minute: minute(t), enabled: enabled() !== false, quietHours: parseQuietHours(quietHours()), presence: c.presence, activity: c.activity }
  }

  function keep(n, decision) {
    held.set(n.id, { n, decision, heldAt: now() })
    while (held.size > maxHeld) {
      // Drop the least urgent; among equals, the oldest.
      let worst
      for (const entry of held.values()) {
        if (!worst || RANK[entry.n.urgency] < RANK[worst.n.urgency]) worst = entry
      }
      held.delete(worst.n.id)
      count({ verdict: 'suppress', rule: 'overflow' })
      bus.publish('notification.suppressed', worst.n)
    }
  }

  function hand(n, decision) {
    if (channels.size === 0) {
      keep(n, { ...decision, verdict: 'hold', rule: 'no-channel', reason: 'Nothing can show or say alerts yet; it is kept until something can.', policy: decision.rule })
      return
    }
    let ok = false
    for (const ch of channels) {
      try {
        ch(n, decision)
        ok = true
      } catch (err) {
        channelErrors += 1
        log.error?.('[jarvis] notification channel failed:', err?.message ?? String(err))
      }
    }
    if (ok) {
      delivered += 1
      bus.publish('notification.delivered', n)
    } else {
      keep(n, { ...decision, verdict: 'hold', rule: 'channel-failed', reason: 'It could not be shown or said; it will be tried again.', policy: decision.rule })
    }
  }

  function handle(n) {
    held.delete(n.id) // a newer copy of the same alert replaces the held one
    const decision = decide(n, ctxNow())
    count(decision)
    if (decision.verdict === 'suppress') bus.publish('notification.suppressed', n)
    else if (decision.verdict === 'hold') keep(n, decision)
    else hand(n, decision)
    return decision
  }

  const unsubscribe = bus.subscribe('notification.created', (event) => { handle(event.payload) })

  return {
    /** Raises an alert: publishes it on the bus, where the notifier hears it. */
    submit(n) {
      return bus.publish('notification.created', n)
    },
    /**
     * What the policy would decide for this alert right now, without raising
     * it: nothing is counted, kept or published. For things that are not
     * alerts but should obey the same rules, like the briefing offer (Q78).
     */
    check(n) {
      return decide(n, ctxNow())
    },
    /** Attaches a delivery channel `(notification, decision) => void`. Returns a detach function. */
    addChannel(fn) {
      if (typeof fn !== 'function') throw new TypeError('A notification channel must be a function.')
      channels.add(fn)
      return () => { channels.delete(fn) }
    },
    /**
     * Looks at every held alert again (call it every minute and when presence
     * or activity changes). Expired ones are dropped; ones the policy would now
     * deliver go out; the rest stay. Returns how many left the list.
     */
    tick() {
      const before = held.size
      for (const { n, heldAt } of [...held.values()]) {
        held.delete(n.id)
        const decision = decide(n, ctxNow())
        if (decision.verdict === 'hold') {
          held.set(n.id, { n, decision, heldAt })
        } else if (decision.verdict === 'deliver' && channels.size === 0) {
          // Still nowhere to send it: keep it without counting it again.
          held.set(n.id, { n, decision: { ...decision, verdict: 'hold', rule: 'no-channel', reason: 'Nothing can show or say alerts yet; it is kept until something can.', policy: decision.rule }, heldAt })
        } else {
          count(decision)
          if (decision.verdict === 'suppress') bus.publish('notification.suppressed', n)
          else hand(n, decision)
        }
      }
      return before - held.size
    },
    /**
     * What is being held back and why ("what did you hold back?", plan 12
     * "Metrics"). Titles are included; the caller decides who may hear them.
     */
    held() {
      return [...held.values()].map(({ n, decision, heldAt }) => ({
        id: n.id, source: n.source, urgency: n.urgency, privacy: n.privacy, title: n.title,
        rule: decision.rule, reason: decision.reason, heldAt,
        ...(decision.holdUntil !== undefined && { holdUntil: decision.holdUntil }),
      }))
    },
    /** Counts since the bridge started, for Diagnostics (plan 16). Never a title or body. */
    stats() {
      return { since, decided: { ...verdicts }, rules: { ...rules }, delivered, held: held.size, channels: channels.size, channelErrors }
    },
    stop() {
      unsubscribe()
    },
  }
}
