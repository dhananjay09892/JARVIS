/**
 * Delegation: the Coordinator handing part of its work to another agent.
 *
 * Only one agent may start agents from inside its own run: the Coordinator
 * (agent-definition.mjs COORDINATOR_ID), and only the agents on its file's
 * `delegate` list. The rules, all enforced by the task manager (tasks.mjs)
 * whatever the session asks for:
 *
 *   - depth: a task the owner, a schedule or an event starts is level 1; an
 *     agent it starts is level 2. `agents.maxDepth` (1–2, default 1) is how
 *     deep that may go, and DEPTH_CEILING (2) holds whatever the setting
 *     says. At the default nothing delegates: agents work alone;
 *   - an allow-list: the Coordinator's `delegate` entries, by id or name,
 *     and nothing else;
 *   - a children cap: one run may start at most MAX_CHILDREN agents in all;
 *   - a budget share: a child runs within what its parent has left (the
 *     smaller of its own budget and the parent's remaining tool calls,
 *     minutes and cost), its tool calls are charged to the parent as they
 *     happen, and its cost when it ends;
 *   - a child ends when its parent ends.
 *
 * The session is offered the delegation tools (task-tools.mjs
 * delegateServer) only when all of that could allow a start; the policy
 * engine (policy.mjs) refuses those tools to every session but the
 * Coordinator's; and the worker rules (agent-runtime.mjs) drop them from any
 * file that lists them, so a definition can never grant them through
 * `tools`.
 */
import { DELEGATE_SERVER, DELEGATE_TOOL_NAMES, DELEGATOR_ID } from './policy.mjs'

/** The hard ceiling on depth, whatever the setting says (agent-triggers.mjs uses the same). */
export const DEPTH_CEILING = 2
/** How many agents one run may start in all. */
export const MAX_CHILDREN = 5
/** The longest a delegating session may wait on one child in one call. */
export const MAX_WAIT_MS = 120_000

/** The delegation tools' server and full names (the policy engine owns the list). */
export { DELEGATE_SERVER, DELEGATE_TOOL_NAMES, DELEGATOR_ID }
export const DELEGATE_TOOLS = Object.freeze(DELEGATE_TOOL_NAMES.map((n) => `mcp__${DELEGATE_SERVER}__${n}`))

/** The depth limit now: the setting clamped to 1…DEPTH_CEILING; nonsense or a throw is 1. */
export function depthLimit(maxDepth) {
  let n
  try { n = typeof maxDepth === 'function' ? maxDepth() : maxDepth } catch { n = 1 }
  return Number.isInteger(n) && n >= 1 ? Math.min(n, DEPTH_CEILING) : 1
}

/** Words for a refused delegation; the model reads them and may say them. */
export const DELEGATION_REFUSALS = Object.freeze({
  notDelegator: 'Only the Coordinator may start other agents.',
  noList: 'The Coordinator has no agents it may start.',
  depthOff: 'Agents work alone at the moment: delegation is off. The owner can allow it in Settings, under Agents.',
  depth: (n) => `Delegation stops at ${n} level${n === 1 ? '' : 's'}, so this run cannot start another agent.`,
  offList: (names) => `That agent is not on the list this run may start${names.length ? `: ${names.join(', ')}` : ''}.`,
  children: (n) => `This run has already started ${n} agent${n === 1 ? '' : 's'}, the most it may.`,
  ended: 'This run has ended.',
  cap: 'Delegation needs room for at least two agents at once; the owner can raise it in Settings, under Agents.',
  noBudget: 'There is no budget left to share with another agent.',
  noGoal: 'Say what the agent should do.',
  notChild: 'That is not an agent this run started.',
})

/** Words for a child stopped because its parent's share ran out. */
export const DELEGATION_STOPS = Object.freeze({
  parentBudget: 'Stopped: the agent that started it has no budget left to share.',
  parentEnded: 'Cancelled: the agent that started it has ended.',
})

/**
 * Whether a run of `def` at `depth` may start agents at all, before any
 * particular request. The task manager checks this again on every start.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function mayDelegate(def, { depth = 1, maxDepth = 1 } = {}) {
  if (def?.id !== DELEGATOR_ID) return { ok: false, reason: DELEGATION_REFUSALS.notDelegator }
  if (!Array.isArray(def.delegate) || def.delegate.length === 0) return { ok: false, reason: DELEGATION_REFUSALS.noList }
  const limit = depthLimit(maxDepth)
  const level = Number.isInteger(depth) && depth >= 1 ? depth : 1
  if (level + 1 > limit) return { ok: false, reason: limit === 1 ? DELEGATION_REFUSALS.depthOff : DELEGATION_REFUSALS.depth(limit) }
  return { ok: true }
}

const num = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * What a parent has left of its budget now, or null when it runs without one.
 *
 * @param {object | null} limits the parent's budget
 * @param {{ calls?: number, startedAt?: number | null, costUsd?: number | null, childCostUsd?: number }} spent
 * @param {number} now
 */
export function remainingBudget(limits, { calls = 0, startedAt = null, costUsd = null, childCostUsd = 0 } = {}, now = Date.now()) {
  if (!limits || typeof limits !== 'object') return null
  const left = {}
  if (Number.isInteger(limits.maxToolCalls)) left.maxToolCalls = Math.max(0, limits.maxToolCalls - (Number.isInteger(calls) ? calls : 0))
  if (num(limits.maxMinutes)) {
    const used = num(startedAt) ? Math.max(0, now - startedAt) / 60_000 : 0
    left.maxMinutes = Math.max(0, limits.maxMinutes - used)
  }
  if (num(limits.maxCostUsd)) left.maxCostUsd = Math.max(0, limits.maxCostUsd - (num(costUsd) ? costUsd : 0) - (num(childCostUsd) ? childCostUsd : 0))
  return Object.keys(left).length ? left : null
}

/** Is anything in this remainder used up? */
export const budgetSpent = (left) => Boolean(left) && Object.values(left).some((v) => v <= 0)

/**
 * A child's budget: for each limit, the smaller of its own and what its
 * parent has left. A limit only one side sets is kept. Never larger than
 * either side.
 */
export function shareBudget(own, left) {
  const out = {}
  for (const key of ['maxToolCalls', 'maxMinutes', 'maxCostUsd']) {
    const a = own && num(own[key]) ? own[key] : undefined
    const b = left && num(left[key]) ? left[key] : undefined
    const v = a === undefined ? b : b === undefined ? a : Math.min(a, b)
    if (v !== undefined) out[key] = key === 'maxToolCalls' ? Math.floor(v) : v
  }
  return Object.keys(out).length ? out : null
}
