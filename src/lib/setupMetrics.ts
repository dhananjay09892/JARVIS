/**
 * Setup drop-off metric, page side (plan 29 phase 1, plan 16; Q77).
 *
 * Opt-in: nothing is sent unless JARVIS_SETUP_METRICS is on, and the bridge
 * checks the setting again before it stores anything (bridge/setup-metrics.mjs).
 * The bridge keeps it in a local file; it never leaves this computer.
 *
 * No imports from ../config, so the tracker runs under `node --test`; the two
 * network helpers take the bridge's address from the caller.
 *
 * What is sent: a random id for this pass through the wizard, which step was
 * reached, whether it was finished or skipped, and the ids of what the
 * self-test found wrong (e.g. "mic-muted"). Never audio, levels or device names.
 */

/** The wizard's steps in order; index = the `step` state in src/ui/Settings.tsx. */
export const WIZARD_STEPS = ['hardware', 'claude', 'voice', 'finish'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export type SetupEvent =
  | { kind: 'start' | 'reach' | 'complete' | 'skip'; run: string; step: WizardStep; at: number }
  | { kind: 'selftest'; run: string; place: 'wizard' | 'settings'; findings: string[]; at: number }

export function newRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Turns what the wizard does into events. `enabled` is asked each time, so
 * turning the setting on part-way counts from then on, and turning it off
 * stops at once. Pure apart from the injected `send`, so it is tested.
 */
export function createWizardTracker(opts: {
  send: (e: SetupEvent) => void
  enabled: () => boolean
  newId?: () => string
  now?: () => number
}) {
  const { send, enabled, newId = newRunId, now = () => Date.now() } = opts
  let run: string | null = null
  let at = 0

  const stepOf = (i: number): WizardStep => WIZARD_STEPS[Math.max(0, Math.min(WIZARD_STEPS.length - 1, i))]
  const emit = (e: SetupEvent) => {
    if (enabled()) send(e)
  }

  return {
    /** The wizard opened (first run, or "Run setup wizard again"). */
    open() {
      run = newId()
      at = 0
      emit({ kind: 'start', run, step: 'hardware', at: now() })
    },
    /** The wizard moved to step `i` (forward or back). */
    step(i: number) {
      if (!run || i === at) return
      at = i
      emit({ kind: 'reach', run, step: stepOf(i), at: now() })
    },
    /** Finish was pressed on the last step. */
    complete() {
      if (!run) return
      emit({ kind: 'complete', run, step: 'finish', at: now() })
      run = null
    },
    /** "Skip setup" (or Escape) on whatever step it was on. */
    skip() {
      if (!run) return
      emit({ kind: 'skip', run, step: stepOf(at), at: now() })
      run = null
    },
    /** The hardware self-test ended, with the ids of what it found wrong. */
    selftest(findings: readonly string[]) {
      const place = run ? 'wizard' : 'settings'
      emit({ kind: 'selftest', run: run ?? newId(), place, findings: [...findings], at: now() })
    },
  }
}

/** Best effort and off the voice path: a missing bridge costs one event. */
export function postSetupEvent(base: string, e: SetupEvent): void {
  void fetch(`${base}/setup-metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(e),
    keepalive: true,
  }).catch(() => {})
}

export type SetupStats = {
  enabled: boolean
  runs?: number
  completed?: number
  skipped?: number
  abandoned?: number
  completionRate?: number | null
  leftAt?: Record<WizardStep, number>
  selftest?: { runs: number; clean: number; failures: { id: string; count: number }[] }
}

/** The numbers for Diagnostics; null if the bridge cannot be reached (or is older). */
export async function fetchSetupStats(base: string): Promise<SetupStats | null> {
  try {
    const res = await fetch(`${base}/setup-metrics/stats`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as SetupStats
  } catch {
    return null
  }
}
