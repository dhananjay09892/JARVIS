/**
 * The wake-word detector interface (plan 02 phase 2, ADR 002).
 *
 * A detector is fed 16 kHz mono audio in fixed frames and answers with a score
 * from 0 to 1: how sure it is that the wake phrase just ended. Everything that
 * decides what to *do* with a score (threshold, cooldown, what happens to the
 * audio) lives outside it, in gate.ts and router.ts, so a different engine —
 * a custom-trained phrase, sherpa-onnx keyword spotting, or the same models
 * running in the bridge for satellites (plan 03) — only has to implement this.
 *
 * Nothing in this folder sends audio anywhere. That is the point of it.
 */

/** Sample rate every detector works at. */
export const WAKE_SAMPLE_RATE = 16000

/** openWakeWord's frame: 80 ms at 16 kHz. */
export const WAKE_FRAME_SAMPLES = 1280

export interface WakeDetector {
  /** Stable engine name, e.g. 'openwakeword'. Goes into traces and Diagnostics. */
  readonly engine: string
  /** The phrase this model listens for, e.g. 'hey jarvis'. */
  readonly phrase: string
  /** Samples per call to `process`. */
  readonly frameSamples: number
  /**
   * Score one frame of float PCM in [-1, 1] at WAKE_SAMPLE_RATE.
   * Calls must not overlap; await each one before sending the next.
   */
  process(frame: Float32Array): Promise<number>
  /** Forget all audio context, e.g. after a wake, so one phrase cannot fire twice. */
  reset(): void
  dispose(): void
}

/**
 * Runs one ONNX model. Kept abstract so the pipeline can be tested without a
 * browser: the page passes onnxruntime-web, a test passes a fake.
 * Returns the first output tensor's data.
 */
export type OnnxRun = (input: Float32Array, dims: number[]) => Promise<Float32Array>
