/**
 * Microphone audio arrives at whatever rate the sound card runs (usually
 * 48 kHz, sometimes 44.1 kHz). The wake models want 16 kHz in 80 ms frames.
 *
 * Box-filter decimation: each output sample is the mean of the input samples
 * that fall in its slot. The mean doubles as a crude low-pass, which is plenty
 * for a wake-word model (it was trained on 16 kHz audio and its mel front end
 * ignores everything above 8 kHz anyway). Asking the AudioContext itself for
 * 16 kHz would be simpler, but Firefox refuses to connect a microphone to a
 * context at a different rate, so we resample ourselves everywhere.
 */
export class FrameResampler {
  private readonly ratio: number
  private readonly frameSize: number
  /** Unconsumed input samples; buf[0] is input sample number `base`. */
  private buf: number[] = []
  private base = 0
  /** Next output sample number. */
  private n = 0
  private frame: Float32Array
  private filled = 0

  constructor(inRate: number, outRate: number, frameSize: number) {
    if (!(inRate > 0 && outRate > 0 && frameSize > 0)) throw new Error('bad resampler rates')
    if (inRate < outRate) throw new Error('upsampling is not supported')
    this.ratio = inRate / outRate
    this.frameSize = frameSize
    this.frame = new Float32Array(frameSize)
  }

  /** Feed input audio; returns any complete output frames. */
  push(chunk: ArrayLike<number>): Float32Array[] {
    const out: Float32Array[] = []
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i])

    for (;;) {
      const start = Math.floor(this.n * this.ratio)
      const end = Math.max(start + 1, Math.floor((this.n + 1) * this.ratio))
      if (end > this.base + this.buf.length) break
      let sum = 0
      for (let j = start; j < end; j++) sum += this.buf[j - this.base]
      this.frame[this.filled++] = sum / (end - start)
      this.n++
      if (this.filled === this.frameSize) {
        out.push(this.frame)
        this.frame = new Float32Array(this.frameSize)
        this.filled = 0
      }
    }

    const keepFrom = Math.floor(this.n * this.ratio) - this.base
    if (keepFrom > 0) {
      this.buf.splice(0, keepFrom)
      this.base += keepFrom
    }
    return out
  }

  reset(): void {
    this.buf = []
    this.base = 0
    this.n = 0
    this.frame = new Float32Array(this.frameSize)
    this.filled = 0
  }
}
