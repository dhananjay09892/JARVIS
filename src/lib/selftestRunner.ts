import { chosenMic, currentMic, openDeviceId } from './audio'
import { holdCamera, releaseCamera } from './camera'
import { openChosenMic } from './micChoice'
import { diagnoseOpenError, frameLevels, rmsDb, type CameraFacts, type Finding, type MicFacts } from './selftest'

/**
 * Hardware self-test (plan 29 phase 2, Q31): the measuring half, browser only.
 * The judgement lives in ./selftest.ts so it can be tested without a browser.
 *
 * Uses the same constraints as src/lib/audio.ts, and the microphone chosen in
 * Settings (Q77), so the levels are the levels JARVIS actually listens to. If
 * JARVIS has already opened that microphone the test reuses the stream
 * (opening a second one makes Chrome drop the first) and leaves it open;
 * otherwise it opens its own and closes it when done.
 *
 * No audio is kept: each block is reduced to one number and dropped.
 */

export type MicSession = {
  facts: MicFacts
  /** The microphone chosen in Settings was missing, so the default was tested. */
  fellBack: boolean
  /** Level of each ~40 ms block over `ms` milliseconds, in dBFS. */
  measure: (ms: number) => Promise<number[]>
  /** Play the test sound for `ms` and measure the microphone while it plays. */
  playAndMeasure: (ms: number) => Promise<number[]>
  close: () => void
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
  let stream: MediaStream
  let owned: boolean
  let fellBack: boolean
  try {
    ;({ stream, owned, fellBack } = await openChosenMic({
      chosen: chosenMic(),
      shared: currentMic(),
      sharedDeviceId: openDeviceId(),
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    }))
  } catch (err) {
    return diagnoseOpenError(err instanceof DOMException ? err.name : '')
  }
  const track = stream.getAudioTracks()[0]
  if (!track) {
    if (owned) stream.getTracks().forEach((t) => t.stop())
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
    fellBack,
    measure,
    playAndMeasure,
    close: () => {
      src.disconnect()
      void ctx.close().catch(() => {})
      if (owned) stream.getTracks().forEach((t) => t.stop())
    },
  }
}

export function isFinding(x: MicSession | Finding): x is Finding {
  return 'severity' in x
}

/**
 * The optional camera check (plan 29 flow step 2, Q77): open the camera
 * through the shared handle in ./camera.ts (so hand tracking is not blinded),
 * look at one small frame, and let go. Returns the facts for diagnoseCamera
 * and a small still so the user can see what the camera sees. The still
 * stays on this page; nothing is recorded or sent.
 */
export async function checkCamera(): Promise<{ facts: CameraFacts; still: string }> {
  if (!navigator.mediaDevices?.getUserMedia) return { facts: { error: 'unsupported', brightness: 0, contrast: 0 }, still: '' }
  let video: HTMLVideoElement
  try {
    video = await holdCamera()
  } catch (err) {
    return { facts: { error: err instanceof DOMException ? err.name : 'error', brightness: 0, contrast: 0 }, still: '' }
  }
  try {
    // Webcams ramp their exposure for a moment after opening.
    await new Promise((r) => setTimeout(r, 900))
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const g = canvas.getContext('2d')
    if (!g) return { facts: { error: 'error', brightness: 0, contrast: 0 }, still: '' }
    g.drawImage(video, 0, 0, canvas.width, canvas.height)
    const levels = frameLevels(g.getImageData(0, 0, canvas.width, canvas.height).data)
    return { facts: { error: '', ...levels }, still: canvas.toDataURL('image/jpeg', 0.7) }
  } finally {
    releaseCamera()
  }
}
