/**
 * Spoken enrolment (plan 01, Q85): "learn my voice". A short dialogue that asks
 * for consent first, then a name, then takes a sample of the next thing said.
 * Pure: it decides what to say and when to take the sample; App.tsx does the
 * speaking and speaker.ts does the recording.
 *
 * Consent is a spoken yes to a question that says what is kept and where. Any
 * other answer, or silence turning into some other request, ends it with nothing
 * recorded.
 */

export type EnrolState =
  | { step: 'idle' }
  | { step: 'consent' }
  | { step: 'name' }
  | { step: 'sample'; name: string }

export type EnrolResult = {
  state: EnrolState
  /** What to say; empty when the dialogue does not apply to this utterance. */
  say: string
  /** The utterance belongs to the dialogue: do not send it to the model. */
  handled: boolean
  /** Take the sample now: the audio spoken since the prompt, enrolled under this name. */
  enrol?: { name: string }
  /** Begin recording the sample that follows the prompt. */
  startSample?: boolean
}

const TRIGGER = /\b(learn|remember|enrol+|enroll|register|record|save)\b.{0,20}\bvoice\b/i
const YES = /^\s*(yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|i (do|agree|consent))\b/i
const NO = /\b(no|nope|cancel|stop|never ?mind|forget it|don'?t)\b/i

export const CONSENT_QUESTION =
  'To learn your voice I will record a short sample and keep only a numeric voiceprint on this computer. It never leaves it, and you can delete it any time in Settings. Do you agree?'

export const IDLE: EnrolState = { step: 'idle' }

/** Pull a first name out of "my name is Priya" / "I'm Priya" / "Priya". */
export function parseName(said: string): string | null {
  const t = said
    .replace(/[.,!?]/g, ' ')
    .replace(/^\s*(hey\s+)?(my name is|i am|i'm|it'?s|call me|this is|name'?s)\s+/i, '')
    .trim()
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 3) return null
  const name = words.join(' ')
  if (name.length > 60 || !/^[\p{L}][\p{L}' -]*$/u.test(name)) return null
  return name
}

export function stepEnrol(state: EnrolState, said: string): EnrolResult {
  const ignore: EnrolResult = { state, say: '', handled: false }
  const stop = (say: string): EnrolResult => ({ state: IDLE, say, handled: true })
  switch (state.step) {
    case 'idle':
      return TRIGGER.test(said) ? { state: { step: 'consent' }, say: CONSENT_QUESTION, handled: true } : ignore
    case 'consent':
      if (YES.test(said) && !NO.test(said.replace(YES, ''))) {
        return { state: { step: 'name' }, say: 'Thank you. What is your name?', handled: true }
      }
      return stop('Understood. I have not recorded anything.')
    case 'name': {
      if (NO.test(said)) return stop('Understood. I have not recorded anything.')
      const name = parseName(said)
      if (!name) return { state, say: 'Sorry, I did not catch a name. Please say just your first name.', handled: true }
      return {
        state: { step: 'sample', name },
        say: `Thank you, ${name}. Now talk to me for about ten seconds. Tell me about your day.`,
        handled: true,
        startSample: true,
      }
    }
    case 'sample':
      return {
        state: IDLE,
        say: '',
        handled: true,
        enrol: { name: state.name },
      }
  }
}
