import { BRIDGE_HTTP_URL } from '../config'
import { offerFrom, sectionsFrom, type BriefingOffer, type BriefingReply } from './briefingRun'

export type { BriefingOffer, BriefingReply, BriefingRun, BriefingSection } from './briefingRun'
export { nextSection, offerStillOpen, OFFER_OPEN_MS } from './briefingRun'

type Lang = { lang?: 'en' | 'hi' | 'gu'; script?: 'native' | 'roman' }

/**
 * Asks the bridge for the briefing (bridge/briefing.mjs, Q34), in the reply
 * language worked out from the owner's language profile (Q78). Never throws:
 * a failure comes back as a reason to say.
 */
export async function fetchBriefing(opts: { short?: boolean; locale?: string } & Lang = {}): Promise<BriefingReply> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/briefing/morning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ short: opts.short === true, locale: opts.locale, lang: opts.lang, script: opts.script }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (data.ok === true) {
      const sections = sectionsFrom(data.sections)
      if (sections.length) return { ok: true, sections, empty: data.empty === true }
    }
    if (data.off === true) return { ok: false, off: true, reason: 'The morning briefing is switched off in Settings.' }
    return { ok: false, reason: 'I could not put the briefing together, sir.' }
  } catch {
    return { ok: false, reason: "I can't reach the bridge for the briefing, sir." }
  }
}

/** How long the page waits for the bridge before greeting as usual. It is on this computer, so this is generous. */
const OFFER_WAIT_MS = 700

/**
 * Whether to offer the briefing instead of the usual greeting, now that he
 * has been woken (Q78). The bridge decides (set time, once a day, the
 * notification policy) and remembers that it offered. Null for no offer,
 * including when the bridge is slow or unreachable.
 */
export async function fetchBriefingOffer(opts: Lang = {}): Promise<BriefingOffer | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/briefing/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: opts.lang, script: opts.script }),
      signal: AbortSignal.timeout(OFFER_WAIT_MS),
    })
    return offerFrom(await res.json().catch(() => null))
  } catch {
    return null
  }
}

// Whether a time is set (Settings → Alerts, JARVIS_BRIEFING_TIME). Without
// one the page never asks, so waking him costs nothing extra.
let offerTimeSet = false

export const briefingOfferTimeSet = (): boolean => offerTimeSet

export function setBriefingOfferTime(value: string | undefined | null): void {
  offerTimeSet = typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}
