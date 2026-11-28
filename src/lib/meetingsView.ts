/** Pure helpers for Settings → Meetings (the status line, keep-days check, minutes counts). */

export interface MeetingAccuracy {
  actionsExpected: number
  actionsCaptured: number
  actionsReturned: number
  recall: number | null
  precision: number | null
  decisionsExpected: number
  decisionsCaptured: number
}

export interface MeetingStatus {
  enabled: boolean
  capturing?: { id: string; title: string; startedAt: number; lines: number } | null
  saved?: number
  keepDays?: number
  accuracy?: MeetingAccuracy
}

export interface MinutesRow { id: string; title: string; startedAt: number; endedAt: number; decisions: number; actions: number; pending: number }

export interface ActionItem { id: string; text: string; owner?: string; due?: string; state: 'pending' | 'approved' | 'dismissed' }
export interface Minutes {
  id: string; title: string; startedAt: number; endedAt: number; speakers: string[]
  summary: string[]; decisions: string[]; actions: ActionItem[]
}

export interface Notice { id: string; text: string }

/** Same rule as the bridge: whole days, 1 to 365. */
export function keepDaysProblem(value: string): string | null {
  const v = value.trim()
  if (!/^\d{1,3}$/.test(v)) return 'Use a whole number of days, 1 to 365.'
  const n = Number(v)
  return n >= 1 && n <= 365 ? null : 'Use a whole number of days, 1 to 365.'
}

/** Whether Start may be pressed: the notice has been shown and the owner has ticked the box. */
export function canStart(s: { noticeShown: boolean; consent: boolean; enabled: boolean; capturing: boolean }): boolean {
  return s.enabled && s.noticeShown && s.consent && !s.capturing
}

/** Minutes the owner can read at a glance: "Launch sync · 2 decisions · 3 actions (1 waiting)". */
export function minutesRowText(r: MinutesRow): string {
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`
  const waiting = r.pending > 0 ? ` (${r.pending} waiting)` : ''
  return `${r.title} · ${n(r.decisions, 'decision')} · ${n(r.actions, 'action')}${waiting}`
}

/** One line for Diagnostics. Counts and percentages only, never a line from a meeting. */
export function meetingStatsText(s: MeetingStatus | null | undefined): string {
  if (!s || !s.enabled) return 'off'
  const parts = [s.capturing ? `capturing, ${s.capturing.lines} lines` : 'idle', `${s.saved ?? 0} saved`]
  const a = s.accuracy
  if (a && a.recall !== null) parts.push(`action items ${a.actionsCaptured}/${a.actionsExpected} on the test call (${a.recall}% found, ${a.precision}% right)`)
  return parts.join(' · ')
}
