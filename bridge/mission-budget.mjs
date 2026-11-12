/**
 * Mission budgets and guardrails (plan 13, phase 3).
 *
 * Every mission (a background task, plain or a named agent's) runs inside
 * limits the task manager enforces as hard stops:
 *
 *   - time (minutes), tool calls, tokens, and cost (cost only counts when the
 *     run is billed per use, as for agents);
 *   - a scope: which tools, which folders and which web domains it may touch.
 *
 * The limits come from the mission's own agent file, else from the defaults in
 * Settings → Agents (`JARVIS_MISSIONS_*`). Whatever they say, each one is cut
 * down to a fixed ceiling, and a limit nobody set is the ceiling: there is no
 * setting, file or tool argument that removes a hard stop. A mission may ask
 * for less than the default, never more.
 *
 * When a mission reaches a limit, the owner's "ask before spending more"
 * setting decides: `ask` turns it into an approval card (at most twice per
 * mission, and never past the ceiling); `stop`, a "no", or no answer ends the
 * mission at once. Every stop writes an audit entry (rule `mission-*`).
 *
 * The scope is checked by `scopeGuard`, which runs inside policy.authorize,
 * after the policy gate and before the taint check, like agentGuard. It only
 * narrows: the policy engine still decides every call first.
 *
 * Pure functions only; tasks.mjs does the counting and the stopping.
 */
import { isAbsolute, resolve, sep } from 'node:path'
import { RUNTIME_TOOLS } from './agent-runtime.mjs'
import { parseBudget } from './agent-settings.mjs'

/** The most any mission may be given of each limit. Nothing raises these. */
export const MISSION_CEILINGS = Object.freeze({ maxToolCalls: 1000, maxMinutes: 1440, maxCostUsd: 100, maxTokens: 5_000_000 })
/** What a plain mission gets when the settings say nothing usable. */
export const MISSION_DEFAULTS = Object.freeze({ maxToolCalls: 40, maxMinutes: 30, maxCostUsd: 2, maxTokens: 500_000 })
/** How many times the owner may be asked for more, per mission. */
export const MAX_EXTENSIONS = 2

/** The settings this module reads. */
export const MISSION_SETTINGS = Object.freeze({
  budget: 'JARVIS_MISSIONS_BUDGET',
  tokens: 'JARVIS_MISSIONS_TOKENS',
  overspend: 'JARVIS_MISSIONS_OVERSPEND',
})

const FIELDS = ['maxToolCalls', 'maxMinutes', 'maxCostUsd', 'maxTokens']
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * Limits cut to the ceilings. A field that is missing or nonsense becomes the
 * ceiling, so the result always bounds every dimension.
 */
export function withCeilings(limits) {
  const out = {}
  for (const f of FIELDS) {
    const v = limits?.[f]
    out[f] = isNum(v) ? Math.min(v, MISSION_CEILINGS[f]) : MISSION_CEILINGS[f]
  }
  return out
}

/**
 * A mission's limits: the smaller of what it was given and what it asked for.
 * `given` is its agent's budget or the settings default; `asked` is optional
 * and can only lower a field.
 */
export function missionLimits(given, asked = null) {
  const base = withCeilings({ ...MISSION_DEFAULTS, ...given })
  if (!asked) return base
  for (const f of FIELDS) if (isNum(asked[f]) && (f !== 'maxCostUsd' ? asked[f] > 0 : true)) base[f] = Math.min(base[f], asked[f])
  return base
}

/** The names of the limits, for words and audit rules. */
export const LIMIT_KINDS = Object.freeze({ maxToolCalls: 'calls', maxMinutes: 'minutes', maxCostUsd: 'cost', maxTokens: 'tokens' })

/** What one more allowance adds to a limit: half of what the mission started with, at least one unit. */
const step = (start) => Math.max(start <= 1 ? 1 : 0, Math.ceil(start / 2))

/**
 * The limits after the owner agreed to spend more on one of them. Null when
 * the limit already sits at its ceiling or the extensions are used up.
 */
export function extendLimit(limits, start, field, extensions) {
  if (!FIELDS.includes(field) || extensions >= MAX_EXTENSIONS) return null
  const ceiling = MISSION_CEILINGS[field]
  if (limits[field] >= ceiling) return null
  const add = field === 'maxCostUsd' ? Math.max(0.5, Math.round(start[field] * 50) / 100) : step(start[field])
  return { ...limits, [field]: Math.min(ceiling, limits[field] + add) }
}

/** The card text for one limit, and the stop text, in words for the owner. */
export const LIMIT_WORDS = Object.freeze({
  maxToolCalls: (n) => `${n} tool call${n === 1 ? '' : 's'}`,
  maxMinutes: (n) => `${n} minute${n === 1 ? '' : 's'}`,
  maxCostUsd: (n) => `$${n.toFixed(2)}`,
  maxTokens: (n) => `${n.toLocaleString('en-US')} tokens`,
})

export const askMoreTitle = (field, limit) => `reached its limit of ${LIMIT_WORDS[field](limit)}. Allow more?`

/** The default limits for plain missions, and the owner's overspend choice, from Settings. */
export function createMissionSettings({ read }) {
  const get = (id) => {
    try {
      const v = read(id)
      return typeof v === 'string' ? v : undefined
    } catch {
      return undefined
    }
  }
  return {
    /** Never null: an unreadable or out-of-range setting falls back to the built-in default. */
    defaultLimits() {
      const b = parseBudget(get(MISSION_SETTINGS.budget))
      const raw = get(MISSION_SETTINGS.tokens)
      const tokens = typeof raw === 'string' && /^\d{4,7}$/.test(raw.trim()) ? Number(raw.trim()) : NaN
      return missionLimits({
        ...(b ?? {}),
        maxTokens: Number.isInteger(tokens) && tokens >= 1000 && tokens <= MISSION_CEILINGS.maxTokens ? tokens : MISSION_DEFAULTS.maxTokens,
      })
    },
    /** 'ask' unless the owner chose 'stop'. */
    overspend: () => (get(MISSION_SETTINGS.overspend) === 'stop' ? 'stop' : 'ask'),
  }
}

// ---- scope ----------------------------------------------------------------

const MAX_ITEMS = 20
const MAX_ITEM_LENGTH = 300
const clean = (list, ok) => (Array.isArray(list)
  ? [...new Set(list.filter((s) => typeof s === 'string').map((s) => s.trim()).filter((s) => s && s.length <= MAX_ITEM_LENGTH && ok(s)))].slice(0, MAX_ITEMS)
  : [])

const hostOf = (s) => {
  const t = s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0]
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t) ? t : ''
}

/**
 * A scope from what a mission asked for: tool names, absolute folders, and
 * domains. Anything malformed is dropped; a list that ends up empty means "no
 * limit of that kind", the same as leaving it out. Returns null when nothing
 * narrows the mission.
 */
export function normaliseScope(raw) {
  if (!raw || typeof raw !== 'object') return null
  const allowedTools = clean(raw.allowedTools, (s) => /^[\w.:*-]{1,200}$/.test(s))
  const allowedPaths = clean(raw.allowedPaths, (s) => isAbsolute(s)).map((p) => resolve(p))
  const allowedDomains = clean(raw.allowedDomains, (s) => hostOf(s) !== '').map(hostOf)
  if (!allowedTools.length && !allowedPaths.length && !allowedDomains.length) return null
  return { allowedTools, allowedPaths, allowedDomains }
}

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
/** Is this path inside one of the folders? `..` is resolved first, so it cannot climb out. */
export function pathAllowed(p, folders) {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) return false
  const target = norm(resolve(p))
  return folders.some((f) => {
    const root = norm(f)
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  })
}
/** Is this host one of the domains, or a subdomain of one? */
export const domainAllowed = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`))

const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path', 'cwd', 'directory', 'dir', 'folder', 'source', 'destination', 'from', 'to'])
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell'])

/** Every string in a tool's input, to a bounded depth. */
function* strings(v, depth = 0, key = '') {
  if (typeof v === 'string') yield [key, v]
  else if (depth < 4 && Array.isArray(v)) for (const x of v.slice(0, 50)) yield* strings(x, depth + 1, key)
  else if (depth < 4 && v && typeof v === 'object') for (const [k, x] of Object.entries(v).slice(0, 50)) yield* strings(x, depth + 1, k)
}

export const SCOPE_REFUSALS = Object.freeze({
  tool: 'That tool is outside what this mission may use.',
  path: 'That path is outside the folders this mission may use.',
  domain: 'That address is outside the websites this mission may use.',
  shell: 'This mission is limited to certain folders or sites, and a shell command cannot be held to them.',
})

/**
 * Why a call is outside the scope, or null. `kind` names the rule for the audit.
 *
 * A shell tool is refused whenever the scope names folders or domains, because
 * a command line cannot be checked against them; a mission that needs a shell
 * lists it in `allowedTools` and gets no path or domain narrowing from it.
 */
export function scopeRefusal(scope, name, input) {
  if (!scope || RUNTIME_TOOLS.includes(name)) return null
  const { allowedTools, allowedPaths, allowedDomains } = scope
  if (allowedTools.length && !allowedTools.includes(name)) return { kind: 'tool', reason: SCOPE_REFUSALS.tool }
  if ((allowedPaths.length || allowedDomains.length) && SHELL_TOOLS.has(name)) return { kind: 'shell', reason: SCOPE_REFUSALS.shell }
  for (const [key, value] of strings(input)) {
    if (allowedPaths.length && PATH_KEYS.has(key) && isAbsolute(value) && !pathAllowed(value, allowedPaths)) return { kind: 'path', reason: SCOPE_REFUSALS.path }
    if (allowedPaths.length && PATH_KEYS.has(key) && !isAbsolute(value) && /(^|[\\/])\.\.([\\/]|$)/.test(value)) return { kind: 'path', reason: SCOPE_REFUSALS.path }
    if (allowedDomains.length) {
      const urls = key === 'url' || key === 'uri' ? [value] : value.match(URL_RE) ?? []
      for (const u of urls) {
        let host = ''
        try { host = new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase() } catch { host = '' }
        if (!host || !domainAllowed(host, allowedDomains)) return { kind: 'domain', reason: SCOPE_REFUSALS.domain }
      }
    }
  }
  return null
}

/**
 * A guard (the shape policy.authorize takes) that refuses calls outside the
 * scope, then hands on to `next`. `onDeny` hears each refusal, for the audit.
 *
 * @param {object | null} scope from normaliseScope
 * @param {(name: string, input: object) => Promise<string|null>|string|null} [next]
 * @param {(refusal: { kind: string, reason: string, tool: string }) => void} [onDeny]
 */
export function scopeGuard(scope, next = null, onDeny = null) {
  return async (name, input) => {
    const why = scopeRefusal(scope, name, input)
    if (why) {
      try { onDeny?.({ ...why, tool: name }) } catch { /* the audit must not change the answer */ }
      return why.reason
    }
    return next ? next(name, input) : null
  }
}

/**
 * The whole guard for a plain mission, which has no allow-list of its own:
 * the budget counts each call (and may ask to spend more), then the scope,
 * then `next`. Progress reports are free.
 */
export function missionGuard({ budget = null, scope = null, next = null, onDeny = null }) {
  const inner = scopeGuard(scope, next, onDeny)
  return async (name, input) => {
    if (!RUNTIME_TOOLS.includes(name) && typeof budget?.toolCall === 'function') {
      const over = await budget.toolCall(name)
      if (over) return over
    }
    return inner(name, input)
  }
}
