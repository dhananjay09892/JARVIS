/**
 * The morning briefing (plan 12 block 5, Q34), pure part: the page's side of
 * bridge/briefing.mjs. The bridge builds the briefing from the connectors that
 * are set up; the page reads it out one section at a time, so "skip" moves on
 * to the next section and "stop" ends it (reflex.ts). Nothing here calls a
 * model.
 */

export type BriefingSectionId = 'greeting' | 'weather' | 'calendar' | 'mail' | 'overnight' | 'held' | 'nothing'

export type BriefingSection = { id: BriefingSectionId; say: string }

export type BriefingReply =
  | { ok: true; sections: BriefingSection[]; empty: boolean }
  | { ok: false; off?: boolean; reason: string }

/** A briefing being read out: its sections and the next one to say. */
export type BriefingRun = { sections: BriefingSection[]; next: number }

/** The bridge's offer at a wake (Q78): what to say instead of the usual greeting. */
export type BriefingOffer = { say: string }

const MAX_SECTIONS = 10
const MAX_SAY = 1200
const MAX_OFFER = 200

/** Only well-formed sections, clipped, so a confused bridge cannot make him read a novel. */
export function sectionsFrom(raw: unknown): BriefingSection[] {
  if (!Array.isArray(raw)) return []
  const out: BriefingSection[] = []
  for (const s of raw.slice(0, MAX_SECTIONS)) {
    if (!s || typeof s !== 'object') continue
    const { id, say } = s as { id?: unknown; say?: unknown }
    if (typeof id !== 'string' || typeof say !== 'string' || !say.trim()) continue
    out.push({ id: id as BriefingSectionId, say: say.trim().slice(0, MAX_SAY) })
  }
  return out
}

/** The bridge's answer to "should he offer it?", or null for no offer (or anything malformed). */
export function offerFrom(raw: unknown): BriefingOffer | null {
  if (!raw || typeof raw !== 'object') return null
  const { offer, say } = raw as { offer?: unknown; say?: unknown }
  if (offer !== true || typeof say !== 'string' || !say.trim()) return null
  return { say: say.trim().slice(0, MAX_OFFER) }
}

/** How long a "yes" still answers the offer after it was made. */
export const OFFER_OPEN_MS = 60_000

/** Whether an offer made at `offeredAt` (0 for none) can still be taken up at `now`. */
export function offerStillOpen(offeredAt: number, now: number): boolean {
  return offeredAt > 0 && now >= offeredAt && now - offeredAt <= OFFER_OPEN_MS
}

/** The next section to say, moving the run on; null when it is over. */
export function nextSection(run: BriefingRun | null): BriefingSection | null {
  if (!run || run.next >= run.sections.length) return null
  return run.sections[run.next++]
}
