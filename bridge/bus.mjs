/**
 * Event bus (plan 12, building block 1; task Q32).
 *
 * Sources inside the bridge publish typed events; listeners (the notification
 * policy engine of Q33, briefings, event-triggered workflows) subscribe by
 * topic. Every event is the `BusEvent` envelope from shared/contracts.ts
 * (plan 38):
 *
 *   { v: 1, id, ts, topic, traceId?, payload }
 *
 * This module is the bridge's copy of that contract, in plain JavaScript so
 * the bridge loads on Node 22.13 without a TypeScript step and without zod.
 * bus.test.mjs runs both against the same samples so they cannot drift.
 *
 * Rules:
 * - Only topics with a payload check here can be published. Adding a
 *   publisher means adding its check and a parity sample in the test; the
 *   bus never carries an unchecked payload.
 * - A rejected event is counted and logged by topic and field only, never by
 *   value (payloads can hold private text).
 * - Delivery is asynchronous: `publish` returns before any listener runs, so
 *   a slow or failing listener never holds up or breaks the publisher (a task
 *   finishing, a scheduled run). A listener that throws is counted and the
 *   others still get the event.
 * - Listeners get a frozen copy, so one cannot change what another sees.
 * - The bus is in memory and in process. Nothing is stored or sent anywhere;
 *   `stats()` (served at GET /bus/stats) holds counts only.
 * - The bus grants nothing. An event is information; whatever a listener does
 *   with it still goes through the policy engine like any other action.
 */
import { randomUUID } from 'node:crypto'

// Same list as TOPICS in shared/contracts.ts (bus.test.mjs checks they match).
export const TOPICS = Object.freeze([
  'utterance.received',
  'turn.started', 'turn.finished',
  'tool.requested', 'tool.allowed', 'tool.denied',
  'approval.requested', 'approval.resolved',
  'notification.created', 'notification.delivered', 'notification.suppressed',
  'device.event',
  'presence.changed',
  'mission.progress', 'mission.finished',
  'health.check',
  'budget.warning', 'budget.exceeded',
  'freeze.on', 'freeze.off',
  'workflow.started', 'workflow.finished',
  'task.finished',
])

const VERSION = 1
// Same rules as `Id`, `Ts` and `TraceId` in shared/contracts.ts.
const ID = /^[^\s\u0000-\u001f]{1,128}$/
const TRACE_ID = /^[0-9a-f]{16}$/
const isId = (v) => typeof v === 'string' && ID.test(v)
const isTs = (v) => Number.isInteger(v) && v >= 0
const isCount = isTs
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (max, min = 0) => (v) => typeof v === 'string' && v.length >= min && v.length <= max
const oneOf = (...values) => (v) => values.includes(v)
const SENSITIVITY = ['public', 'private', 'vault']

/** `WorkflowRun` in shared/contracts.ts. */
const WORKFLOW_RUN = {
  fields: {
    runId: [isId, 'invalid id'],
    workflowId: [isId, 'invalid id'],
    name: [isText(60, 1), 'must be 1–60 characters'],
    trigger: [oneOf('manual', 'schedule'), 'must be manual or schedule'],
    status: [oneOf('running', 'completed', 'failed'), 'must be running, completed or failed'],
    stepsTotal: [isCount, 'must be a whole number ≥ 0'],
    stepsCompleted: [isCount, 'must be a whole number ≥ 0'],
    startedAt: [isTs, 'must be a timestamp'],
  },
  optional: { finishedAt: [isTs, 'must be a timestamp'] },
  rules: [
    [(p) => p.stepsCompleted <= p.stepsTotal, 'stepsCompleted', 'more steps completed than exist'],
    [(p) => (p.status === 'running') === (p.finishedAt === undefined), 'finishedAt', 'finishedAt is set exactly when the run has ended'],
  ],
}

/** `TaskOutcome` in shared/contracts.ts. */
const TASK_OUTCOME = {
  fields: {
    taskId: [isId, 'invalid id'],
    title: [isText(60, 1), 'must be 1–60 characters'],
    status: [oneOf('done', 'failed', 'cancelled', 'interrupted'), 'must be done, failed, cancelled or interrupted'],
    summary: [isText(300), 'must be a string of at most 300 characters'],
    endedAt: [isTs, 'must be a timestamp'],
    sensitivity: [oneOf(...SENSITIVITY), `must be one of ${SENSITIVITY.join(', ')}`],
  },
  optional: {
    costUsd: [(v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, 'must be a number ≥ 0'],
    startedAt: [isTs, 'must be a timestamp'],
  },
  rules: [],
}

const URGENCY = ['info', 'normal', 'important', 'urgent']
const isAction = (a) => isRecord(a) && isId(a.id) && isText(Infinity, 1)(a.label)

/**
 * `Notification` in shared/contracts.ts (plan 12, Q33): a candidate alert.
 * It carries its own envelope (`v`, `id`, `ts`) inside the bus envelope.
 */
const NOTIFICATION = {
  fields: {
    v: [(v) => v === VERSION, `must be ${VERSION}`],
    id: [isId, 'invalid id'],
    ts: [isTs, 'must be a timestamp'],
    source: [isText(Infinity, 1), 'must be a non-empty string'],
    urgency: [oneOf(...URGENCY), `must be one of ${URGENCY.join(', ')}`],
    audience: [(v) => Array.isArray(v) && v.length >= 1 && v.every(isText(Infinity, 1)), 'must be a non-empty list of names'],
    privacy: [oneOf('public', 'private'), 'must be public or private'],
    title: [isText(Infinity, 1), 'must be a non-empty string'],
    body: [isText(Infinity), 'must be a string'],
  },
  optional: {
    traceId: [(v) => typeof v === 'string' && TRACE_ID.test(v), 'must be 16 hex characters'],
    actions: [(v) => Array.isArray(v) && v.every(isAction), 'must be a list of { id, label }'],
    expiresAt: [isTs, 'must be a timestamp'],
  },
  rules: [],
  // Nested objects are stripped too, as zod does.
  clean: { actions: (list) => list.map(({ id, label }) => ({ id, label })) },
}

/** Payload checks for the topics the bridge publishes today. */
const PAYLOADS = {
  'workflow.started': WORKFLOW_RUN,
  'workflow.finished': WORKFLOW_RUN,
  'task.finished': TASK_OUTCOME,
  'notification.created': NOTIFICATION,
  'notification.delivered': NOTIFICATION,
  'notification.suppressed': NOTIFICATION,
}
export const PUBLISHABLE = Object.freeze(Object.keys(PAYLOADS))

/**
 * Checks an event against the envelope and its topic's payload. Returns
 * `{ ok: true }` or `{ ok: false, error }`; the error names the field, never
 * the value, so it is safe to log. Unknown fields are allowed (and dropped by
 * `publish`), matching the contract's "strip, don't reject" rule.
 */
export function checkBusEvent(e) {
  if (!isRecord(e)) return { ok: false, error: '(root): must be an object' }
  if (e.v !== VERSION) return { ok: false, error: `v: must be ${VERSION}` }
  if (!isId(e.id)) return { ok: false, error: 'id: invalid id' }
  if (!isTs(e.ts)) return { ok: false, error: 'ts: must be a timestamp' }
  if (!TOPICS.includes(e.topic)) return { ok: false, error: 'topic: unknown topic' }
  if (e.traceId !== undefined && !(typeof e.traceId === 'string' && TRACE_ID.test(e.traceId))) {
    return { ok: false, error: 'traceId: must be 16 hex characters' }
  }
  const spec = PAYLOADS[e.topic]
  if (!spec) return { ok: false, error: 'topic: no payload check in the bridge yet' }
  const p = e.payload
  if (!isRecord(p)) return { ok: false, error: 'payload: must be an object' }
  for (const [key, [test, message]] of Object.entries(spec.fields)) {
    if (!test(p[key])) return { ok: false, error: `payload.${key}: ${message}` }
  }
  for (const [key, [test, message]] of Object.entries(spec.optional)) {
    if (p[key] !== undefined && !test(p[key])) return { ok: false, error: `payload.${key}: ${message}` }
  }
  for (const [rule, key, message] of spec.rules) {
    if (!rule(p)) return { ok: false, error: `payload.${key}: ${message}` }
  }
  return { ok: true }
}

/** Only the fields the contract knows, so nothing extra rides along to listeners. */
function strip(topic, payload) {
  const spec = PAYLOADS[topic]
  const out = {}
  for (const key of [...Object.keys(spec.fields), ...Object.keys(spec.optional)]) {
    if (payload[key] !== undefined) out[key] = spec.clean?.[key] ? spec.clean[key](payload[key]) : payload[key]
  }
  return out
}

/**
 * Checks a bare `Notification` (not wrapped in a bus event), with the same
 * rules the bus applies. Returns `{ ok: true }` or `{ ok: false, error }`
 * naming the field only.
 */
export function checkNotification(n) {
  const r = checkBusEvent({ v: VERSION, id: 'check', ts: 0, topic: 'notification.created', payload: n })
  if (r.ok) return r
  return { ok: false, error: r.error.startsWith('payload.') ? r.error.slice('payload.'.length) : '(root): must be an object' }
}

/**
 * A topic pattern: an exact topic, a prefix ending in `.*` that some topic
 * has (`task.*`), or `*` for everything. Anything else is a typo and throws,
 * rather than silently never matching.
 */
function matcher(pattern) {
  if (pattern === '*') return () => true
  if (typeof pattern === 'string' && pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1)
    if (TOPICS.some((t) => t.startsWith(prefix))) return (topic) => topic.startsWith(prefix)
  } else if (TOPICS.includes(pattern)) {
    return (topic) => topic === pattern
  }
  throw new Error(`Unknown bus topic pattern: ${String(pattern).slice(0, 60)}`)
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x)
    Object.freeze(v)
  }
  return v
}

export function createBus({ now = () => Date.now(), newId = () => `ev-${randomUUID()}`, log = console } = {}) {
  const since = new Date(now()).toISOString()
  const listeners = new Set()
  const published = {}
  let rejected = 0
  let listenerErrors = 0

  const failed = (topic, err) => {
    listenerErrors += 1
    log.error?.(`[jarvis] bus listener for ${topic} failed:`, err?.message ?? String(err))
  }

  function deliver(event) {
    for (const l of [...listeners]) {
      if (!listeners.has(l) || !l.match(event.topic)) continue
      try {
        const r = l.handler(event)
        if (r && typeof r.then === 'function') r.then(undefined, (err) => failed(event.topic, err))
      } catch (err) {
        failed(event.topic, err)
      }
    }
  }

  return {
    /**
     * Publishes one event. Returns `{ ok: true, event }` with the envelope as
     * listeners will see it, or `{ ok: false, error }` when it fails its
     * check (then nobody hears it). Never throws.
     */
    publish(topic, payload, { traceId } = {}) {
      const event = { v: VERSION, id: newId(), ts: now(), topic, ...(traceId !== undefined && { traceId }), payload }
      const check = checkBusEvent(event)
      if (!check.ok) {
        rejected += 1
        log.error?.(`[jarvis] bus rejected a ${TOPICS.includes(topic) ? topic : 'unknown-topic'} event: ${check.error}`)
        return { ok: false, error: check.error }
      }
      event.payload = strip(topic, payload)
      const frozen = deepFreeze(structuredClone(event))
      published[topic] = (published[topic] ?? 0) + 1
      queueMicrotask(() => deliver(frozen))
      return { ok: true, event: frozen }
    },
    /**
     * Calls `handler(event)` for every later event whose topic matches
     * `pattern` (see `matcher`). Returns a function that unsubscribes.
     */
    subscribe(pattern, handler) {
      if (typeof handler !== 'function') throw new TypeError('A bus listener must be a function.')
      const l = { match: matcher(pattern), handler }
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    /** Counts since the bridge started, for Diagnostics (plan 16). Never payloads. */
    stats() {
      return { since, published: { ...published }, rejected, listenerErrors, listeners: listeners.size }
    },
  }
}
