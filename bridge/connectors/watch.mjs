/**
 * Background sync for connectors that can watch their source (task C13).
 *
 * A connector that has a `watch(onChange)` method (Obsidian watches its vault
 * folder) is only watched while all of these hold, checked on every
 * `reconcile()` and again before each sync:
 *   - it is registered and connected,
 *   - the owner granted "Sync in the background" (the `subscribe` grant, off
 *     by default),
 *   - it is not turned off and connectors are not frozen.
 * The read grant is checked by the registry inside the sync itself.
 *
 * A change runs `syncNow(id)` (the same path as the card's "Sync now"). Syncs
 * never overlap: changes that arrive during one run one more sync after it.
 * Starting the watch also runs one sync, to catch up on edits made while
 * nothing was watching.
 */

/**
 * @param {{
 *   registry: ReturnType<typeof import('./registry.mjs').createConnectorRegistry>,
 *   id: string,
 *   syncNow: (id: string) => Promise<unknown>,
 *   everyMs?: number,        how often reconcile() runs after start()
 *   log?: Pick<Console, 'warn'>,
 * }} opts
 */
export function createConnectorWatcher({ registry, id, syncNow, everyMs = 30_000, log = console }) {
  let stop = null
  let target = null
  let running = false
  let again = false
  let interval = null
  let syncs = 0

  const adapter = () => (registry.has(id) ? registry.get(id) : null)

  /** Should this connector be watched right now? */
  function wanted() {
    const c = adapter()
    if (!c || typeof c.watch !== 'function') return false
    const g = registry.grants
    if (g.isFrozen() || g.isDisabled(id) || !g.has(id, 'subscribe')) return false
    try {
      return c.status()?.state !== 'disconnected'
    } catch {
      return false
    }
  }

  async function runSync() {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        if (!wanted()) break
        syncs++
        try {
          await syncNow(id)
        } catch (err) {
          log?.warn?.(`[jarvis] connector ${id}: background sync failed:`, err?.message ?? err)
        }
      } while (again)
    } finally {
      running = false
    }
  }

  function halt() {
    if (stop) {
      try { stop() } catch { /* already stopped */ }
    }
    stop = null
    target = null
  }

  /** Start, stop or restart the watch to match the switches. Never throws. */
  function reconcile() {
    try {
      if (!wanted()) {
        halt()
        return false
      }
      const c = adapter()
      const t = typeof c.watchTarget === 'function' ? c.watchTarget() : 'default'
      if (stop && t === target) return true
      halt()
      const s = c.watch(() => { void runSync() })
      if (typeof s !== 'function') return false
      stop = s
      target = t
      void runSync()
      return true
    } catch (err) {
      log?.warn?.(`[jarvis] connector ${id}: watch failed:`, err?.message ?? err)
      halt()
      return false
    }
  }

  return {
    reconcile,
    /** Reconcile now and every `everyMs` (the timer does not keep the bridge alive). */
    start() {
      reconcile()
      if (!interval && everyMs > 0) {
        interval = setInterval(reconcile, everyMs)
        interval.unref?.()
      }
    },
    stop() {
      if (interval) clearInterval(interval)
      interval = null
      halt()
    },
    watching: () => stop !== null,
    /** Background syncs started so far (for tests and Diagnostics). */
    syncs: () => syncs,
    /** Resolves when no background sync is running (for tests). */
    async idle() {
      while (running) await new Promise((r) => setTimeout(r, 5))
    },
  }
}
