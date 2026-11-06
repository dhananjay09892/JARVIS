/**
 * Running a named agent: what a task with a definition is given.
 *
 * An agent is a background task (tasks.mjs) that carries an `agentId`. This
 * module turns the agent's checked definition (agent-definition.mjs, loaded by
 * agents.mjs) into the pieces a worker session is built from:
 *
 *   - its tools: the definition's `tools`, minus anything the worker rules,
 *     its memory scope, its connector grants or the policy engine rule out
 *     (agentToolPlan). The result can only be smaller than the definition's
 *     list, never larger;
 *   - a guard (agentGuard) that refuses any call outside that list and counts
 *     calls against the budget. It runs inside policy.authorize, after the
 *     policy gate, so the policy still decides every call first and a policy
 *     denial still denies a tool the definition allows;
 *   - the session's servers and the tool names the brain is not shown
 *     (narrowServers, hiddenTools), so a tool outside the list is not offered;
 *   - its brain and model (agentBrain), and its prompt (agentPrompt).
 *
 * Nothing here grants anything. A task without an agent id never comes here
 * and runs exactly as before.
 */
import { DELEGATE_SERVER, READ_ONLY_BUILTINS, WRITE_BUILTINS, mcpServerOf } from './policy.mjs'
import { parseConnectorTool, CONNECTOR_SERVER } from './connectors/registry.mjs'

/** The worker's own progress and question tools; every task gets them. */
export const RUNTIME_SERVER = 'jarvis_task'
export const RUNTIME_TOOLS = Object.freeze([`mcp__${RUNTIME_SERVER}__report_progress`, `mcp__${RUNTIME_SERVER}__ask_owner`])

/** Memory tools that only read. Every other memory tool writes. */
export const MEMORY_SERVER = 'jarvis_memory'
export const MEMORY_READ_TOOLS = Object.freeze(['list_memories', 'search_memory'])

const toolPart = (name) => {
  const m = /^mcp__[A-Za-z0-9_-]+?__(.+)$/.exec(name)
  return m ? m[1] : name
}
const serverIs = (...servers) => (name) => servers.includes(mcpServerOf(name))
const partMatches = (re) => (name) => re.test(toolPart(name).toLowerCase())

/**
 * What a worker agent may never do in this version, whatever its file lists.
 * Each rule is a test on the full tool name. A later task may let a
 * definition opt into one of these with the owner's approval; until then they
 * hold for every agent, the Coordinator included: it starts agents through
 * the delegation tools the runtime adds from its `delegate` list
 * (agent-delegation.mjs), never through its own tool list.
 */
export const WORKER_RULES = Object.freeze([
  {
    id: 'start-agents',
    text: 'workers cannot start other agents',
    // The Coordinator's delegation tools are never the file's to list: the
    // runtime adds them from its `delegate` list (agent-delegation.mjs).
    test: (n) => n === 'Task' || n === 'Agent' || serverIs('jarvis_tasks', DELEGATE_SERVER)(n),
  },
  {
    id: 'talk-to-user',
    text: 'workers do not talk to you directly; they ask through the task board',
    test: (n) => serverIs('jarvis', 'jarvis_ui', 'jarvis_eyes')(n) || partMatches(/(^|_)(speak|say|notify|display|blade)(_|$)/)(n),
  },
  {
    id: 'memory-write',
    text: 'workers never write shared memory',
    test: (n) => serverIs(MEMORY_SERVER)(n) && !MEMORY_READ_TOOLS.includes(toolPart(n)),
  },
  {
    id: 'send-publish',
    text: 'workers draft; they do not send, post or publish',
    test: partMatches(/(^|_)(send|post|publish|reply|forward|share|tweet|upload|push)(_|$)/),
  },
  {
    id: 'schedule',
    text: 'workers cannot schedule work',
    test: (n) => serverIs('jarvis_workflows')(n) || partMatches(/(^|_)(schedule|cron|remind|reminder|wakeup|trigger)(_|$)/)(n),
  },
  {
    id: 'secrets',
    text: 'workers cannot read secrets',
    test: (n) => serverIs('dpapi', 'secrets', 'keychain')(n) || partMatches(/(secret|password|passwd|credential|keychain|api_?key|token)/)(n),
  },
  {
    id: 'settings',
    text: 'workers cannot change settings',
    test: (n) => serverIs('jarvis_settings')(n) || partMatches(/(^|_)settings?(_|$)/)(n),
  },
])

/** The worker rule a tool breaks, or null. */
export function workerRuleFor(name) {
  return WORKER_RULES.find((r) => r.test(name)) ?? null
}

/**
 * Which of the definition's tools this run may use, and why the rest were
 * dropped. `decideTool(name)` is the policy engine's yes/no; a tool it denies
 * now is not offered (it would be refused anyway).
 *
 * @param {object} def a checked AgentDefinition
 * @param {{ decideTool?: (name: string) => boolean }} [o]
 * @returns {{ allowed: string[], dropped: { tool: string, reason: string }[] }}
 */
export function agentToolPlan(def, { decideTool = () => false } = {}) {
  const allowed = []
  const dropped = []
  const drop = (tool, reason) => dropped.push({ tool, reason })
  for (const tool of Array.isArray(def?.tools) ? def.tools : []) {
    if (typeof tool !== 'string' || !tool) continue
    if (RUNTIME_TOOLS.includes(tool)) continue // always there; not the file's to give
    const rule = workerRuleFor(tool)
    if (rule) { drop(tool, rule.id); continue }
    if (serverIs(MEMORY_SERVER)(tool) && def.memory === 'none') { drop(tool, 'memory-scope'); continue }
    if (serverIs(CONNECTOR_SERVER)(tool)) {
      const c = parseConnectorTool(tool)
      const access = c ? def.connectors?.[c.connectorId] : undefined
      if (!c || !access) { drop(tool, 'connector-not-granted'); continue }
      if (c.capability !== 'read' && access !== 'write') { drop(tool, 'connector-read-only'); continue }
    }
    let ok = false
    try { ok = decideTool(tool) === true } catch { ok = false }
    if (!ok) { drop(tool, 'policy'); continue }
    allowed.push(tool)
  }
  return { allowed: [...new Set(allowed)].sort(), dropped }
}

/** Words for a refusal the model reads. Never names anything but the tool. */
export const AGENT_REFUSALS = Object.freeze({
  notAllowed: 'Not run: this agent is not allowed that tool. Finish with the tools you have, or say what is missing.',
  budget: 'Not run: this agent has used its budget of tool calls, so the run is stopping.',
})

/**
 * The guard for an agent's session: refuse anything outside `allowed`, then
 * spend one tool call from the budget, then hand on to `next` (the taint
 * guard). Runs inside policy.authorize, after the policy gate, so it can only
 * add refusals.
 *
 * @param {object} o
 * @param {string[]} o.allowed the run's tools (RUNTIME_TOOLS are always allowed)
 * @param {{ toolCall?: (name: string) => string | null }} [o.budget] from the task manager
 * @param {(name: string, input: object) => Promise<string|null>|string|null} [o.next]
 */
export function agentGuard({ allowed, budget = null, next = null }) {
  const ok = new Set([...(allowed ?? []), ...RUNTIME_TOOLS])
  return async (name, input) => {
    if (!ok.has(name)) return AGENT_REFUSALS.notAllowed
    // Reporting progress is free; everything else counts.
    if (!RUNTIME_TOOLS.includes(name) && typeof budget?.toolCall === 'function') {
      const over = budget.toolCall(name)
      if (over) return over
    }
    return next ? next(name, input) : null
  }
}

/**
 * The session's servers, cut down to those the run has a tool on (plus the
 * worker's own progress server). A server none of the allowed tools names is
 * not started at all.
 */
export function narrowServers(servers, allowed) {
  const keep = new Set([RUNTIME_SERVER])
  for (const name of allowed ?? []) {
    const s = mcpServerOf(name)
    if (s) keep.add(s)
  }
  return Object.fromEntries(Object.entries(servers ?? {}).filter(([key]) => keep.has(key)))
}

/**
 * Tool names the brain must not be shown: every built-in and every known tool
 * of the kept servers that is not allowed. Tools of servers whose list the
 * bridge cannot read are not named here; the guard still refuses them.
 *
 * @param {string[]} allowed
 * @param {{ builtins?: Iterable<string>, known?: Iterable<string> }} [o]
 */
export function hiddenTools(allowed, { builtins = [...READ_ONLY_BUILTINS, ...WRITE_BUILTINS], known = [] } = {}) {
  const ok = new Set([...(allowed ?? []), ...RUNTIME_TOOLS])
  return [...new Set([...builtins, ...known])].filter((n) => !ok.has(n)).sort()
}

/**
 * A tool-loop brain's handlers and specs, cut down to the allowed tools, so
 * the tool bridge never offers the rest.
 */
export function narrowToolParams(params, allowed) {
  if (!params || typeof params !== 'object' || !params.tools) return params ?? {}
  const ok = new Set([...(allowed ?? []), ...RUNTIME_TOOLS])
  const pick = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => ok.has(k)))
  return { ...params, tools: pick(params.tools), ...(params.toolSpecs && { toolSpecs: pick(params.toolSpecs) }) }
}

/**
 * Which brain runs the agent. A registered brain the definition names; the
 * default brain when it names one that is not installed (with a note why).
 * External agents are not connected yet, so they do not run at all.
 *
 * @param {object} def
 * @param {{ has: (id: string) => boolean, get: (id: string) => object, default: () => object }} brains
 * @returns {{ ok: true, brain: object, note?: string } | { ok: false, reason: string }}
 */
export function agentBrain(def, brains) {
  const wanted = typeof def?.brain === 'string' ? def.brain : 'claude'
  if (wanted.startsWith('external:')) return { ok: false, reason: 'External agents are not connected yet.' }
  let has = false
  try { has = brains.has(wanted) } catch { has = false }
  if (has) return { ok: true, brain: brains.get(wanted) }
  const brain = brains.default()
  return { ok: true, brain, note: `brain ${wanted} is not installed; using ${brain.id}` }
}

/** The model to ask for: the definition's own, or `fallback()` for `default`. */
export function agentModel(def, fallback) {
  return typeof def?.model === 'string' && def.model !== 'default' ? def.model : fallback()
}

const MEMORY_LINES = {
  none: 'You have no access to the owner\'s memory.',
  read: 'You may read the owner\'s memory but never change it.',
  propose: 'You may read the owner\'s memory. If something should be remembered, say so in your summary as a proposal; never save it yourself.',
}

/**
 * The agent's system prompt: the worker's standing rules first (they always
 * apply), then who this agent is, its memory scope, and its own instructions.
 * The definition's text cannot remove the worker rules; it comes after them
 * and is framed as the agent's role.
 */
export function agentPrompt(def, workerPrompt) {
  return `${workerPrompt}

## Your role: ${def.name}
${def.description}

${MEMORY_LINES[def.memory] ?? MEMORY_LINES.none}
You cannot start other agents, message anyone, save to memory, schedule work,
read secrets or change settings. If the goal needs one of those, say so in your
summary instead.

## Your instructions
${def.body}`
}

/** Short words for a budget stop, for the board and the bus. */
export const BUDGET_STOPS = Object.freeze({
  toolCalls: (n) => `Stopped: it reached its budget of ${n} tool call${n === 1 ? '' : 's'} before finishing.`,
  minutes: (n) => `Stopped: it reached its time limit of ${n} minute${n === 1 ? '' : 's'} before finishing.`,
  cost: (usd) => `Stopped: it reached its cost limit of $${usd.toFixed(2)} before finishing.`,
})
