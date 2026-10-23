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
 *   { t: 'ready',       servers }                        the session's usable tool servers (optional, once)
 *   { t: 'text',        delta }                          spoken text, in order
 *   { t: 'tool_start',  id, name }                       a tool call has begun; args not known yet (optional, early)
 *   { t: 'tool_call',   id, name, args }                 the model asked for a tool
 *   { t: 'tool_result', id, ok, summary, tainted,        what came back (ok: false = refused or failed);
 *                       detail? }                        detail is the bounded output, for the local journal only
 *   { t: 'usage',       inTokens, outTokens, costUsd? }  once per turn, before done
 *   { t: 'error',       code, retryable, message? }      why a turn failed
 *   { t: 'done',        reason }                         exactly one per turn, always last
 *
 * A turn always ends with exactly one `done`, even when it fails or is
 * cancelled, so whoever is listening never waits for ever.
 *
 * `ready` and `tool_start` are optional: a brain that cannot tell them simply
 * never sends them, and a listener must work without them. `tool_start` only
 * lets the HUD light the tool badge before the arguments have streamed; the
 * `tool_call` with the same id always follows.
 */

export const BRAIN_EVENT_TYPES = Object.freeze(['ready', 'text', 'tool_start', 'tool_call', 'tool_result', 'usage', 'error', 'done'])

/** Longest `tool_result.detail`, in characters. */
export const DETAIL_MAX = 2000
export const DONE_REASONS = Object.freeze(['complete', 'cancelled', 'limit', 'error'])

// Same rule as `Id` in shared/contracts.ts.
const ID = /^[^\s\u0000-\u001f]{1,128}$/

const isString = (v) => typeof v === 'string'
const isCount = (v) => Number.isInteger(v) && v >= 0
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Field checks per event type: name → [test, message]. */
const FIELDS = {
  ready: { servers: [(v) => Array.isArray(v) && v.every((x) => isString(x) && x.length > 0), 'must be a list of names'] },
  text: { delta: [isString, 'must be a string'] },
  tool_start: {
    id: [(v) => isString(v) && ID.test(v), 'invalid id'],
    name: [(v) => isString(v) && v.length > 0, 'must be a non-empty string'],
  },
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
  tool_result: { detail: [(v) => isString(v) && v.length <= DETAIL_MAX, `must be a string of at most ${DETAIL_MAX} characters`] },
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

/** The text of a tool's output, flattened. */
function flatten(content) {
  if (isString(content)) return content
  if (Array.isArray(content)) {
    return content.map((b) => (isString(b) ? b : b?.type === 'text' && isString(b.text) ? b.text : '')).join('\n')
  }
  return ''
}

/**
 * The bounded full text of a tool's output for `tool_result.detail`. Only the
 * bridge's own project journal reads it (journal.mjs: a write's size and hash,
 * a failure's reason); it never goes to the HUD or into traces.
 */
export function detailOf(content, max = DETAIL_MAX) {
  const text = flatten(content)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
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
