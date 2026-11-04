/**
 * The kill switch, as far as plan 20 needs it (spec §5.7, task Q79).
 *
 * - `freeze(source)` from the owner over chat ('chat') or the HUD ('hud')
 *   sets it and publishes `freeze.on`.
 * - `unfreeze('hud')` is the only way back. Any other source is refused, so
 *   someone holding the owner's phone can stop JARVIS but not restart him.
 * - The bridge hands `isFrozen` to the policy engine and to the channel
 *   pipeline: while frozen every tool call is refused and channels drop
 *   messages in silence.
 *
 * `onChange(listener)` tells local subsystems (the task manager's "pause all
 * agents") at once, with or without the event bus.
 *
 * In memory: a restart of the bridge (which only someone at the computer can
 * do) clears it. Plan 15 owns a fuller, persisted kill switch.
 */

export const FREEZE_SOURCES = Object.freeze(['chat', 'hud'])

export function createKillSwitch({ bus = null, now = () => Date.now(), log = console } = {}) {
  let state = { frozen: false }
  const listeners = new Set()
  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener({ ...state })
      } catch (err) {
        log?.warn?.('[jarvis] a kill switch listener failed:', err?.message ?? err)
      }
    }
  }
  const publish = (topic, payload) => {
    try {
      bus?.publish?.(topic, payload)
    } catch (err) {
      log?.warn?.('[jarvis] freeze event not published:', err?.message ?? err)
    }
  }
  return {
    isFrozen: () => state.frozen,
    /** Hear about every freeze and unfreeze. Returns an unsubscribe function. */
    onChange(listener) {
      if (typeof listener !== 'function') throw new Error('kill switch: listener must be a function')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    state: () => ({ ...state }),
    freeze(source) {
      if (!FREEZE_SOURCES.includes(source)) throw new Error('freeze: unknown source')
      if (state.frozen) return false
      state = { frozen: true, source, at: now() }
      publish('freeze.on', { source, at: state.at })
      changed()
      return true
    },
    unfreeze(source) {
      if (source !== 'hud') throw new Error('freeze: unfreeze is HUD-only')
      if (!state.frozen) return false
      state = { frozen: false }
      publish('freeze.off', { source, at: now() })
      changed()
      return true
    },
  }
}
