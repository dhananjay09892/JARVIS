/**
 * Turns a stream of detector scores into wake events.
 *
 * Kept apart from the detector so the threshold is a setting rather than a
 * property of the model, and so plan 02 phase 3 (TV mode, a learned threshold)
 * changes one small file.
 */

export type WakeSensitivity = 'low' | 'medium' | 'high'

export const WAKE_SENSITIVITIES: readonly WakeSensitivity[] = ['low', 'medium', 'high']

/**
 * Score a frame must reach to count as the wake phrase. openWakeWord's own
 * default is 0.5. "High" sensitivity wakes more easily (more false wakes from a
 * TV); "low" needs a clearer "hey jarvis".
 */
export const WAKE_THRESHOLDS: Readonly<Record<WakeSensitivity, number>> = {
  low: 0.7,
  medium: 0.5,
  high: 0.3,
}

/** One phrase produces several high frames in a row; this keeps it to one wake. */
export const WAKE_COOLDOWN_MS = 1500

export function thresholdFor(sensitivity: string | undefined): number {
  return WAKE_THRESHOLDS[(sensitivity as WakeSensitivity)] ?? WAKE_THRESHOLDS.medium
}

export type WakeGate = {
  /** Feed one score; true means "this is a wake". */
  push: (score: number, now: number) => boolean
  setSensitivity: (sensitivity: string | undefined) => void
  threshold: () => number
  /** Highest score since the last wake, for Diagnostics and tuning. */
  peak: () => number
}

export function makeWakeGate(sensitivity?: string): WakeGate {
  let threshold = thresholdFor(sensitivity)
  let lastWake = -Infinity
  let peak = 0
  return {
    push(score, now) {
      if (score > peak) peak = score
      if (score < threshold) return false
      if (now - lastWake < WAKE_COOLDOWN_MS) return false
      lastWake = now
      peak = 0
      return true
    },
    setSensitivity(s) {
      threshold = thresholdFor(s)
    },
    threshold: () => threshold,
    peak: () => peak,
  }
}
