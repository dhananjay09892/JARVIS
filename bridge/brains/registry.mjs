/**
 * The brain registry (plan 21, phase 1).
 *
 * The bridge asks the registry for a brain instead of reaching for a provider's
 * SDK. Today it holds one brain, Claude, and that is the default. Plan 21's
 * later phases add others behind the same shape; the policy engine stays
 * outside every one of them.
 *
 * A brain is an object with:
 *   id, label, capabilities
 *   status()             → { installed, version, authenticated, authMode, … }
 *   startSession(params) → a running session (async iterable of events)
 */

const ID = /^[a-z][a-z0-9-]{0,31}$/

export function createBrainRegistry({ defaultId = 'claude' } = {}) {
  const brains = new Map()

  return {
    /** Add a brain. Rejects a malformed brain or a second brain with the same id. */
    register(brain) {
      if (!brain || typeof brain !== 'object') throw new Error('A brain must be an object.')
      if (typeof brain.id !== 'string' || !ID.test(brain.id)) throw new Error(`Bad brain id: ${brain.id}`)
      if (typeof brain.label !== 'string' || !brain.label) throw new Error(`Brain ${brain.id} needs a label.`)
      if (!brain.capabilities || typeof brain.capabilities !== 'object') {
        throw new Error(`Brain ${brain.id} needs capabilities.`)
      }
      for (const method of ['status', 'startSession']) {
        if (typeof brain[method] !== 'function') throw new Error(`Brain ${brain.id} needs ${method}().`)
      }
      if (brains.has(brain.id)) throw new Error(`Brain ${brain.id} is already registered.`)
      brains.set(brain.id, brain)
      return brain
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

    /** id, label and capabilities of every registered brain, for Settings and Diagnostics. */
    list() {
      return [...brains.values()].map(({ id, label, capabilities }) => ({ id, label, capabilities }))
    },
  }
}
