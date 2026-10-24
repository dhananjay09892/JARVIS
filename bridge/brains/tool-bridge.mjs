/**
 * The tool bridge (plan 21, phase 3): the policy-gated executor for brains in
 * tool-loop mode.
 *
 * A tool-loop brain (an OpenAI-compatible API, a local model) has no
 * pre-execution hook of its own: its model only proposes tool calls. JARVIS
 * runs the loop, and every proposed call comes here. The bridge asks the
 * policy engine (policy.mjs `authorize`, the same decision and audit entry an
 * agent-CLI brain's PreToolUse hook takes), then the guard after it (the taint
 * check), and only then runs the tool. A refused call never reaches its
 * handler and comes back as a failed `tool_result`, so it never looks like
 * work that happened.
 *
 * The brain never sees the handlers, only `offered()` (what to show its model)
 * and `run()`. The registry (registry.mjs) builds one bridge per session and
 * checks every `tool_result` the brain reports against what the bridge
 * actually decided, so a brain cannot run a tool around it or report a refused
 * call as a success.
 */
import { detailOf, summarise } from './events.mjs'

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * @param {object} p
 * @param {object} p.policy  the policy engine (policy.mjs createPolicy)
 * @param {'voice'|'worker'} p.actor  who is asking, for the audit trail
 * @param {Record<string, (args: object) => unknown>} [p.tools]  tool name → handler;
 *        a handler resolves to the tool's output (a string, or MCP-style content)
 *        or throws to fail the call
 * @param {Function} [p.guard]   extra check after the gate (the taint guard)
 * @param {(toolName: string) => boolean} [p.tainted]  does this tool's output count as private?
 * @param {object} [p.log]
 */
export function createToolBridge({ policy, actor, tools = {}, guard = null, tainted = () => false, log = console } = {}) {
  if (typeof policy?.authorize !== 'function' || typeof policy?.decideTool !== 'function') {
    throw new Error('The tool bridge needs the policy engine.')
  }
  if (actor !== 'voice' && actor !== 'worker') throw new Error(`Unknown actor: ${actor}`)
  if (!isRecord(tools)) throw new Error('Tools must be an object of name → handler.')
  const handlers = new Map()
  for (const [name, handler] of Object.entries(tools)) {
    if (typeof handler !== 'function') throw new Error(`Tool ${name} needs a handler function.`)
    handlers.set(name, handler)
  }
  // Every call this bridge decided, by id, and whether it ended ok.
  const outcomes = new Map()

  const result = (id, name, ok, content) => {
    outcomes.set(id, ok)
    return {
      t: 'tool_result',
      id,
      ok,
      summary: summarise(content),
      tainted: ok && Boolean(name && tainted(name)),
      detail: detailOf(content),
    }
  }

  return Object.freeze({
    /**
     * The tools to show the model: the ones the policy would allow right now.
     * Like the Claude brain's `disallowedTools`, this keeps the model from
     * planning around tools it cannot use; `run()` still decides every call.
     */
    offered() {
      return [...handlers.keys()].filter((name) => policy.decideTool(name))
    },

    /**
     * Decide one proposed call and, if allowed, run it. Never throws: a
     * refusal, an unknown tool or a failing handler is a failed tool_result.
     * Each call id is decided once; a repeated id is refused.
     */
    async run({ id, name, args } = {}) {
      if (typeof id !== 'string' || !id) throw new Error('A tool call needs an id.')
      if (outcomes.has(id)) return { t: 'tool_result', id, ok: false, summary: 'This tool call was already decided.', tainted: false, detail: '' }
      outcomes.set(id, false)
      const input = isRecord(args) ? args : {}
      const { refusal } = await policy.authorize({ name, input, actor, stage: 'tool-bridge', guard, log })
      if (refusal !== null) return result(id, name, false, refusal)
      const handler = handlers.get(name)
      if (!handler) return result(id, name, false, `No such tool available: ${name}`)
      try {
        const output = await handler(input)
        return result(id, name, true, typeof output === 'string' || Array.isArray(output) ? output : output == null ? '' : JSON.stringify(output))
      } catch (err) {
        return result(id, name, false, String(err?.message ?? err))
      }
    },

    /** Did this bridge decide the call with this id, and how did it end? undefined if never. */
    outcome(id) {
      return outcomes.get(id)
    },
  })
}
