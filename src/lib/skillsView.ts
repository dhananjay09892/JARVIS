/** Types and pure helpers for Settings → Skills (see skills.ts for the bridge calls). */

export interface InstalledSkill {
  id: string
  version: string
  pinned: boolean
  canRollBack: boolean
  on: boolean
  name?: string
  description?: string
  riskTier?: 'low' | 'medium' | 'high'
  phrases?: string[]
  tools?: string[]
  broken?: string[]
}

export interface SkillStats { runs: number; steps: number; waiting: number; refused: number; failed: number; blocked: number }

export interface SkillsList {
  ok: true
  paused: boolean
  pausedSetting: boolean
  installed: InstalledSkill[]
  packs: { name: string; installedVersion: string | null }[]
  stats: Partial<SkillStats>
}

export interface SkillReview {
  ok: true
  reviewId: string
  id: string
  name: string
  version: string
  screen: { permissions?: string[]; [k: string]: unknown }
  steps: { step: number; tool: string; label?: string; verdict: string; reason?: string }[]
  findings: { where: string; problem: string }[]
  installedVersion: string | null
  changes?: unknown
}

export type SkillReply = { ok: true; snapshot?: SkillsList } | { ok: false; reason: string }

/** One line for a Diagnostics row; null when no skill has run. */
export function skillStatsText(s: Partial<SkillStats> | undefined): string | null {
  if (!s || !s.runs) return null
  const bits = [`${s.runs} run${s.runs === 1 ? '' : 's'}`, `${s.steps ?? 0} steps`]
  if (s.waiting) bits.push(`${s.waiting} waiting for allow actions`)
  if (s.refused) bits.push(`${s.refused} refused`)
  if (s.failed) bits.push(`${s.failed} failed`)
  return bits.join(' · ')
}
