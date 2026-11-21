import { BRIDGE_HTTP_URL } from '../config'
import type { SkillReply, SkillReview, SkillsList } from './skillsView'

export * from './skillsView'

/**
 * Settings → Skills: the page's side of bridge/skill-routes.mjs. The page only
 * ever names a first-party pack; the bridge builds the permission review and
 * installs only the exact files that were reviewed. Nothing here grants anything:
 * the policy engine still decides every step a skill takes.
 */

async function send<T>(path: string, body: Record<string, unknown> = {}): Promise<T | { ok: false; reason: string }> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/skills${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; reason?: string }
    if (!res.ok && data.ok !== false) return { ok: false, reason: 'That did not work.' }
    return data
  } catch {
    return { ok: false, reason: 'The bridge did not answer.' }
  }
}

export async function listSkills(): Promise<SkillsList> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/skills`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read the skills.')
  return res.json()
}

const at = (id: string, action: string) => `/${encodeURIComponent(id)}/${action}`

export const reviewPack = (pack: string) => send<SkillReview>('/review', { pack })
export const installPack = (pack: string, approve: string) => send<SkillReply>('/install', { pack, approve })
export const setSkillEnabled = (id: string, enabled: boolean) => send<SkillReply>(at(id, 'enabled'), { enabled })
export const pinSkill = (id: string, pinned: boolean) => send<SkillReply>(at(id, pinned ? 'pin' : 'unpin'))
export const rollBackSkill = (id: string) => send<SkillReply>(at(id, 'rollback'))
export const removeSkill = (id: string) => send<SkillReply>(at(id, 'remove'), { confirm: true })
export const pauseSkills = (paused: boolean) => send<SkillReply>('/paused', { paused })
