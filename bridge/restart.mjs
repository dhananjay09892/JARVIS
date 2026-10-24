/**
 * "Restart JARVIS to apply" (plan 39, phase 4).
 *
 * Most settings now take effect without a restart. The few that cannot (the
 * writes switch, the audit log, the wake engine and the like are read once,
 * when the bridge starts) are listed in a banner with one button. That button
 * asks the bridge to exit with RESTART_EXIT_CODE; whatever started it — the
 * Windows launcher (launcher/jarvis.mjs) or `npm start` (scripts/start.mjs) —
 * sees that code and starts a fresh bridge, which reads the saved settings.
 *
 * A bridge started by hand (`npm run bridge`) has nobody to start it again,
 * so it says it cannot restart itself and the banner asks the owner to do it.
 * Supervisors announce themselves with JARVIS_SUPERVISED=1.
 */

/** Exit code that means "start me again". 75 is EX_TEMPFAIL: try again. */
export const RESTART_EXIT_CODE = 75

/** Whether something will start the bridge again after it exits. */
export function canRestart(env = process.env) {
  return env.JARVIS_SUPERVISED === '1'
}

/**
 * @param {object}   deps
 * @param {object}   [deps.env]          environment, for canRestart
 * @param {Function} [deps.exit]         process.exit
 * @param {Function} [deps.beforeExit]   stop accepting work (close the HTTP server)
 * @param {Function} [deps.log]
 * @param {number}   [deps.delayMs]      time for the reply to reach the page
 */
export function createRestarter({
  env = process.env,
  exit = (code) => process.exit(code),
  beforeExit = () => {},
  log = console.log,
  delayMs = 250,
} = {}) {
  let pending = false
  return {
    get available() {
      return canRestart(env)
    },
    /**
     * Schedule the restart. Returns { ok: true } once it is on its way, or
     * { ok: false, reason } when nothing would start the bridge again.
     * Asking twice is harmless.
     */
    request() {
      if (!canRestart(env)) {
        return { ok: false, reason: 'JARVIS was started by hand, so it cannot restart itself. Stop it and start it again.' }
      }
      if (!pending) {
        pending = true
        log('[jarvis] restarting to apply settings')
        setTimeout(() => {
          try {
            beforeExit()
          } catch {
            /* exiting anyway */
          }
          exit(RESTART_EXIT_CODE)
        }, delayMs)
      }
      return { ok: true }
    },
  }
}
