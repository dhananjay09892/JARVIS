/**
 * Connector grants and kill switches (vetting rules 3 and 9).
 *
 * What a connector *can* do is its `capabilities`; what it *may* do is a grant,
 * one per capability, held here:
 *
 *   read       on by default for a connector that can read (the owner chose to
 *              connect it, which is consent to read). Owner only.
 *   write      always off by default. Even when granted, the policy engine also
 *              requires general writes, and each write asks for approval at
 *              the tool that performs it.
 *   subscribe  off by default (background sync / push).
 *
 * And two kill switches, read on every decision:
 *   disable(id) — one connector stops: no sync, no tools, no messages.
 *   freezeAll() — every connector stops at once ("freeze").
 *
 * `snapshot()` / `restore()` let the Settings card (task C03) keep grants
 * across restarts; restore only accepts known connectors and booleans.
 */
import { CAPABILITIES, CONNECTOR_ID } from './interface.mjs'

export const DEFAULT_GRANTS = Object.freeze({ read: true, write: false, subscribe: false })

export function createGrants() {
  const grants = new Map() // id -> { read, write, subscribe }
  const capable = new Map() // id -> capabilities the adapter declared
  const disabled = new Set()
  let frozen = false

  const known = (id) => {
    if (!grants.has(id)) throw new Error(`No connector called ${id}.`)
  }
  const checkCap = (cap) => {
    if (!CAPABILITIES.includes(cap)) throw new Error(`Unknown capability: ${cap}`)
  }

  return {
    /** Called by the registry when a connector registers. */
    init(id, capabilities) {
      if (!CONNECTOR_ID.test(id)) throw new Error(`Bad connector id: ${id}`)
      capable.set(id, { ...capabilities })
      grants.set(id, {
        read: DEFAULT_GRANTS.read && capabilities.read === true,
        write: false,
        subscribe: false,
      })
    },
    forget(id) {
      grants.delete(id)
      capable.delete(id)
      disabled.delete(id)
    },
    /** Grant a capability. A capability the adapter doesn't have can't be granted. */
    grant(id, cap) {
      known(id)
      checkCap(cap)
      if (capable.get(id)?.[cap] !== true) throw new Error(`${id} cannot ${cap}.`)
      grants.get(id)[cap] = true
    },
    revoke(id, cap) {
      known(id)
      checkCap(cap)
      grants.get(id)[cap] = false
    },
    /** True only for a known connector with this capability granted. */
    has(id, cap) {
      return grants.get(id)?.[cap] === true
    },
    of(id) {
      const g = grants.get(id)
      return g ? { ...g } : null
    },

    disable(id) {
      known(id)
      disabled.add(id)
    },
    enable(id) {
      known(id)
      disabled.delete(id)
    },
    isDisabled: (id) => disabled.has(id),
    freezeAll() {
      frozen = true
    },
    unfreezeAll() {
      frozen = false
    },
    isFrozen: () => frozen,

    snapshot() {
      return {
        frozen,
        connectors: Object.fromEntries([...grants].map(([id, g]) => [id, { ...g, disabled: disabled.has(id) }])),
      }
    },
    /** Apply saved grants. Unknown ids and non-boolean values are ignored. */
    restore(saved) {
      if (!saved || typeof saved !== 'object') return
      if (saved.frozen === true) frozen = true
      for (const [id, g] of Object.entries(saved.connectors ?? {})) {
        if (!grants.has(id) || !g || typeof g !== 'object') continue
        for (const cap of CAPABILITIES) {
          if (typeof g[cap] !== 'boolean') continue
          if (g[cap] && capable.get(id)?.[cap] !== true) continue
          grants.get(id)[cap] = g[cap]
        }
        if (g.disabled === true) disabled.add(id)
        else if (g.disabled === false) disabled.delete(id)
      }
    },
  }
}
