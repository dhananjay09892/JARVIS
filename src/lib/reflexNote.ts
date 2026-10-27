/**
 * Telling the brain what reflexes did (plan 06 phase 1, Q75).
 *
 * Reflexes answer on the page without the model, so on its own the model
 * never learns that a timer was set or the volume changed, and "what was that
 * timer for?" draws a blank. This keeps a short memory of reflex exchanges
 * and builds one short note that rides along with the next model turn as part
 * of its preface (the bridge adds it to the turn's instructions; the stored
 * conversation keeps only what the owner said).
 *
 * The note says:
 *   - the reflex exchanges since the last model turn (at most three),
 *   - timers that finished since then,
 *   - every timer still running, with its name, length and time left,
 *   - the voice volume, once a reflex has changed it.
 *
 * Nothing new leaves the machine that the owner did not already say to
 * JARVIS: these are commands that would have gone to the model anyway had
 * there been no reflex layer. Pure apart from its own small state.
 */
import { speakDuration, speakTime, timerName, type TimerView, type VolumeState } from './reflex.ts'

export type ReflexExchange = { said: string; answer: string | null; at: number }

export type ReflexNoteState = {
  now: Date
  timers: TimerView[]
  volume: VolumeState
  locale?: string
}

/** Most reflex exchanges carried into one note. */
export const MAX_EXCHANGES = 3
/** Most running timers listed. */
const MAX_TIMERS_LISTED = 5
/** Longest the note gets; the bridge accepts up to 1000 characters of page preface. */
export const MAX_NOTE = 900
const MAX_QUOTE = 100

const quote = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return `"${t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t}"`
}

export type ReflexMemory = {
  /** A reflex was answered: what was said, and what JARVIS answered (null for silence). */
  record(said: string, answer: string | null, opts?: { volumeChanged?: boolean; at?: number }): void
  /** A timer finished. */
  timerDone(t: { ms: number; label?: string }, at?: number): void
  /** The note for the next model turn, or '' when there is nothing to tell. */
  note(state: ReflexNoteState): string
  /** The model turn carrying the note went out: exchanges and finished timers are now known to it. */
  sent(): void
  /** A new conversation: forget everything. */
  clear(): void
}

export function makeReflexMemory(): ReflexMemory {
  let exchanges: ReflexExchange[] = []
  let finished: { name: string; at: number }[] = []
  let volumeChanged = false

  return {
    record(said, answer, opts = {}) {
      exchanges.push({ said, answer, at: opts.at ?? Date.now() })
      if (exchanges.length > MAX_EXCHANGES) exchanges = exchanges.slice(-MAX_EXCHANGES)
      if (opts.volumeChanged) volumeChanged = true
    },

    timerDone(t, at = Date.now()) {
      finished.push({ name: timerName(t), at })
      if (finished.length > MAX_EXCHANGES) finished = finished.slice(-MAX_EXCHANGES)
    },

    note({ now, timers, volume, locale = 'en-GB' }) {
      const clock = (ms: number) => speakTime(new Date(ms), locale)
      const lines: string[] = []
      for (const e of exchanges) {
        lines.push(`At ${clock(e.at)} the user said ${quote(e.said)} and you answered ${e.answer ? quote(e.answer) : 'by going quiet'}.`)
      }
      for (const f of finished) lines.push(`${f.name[0].toUpperCase()}${f.name.slice(1)} finished at ${clock(f.at)}.`)
      if (timers.length) {
        const running = [...timers]
          .sort((a, b) => a.endsAt - b.endsAt)
          .slice(0, MAX_TIMERS_LISTED)
          .map((t) => `${timerName(t)} (${speakDuration(t.ms)}, set at ${clock(t.endsAt - t.ms)}, ${speakDuration(Math.max(0, t.endsAt - now.getTime()))} left)`)
        const more = timers.length > MAX_TIMERS_LISTED ? ` and ${timers.length - MAX_TIMERS_LISTED} more` : ''
        lines.push(`Timers running now: ${running.join('; ')}${more}.`)
      } else if (exchanges.length || finished.length) {
        lines.push('No timers are running now.')
      }
      if (volumeChanged || volume.muted) {
        lines.push(`Your voice volume is ${Math.round(volume.level * 100)} percent${volume.muted ? ', muted' : ''}.`)
      }
      if (!lines.length) return ''
      const head =
        'Quick commands handled on this device without you (context only: mention them if asked; you cannot change them yourself):'
      let note = `${head} ${lines.join(' ')}`
      if (note.length > MAX_NOTE) note = `${note.slice(0, MAX_NOTE - 1)}…`
      return note
    },

    sent() {
      exchanges = []
      finished = []
    },

    clear() {
      exchanges = []
      finished = []
      volumeChanged = false
    },
  }
}
