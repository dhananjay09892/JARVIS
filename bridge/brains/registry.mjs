/**
 * The brain registry (plan 21, phases 1 and 3).
 *
 * The bridge asks the registry for a brain instead of reaching for a provider's
 * SDK. Today it holds one brain, Claude, and that is the default. Plan 21's
 * later phases add others behind the same shape; the policy engine stays
 * outside every one of them.
 *
 * A brain is an object with:
 *   id, label, capabilities
 *   status()             → { installed, version, authenticated, authMode, … }
 *   startSession(params) → the provider's own running session (not handed out
 *                          by the registry: the bridge reads only converse())
 *   converse(params)     → { events, cancel, close }: the session as normalised
 *                          BrainEvents (events.mjs); what conformance.mjs tests
 *
 * The policy contract (phase 3). No brain runs a tool without a policy
 * decision. `capabilities.toolGate` says how a brain's tool calls reach the
 * policy engine, and that decides the brain's tool mode:
 *
 *   'hook' → agent mode. The vendor's agent loop runs tools, but asks a
 *            pre-execution hook first (the Claude Agent SDK's PreToolUse hook
 *            and canUseTool). The brain must wire `params.policy` into it.
 *   'loop' → tool-loop mode. JARVIS runs the loop: the model only proposes
 *            calls, and the brain must run each through `params.tools`, the
 *            tool bridge (tool-bridge.mjs) the registry builds for the session.
 *   absent → read-only mode. A brain with no way to ask before a tool runs is
 *            given no tools at all (no MCP servers, no handlers) and told
 *            `readOnly: true`, so its adapter turns its vendor's own tools off.
 *
 * Whatever the mode, the registry watches the brain's events and stops a turn
 * the moment a tool appears that the policy engine did not allow: a read-only
 * brain using any tool, a tool-loop brain reporting a result the bridge never
 * produced, or an agent brain reporting a tool that ran with no allow from its
 * hook. The turn then ends with an `error` (`policy_bypass`) and `done`
 * `error`, and the rest of that turn is dropped.
 */
import { createToolBridge } from './tool-bridge.mjs'

const ID = /^[a-z][a-z0-9-]{0,31}$/

/** capabilities.toolGate → tool mode. Anything missing is read-only. */
export const TOOL_MODES = Object.freeze({ hook: 'agent', loop: 'tool-loop' })

/** The error code a turn ends with when a brain used a tool around the policy engine. */
export const POLICY_BYPASS = 'policy_bypass'

/** The tool mode a brain runs in, from its capabilities. */
export function toolModeOf(capabilities) {
  return TOOL_MODES[capabilities?.toolGate] ?? 'read-only'
}

export function createBrainRegistry({ defaultId = 'claude', log = console } = {}) {
  const brains = new Map()

  return {
    /**
     * Add a brain. Rejects a malformed brain or a second brain with the same
     * id. Returns the brain as the bridge will use it: converse() goes through
     * the policy contract for its tool mode, and startSession() is not exposed.
     */
    register(brain) {
      if (!brain || typeof brain !== 'object') throw new Error('A brain must be an object.')
      if (typeof brain.id !== 'string' || !ID.test(brain.id)) throw new Error(`Bad brain id: ${brain.id}`)
      if (typeof brain.label !== 'string' || !brain.label) throw new Error(`Brain ${brain.id} needs a label.`)
      if (!brain.capabilities || typeof brain.capabilities !== 'object') {
        throw new Error(`Brain ${brain.id} needs capabilities.`)
      }
      const gate = brain.capabilities.toolGate
      if (gate !== undefined && !Object.hasOwn(TOOL_MODES, gate)) {
        throw new Error(`Brain ${brain.id} has an unknown toolGate: ${gate}`)
      }
      for (const method of ['status', 'startSession', 'converse']) {
        if (typeof brain[method] !== 'function') throw new Error(`Brain ${brain.id} needs ${method}().`)
      }
      if (brains.has(brain.id)) throw new Error(`Brain ${brain.id} is already registered.`)
      const gated = guarded(brain, log)
      brains.set(brain.id, gated)
      return gated
    },

    /** The brain with this id. Unknown ids throw rather than quietly falling back. */
    get(id) {
      const brain = brains.get(id)
      if (!brain) throw new Error(`No brain called ${id}.`)
      return brain
    },

    has: (id) => brains.has(id),

    /** The default brain (Claude, per the standing constraint in plans/README.md). */
    default() {
      return this.get(defaultId)
    },

    /** id, label, capabilities and tool mode of every brain, for Settings and Diagnostics. */
    list() {
      return [...brains.values()].map(({ id, label, capabilities, toolMode }) => ({ id, label, capabilities, toolMode }))
    },
  }
}

/** The brain as the bridge sees it: the same brain, with converse() under the policy contract. */
function guarded(brain, log) {
  const toolMode = toolModeOf(brain.capabilities)
  const out = {
    id: brain.id,
    label: brain.label,
    capabilities: brain.capabilities,
    toolMode,
    status: (...a) => brain.status(...a),
    converse: (params = {}) => converse(brain, toolMode, params, log),
  }
  if (typeof brain.login === 'function') out.login = (...a) => brain.login(...a)
  return Object.freeze(out)
}

function converse(brain, toolMode, params, log) {
  const { policy } = params
  if (typeof policy?.authorize !== 'function' || typeof policy?.decide !== 'function') {
    throw new Error(`Brain ${brain.id}: converse needs the policy engine.`)
  }

  if (toolMode === 'agent') {
    // The brain gets the policy as it is, except that every verdict its hooks
    // hand back is noted, so a tool reported as run can be matched to an allow.
    const allows = new Map() // tool name → allow verdicts not yet matched to a result
    const run = brain.converse({ ...params, policy: observed(policy, allows) })
    const names = new Map() // tool id → name, this turn
    return watched(run, brain.id, log, (e) => {
      if (e.t === 'tool_call') names.set(e.id, e.name)
      if (e.t === 'tool_result' && e.ok) {
        const name = names.get(e.id)
        const left = name ? allows.get(name) ?? 0 : 0
        if (left === 0) return `${name || 'a tool'} ran without a policy decision`
        allows.set(name, left - 1)
      }
      if (e.t === 'done') {
        names.clear()
        allows.clear()
      }
      return null
    })
  }

  if (toolMode === 'tool-loop') {
    // Only the bridge can run tools: the brain gets no MCP servers, no raw
    // handlers, no guard, no PostToolUse hook and no policy to call around it.
    // The bridge runs the hook itself after each tool (labelling and taint).
    const { mcpServers: _m, tools = {}, guard, afterTool, policy: _p, tainted, ...rest } = params
    const bridge = createToolBridge({ policy, actor: params.actor, tools, guard, tainted, afterTool, log })
    const run = brain.converse({ ...rest, tools: bridge })
    return watched(run, brain.id, log, (e) => {
      if (e.t !== 'tool_result') return null
      const ok = bridge.outcome(e.id)
      if (ok === undefined) return `a result for ${e.id} that the tool bridge never decided`
      if (e.ok && !ok) return `a refused or failed call ${e.id} reported as a success`
      return null
    })
  }

  // Read-only: nothing to run tools with, and any sign of a tool stops the turn.
  const { mcpServers: _m, tools: _t, guard: _g, afterTool: _a, policy: _p, ...rest } = params
  const run = brain.converse({ ...rest, readOnly: true })
  return watched(run, brain.id, log, (e) =>
    e.t === 'tool_start' || e.t === 'tool_call' || e.t === 'tool_result' ? 'a read-only brain used a tool' : null)
}

/**
 * The policy engine with every hook verdict noted: an allow from the
 * PreToolUse hook or canUseTool adds one to `allows` for that tool name.
 * Deciding is unchanged; this only watches.
 */
function observed(policy, allows) {
  const note = (name, ok) => {
    if (ok && typeof name === 'string' && name) allows.set(name, (allows.get(name) ?? 0) + 1)
  }
  return Object.freeze({
    ...policy,
    preToolUse(options) {
      const matcher = policy.preToolUse(options)
      return {
        ...matcher,
        hooks: matcher.hooks.map((hook) => async (input, ...rest) => {
          const out = await hook(input, ...rest)
          note(input?.tool_name, out?.hookSpecificOutput?.permissionDecision !== 'deny')
          return out
        }),
      }
    },
    canUseTool(context, log) {
      const callback = policy.canUseTool(context, log)
      return async (toolName, ...rest) => {
        const verdict = await callback(toolName, ...rest)
        note(toolName, verdict?.behavior === 'allow')
        return verdict
      }
    },
  })
}

/**
 * A session whose events pass `breach(e)`: null lets the event through, a
 * reason stops the turn. A stopped turn yields one `error` (POLICY_BYPASS),
 * the brain is told to cancel, everything else it sends for that turn is
 * dropped, and its `done` becomes `done` `error` so the failure is reported
 * rather than passed off as a barge-in.
 */
function watched(run, brainId, log, breach) {
  async function* events() {
    let stopped = false
    for await (const e of run.events) {
      if (stopped) {
        if (e.t === 'done') {
          stopped = false
          yield { t: 'done', reason: 'error' }
        }
        continue
      }
      const reason = breach(e)
      if (reason === null) {
        yield e
        continue
      }
      stopped = true
      log?.error?.(`[jarvis] brain ${brainId}: ${reason}; turn stopped`)
      yield { t: 'error', code: POLICY_BYPASS, retryable: false, message: `Stopped: ${reason}.` }
      try {
        await run.cancel?.()
      } catch (err) {
        log?.error?.(`[jarvis] brain ${brainId}: cancel failed:`, err?.message ?? err)
      }
    }
  }
  return {
    events: events(),
    cancel: () => run.cancel?.(),
    close: () => run.close?.(),
  }
}
