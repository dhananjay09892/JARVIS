import { currentMic } from './audio'
import { diagnoseOpenError, rmsDb, type Finding, type MicFacts } from './selftest'

/**
 * Hardware self-test (plan 29 phase 2, Q31): the measuring half, browser only.
 * The judgement lives in ./selftest.ts so it can be tested without a browser.
 *
 * Uses the same constraints as src/lib/audio.ts, so the levels are the levels
 * JARVIS actually listens to. If JARVIS has already opened the microphone the
 * test reuses that stream (opening a second one makes Chrome drop the first)
 * and leaves it open; otherwise it opens its own and closes it when done.
 *
 * No audio is kept: each block is reduced to one number and dropped.
 */

export type MicSession = {
  facts: MicFacts
  /** Level of each ~40 ms block over `ms` milliseconds, in dBFS. */
  measure: (ms: number) => Promise<number[]>
  /** Play the test sound for `ms` and measure the microphone while it plays. */
  playAndMeasure: (ms: number) => Promise<number[]>
  close: () => void
}

const CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
}

export async function openMicSession(): Promise<MicSession | Finding> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      id: 'mic-unsupported',
      severity: 'fail',
      title: 'This browser cannot use a microphone here.',
      fix: 'Open JARVIS in Chrome or Edge at the address the launcher shows (http://localhost…), not inside another app.',
    }
  }
  const shared = currentMic()
  let stream: MediaStream
  try {
    stream = shared ?? (await navigator.mediaDevices.getUserMedia(CONSTRAINTS))
  } catch (err) {
    return diagnoseOpenError(err instanceof DOMException ? err.name : '')
  }
  const track = stream.getAudioTracks()[0]
  if (!track) {
    if (!shared) stream.getTracks().forEach((t) => t.stop())
    return diagnoseOpenError('NotFoundError')
  }
  // Labels are only filled in once permission is granted, which it now is.
  const inputs = (await navigator.mediaDevices.enumerateDevices().catch((): MediaDeviceInfo[] => []))
    .filter((d) => d.kind === 'audioinput')
    .map((d) => d.label)

  const ctx = new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
  const src = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  src.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)

  const measure = (ms: number) =>
    new Promise<number[]>((resolve) => {
      const out: number[] = []
      const id = setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        out.push(rmsDb(buf))
      }, 40)
      setTimeout(() => {
        clearInterval(id)
        resolve(out)
      }, ms)
    })

  /** A rising two-tone chime, repeated: easy to recognise, covers voice frequencies. */
  const playAndMeasure = async (ms: number) => {
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(ctx.destination)
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.connect(gain)
    const t0 = ctx.currentTime + 0.05
    for (let t = 0; t < ms / 1000; t += 0.5) {
      osc.frequency.setValueAtTime(660, t0 + t)
      osc.frequency.setValueAtTime(880, t0 + t + 0.25)
    }
    gain.gain.setValueAtTime(0.25, t0)
    gain.gain.setValueAtTime(0, t0 + ms / 1000)
    osc.start(t0)
    osc.stop(t0 + ms / 1000 + 0.05)
    // Skip the first 150 ms so the measurement covers the sound, not its start.
    await new Promise((r) => setTimeout(r, 150))
    const blocks = await measure(Math.max(200, ms - 200))
    gain.disconnect()
    return blocks
  }

  return {
    facts: { label: track.label, trackMuted: track.muted || !track.enabled, inputs },
    measure,
    playAndMeasure,
    close: () => {
      src.disconnect()
      void ctx.close().catch(() => {})
      if (!shared) stream.getTracks().forEach((t) => t.stop())
    },
  }
}

export function isFinding(x: MicSession | Finding): x is Finding {
  return 'severity' in x
}
