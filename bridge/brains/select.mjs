/**
 * Which brain a new conversation runs on, and what it is handed (plan 25,
 * task Q54).
 *
 * The Settings switch `JARVIS_BRAIN` is 'claude' by default (the standing
 * constraint in plans/README.md). Anything else that is not a registered
 * brain also means Claude. A brain picked here is never swapped for another
 * on its own: if the OpenAI brain has no key, its turns say so rather than
 * quietly running on Claude (or the other way round).
 *
 * A tool-loop brain has no MCP client, so it is given the bridge's own tools
 * as handlers and JSON Schemas (sdk-tools.mjs), which the registry puts
 * behind the policy-gated tool bridge. An agent brain (Claude) gets nothing
 * extra: its parameters are exactly what they were before this switch.
 */
import { toolsFromServers } from './sdk-tools.mjs'

export const BRAIN_CHOICES = Object.freeze(['claude', 'openai'])

/** The brain for a new conversation, from the Settings choice. */
export function chooseBrain(brains, choice) {
  if (typeof choice === 'string' && choice !== 'claude' && BRAIN_CHOICES.includes(choice) && brains.has(choice)) {
    return brains.get(choice)
  }
  return brains.default()
}

/**
 * Extra converse() parameters for this brain. For a tool-loop brain: `tools`
 * (name → handler) and `toolSpecs` (name → { description, parameters }) from
 * the session's in-process servers. For any other brain: nothing.
 */
export function toolParams(brain, mcpServers, { schema = null, log = console } = {}) {
  if (brain?.toolMode !== 'tool-loop') return {}
  const { handlers, specs, skipped } = toolsFromServers(mcpServers, { schema, log })
  if (skipped.length) {
    log?.log?.(`[jarvis] brain ${brain.id}: these MCP servers run outside the bridge and are not offered to it yet: ${skipped.join(', ')}`)
  }
  return { tools: handlers, toolSpecs: specs }
}
