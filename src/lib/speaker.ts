import { BRIDGE_HTTP_URL } from '../config'
import { blobToPcm16, concat, seconds } from './pcm.ts'

/**
 * Page side of speaker identification (plan 01, Q85). The bridge does the
 * recognising; this sends it 16 kHz PCM in parallel with the transcription so
 * no latency is added to the turn, and does the enrolment recording. Nothing
 * here is used unless Settings → "Recognise who is speaking" is on.
 */

export type Person = { id: string; name: string; role: string; clips: number }

let enabled = false
export const setSpeakerEnabled = (on: boolean) => {
  enabled = on
}
export const speakerEnabled = () => enabled

const post = (path: string, body?: Uint8Array) =>
  fetch(`${BRIDGE_HTTP_URL}/speaker/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: body as BodyInit | undefined,
  })

// -- identify -----------------------------------------------------------------

/** Fire and forget: the bridge remembers who spoke last for the next turn. */
export function identifySegment(blob: Blob): void {
  if (!enabled) return
  void (async () => {
    try {
      await post('identify', await blobToPcm16(blob))
    } catch {
      // Identification is a nicety; a failure leaves the turn as it was.
    }
  })()
}

// -- segments kept while a spoken enrolment is sampling ----------------------------

const MAX_KEPT = 8
let sampling: Blob[] | null = null

/** Voice calls this with every segment captured while the user is talking to JARVIS. */
export function offerSegment(blob: Blob): void {
  identifySegment(blob)
  if (sampling) {
    sampling.push(blob)
    if (sampling.length > MAX_KEPT) sampling.shift()
  }
}

export const startSampling = () => {
  sampling = []
}
export const stopSampling = () => {
  sampling = null
}

export type EnrolReply = { ok: boolean; reason?: string; person?: Person }

/** Enrol from raw PCM16. `consent` must come from a yes the person actually gave. */
export async function enrolPcm(pcm: Uint8Array, name: string, role: string, consent: boolean): Promise<EnrolReply> {
  const q = new URLSearchParams({ name, role, consent: consent ? '1' : '0' })
  const res = await post(`enroll?${q}`, pcm)
  return (await res.json().catch(() => ({ ok: false, reason: 'failed' }))) as EnrolReply
}

/** Enrol from the segments heard since startSampling(). */
export async function enrolSampled(name: string, role = 'owner'): Promise<EnrolReply> {
  const blobs = sampling ?? []
  sampling = null
  if (blobs.length === 0) return { ok: false, reason: 'too-short' }
  const pcm = concat(await Promise.all(blobs.map(blobToPcm16)))
  if (seconds(pcm) < 1) return { ok: false, reason: 'too-short' }
  return enrolPcm(pcm, name, role, true)
}

/** Record `ms` from the microphone and enrol it. Used by Settings. */
export async function recordAndEnrol(name: string, role: string, ms = 8000): Promise<EnrolReply> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  try {
    const rec = new MediaRecorder(stream)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    const done = new Promise<void>((r) => (rec.onstop = () => r()))
    rec.start()
    await new Promise((r) => setTimeout(r, ms))
    rec.stop()
    await done
    const pcm = await blobToPcm16(new Blob(chunks, { type: rec.mimeType }))
    return enrolPcm(pcm, name, role, true)
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}

// -- people ---------------------------------------------------------------------

export async function listPeople(): Promise<{ ok: boolean; reason?: string; people: Person[] }> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/speaker/people`)
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; people?: Person[] }
  return { ok: Boolean(j.ok), reason: j.reason, people: j.people ?? [] }
}

export async function forgetPerson(id: string): Promise<boolean> {
  const res = await post(`people/${encodeURIComponent(id)}/forget`)
  return res.ok
}
