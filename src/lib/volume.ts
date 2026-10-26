/**
 * JARVIS's own volume, set by the reflex layer ("louder", "quieter", "mute",
 * "volume 40 percent"; plan 06). Applies to his voice and, scaled the same,
 * to the interface sounds. Muting silences the voice only: the cues still
 * confirm he heard you, and answers still show as captions.
 *
 * Remembered per browser in local storage, so it survives a reload.
 */
import { setSpeechVolume } from './tts'
import * as sfx from './sfx'
import type { VolumeState } from './reflex'

const KEY = 'jarvis.volume'
/** The cue level before this existed; full volume keeps it unchanged. */
const SFX_AT_FULL = 0.5

let state: VolumeState = load()
apply()

function load(): VolumeState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (v && Number.isFinite(v.level) && v.level > 0 && v.level <= 1) return { level: v.level, muted: v.muted === true }
  } catch {
    /* blocked or unreadable storage: full volume */
  }
  return { level: 1, muted: false }
}

function apply() {
  setSpeechVolume(state.muted ? 0 : state.level)
  sfx.setVolume(SFX_AT_FULL * state.level)
}

export function getVolume(): VolumeState {
  return { ...state }
}

export function setVolume(next: VolumeState): void {
  state = { level: next.level, muted: next.muted }
  apply()
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* it still applies for this session */
  }
}
