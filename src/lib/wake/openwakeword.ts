import { WAKE_FRAME_SAMPLES, type OnnxRun, type WakeDetector } from './detector.ts'

/**
 * openWakeWord's streaming feature pipeline, ported to TypeScript.
 *
 * openWakeWord (Apache-2.0, github.com/dscripka/openWakeWord) is three small
 * ONNX models in a chain, and only the last one knows the phrase:
 *
 *   80 ms of 16 kHz audio ──► melspectrogram.onnx ──► 8 rows of 32 mel bins
 *   last 76 mel rows      ──► embedding_model.onnx ──► one 96-number embedding
 *   last 16 embeddings    ──► hey_jarvis_v0.1.onnx ──► score 0..1
 *
 * The model files ship in public/models/wake/ (see the LICENSE there: the
 * pre-trained phrase model is CC BY-NC-SA 4.0, non-commercial).
 *
 * This mirrors openwakeword/utils.py `AudioFeatures` for the one case JARVIS
 * needs — frames of exactly 1280 samples — rather than its general buffering.
 * Two deliberate differences: audio arrives as Web Audio floats and is scaled
 * to the int16 range the mel model was trained on, and the first scores are
 * held at 0 until 16 real embeddings exist (about 1.3 s), where upstream
 * starts from embeddings of random noise. The second only delays readiness at
 * start-up and after `reset()`; it cannot cause a wake.
 */

/** Mel input = the new frame plus 3 hops of history, as upstream does (160 * 3). */
const MEL_CONTEXT = 480
const MEL_BINS = 32
/** Mel rows per embedding window. */
const EMBED_WINDOW = 76
const EMBED_SIZE = 96
/** Embeddings per classifier input. */
const FEATURE_WINDOW = 16

export type OpenWakeWordModels = {
  mel: OnnxRun
  embedding: OnnxRun
  wake: OnnxRun
}

/** Upstream's melspec_transform: `x / 10 + 2`. */
export const melTransform = (x: number) => x / 10 + 2

export class OpenWakeWord implements WakeDetector {
  readonly engine = 'openwakeword'
  readonly frameSamples = WAKE_FRAME_SAMPLES
  readonly phrase: string

  private models: OpenWakeWordModels
  /** The last MEL_CONTEXT samples of the previous frame, int16-scaled. */
  private tail = new Float32Array(MEL_CONTEXT)
  private melRows: Float32Array[] = []
  private embeddings: Float32Array[] = []
  private disposed = false

  constructor(models: OpenWakeWordModels, phrase = 'hey jarvis') {
    this.models = models
    this.phrase = phrase
    this.reset()
  }

  reset(): void {
    this.tail = new Float32Array(MEL_CONTEXT)
    // Upstream starts the mel buffer as 76 rows of ones.
    this.melRows = Array.from({ length: EMBED_WINDOW }, () => new Float32Array(MEL_BINS).fill(1))
    this.embeddings = []
  }

  dispose(): void {
    this.disposed = true
    this.melRows = []
    this.embeddings = []
  }

  async process(frame: Float32Array): Promise<number> {
    if (this.disposed) return 0
    if (frame.length !== WAKE_FRAME_SAMPLES) {
      throw new Error(`openWakeWord needs frames of ${WAKE_FRAME_SAMPLES} samples, got ${frame.length}`)
    }

    // 1. Mel spectrogram over [previous 480 samples | this frame].
    const input = new Float32Array(MEL_CONTEXT + WAKE_FRAME_SAMPLES)
    input.set(this.tail, 0)
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]))
      input[MEL_CONTEXT + i] = Math.trunc(s * 32767)
    }
    this.tail = input.slice(input.length - MEL_CONTEXT)

    const mel = await this.models.mel(input, [1, input.length])
    const rows = Math.floor(mel.length / MEL_BINS)
    for (let r = 0; r < rows; r++) {
      const row = new Float32Array(MEL_BINS)
      for (let b = 0; b < MEL_BINS; b++) row[b] = melTransform(mel[r * MEL_BINS + b])
      this.melRows.push(row)
    }
    if (this.melRows.length > EMBED_WINDOW) this.melRows.splice(0, this.melRows.length - EMBED_WINDOW)

    // 2. One embedding from the last 76 mel rows.
    const window = new Float32Array(EMBED_WINDOW * MEL_BINS)
    this.melRows.forEach((row, i) => window.set(row, i * MEL_BINS))
    const emb = await this.models.embedding(window, [1, EMBED_WINDOW, MEL_BINS, 1])
    if (emb.length < EMBED_SIZE) throw new Error(`embedding model returned ${emb.length} values`)
    this.embeddings.push(emb.slice(0, EMBED_SIZE))
    if (this.embeddings.length > FEATURE_WINDOW) this.embeddings.shift()
    if (this.embeddings.length < FEATURE_WINDOW || this.disposed) return 0

    // 3. The phrase classifier over the last 16 embeddings.
    const features = new Float32Array(FEATURE_WINDOW * EMBED_SIZE)
    this.embeddings.forEach((e, i) => features.set(e, i * EMBED_SIZE))
    const out = await this.models.wake(features, [1, FEATURE_WINDOW, EMBED_SIZE])
    const score = out[0]
    return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0
  }
}
