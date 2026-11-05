/**
 * Agent settings: the owner's limits on named agents and background tasks,
 * read from the settings registry (settings-registry.mjs, section "Agents").
 *
 *   JARVIS_AGENTS_MAX_CONCURRENT  how many background tasks run at once (1–8, default 3)
 *   JARVIS_AGENTS_MAX_DEPTH       how deep delegation may go (1–2, default 1)
 *   JARVIS_AGENTS_BUDGET          the budget for an agent whose file sets none
 *   JARVIS_AGENTS_REVIEWER        whether agents get a reviewer pass unless their file says otherwise
 *   JARVIS_AGENTS_PAUSED          "pause all agents"
 *   JARVIS_AGENT_SWITCHES         per-agent on/off
 *
 * Every value is read when it is needed, so changes apply live. A bad value
 * (an environment variable the registry never validated) falls back to the
 * safe default instead of throwing.
 *
 * "Pause all agents" and the kill switch both pause: while either is set, no
 * background task starts and none keeps running. Nothing here touches the
 * voice session, which is not a task: the cap and the pause only ever hold
 * back background work, never the conversation.
 *
 * Per-agent switches: an on-demand agent is on unless switched off; an agent
 * that runs without being asked each time (scheduled, continuous, triggered)
 * is off until switched on.
 *
 * Nothing here grants anything. A switch can only stop an agent from running;
 * what a running agent may do is still its definition, narrowed by the
 * runtime and decided call by call by policy.mjs.
 */

import { UNATTENDED_MODES } from './agent-definition.mjs'

export const AGENT_SETTINGS = Object.freeze({
  maxConcurrent: 'JARVIS_AGENTS_MAX_CONCURRENT',
  maxDepth: 'JARVIS_AGENTS_MAX_DEPTH',
  defaultBudget: 'JARVIS_AGENTS_BUDGET',
  reviewer: 'JARVIS_AGENTS_REVIEWER',
  paused: 'JARVIS_AGENTS_PAUSED',
  switches: 'JARVIS_AGENT_SWITCHES',
})

/** Settings whose change must reach running and queued tasks at once. */
export const AGENT_LIVE_SETTINGS = Object.freeze([
  AGENT_SETTINGS.maxConcurrent, AGENT_SETTINGS.paused, AGENT_SETTINGS.switches,
])

export const CONCURRENCY = Object.freeze({ min: 1, max: 8, default: 3 })
export const DEPTH = Object.freeze({ min: 1, max: 2, default: 1 })
export const DEFAULT_BUDGET = Object.freeze({ maxToolCalls: 40, maxMinutes: 20, maxCostUsd: 1 })

/** Modes that run without the owner asking each time: off until switched on. */
const UNATTENDED = new Set(UNATTENDED_MODES)
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/
const MAX_SWITCHES = 200

export const PAUSE_REASONS = Object.freeze({
  frozen: 'JARVIS is frozen by the kill switch, so no agent runs.',
  paused: 'All agents are paused. Switch them back on in Settings.',
})

function whole(raw, { min, max, default: fallback }) {
  const n = typeof raw === 'string' && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/**
 * "40 calls, 20 min, $1.00" → { maxToolCalls, maxMinutes, maxCostUsd }, with
 * the same limits an agent file has (agent-definition.mjs). null when it
 * does not parse or is out of range.
 */
export function parseBudget(raw) {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{1,4}) calls?, (\d{1,4}) min, \$(\d{1,3}(?:\.\d{1,2})?)\s*$/.exec(raw)
  if (!m) return null
  const maxToolCalls = Number(m[1])
  const maxMinutes = Number(m[2])
  const maxCostUsd = Number(m[3])
  if (!(maxToolCalls >= 1 && maxToolCalls <= 1000)) return null
  if (!(maxMinutes >= 1 && maxMinutes <= 1440)) return null
  if (!(maxCostUsd >= 0 && maxCostUsd <= 100)) return null
  return { maxToolCalls, maxMinutes, maxCostUsd }
}

export const formatBudget = (b) => `${b.maxToolCalls} calls, ${b.maxMinutes} min, $${b.maxCostUsd.toFixed(2)}`

/** "researcher=off,inbox-triager=on" → Map id → boolean. Bad entries are ignored. */
export function parseSwitches(raw) {
  const out = new Map()
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === 'none') return out
  for (const part of raw.split(',').slice(0, MAX_SWITCHES)) {
    const m = /^\s*([a-z][a-z0-9-]{0,39})=(on|off)\s*$/.exec(part)
    if (m) out.set(m[1], m[2] === 'on')
  }
  return out
}

/** The stored form of a switch map: sorted, 'none' when empty. */
export function formatSwitches(map) {
  const parts = [...map].filter(([id]) => AGENT_ID.test(id)).sort(([a], [b]) => a.localeCompare(b)).map(([id, on]) => `${id}=${on ? 'on' : 'off'}`)
  return parts.length ? parts.slice(0, MAX_SWITCHES).join(',') : 'none'
}

/** Whether an agent is on by default, before any switch: on-demand yes, unattended no. */
export const onByDefault = (definition) => !UNATTENDED.has(definition?.mode)

/**
 * @param {object} o
 * @param {(id: string) => string | undefined} o.read a setting's effective value (settings.mjs `setting`)
 * @param {() => boolean} [o.frozen] the kill switch
 */
export function createAgentSettings({ read, frozen = () => false } = {}) {
  if (typeof read !== 'function') throw new Error('agent settings: read must be a function')
  const get = (id) => {
    try {
      const v = read(id)
      return typeof v === 'string' ? v : undefined
    } catch {
      return undefined
    }
  }
  const isFrozen = () => {
    // A kill-switch reading that cannot be taken counts as frozen (as in policy.mjs).
    try { return frozen() === true } catch { return true }
  }
  const switches = () => parseSwitches(get(AGENT_SETTINGS.switches))

  return {
    maxConcurrent: () => whole(get(AGENT_SETTINGS.maxConcurrent), CONCURRENCY),
    maxDepth: () => whole(get(AGENT_SETTINGS.maxDepth), DEPTH),
    defaultBudget: () => parseBudget(get(AGENT_SETTINGS.defaultBudget)) ?? { ...DEFAULT_BUDGET },
    reviewerDefault: () => get(AGENT_SETTINGS.reviewer) === '1',

    /** Why background work is paused now, or null when it may run. */
    paused() {
      if (isFrozen()) return PAUSE_REASONS.frozen
      if (get(AGENT_SETTINGS.paused) === '1') return PAUSE_REASONS.paused
      return null
    },

    /** Whether the owner has set this agent's switch (rather than its mode's default). */
    hasSwitch: (id) => switches().has(id),

    /** Is this agent switched on? Its own switch, else the default for its mode. */
    isSwitchedOn(id, definition) {
      const s = switches()
      return s.has(id) ? s.get(id) : onByDefault(definition)
    },

    /**
     * The settings patch that switches one agent on or off (for PATCH /settings).
     * `null` forgets the agent's switch, so it falls back to its mode's default
     * (used when a definition is deleted, so a new file with the same id never
     * inherits an old "on").
     */
    switchPatch(id, on) {
      if (typeof id !== 'string' || !AGENT_ID.test(id)) throw new Error('agent settings: bad agent id')
      const s = switches()
      if (on === null) s.delete(id)
      else s.set(id, on === true)
      return { [AGENT_SETTINGS.switches]: formatSwitches(s) }
    },
  }
}

/**
 * The agent registry as the task manager should see it: an agent counts as
 * active only when the registry says so and its switch is on.
 */
export function switchedRegistry(registry, agentSettings) {
  return {
    has: (id) => registry.has(id),
    get: (id) => registry.get(id),
    isActive: (id) => registry.isActive(id) === true && agentSettings.isSwitchedOn(id, registry.get(id)) === true,
    /** Every loaded agent as the registry lists it (`active` is approval only; ask `isActive` for the switch too). */
    list: () => (typeof registry.list === 'function' ? registry.list() : []),
  }
}
