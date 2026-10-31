/**
 * Choosing the microphone inside JARVIS (plan 29 phase 2, Q77).
 *
 * Until now JARVIS always took the Windows default input, so a wrong default
 * (a webcam microphone that is switched off, a "Stereo Mix" loopback) could
 * only be fixed in Windows. The choice made here is used by getMic() in
 * ./audio.ts, which feeds the wake word, voice detection and clap, and by the
 * hardware self-test, so the test checks the microphone JARVIS will use.
 *
 * Not covered: the browser's own speech recognition (used when there is no
 * ElevenLabs key) opens its own input and always takes the Windows default.
 * The control says so.
 *
 * The choice is a browser device id, kept in this browser only (ids are per
 * site and per browser profile, so there is nothing useful to keep anywhere
 * else). It is never sent to the bridge or counted in a metric.
 *
 * Pure apart from the injected getUserMedia, so it runs under `node --test`.
 */

/** The same processing JARVIS has always asked for; the levels in selftest.ts assume it. */
export const MIC_PROCESSING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const

/** '' means "whatever Windows has as the default input". */
export const SYSTEM_DEFAULT = ''

export const MIC_CHOICE_KEY = 'jarvis.micDeviceId'

/** Constraints for getUserMedia: the chosen device exactly, or the default. */
export function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: deviceId ? { ...MIC_PROCESSING, deviceId: { exact: deviceId } } : { ...MIC_PROCESSING },
  }
}

export type DeviceLike = { kind: string; deviceId: string; label: string; groupId?: string }
export type MicOption = { id: string; label: string }

/**
 * The real microphones to offer, in the browser's order. Chrome also lists
 * "default" and "communications" entries that are aliases of a real device;
 * those are left out (the "Windows default" option covers them). Labels are
 * empty until the microphone has been allowed once, so they get a number.
 */
export function micOptions(devices: readonly DeviceLike[]): MicOption[] {
  const out: MicOption[] = []
  const seen = new Set<string>()
  for (const d of devices) {
    if (d.kind !== 'audioinput') continue
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue
    if (seen.has(d.deviceId)) continue
    seen.add(d.deviceId)
    out.push({ id: d.deviceId, label: d.label || `Microphone ${out.length + 1}` })
  }
  return out
}

/** Whether a stream already open on `openDeviceId` is the one the user chose. */
export function streamIsChosen(openDeviceId: string | undefined, chosen: string): boolean {
  return !chosen || openDeviceId === chosen
}

export type OpenedMic = {
  stream: MediaStream
  /** True when this call opened the stream (the caller closes it); false when it reused `shared`. */
  owned: boolean
  /** True when the chosen microphone could not be opened and the default was used instead. */
  fellBack: boolean
}

/**
 * Open the chosen microphone, reusing `shared` when it is already the right
 * one (a second getUserMedia makes Chrome drop the first stream). If the
 * chosen device is gone (unplugged), fall back to the default rather than
 * leave JARVIS deaf, and say so. Other errors (blocked, busy) are thrown as
 * they are, for diagnoseOpenError.
 */
export async function openChosenMic(opts: {
  chosen: string
  shared: MediaStream | null
  sharedDeviceId?: string
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
}): Promise<OpenedMic> {
  const { chosen, shared, sharedDeviceId, getUserMedia } = opts
  if (shared && streamIsChosen(sharedDeviceId, chosen)) return { stream: shared, owned: false, fellBack: false }
  if (!chosen) return { stream: await getUserMedia(micConstraints(SYSTEM_DEFAULT)), owned: true, fellBack: false }
  try {
    return { stream: await getUserMedia(micConstraints(chosen)), owned: true, fellBack: false }
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw err
    if (shared) return { stream: shared, owned: false, fellBack: true }
    return { stream: await getUserMedia(micConstraints(SYSTEM_DEFAULT)), owned: true, fellBack: true }
  }
}

/** Storage that may be missing or throw (private windows, blocked site data). */
export type StoreLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export function readChoice(store: StoreLike | null | undefined): string {
  try {
    return store?.getItem(MIC_CHOICE_KEY) ?? SYSTEM_DEFAULT
  } catch {
    return SYSTEM_DEFAULT
  }
}

export function writeChoice(store: StoreLike | null | undefined, deviceId: string): void {
  try {
    if (deviceId) store?.setItem(MIC_CHOICE_KEY, deviceId)
    else store?.removeItem(MIC_CHOICE_KEY)
  } catch {
    /* not kept: the choice lasts until the page reloads */
  }
}
