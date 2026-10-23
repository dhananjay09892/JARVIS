/**
 * Brain events (plan 21, phase 2).
 *
 * Every brain, whatever its vendor's stream looks like, hands the bridge the
 * same small set of events. They are the `BrainEvent` contract in
 * shared/contracts.ts (plan 38); this module is the bridge's copy of it, in
 * plain JavaScript so the bridge loads on Node 22.13 without a TypeScript step
 * and without zod. events.test.mjs runs both against the same samples so the
 * two can never drift apart.
 *
 *   { t: 'text',        delta }                          spoken text, in order
 *   { t: 'tool_call',   id, name, args }                 the model asked for a tool
 *   { t: 'tool_result', id, ok, summary, tainted }       what came back (ok: false = refused or failed)
 *   { t: 'usage',       inTokens, outTokens, costUsd? }  once per turn, before done
 *   { t: 'error',       code, retryable, message? }      why a turn failed
 *   { t: 'done',        reason }                         exactly one per turn, always last
 *
 * A turn always ends with exactly one `done`, even when it fails or is
 * cancelled, so whoever is listening never waits for ever.
 */

export const BRAIN_EVENT_TYPES = Object.freeze(['text', 'tool_call', 'tool_result', 'usage', 'error', 'done'])
export const DONE_REASONS = Object.freeze(['complete', 'cancelled', 'limit', 'error'])

// Same rule as `Id` in shared/contracts.ts.
const ID = /^[^\s\u0000-\u001f]{1,128}$/

const isString = (v) => typeof v === 'string'
const isCount = (v) => Number.isInteger(v) && v >= 0
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Field checks per event type: name → [test, message]. */
const FIELDS = {
  text: { delta: [isString, 'must be a string'] },
  tool_call: {
    id: [(v) => isString(v) && ID.test(v), 'invalid id'],
    name: [(v) => isString(v) && v.length > 0, 'must be a non-empty string'],
    args: [isRecord, 'must be an object'],
  },
  tool_result: {
    id: [(v) => isString(v) && ID.test(v), 'invalid id'],
    ok: [(v) => typeof v === 'boolean', 'must be a boolean'],
    summary: [isString, 'must be a string'],
    tainted: [(v) => typeof v === 'boolean', 'must be a boolean'],
  },
  usage: {
    inTokens: [isCount, 'must be a whole number ≥ 0'],
    outTokens: [isCount, 'must be a whole number ≥ 0'],
  },
  error: {
    code: [(v) => isString(v) && v.length > 0, 'must be a non-empty string'],
    retryable: [(v) => typeof v === 'boolean', 'must be a boolean'],
  },
  done: { reason: [(v) => DONE_REASONS.includes(v), `must be one of ${DONE_REASONS.join(', ')}`] },
}

/** Optional fields: present → must pass. */
const OPTIONAL = {
  usage: { costUsd: [(v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, 'must be a number ≥ 0'] },
  error: { message: [isString, 'must be a string'] },
}

/**
 * Check one event. Mirrors `checkContract('BrainEvent', e)`: errors are short
 * `path: message` strings that never echo the value, so they are safe to log.
 */
export function checkBrainEvent(e) {
  if (!isRecord(e)) return { ok: false, errors: ['(root): must be an object'] }
  if (!BRAIN_EVENT_TYPES.includes(e.t)) return { ok: false, errors: ['t: unknown event type'] }
  const errors = []
  for (const [field, [test, message]] of Object.entries(FIELDS[e.t])) {
    if (!test(e[field])) errors.push(`${field}: ${message}`)
  }
  for (const [field, [test, message]] of Object.entries(OPTIONAL[e.t] ?? {})) {
    if (e[field] !== undefined && !test(e[field])) errors.push(`${field}: ${message}`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: e }
}

/**
 * A one-line, bounded summary of a tool's output for `tool_result.summary`.
 * Only the first line is kept: the full output stays with the brain, and a
 * summary is what reaches traces and the HUD.
 */
export function summarise(content, max = 160) {
  let text = ''
  if (isString(content)) text = content
  else if (Array.isArray(content)) {
    text = content.map((b) => (isString(b) ? b : b?.type === 'text' && isString(b.text) ? b.text : '')).join(' ')
  }
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
