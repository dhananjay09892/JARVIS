/**
 * Quick start: where to cut the first phrase of an answer (plan 05 phase 2).
 *
 * Speech normally waits for a whole sentence, which is right for prosody but
 * means the first word is heard only once the model has written the entire
 * first sentence — a long opener ("Certainly, the meeting with the design team
 * has moved to Thursday afternoon.") costs a few hundred milliseconds of
 * silence while it streams in. With quick start on, the *first* chunk of an
 * answer may end at a clause boundary instead (a comma, semicolon, colon or
 * dash followed by a space), once there is enough text for it to sound like a
 * phrase rather than a stutter. Every later chunk still waits for a sentence.
 *
 * Pure and dependency-free so it can be tested under plain Node.
 */

/** Shorter than this and the cut sounds like a hiccup ("Well, …"). */
export const FIRST_PHRASE_MIN = 24

/** Longer than this and there is nothing left to win: wait for the sentence. */
export const FIRST_PHRASE_MAX = 160

/** A clause boundary: , ; : or a spaced dash, then whitespace. */
const CLAUSE_END = /([,;:]|\s[—–-])\s/g

/** A comma between digits ("1, 2 and 3" aside) is a number, not a clause. */
const NUMBERISH = /\d[,;:]\s\d/

/**
 * Where to cut the first phrase in `buffer`, as an index just past the
 * boundary's whitespace, or -1 to keep waiting for a sentence end. Picks the
 * earliest boundary at or past FIRST_PHRASE_MIN characters of speech.
 */
export function firstPhraseCut(buffer: string): number {
  CLAUSE_END.lastIndex = 0
  for (let m = CLAUSE_END.exec(buffer); m; m = CLAUSE_END.exec(buffer)) {
    const cut = m.index + m[0].length
    if (cut > FIRST_PHRASE_MAX) return -1
    const phrase = buffer.slice(0, m.index + m[1].length).trim()
    if (phrase.length < FIRST_PHRASE_MIN) continue
    if (NUMBERISH.test(buffer.slice(Math.max(0, m.index - 1), cut + 1))) continue
    return cut
  }
  return -1
}
