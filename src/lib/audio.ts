/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 */

import { openChosenMic, readChoice, writeChoice } from './micChoice'

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null

const storage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The microphone chosen under Settings → Microphone and speakers ('' = Windows default). Q77. */
let chosen = readChoice(storage())
/** Whether the open stream fell back to the default because the chosen one is gone. */
let fellBack = false

export function chosenMic(): string {
  return chosen
}

/**
 * Choose the microphone (Q77). Kept in this browser only. If the microphone
 * is already open on another device it keeps running until the page reloads:
 * the wake word, voice detection and clap each hold the stream, so swapping it
 * under them is not safe. Returns whether a reload is needed.
 */
export function setChosenMic(deviceId: string): boolean {
  const before = chosen
  chosen = deviceId
  writeChoice(storage(), deviceId)
  if (!stream || before === deviceId) return false
  // Back to the Windows default: the open stream may already be on it, but
  // there is no way to tell, so a reload is the honest answer.
  return deviceId ? openDeviceId() !== deviceId : true
}

/** The device id of the open stream, if any. */
export function openDeviceId(): string | undefined {
  return stream?.getAudioTracks()[0]?.getSettings?.().deviceId
}

/** True when the chosen microphone was missing and getMic() used the default. */
export function micFellBack(): boolean {
  return fellBack
}

export async function getMic(): Promise<MediaStream> {
  if (stream) return stream
  const opened = await openChosenMic({
    chosen,
    shared: null,
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  })
  stream = opened.stream
  fellBack = opened.fellBack
  return stream
}

/** The shared stream if something has already opened it, without opening it. */
export function currentMic(): MediaStream | null {
  return stream
}

export async function startAnalyser(): Promise<void> {
  if (analyser) return
  const s = await getMic()
  ctx = new AudioContext()
  const src = ctx.createMediaStreamSource(s)
  analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.75
  src.connect(analyser)
  buf = new Uint8Array(analyser.frequencyBinCount)
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
