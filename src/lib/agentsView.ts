/**
 * Settings → Agents (agents phase A3): the types the bridge's agent routes
 * (bridge/agent-routes.mjs) send, and the pure helpers the screen uses:
 * paging, the "unused for 30 days" hint, text for numbers, and building an
 * edit. No imports, so it runs under `node --test`.
 */

export type AgentMode = 'on-demand' | 'scheduled' | 'triggered' | 'continuous'

export type AgentBudget = { maxToolCalls: number; maxMinutes: number; maxCostUsd: number }

export type AgentStats = {
  runs: number
  done: number
  failed: number
  cancelled: number
  active: number
  /** done ÷ (done + failed); null until a run has finished. */
  successRate: number | null
  minutes: number
  costUsd: number
  lastRunAt: number | null
}

/** One row of the roster (GET /agents). */
export type AgentCard = {
  id: string
  name: string
  description: string
  mode: AgentMode
  source: 'builtin' | 'user'
  readOnly: boolean
  createdBy: 'builtin' | 'user' | 'agent'
  active: boolean
  inactiveReason?: string
  inactiveDetail?: string
  icon: string | null
  switchedOn: boolean
  runsUnasked: boolean
  tools: number
  connectors: number
  review: boolean
  stats: AgentStats
}

export type AgentDefinition = {
  v?: number
  id: string
  name: string
  description: string
  icon?: string
  mode: AgentMode
  schedule: string | null
  trigger: string | null
  brain: string
  model: string
  tools: string[]
  connectors: Record<string, 'read' | 'write'>
  memory: 'none' | 'read' | 'propose'
  budget?: AgentBudget
  review: boolean
  delegate: string[]
  output: string
  createdBy: 'builtin' | 'user' | 'agent'
  requestedBy?: string
  body: string
}

export type AgentRun = {
  id: string
  title: string
  status: string
  createdAt: number | null
  startedAt: number | null
  endedAt: number | null
  minutes: number | null
  costUsd: number | null
  error?: string
}

export type AgentLimits = { maxConcurrent: number | null; maxDepth: number | null; paused: boolean | null }

export type RefusedFile = { source: 'builtin' | 'user'; file: string; reasons: string[] }

export type AgentsList = { ok: true; agents: AgentCard[]; refused: RefusedFile[]; limits: AgentLimits }

export type AgentDetail = {
  ok: true
  agent: AgentCard
  definition: AgentDefinition
  /** The definition as file text; it has a `review:` line only when the file set it. */
  file: string
  runs: AgentRun[]
}

/** What every change returns: ok, or a plain-language reason (and the checker's reasons). */
export type AgentReply = {
  ok: boolean
  reason?: string
  reasons?: string[]
  needsConfirm?: boolean
  id?: string
  switchedOn?: boolean
  deleted?: boolean
  agent?: AgentCard
}

/** Rows shown per page of the roster. */
export const PAGE_SIZE = 50
/** Days without a run before the "unused" hint shows. */
export const UNUSED_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** Most checker reasons shown under a refused change. */
export const MAX_REASONS = 8

const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/

/** The roster filtered by a search (name, id or description) and sorted by name. */
export function filterAgents(agents: AgentCard[], query: string): AgentCard[] {
  const q = query.trim().toLowerCase()
  const hit = (a: AgentCard) =>
    !q || a.name.toLowerCase().includes(q) || a.id.includes(q) || a.description.toLowerCase().includes(q)
  return agents.filter(hit).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** One page of a list; the page number is clamped to what exists. */
export function pageOf<T>(items: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const p = Math.min(Math.max(0, Math.floor(Number.isFinite(page) ? page : 0)), pages - 1)
  return { items: items.slice(p * size, p * size + size), page: p, pages }
}

/**
 * The "unused" hint for one agent: true when its last recorded run is more
 * than 30 days old. With no recorded run it says nothing, because the bridge
 * only keeps the most recent tasks and cannot tell "never" from "a while ago".
 */
export function isUnused(stats: Pick<AgentStats, 'lastRunAt'>, now = Date.now()): boolean {
  return typeof stats.lastRunAt === 'number' && now - stats.lastRunAt > UNUSED_DAYS * DAY_MS
}

export const MODE_LABEL: Record<AgentMode, string> = {
  'on-demand': 'when you ask',
  scheduled: 'on a schedule',
  triggered: 'when something happens',
  continuous: 'keeps running',
}

/** "how it runs" in words, with the schedule or event when there is one. */
export function modeText(def: Pick<AgentDefinition, 'mode' | 'schedule' | 'trigger'>): string {
  const label = MODE_LABEL[def.mode] ?? def.mode
  if (def.mode === 'scheduled' && def.schedule) return `${label} (${def.schedule})`
  if (def.mode === 'triggered' && def.trigger) return `${label} (${def.trigger})`
  return label
}

export function budgetText(budget: AgentBudget | undefined): string {
  if (!budget) return 'the default budget'
  const calls = `${budget.maxToolCalls} tool call${budget.maxToolCalls === 1 ? '' : 's'}`
  return `${calls}, ${budget.maxMinutes} min, $${budget.maxCostUsd.toFixed(2)}`
}

export function successText(stats: AgentStats): string {
  if (stats.successRate === null) return 'no finished runs'
  return `${Math.round(stats.successRate * 100)}% succeeded`
}

export function costText(usd: number | null | undefined): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return '$0'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export function connectorsText(connectors: Record<string, 'read' | 'write'>): string {
  const list = Object.entries(connectors).map(([id, access]) => `${id} (${access})`)
  return list.length ? list.join(', ') : 'none'
}

/** A copy id that is free: `<id>-copy`, `<id>-copy-2`, … kept within 40 characters. */
export function suggestCopyId(id: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = `${id.slice(0, 35)}-copy`
  if (!used.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const next = `${id.slice(0, 40 - `-copy-${n}`.length)}-copy-${n}`
    if (!used.has(next)) return next
  }
  return base
}

export const isAgentId = (id: string) => AGENT_ID.test(id)

/** The structured edits the detail view offers; anything else is edited as file text. */
export type AgentEdits = {
  name?: string
  description?: string
  /** 'default' follows the owner's reviewer setting; on/off is written into the file. */
  review?: 'default' | 'on' | 'off'
  /** null removes the agent's own budget so the default applies. */
  budget?: AgentBudget | null
}

/** Whether the agent's file says `review:` itself (otherwise the owner's default applies). */
export const reviewIsSet = (file: string) => /^review: (?:true|false)\s*$/m.test(file)

/** The review choice an agent's file stands for. */
export function reviewChoice(detail: Pick<AgentDetail, 'file' | 'definition'>): 'default' | 'on' | 'off' {
  if (!reviewIsSet(detail.file)) return 'default'
  return detail.definition.review ? 'on' : 'off'
}

/**
 * The definition to send for a structured edit: the agent as it is, with the
 * edits applied. `review` is only sent when the file sets it (or the edit
 * does), so an agent that follows the reviewer default keeps following it;
 * `budget: null` leaves the budget out. Never adds tools, connectors or
 * delegation: those fields are copied as they are.
 */
export function definitionPatch(detail: Pick<AgentDetail, 'file' | 'definition'>, edits: AgentEdits): Record<string, unknown> {
  const { review: _review, budget, v: _v, ...rest } = detail.definition
  const out: Record<string, unknown> = { ...rest }
  if (edits.name !== undefined) out.name = edits.name.trim()
  if (edits.description !== undefined) out.description = edits.description.trim()
  const choice = edits.review ?? reviewChoice(detail)
  if (choice === 'on') out.review = true
  else if (choice === 'off') out.review = false
  if (edits.budget === null) {
    // leave it out: the default budget applies
  } else if (edits.budget) out.budget = { ...edits.budget }
  else if (budget) out.budget = { ...budget }
  return out
}

/** A budget from three form fields, or a reason it cannot be used. */
export function readBudget(calls: string, minutes: string, cost: string): { budget: AgentBudget } | { error: string } {
  const c = Number(calls), m = Number(minutes), u = Number(cost)
  if (!Number.isInteger(c) || c < 1 || c > 1000) return { error: 'Tool calls must be a whole number from 1 to 1000.' }
  if (!Number.isFinite(m) || m <= 0 || m > 1440) return { error: 'Minutes must be more than 0 and at most 1440.' }
  if (cost.trim() === '' || !Number.isFinite(u) || u < 0 || u > 100) return { error: 'Cost must be from $0 to $100.' }
  return { budget: { maxToolCalls: c, maxMinutes: m, maxCostUsd: Math.round(u * 100) / 100 } }
}

/** A refused change in words: the reason and up to a few of the checker's reasons, clipped. */
export function replyText(r: AgentReply, fallback = 'That did not work.'): string {
  const head = (r.reason || fallback).slice(0, 200)
  const reasons = Array.isArray(r.reasons) ? r.reasons.filter((x) => typeof x === 'string').slice(0, MAX_REASONS) : []
  return reasons.length ? `${head} ${reasons.map((x) => x.slice(0, 160)).join('; ')}` : head
}
