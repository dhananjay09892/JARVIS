/**
 * Turning a recorded segment into what the speaker service wants: 16 kHz mono
 * 16-bit little-endian PCM (plan 01, Q85). The pure parts are separate from the
 * browser decode so they can be tested.
 */

export const SPEAKER_RATE = 16000

/** Average all channels into one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(channels[0].length)
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length
  return out
}

/** Linear resampling. Speech for an embedding does not need better. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input
  const n = Math.max(1, Math.round((input.length * to) / from))
  const out = new Float32Array(n)
  const ratio = from / to
  for (let i = 0; i < n; i++) {
    const pos = i * ratio
    const i0 = Math.min(input.length - 1, Math.floor(pos))
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** Float samples in -1..1 to 16-bit little-endian bytes, clipped. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
  }
  return out
}

/** Join several clips into one, in order. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Seconds of audio in a PCM16 buffer at the speaker rate. */
export const seconds = (pcm: Uint8Array) => pcm.length / 2 / SPEAKER_RATE

/** Decode a recorded blob (webm/opus, mp4...) to PCM16 at 16 kHz. Browser only. */
export async function blobToPcm16(blob: Blob): Promise<Uint8Array> {
  const ctx = new AudioContext()
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer())
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
    return toPcm16(resample(mixToMono(channels), audio.sampleRate, SPEAKER_RATE))
  } finally {
    void ctx.close()
  }
}
