/**
 * Hardware self-test (plan 29 phase 2, Q31): the judgement half.
 *
 * The wizard's "Microphone and speakers" step measures four things in the
 * browser (src/lib/selftestRunner.ts) and hands the numbers to these pure
 * functions, which decide what is wrong and say how to fix it in plain words:
 *
 *   1. opening the microphone: permission, no device, device busy;
 *   2. which microphone the browser picked: muted, a virtual/loopback device
 *      instead of a real one, a microphone that sends nothing while another
 *      one is plugged in;
 *   3. noise floor (a quiet moment) and voice level (the user says a line);
 *   4. speaker and echo: a test sound plays; the user says whether they heard
 *      it, and the microphone measures how much of it leaks back in (JARVIS
 *      hearing himself is what makes him interrupt or wake himself).
 *
 * Nothing here touches the DOM or the network, so it runs under `node --test`.
 * Levels are RMS in dBFS (0 is full scale, silence is very negative), measured
 * on the same processed stream JARVIS listens to (echo cancellation, noise
 * suppression and auto gain on), so the thresholds are for that stream.
 *
 * Measurements stay on the page. Nothing is recorded or sent anywhere.
 */

export type Severity = 'ok' | 'warn' | 'fail'

export type Finding = {
  /** Stable id, for tests and for a later metric (plan 16). */
  id: string
  severity: Severity
  /** One line: what we found. */
  title: string
  /** What to do about it. Empty for 'ok'. */
  fix: string
}

/** Anything quieter than this over a whole window is not a real microphone signal
 *  (a muted Windows input delivers exact zeros; a quiet room under noise
 *  suppression still sits well above this). */
export const SILENCE_DB = -100
/** Quiet-room floor on the processed stream; above WARN JARVIS may mishear, above FAIL he will. */
export const NOISE_WARN_DB = -50
export const NOISE_FAIL_DB = -38
/** Loudest 100 ms of the spoken line should reach this. */
export const VOICE_QUIET_DB = -42
/** The voice must stand this far above the room. */
export const VOICE_MARGIN_DB = 12
/** How far the test sound may raise the microphone level before it counts as echo. */
export const ECHO_WARN_DB = 8
export const ECHO_FAIL_DB = 18

const MIN_DB = -120

/** RMS level of a block of samples in dBFS, floored at -120 so silence is a number. */
export function rmsDb(samples: ArrayLike<number>): number {
  if (!samples.length) return MIN_DB
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / samples.length)
  if (rms <= 0) return MIN_DB
  return Math.max(MIN_DB, 20 * Math.log10(rms))
}

/**
 * Levels for a run of short blocks: the quiet floor (20th percentile, so a
 * cough does not count as room noise) and the peak (loudest block).
 */
export function summarise(blockDbs: readonly number[]): { floor: number; peak: number } {
  if (!blockDbs.length) return { floor: MIN_DB, peak: MIN_DB }
  const sorted = [...blockDbs].sort((a, b) => a - b)
  return { floor: sorted[Math.floor((sorted.length - 1) * 0.2)], peak: sorted[sorted.length - 1] }
}

const PRIVACY_FIX =
  'Windows: Settings → Privacy & security → Microphone, turn on “Microphone access” and “Let desktop apps access your microphone”. In the browser, click the icon left of the address bar and allow the microphone for this page, then run the test again.'

/** Advice for a getUserMedia failure, by the DOMException name. */
export function diagnoseOpenError(name: string): Finding {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        id: 'mic-blocked',
        severity: 'fail',
        title: 'The microphone is blocked.',
        fix: PRIVACY_FIX,
      }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        id: 'mic-none',
        severity: 'fail',
        title: 'No microphone was found.',
        fix: 'Plug in a microphone or headset. If one is plugged in, check Windows: Settings → System → Sound → Input, and make sure it is listed and not disabled.',
      }
    case 'NotReadableError':
    case 'AbortError':
      return {
        id: 'mic-busy',
        severity: 'fail',
        title: 'The microphone is there but could not be opened.',
        fix: 'Another app may be holding it (a call or recording app). Close that app, or unplug the microphone and plug it back in, then run the test again.',
      }
    default:
      return {
        id: 'mic-error',
        severity: 'fail',
        title: 'The microphone could not be opened.',
        fix: 'Restart the browser and run the test again. If it keeps failing, check the microphone in Windows: Settings → System → Sound → Input.',
      }
  }
}

/**
 * Microphone names that are not a microphone: loopback and virtual mixers
 * record what the computer plays, not the room. A common way to end up with
 * JARVIS "hearing nothing" after installing streaming or call software.
 */
const VIRTUAL = [
  /stereo mix/i,
  /what u hear/i,
  /wave out mix/i,
  /\bloopback\b/i,
  /monitor of/i,
  /\bcable (output|input)\b/i,
  /vb-audio/i,
  /voicemeeter/i,
  /virtual/i,
  /blackhole/i,
  /soundflower/i,
]

export function looksVirtual(label: string): boolean {
  return VIRTUAL.some((re) => re.test(label))
}

/** Chrome lists the default device twice, once as "Default - <name>"; strip that. */
export function plainLabel(label: string): string {
  return label.replace(/^(default|communications)\s*-\s*/i, '').trim()
}

export type MicFacts = {
  /** The label of the track we got (the device the browser picked). */
  label: string
  /** track.muted: the OS or hardware is not delivering audio. */
  trackMuted: boolean
  /** Labels of every audio input the browser can see, including the one in use. */
  inputs: readonly string[]
}

/** Other real microphones the user could switch to. */
export function alternatives(facts: Pick<MicFacts, 'label' | 'inputs'>): string[] {
  const current = plainLabel(facts.label)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of facts.inputs) {
    const name = plainLabel(raw)
    if (!name || name === current || looksVirtual(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

const SWITCH_FIX = (others: string[]) =>
  `Choose ${others.length ? `“${others[0]}”` : 'your real microphone'} under “Microphone” above this check, or make it the default input in Windows: Settings → System → Sound → Input. Then run the test again. (The browser's own speech recognition always uses the Windows default, so set it there too if JARVIS uses that.)`

/** Checks on the device itself, before any sound is measured. */
export function diagnoseDevice(facts: MicFacts): Finding[] {
  const out: Finding[] = []
  const name = plainLabel(facts.label) || 'the default microphone'
  if (looksVirtual(facts.label)) {
    out.push({
      id: 'mic-virtual',
      severity: 'fail',
      title: `The default microphone is “${name}”, which records the computer's own sound, not your voice.`,
      fix: SWITCH_FIX(alternatives(facts)),
    })
  }
  if (facts.trackMuted) {
    out.push({
      id: 'mic-muted',
      severity: 'fail',
      title: `“${name}” is muted.`,
      fix: 'Check the mute switch or button on the microphone or headset (often a red light). On Windows also check Settings → System → Sound → Input → volume, and the microphone key on the keyboard if it has one.',
    })
  }
  return out
}

/**
 * The quiet moment: is the microphone alive, and how noisy is the room?
 * `floor` and `peak` are from summarise() over the quiet window.
 */
export function diagnoseQuiet(facts: MicFacts, level: { floor: number; peak: number }): Finding[] {
  const name = plainLabel(facts.label) || 'the default microphone'
  if (level.peak <= SILENCE_DB) {
    const others = alternatives(facts)
    // Pure digital silence with another microphone plugged in: almost always
    // Windows picked the wrong default (a disconnected headset, a webcam mic
    // that is switched off). With no alternative it is a mute.
    if (others.length) {
      return [
        {
          id: 'mic-wrong-device',
          severity: 'fail',
          title: `“${name}” sends no sound at all, and another microphone (“${others[0]}”) is plugged in.`,
          fix: SWITCH_FIX(others),
        },
      ]
    }
    return [
      {
        id: 'mic-silent',
        severity: 'fail',
        title: `“${name}” sends no sound at all. It is probably muted.`,
        fix: `Check the mute switch on the microphone or headset, and Windows: Settings → System → Sound → Input → volume (not 0). ${PRIVACY_FIX}`,
      },
    ]
  }
  if (level.floor >= NOISE_FAIL_DB) {
    return [
      {
        id: 'noise-high',
        severity: 'fail',
        title: 'The room is too loud for JARVIS to hear you reliably.',
        fix: 'Turn down music or the TV, move away from fans, or use a headset with a microphone close to your mouth.',
      },
    ]
  }
  if (level.floor >= NOISE_WARN_DB) {
    return [
      {
        id: 'noise-some',
        severity: 'warn',
        title: 'There is some background noise.',
        fix: 'JARVIS should still hear you. If he mishears, reduce the noise or move the microphone closer.',
      },
    ]
  }
  return [{ id: 'noise-ok', severity: 'ok', title: 'The room is quiet enough.', fix: '' }]
}

/** The spoken line: loud enough, and clearly above the room? */
export function diagnoseVoice(facts: MicFacts, quietFloor: number, speech: { peak: number }): Finding[] {
  const others = alternatives(facts)
  if (speech.peak <= SILENCE_DB) return diagnoseQuiet(facts, { floor: speech.peak, peak: speech.peak })
  if (speech.peak < VOICE_QUIET_DB) {
    return [
      {
        id: 'voice-quiet',
        severity: 'fail',
        title: 'Your voice is very quiet on this microphone.',
        fix:
          `Speak a little closer to the microphone, and raise its volume in Windows: Settings → System → Sound → Input.` +
          (others.length ? ` If you meant to use “${others[0]}”, make it the default input there.` : ''),
      },
    ]
  }
  if (speech.peak - quietFloor < VOICE_MARGIN_DB) {
    return [
      {
        id: 'voice-buried',
        severity: 'warn',
        title: 'Your voice is only a little louder than the room.',
        fix: 'Reduce the background noise, or move the microphone closer to you.',
      },
    ]
  }
  return [{ id: 'voice-ok', severity: 'ok', title: 'JARVIS can hear you clearly.', fix: '' }]
}

/**
 * The test sound: did the user hear it (speakers), and how much did the
 * microphone pick it up (echo)? `heard` is null until the user answers.
 */
export function diagnoseSpeaker(heard: boolean | null, quietFloor: number, duringSound: { floor: number }): Finding[] {
  const out: Finding[] = []
  if (heard === false) {
    out.push({
      id: 'speaker-silent',
      severity: 'fail',
      title: 'You did not hear the test sound.',
      fix: 'Check the volume and mute key, and that the right speakers or headphones are chosen in Windows: Settings → System → Sound → Output. Then play the sound again.',
    })
  } else if (heard === true) {
    out.push({ id: 'speaker-ok', severity: 'ok', title: 'The speakers work.', fix: '' })
  }
  // The floor while the sound plays, not the peak: a single click does not count.
  const rise = duringSound.floor - quietFloor
  if (rise >= ECHO_FAIL_DB) {
    out.push({
      id: 'echo-high',
      severity: 'warn',
      title: 'The microphone hears the speakers loudly. JARVIS may hear himself and stop or wake on his own voice.',
      fix: 'Use headphones, lower the speaker volume, or move the microphone away from the speakers.',
    })
  } else if (rise >= ECHO_WARN_DB) {
    out.push({
      id: 'echo-some',
      severity: 'warn',
      title: 'The microphone hears some of the speakers.',
      fix: 'Usually fine. If JARVIS interrupts himself, lower the volume or use headphones.',
    })
  } else {
    out.push({ id: 'echo-ok', severity: 'ok', title: 'No echo from the speakers.', fix: '' })
  }
  return out
}

/** The worst severity in a list, for the step's one-line verdict. */
export function worst(findings: readonly Finding[]): Severity {
  if (findings.some((f) => f.severity === 'fail')) return 'fail'
  if (findings.some((f) => f.severity === 'warn')) return 'warn'
  return 'ok'
}

/**
 * The microphone chosen in Settings (Q77) could not be opened, so the
 * Windows default was used instead: usually a headset that is unplugged.
 */
export function diagnoseChoice(fellBack: boolean): Finding[] {
  if (!fellBack) return []
  return [
    {
      id: 'mic-choice-missing',
      severity: 'warn',
      title: 'The microphone chosen under “Microphone” is not plugged in, so the Windows default was tested instead.',
      fix: 'Plug it back in, or choose another microphone (or “Windows default”) above, then run the test again.',
    },
  ]
}

/** What the optional camera check saw (plan 29 flow step 2). */
export type CameraFacts = {
  /** The DOMException name if the camera could not be opened, '' otherwise. */
  error: string
  /** Average brightness of one small frame, 0 (black) to 255 (white). */
  brightness: number
  /** How much the frame varies (standard deviation of brightness). A covered lens is flat as well as dark. */
  contrast: number
}

/** Below this the picture is black: a lens cover, a privacy shutter, or a camera switched off. */
export const CAMERA_DARK = 14
/** A covered lens is also flat; a dim room still has some detail. */
export const CAMERA_FLAT = 6

/**
 * The optional camera check. JARVIS works without a camera; it is only for
 * hand gestures and "look at this". One frame is looked at on this page and
 * dropped; nothing is recorded or sent.
 */
export function diagnoseCamera(facts: CameraFacts): Finding[] {
  switch (facts.error) {
    case '':
      break
    case 'unsupported':
      return [
        {
          id: 'camera-unsupported',
          severity: 'warn',
          title: 'This browser cannot use a camera here.',
          fix: 'Open JARVIS in Chrome or Edge at the address the launcher shows (http://localhost…). JARVIS works without a camera.',
        },
      ]
    case 'NotAllowedError':
    case 'SecurityError':
      return [
        {
          id: 'camera-blocked',
          severity: 'warn',
          title: 'The camera is blocked.',
          fix: 'Windows: Settings → Privacy & security → Camera, turn on “Camera access” and “Let desktop apps access your camera”. In the browser, click the icon left of the address bar and allow the camera for this page. JARVIS works without it.',
        },
      ]
    case 'NotFoundError':
    case 'OverconstrainedError':
      return [
        {
          id: 'camera-none',
          severity: 'warn',
          title: 'No camera was found.',
          fix: 'That is fine: the camera is only for hand gestures and “look at this”. Plug in a webcam if you want those.',
        },
      ]
    case 'NotReadableError':
    case 'AbortError':
      return [
        {
          id: 'camera-busy',
          severity: 'warn',
          title: 'The camera is there but could not be opened.',
          fix: 'Another app (a video call, the Camera app) may be using it. Close that app and test again.',
        },
      ]
    default:
      return [
        {
          id: 'camera-error',
          severity: 'warn',
          title: 'The camera could not be opened.',
          fix: 'Restart the browser and test again. JARVIS works without a camera.',
        },
      ]
  }
  if (facts.brightness < CAMERA_DARK && facts.contrast < CAMERA_FLAT) {
    return [
      {
        id: 'camera-dark',
        severity: 'warn',
        title: 'The camera opened, but the picture is black.',
        fix: 'Check for a lens cover or a privacy slider on the webcam, or a camera key on the keyboard (often F8 or F10). Then test again.',
      },
    ]
  }
  return [{ id: 'camera-ok', severity: 'ok', title: 'The camera works.', fix: '' }]
}

/** Brightness and contrast of RGBA pixels (from a canvas), for diagnoseCamera. */
export function frameLevels(rgba: ArrayLike<number>): { brightness: number; contrast: number } {
  const n = Math.floor(rgba.length / 4)
  if (!n) return { brightness: 0, contrast: 0 }
  let sum = 0
  let sq = 0
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]
    sum += y
    sq += y * y
  }
  const mean = sum / n
  return { brightness: mean, contrast: Math.sqrt(Math.max(0, sq / n - mean * mean)) }
}

/**
 * The ids worth counting in the opt-in setup metric (Q77): everything that is
 * not "ok". Ids only: never titles, which can name a device.
 */
export function problemIds(findings: readonly Finding[]): string[] {
  return findings.filter((f) => f.severity !== 'ok').map((f) => f.id)
}
