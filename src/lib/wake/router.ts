/**
 * Where microphone audio is allowed to go. The privacy core of plan 02.
 *
 * The voice-activity detector (vad.ts) cuts the microphone into speech
 * segments. Before the offline wake engine, every segment went to the
 * transcriber — including everything said in the room while JARVIS was
 * asleep, because the wake word itself was found in the transcript.
 *
 * With the offline engine active the rule is simple and testable:
 *
 *   A segment that ENDS while JARVIS is asleep never leaves the machine.
 *
 * It is held in memory for a moment (`graceMs`) in case the wake word turns
 * out to have been in it — the detector can finish scoring "hey jarvis" a few
 * hundred milliseconds after the energy gate closed — and is uploaded only if
 * a wake arrives in that window. Otherwise it is dropped. A segment that
 * started asleep but ends after a wake (the usual "hey jarvis, what's the time"
 * in one breath) is uploaded marked `afterWake`, so the transcript's leading
 * "hey jarvis" can be stripped and the rest becomes the command.
 *
 * When the offline engine is not active (turned off in Settings, or it failed
 * to start) the router behaves exactly as before, and the UI shows the
 * "cloud listening" badge so this is never silent.
 *
 * Nothing here touches the network itself: it decides, and `upload` acts.
 * That is what lets router.test.ts prove the rule with a fake `upload`.
 */

export type ListenMode = 'wake' | 'command' | 'guard' | 'deaf'

/** Long enough for the detector to catch up with the energy gate; short enough to be "a moment". */
export const WAKE_GRACE_MS = 1200

/** A wake followed by no command for this long, once he is back asleep, was a false wake. */
export const FALSE_WAKE_AFTER_MS = 1000

export type UploadMeta = {
  /** The segment began before the wake, so its transcript may start with the wake phrase. */
  afterWake: boolean
}

export type RouterStats = {
  /** Wake events from the offline detector. */
  wakes: number
  /** Wakes that led to no command before he went back to sleep. */
  falseWakes: number
  /** Segments uploaded for transcription, any mode. */
  uploads: number
  /** Segments that ended while asleep and were dropped on this machine. */
  droppedAsleep: number
  /** Bytes of audio dropped on this machine while asleep. */
  droppedBytes: number
  /**
   * Bytes uploaded while asleep with no wake: what cloud listening costs in
   * privacy. Always 0 while the offline engine is on (router.test.ts).
   */
  uploadedAsleepBytes: number
}

export type AudioRouter = {
  /** The VAD confirmed speech; `mode` is the mode at that moment. */
  segmentStart: (mode: ListenMode) => void
  /** The VAD closed a segment; `mode` is the mode now. */
  segmentEnd: (audio: Blob, mode: ListenMode) => void
  /** The offline detector heard the wake phrase. */
  wake: () => void
  /** A command made it through to the app (used to tell real wakes from false ones). */
  accepted: () => void
  /** Called a few times a second with the current mode: expires held audio, counts false wakes. */
  tick: (mode: ListenMode) => void
  stats: () => RouterStats
}

export type RouterOptions = {
  /** Whether the offline wake engine is running right now. */
  offline: () => boolean
  /** Send a segment to the transcriber. */
  upload: (audio: Blob, meta: UploadMeta) => void
  now?: () => number
  graceMs?: number
}

/**
 * For the browser's SpeechRecognition path, which streams continuously rather
 * than in segments: may the cloud recogniser run in this mode? Only "asleep
 * with the offline engine on" says no. ('deaf' is unchanged from before: the
 * recogniser keeps its session and its results are discarded.)
 */
export function cloudMayListen(mode: ListenMode, offline: boolean): boolean {
  return !(offline && mode === 'wake')
}

export function makeAudioRouter(opts: RouterOptions): AudioRouter {
  const now = opts.now ?? (() => Date.now())
  const graceMs = opts.graceMs ?? WAKE_GRACE_MS
  const s: RouterStats = {
    wakes: 0,
    falseWakes: 0,
    uploads: 0,
    droppedAsleep: 0,
    droppedBytes: 0,
    uploadedAsleepBytes: 0,
  }

  let startedAsleep = false
  let held: { audio: Blob; at: number } | null = null
  let awaitingCommandSince = 0

  const send = (audio: Blob, meta: UploadMeta, asleepNoWake = false) => {
    s.uploads++
    if (asleepNoWake) s.uploadedAsleepBytes += audio.size
    opts.upload(audio, meta)
  }

  const dropHeld = () => {
    if (!held) return
    s.droppedAsleep++
    s.droppedBytes += held.audio.size
    held = null
  }

  return {
    segmentStart(mode) {
      startedAsleep = mode === 'wake'
    },

    segmentEnd(audio, mode) {
      const wasAsleep = startedAsleep
      startedAsleep = false
      if (mode === 'deaf') return

      if (!opts.offline()) {
        // Cloud listening: the transcript is how the wake word is found.
        send(audio, { afterWake: false }, mode === 'wake')
        return
      }

      if (mode === 'wake') {
        // Asleep and no wake yet: keep it here, briefly, and nowhere else.
        dropHeld()
        held = { audio, at: now() }
        return
      }

      send(audio, { afterWake: wasAsleep })
    },

    wake() {
      s.wakes++
      awaitingCommandSince = now()
      if (held && now() - held.at <= graceMs) {
        const { audio } = held
        held = null
        send(audio, { afterWake: true })
      } else {
        dropHeld()
      }
    },

    accepted() {
      awaitingCommandSince = 0
    },

    tick(mode) {
      const t = now()
      if (held && t - held.at > graceMs) dropHeld()
      if (awaitingCommandSince && mode === 'wake' && t - awaitingCommandSince > FALSE_WAKE_AFTER_MS) {
        s.falseWakes++
        awaitingCommandSince = 0
      }
    },

    stats: () => ({ ...s }),
  }
}
