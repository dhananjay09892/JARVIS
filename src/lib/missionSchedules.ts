/**
 * Settings → Scheduled missions (plan 13 phase 7, Q129): the bridge's
 * /missions/schedules, and the plain-words picker. The page sends what the
 * owner picked ("every Friday at 4 pm" as { every, day, time }); the bridge
 * turns it into a cron string and decides whether it is allowed. No imports
 * from ../config, so the pure parts run under `node --test`.
 */

export type ScheduledMission = {
  id: string
  title: string
  goal: string
  cron?: string
  topic?: string
  /** The schedule in words, from the bridge ("every Friday at 4 pm"). */
  words: string
  enabled: boolean
  createdAt: number
  lastAt?: number
}

export type Every = 'day' | 'weekday' | 'weekend' | 'week' | 'month' | 'hours' | 'event'

export type WhenPick = {
  every: Every
  day: string
  time: string
  dayOfMonth: string
  hours: string
}

export const EVERY_LABEL: Record<Every, string> = {
  day: 'Every day',
  weekday: 'Every weekday',
  weekend: 'Every weekend',
  week: 'Every week',
  month: 'Every month',
  hours: 'Every few hours',
  event: 'When a meeting ends',
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const emptyPick = (): WhenPick => ({ every: 'week', day: 'Friday', time: '16:00', dayOfMonth: '1', hours: '2' })

export type NewSchedule = { title: string; goal: string; when?: Record<string, unknown>; topic?: string }

/** What the form holds → the body to send, or what is missing, in words. */
export function scheduleRequest(title: string, goal: string, pick: WhenPick): { ok: true; body: NewSchedule } | { ok: false; reason: string } {
  const t = title.trim()
  const g = goal.trim()
  if (!t) return { ok: false, reason: 'Give it a short name.' }
  if (!g) return { ok: false, reason: 'Say what the mission should do.' }
  if (pick.every === 'event') return { ok: true, body: { title: t, goal: g, topic: 'meeting.ended' } }
  if (pick.every === 'hours') return { ok: true, body: { title: t, goal: g, when: { every: 'hours', hours: Number(pick.hours) } } }
  if (!/^\d{1,2}:\d{2}$/.test(pick.time)) return { ok: false, reason: 'WhenPick a time.' }
  const when: Record<string, unknown> = { every: pick.every, time: pick.time }
  if (pick.every === 'week') when.day = pick.day
  if (pick.every === 'month') when.dayOfMonth = Number(pick.dayOfMonth)
  return { ok: true, body: { title: t, goal: g, when } }
}

export type ScheduleReply = { ok: boolean; reason?: string }

export async function getSchedules(base: string): Promise<ScheduledMission[] | null> {
  try {
    const res = await fetch(`${base}/missions/schedules`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const j = (await res.json()) as { schedules?: ScheduledMission[] }
    return Array.isArray(j.schedules) ? j.schedules : []
  } catch {
    return null
  }
}

async function post(url: string, body?: unknown): Promise<ScheduleReply> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(6000),
    })
    const j = (await res.json().catch(() => ({}))) as ScheduleReply
    return res.ok ? { ok: true } : { ok: false, reason: j.reason ?? 'The bridge refused that.' }
  } catch {
    return { ok: false, reason: 'Could not reach the bridge.' }
  }
}

export const addSchedule = (base: string, body: NewSchedule) => post(`${base}/missions/schedules`, body)
export const setScheduleOn = (base: string, id: string, enabled: boolean) => post(`${base}/missions/schedules/${encodeURIComponent(id)}`, { enabled })
export const removeSchedule = (base: string, id: string) => post(`${base}/missions/schedules/${encodeURIComponent(id)}/remove`)

/** "last ran Fri 4:00 pm", or "has not run yet". */
export const lastRun = (s: Pick<ScheduledMission, 'lastAt' | 'topic'>, locale?: string) =>
  s.lastAt && !s.topic ? `last checked ${new Date(s.lastAt).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''
