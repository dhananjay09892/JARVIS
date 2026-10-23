import { getMic } from '../audio'
import { WAKE_FRAME_SAMPLES, WAKE_SAMPLE_RATE, type OnnxRun } from './detector.ts'
import { makeWakeGate } from './gate.ts'
import { OpenWakeWord } from './openwakeword.ts'
import { FrameResampler } from './resample.ts'

/**
 * The offline wake engine, in the page (ADR 002: openWakeWord in the page).
 *
 * Taps the shared microphone stream, resamples it to 16 kHz, and scores every
 * 80 ms frame with openWakeWord through onnxruntime-web. Audio goes no further
 * than this tab: the only thing that leaves this module is a wake event.
 *
 * Everything it loads is served by JARVIS itself, never a CDN, so it works
 * offline and nothing about it depends on a vendor account:
 *   /models/wake/*.onnx — the three openWakeWord models (committed, see LICENSE there)
 *   /ort/*              — onnxruntime-web's WebAssembly, copied out of
 *                         node_modules by scripts/start.mjs and scripts/package.mjs
 *
 * If any of it fails, `startWakeEngine` throws and voice.ts falls back to cloud
 * listening with a visible badge, rather than leaving JARVIS deaf.
 */

export const WAKE_MODEL_BASE = '/models/wake/'
export const ORT_WASM_BASE = '/ort/'
export const WAKE_MODEL_FILES = {
  mel: 'melspectrogram.onnx',
  embedding: 'embedding_model.onnx',
  wake: 'hey_jarvis_v0.1.onnx',
} as const

/** More than this many frames waiting (about 1 s) means inference is falling behind. */
const MAX_BACKLOG = 12

export type WakeEngineMeter = {
  /** Last frame's score, 0..1. */
  score: number
  /** Highest score since the last wake. */
  peak: number
  threshold: number
  /** Frames dropped because scoring fell behind. */
  lagDrops: number
  /** Mean milliseconds to score one 80 ms frame. Must stay well under 80. */
  frameMs: number
}

export type WakeEngine = {
  readonly engine: string
  readonly phrase: string
  stop: () => void
  setSensitivity: (sensitivity: string) => void
  meter: () => WakeEngineMeter
}

export type WakeEngineOptions = {
  sensitivity: string
  /** Only score while this is true (JARVIS is asleep). Saves CPU the rest of the time. */
  active: () => boolean
  onWake: (score: number) => void
}

/** Collects the worklet's 128-sample blocks into larger chunks before posting them. */
const TAP_WORKLET = `
class JarvisWakeTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
      }
    }
    return true
  }
}
registerProcessor('jarvis-wake-tap', JarvisWakeTap)
`

type Ort = typeof import('onnxruntime-web')

async function loadRunner(ort: Ort, url: string): Promise<{ run: OnnxRun; release: () => void }> {
  const session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] })
  const input = session.inputNames[0]
  const output = session.outputNames[0]
  return {
    run: async (data, dims) => {
      const result = await session.run({ [input]: new ort.Tensor('float32', data, dims) })
      return result[output].data as Float32Array
    },
    release: () => void session.release().catch(() => {}),
  }
}

export async function startWakeEngine(opts: WakeEngineOptions): Promise<WakeEngine> {
  const ort: Ort = await import('onnxruntime-web')
  ort.env.wasm.wasmPaths = ORT_WASM_BASE
  // One thread: multi-threaded WASM needs cross-origin isolation, which the
  // page does not have, and three tiny models do not need it.
  ort.env.wasm.numThreads = 1

  const runners = await Promise.all([
    loadRunner(ort, WAKE_MODEL_BASE + WAKE_MODEL_FILES.mel),
    loadRunner(ort, WAKE_MODEL_BASE + WAKE_MODEL_FILES.embedding),
    loadRunner(ort, WAKE_MODEL_BASE + WAKE_MODEL_FILES.wake),
  ])
  const [mel, embedding, wake] = runners
  const detector = new OpenWakeWord({ mel: mel.run, embedding: embedding.run, wake: wake.run })
  const gate = makeWakeGate(opts.sensitivity)

  const stream = await getMic()
  const ctx = new AudioContext()
  void ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const resampler = new FrameResampler(ctx.sampleRate, WAKE_SAMPLE_RATE, WAKE_FRAME_SAMPLES)
  // Muted sink: some browsers only pull audio through nodes that reach the destination.
  const sink = ctx.createGain()
  sink.gain.value = 0
  sink.connect(ctx.destination)

  let stopped = false
  let score = 0
  let lagDrops = 0
  let frameMs = 0
  let wasActive = true
  const queue: Float32Array[] = []
  let busy = false

  const pump = async () => {
    if (busy) return
    busy = true
    try {
      while (queue.length && !stopped) {
        const frame = queue.shift()!
        const t0 = performance.now()
        score = await detector.process(frame)
        frameMs += (performance.now() - t0 - frameMs) * 0.05
        if (gate.push(score, performance.now())) {
          detector.reset()
          queue.length = 0
          opts.onWake(score)
        }
      }
    } catch (err) {
      console.warn('[jarvis] wake engine frame failed', err)
    } finally {
      busy = false
    }
  }

  const onAudio = (chunk: Float32Array) => {
    if (stopped) return
    const active = opts.active()
    if (!active) {
      // Not asleep: nothing to listen for. Forget the context so stale audio
      // from before the conversation cannot complete a phrase afterwards.
      if (wasActive) {
        detector.reset()
        resampler.reset()
        queue.length = 0
      }
      wasActive = false
      return
    }
    wasActive = true
    for (const frame of resampler.push(chunk)) queue.push(frame)
    if (queue.length > MAX_BACKLOG) {
      lagDrops += queue.length
      queue.length = 0
      detector.reset()
    }
    void pump()
  }

  let tap: AudioNode
  let workletUrl = ''
  if (ctx.audioWorklet) {
    workletUrl = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(ctx, 'jarvis-wake-tap')
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onAudio(e.data)
    tap = node
  } else {
    // Older browsers: the deprecated ScriptProcessor does the same job on the main thread.
    const node = ctx.createScriptProcessor(2048, 1, 1)
    node.onaudioprocess = (e) => onAudio(new Float32Array(e.inputBuffer.getChannelData(0)))
    tap = node
  }
  source.connect(tap)
  tap.connect(sink)

  return {
    engine: detector.engine,
    phrase: detector.phrase,
    stop: () => {
      stopped = true
      queue.length = 0
      try {
        source.disconnect()
        tap.disconnect()
        void ctx.close()
      } catch {
        /* already closed */
      }
      if (workletUrl) URL.revokeObjectURL(workletUrl)
      detector.dispose()
      for (const r of runners) r.release()
    },
    setSensitivity: (s) => gate.setSensitivity(s),
    meter: () => ({ score, peak: gate.peak(), threshold: gate.threshold(), lagDrops, frameMs }),
  }
}
