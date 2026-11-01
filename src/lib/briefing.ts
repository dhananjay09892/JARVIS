import { BRIDGE_HTTP_URL } from '../config'
import { sectionsFrom, type BriefingReply } from './briefingRun'

export type { BriefingReply, BriefingRun, BriefingSection } from './briefingRun'
export { nextSection } from './briefingRun'

/** Asks the bridge for the briefing (bridge/briefing.mjs, Q34). Never throws: a failure comes back as a reason to say. */
export async function fetchBriefing(opts: { short?: boolean; locale?: string } = {}): Promise<BriefingReply> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/briefing/morning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ short: opts.short === true, locale: opts.locale }),
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
