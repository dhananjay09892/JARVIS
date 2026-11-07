/**
 * Asking a named agent for something, from the voice session.
 *
 * The voice session (the Coordinator) is the only place that can start an
 * agent: its task tools (task-tools.mjs) gain `start_agent` and `list_agents`,
 * built on the operations here. A worker never gets those tools: the voice
 * session's jarvis_tasks server is not handed to workers, and the worker rules
 * (agent-runtime.mjs) drop every jarvis_tasks tool from a definition anyway.
 *
 * Two ways in:
 *
 *   - the model names the agent and writes the goal (`agent` + `goal`);
 *   - the model passes the owner's own words (`request`), e.g. "ask the
 *     researcher to compare three desks", and `parseAgentRequest` splits
 *     them into the agent and the goal with plain rules and no model call.
 *     Words that name no agent ("compare three standing desks") go to the
 *     one agent that clearly fits them (agent-match.mjs), or to none: a
 *     close call is answered with the candidates, and nothing is queued.
 *
 * Names are matched loosely ("the researcher", "Researcher agent", "inbox
 * triager" for `inbox-triager`) but only ever to an agent in the roster.
 * An unknown, switched-off or unapproved agent gets an answer that can be
 * spoken as it is, and nothing is queued.
 *
 * Starting an agent grants nothing: the task manager re-checks the agent,
 * and what it may do is still its definition, narrowed by the runtime and
 * decided call by call by policy.mjs. Only Node built-ins are used here, so
 * this can be tested on its own.
 */
import { matchAgent } from './agent-match.mjs'

const MAX_LISTED = 50
const MAX_QUERY = 60
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

/** Lowercase words only: what two spellings of a name have in common. */
export function nameKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/['’]s$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|my|your|our)\s+/, '')
    .replace(/\s+agent$/, '')
    .trim()
}

/** Safe to say aloud and to log: letters, digits and spaces, clipped. */
const spoken = (text) => clip(String(text ?? '').replace(/[^\p{L}\p{N} '-]+/gu, ' ').replace(/\s+/g, ' '), 40)

/** Every key an agent answers to: its id, its id with spaces, its name. */
function keysOf(a) {
  return [...new Set([nameKey(a.id), nameKey(String(a.id).replace(/-/g, ' ')), nameKey(a.name)])].filter(Boolean)
}

/**
 * The roster as the voice session sees it.
 *
 * @param {{ list?: Function, isActive: Function }} agents the switched registry
 *   (agent-settings.mjs switchedRegistry): `list()` gives every loaded agent,
 *   `isActive(id)` says whether it may run now.
 * @returns {{ id: string, name: string, description: string, mode: string, on: boolean, why?: string }[]}
 */
export function roster(agents) {
  let list = []
  try { list = typeof agents?.list === 'function' ? agents.list() : [] } catch { list = [] }
  if (!Array.isArray(list)) return []
  return list
    .filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
    .map((a) => {
      let on = false
      try { on = agents.isActive(a.id) === true } catch { on = false }
      const why = on ? undefined : a.active === false ? 'waiting for your approval' : 'switched off'
      return { id: a.id, name: a.name, description: clip(a.description, 200), mode: a.mode, on, ...(why && { why }) }
    })
}

/**
 * The roster entry a name refers to, or null. An exact id wins; then a
 * whole-name match on the loose key.
 */
export function resolveAgent(entries, query) {
  if (typeof query !== 'string' || !query.trim()) return null
  const q = query.trim().slice(0, MAX_QUERY)
  const exact = entries.find((a) => a.id === q)
  if (exact) return exact
  const key = nameKey(q)
  if (!key) return null
  return entries.find((a) => keysOf(a).includes(key)) ?? null
}

const ASK_VERB = /^\s*(?:(?:please|jarvis|ok|okay|hey)[\s,]+)*(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(ask|get|have|tell|let)\s+(.+)$/i

/**
 * Split the owner's words into an agent and a goal, or null when they are
 * not a request to a named agent.
 *
 *   "ask the researcher to compare three desks"   → researcher, "compare three desks"
 *   "get the writer to draft a thank-you note"    → writer, "draft a thank-you note"
 *   "have the inbox triager sort today's mail"    → inbox-triager, "sort today's mail"
 *
 * A name in the roster is preferred (longest first), so multi-word names
 * work with or without "to". Otherwise the words before " to " are taken as
 * the name, so "ask the plumber to fix the sink" comes back with
 * `agent: null` and `query: "plumber"`, for an honest "no such agent".
 *
 * @returns {{ agent: object | null, query: string, goal: string } | null}
 */
export function parseAgentRequest(text, entries = []) {
  if (typeof text !== 'string') return null
  const m = ASK_VERB.exec(text.trim().slice(0, 4000))
  if (!m) return null
  const rest = m[2]
  const names = entries
    .flatMap((a) => keysOf(a).map((k) => ({ a, k })))
    .sort((x, y) => y.k.length - x.k.length)
  for (const { a, k } of names) {
    const pattern = new RegExp(`^(?:the |my |your |our )?${k.replace(/ /g, '[\\s-]+')}(?:'s)?(?: agent)?[\\s,:]+(?:to\\s+)?`, 'i')
    const hit = pattern.exec(rest)
    if (!hit) continue
    const goal = clip(rest.slice(hit[0].length).replace(/[\s.!?]+$/, ''), 4000)
    if (goal) return { agent: a, query: a.name, goal }
  }
  const to = /^(.{1,60}?)\s+to\s+(.+)$/is.exec(rest)
  if (!to) return null
  const query = nameKey(to[1])
  const goal = clip(to[2].replace(/[\s.!?]+$/, ''), 4000)
  // "ask him to…", "tell me to…": not an agent, just words.
  if (!query || !goal || /^(me|him|her|them|it|us|you|someone|somebody)$/.test(query)) return null
  return { agent: null, query, goal }
}

/** The spoken answer when a name matches nothing. */
function unknownAnswer(query, entries) {
  const names = entries.filter((a) => a.on).map((a) => a.name)
  const have = names.length
    ? ` The agents I can ask are ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}.`
    : ' No agents are set up yet.'
  const who = spoken(query)
  return `I don't have an agent called ${who ? `"${who}"` : 'that'}.${have}`
}

/** The spoken answer when no agent clearly fits words that name none. */
function noMatchAnswer(candidates) {
  const names = candidates.map((c) => c.name)
  if (names.length >= 2) return `I'm not sure which agent fits: it could be the ${names.slice(0, -1).join(', ')} or the ${names.at(-1)}. Say which one to ask.`
  return 'No agent clearly fits that. Say which agent to ask, or I can start a plain task.'
}

const offAnswer = (a) => (a.why === 'waiting for your approval'
  ? `The ${a.name} agent is waiting for your approval, so I can't ask it yet.`
  : `The ${a.name} agent is switched off. You can switch it on in Settings, under Agents.`)

const brief = (t) => ({
  id: t.id, title: t.title, status: t.status, percent: t.percent, note: t.note, error: t.error || undefined,
  ...(t.agentName && { agent: t.agentName }),
})

/**
 * The voice session's agent operations, over the task manager and the roster.
 *
 * @param {{ spawn: Function }} manager the task manager (tasks.mjs)
 * @param {{ list?: Function, isActive: Function } | null} agents the switched registry
 */
export function agentOperations(manager, agents) {
  return {
    /** Every agent, with whether it can be asked now. */
    list() {
      const entries = roster(agents)
      return {
        agents: entries.slice(0, MAX_LISTED),
        ...(entries.length > MAX_LISTED && { more: entries.length - MAX_LISTED }),
      }
    },

    /**
     * Queue a task for a named agent. Either `agent` and `goal`, or the
     * owner's own words as `request`.
     */
    start({ agent, goal, title, request } = {}) {
      const entries = roster(agents)
      let target = null
      let query = typeof agent === 'string' ? agent : ''
      let g = clip(goal, 4000)
      let matched = false
      if (query.trim()) {
        target = resolveAgent(entries, query)
        if (!g && typeof request === 'string') g = parseAgentRequest(request, target ? [target] : [])?.goal ?? ''
      } else if (typeof request === 'string' && request.trim()) {
        const parsed = parseAgentRequest(request, entries)
        if (parsed) {
          target = parsed.agent
          query = parsed.query
          if (!g) g = parsed.goal
        } else {
          // No agent named: pick one by what the words ask for, only when
          // one agent that is on clearly fits (agent-match.mjs).
          const m = matchAgent(entries.filter((a) => a.on), request)
          if (!m.agent) return { started: false, reason: noMatchAnswer(m.candidates) }
          target = m.agent
          matched = true
          if (!g) g = clip(request.replace(/[\s.!?]+$/, ''), 4000)
        }
      } else {
        return { started: false, reason: 'Say which agent to ask.' }
      }
      if (!target) return { started: false, reason: unknownAnswer(query, entries) }
      if (!target.on) return { started: false, reason: offAnswer(target) }
      if (!g) return { started: false, reason: `What should the ${target.name} agent do?` }
      const r = manager.spawn({ title: clip(title, 60) || clip(g, 60), goal: g, agentId: target.id })
      return r.ok
        ? { started: true, agent: target.name, ...(matched && { matched: true }), ...brief(r.task) }
        : { started: false, agent: target.name, reason: r.reason }
    },
  }
}

export { brief as taskBrief }
