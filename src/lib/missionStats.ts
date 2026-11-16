/**
 * Mission numbers for Diagnostics (plan 13 phase 7, plan 16; Q128): success
 * rate, how often help was needed and cost per mission, from the bridge's
 * /missions/stats, plus how many scheduled missions there are.
 *
 * No imports from ../config, so it runs under `node --test`; the network
 * helper takes the bridge's address from the caller. Numbers only: the
 * bridge never sends a title, goal or result here.
 */

export type MissionStats = {
  missions: number
  open: number
  done: number
  failed: number
  cancelled: number
  successRate?: number
  helpRate?: number
  avgCostUsd?: number
  narration?: { enabled?: boolean; step?: number; blocked?: number; finished?: number }
  scheduled?: { total: number; on: number }
}

const pct = (x: number) => `${Math.round(x * 100)}%`

/** A mission success target the Diagnostics row is marked against. */
export const MISSION_SUCCESS_TARGET = 0.8

/** The rows Diagnostics shows. Pure, so it is tested. */
export function missionRows(s: MissionStats): { k: string; v: string; bad?: boolean }[] {
  const finished = s.done + s.failed
  const rows: { k: string; v: string; bad?: boolean }[] = [
    {
      k: 'missions finished',
      v: finished
        ? `${s.done} of ${finished} succeeded (${pct(s.successRate ?? s.done / finished)}) · ${s.open} open · ${s.cancelled} cancelled`
        : `none finished yet · ${s.open} open`,
      bad: finished > 0 && (s.successRate ?? s.done / finished) < MISSION_SUCCESS_TARGET,
    },
  ]
  if (finished > 0 && s.helpRate !== undefined) rows.push({ k: 'needed your help', v: pct(s.helpRate) })
  if (s.avgCostUsd !== undefined) rows.push({ k: 'cost per mission', v: `$${s.avgCostUsd.toFixed(s.avgCostUsd < 0.1 ? 3 : 2)}` })
  if (s.scheduled) rows.push({ k: 'scheduled missions', v: s.scheduled.total ? `${s.scheduled.on} on of ${s.scheduled.total}` : 'none' })
  return rows
}

/** The numbers for Diagnostics; null if the bridge cannot be reached (or is older). */
export async function fetchMissionStats(base: string): Promise<MissionStats | null> {
  try {
    const res = await fetch(`${base}/missions/stats`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const stats = (await res.json()) as MissionStats
    try {
      const sres = await fetch(`${base}/missions/schedules`, { signal: AbortSignal.timeout(3000) })
      if (sres.ok) {
        const list = ((await sres.json()) as { schedules?: { enabled?: boolean }[] }).schedules ?? []
        stats.scheduled = { total: list.length, on: list.filter((x) => x.enabled).length }
      }
    } catch {
      /* an older bridge has no schedules; the rest still shows */
    }
    return stats
  } catch {
    return null
  }
}
