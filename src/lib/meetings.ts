import { BRIDGE_HTTP_URL } from '../config'
import type { MeetingStatus, Minutes, MinutesRow, Notice } from './meetingsView'

export * from './meetingsView'

/** Settings → Meetings: the page's side of the bridge's /meetings routes. */

type Result = { ok: boolean; reason?: string; needs?: string; id?: string; minutes?: Minutes }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read meetings.')
  return res.json()
}

async function post(path: string, body: object = {}): Promise<Result> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/meetings/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok && data.ok !== false) return { ok: false, reason: 'That did not work.' }
    return data
  } catch {
    return { ok: false, reason: 'The bridge did not answer.' }
  }
}

export const getMeetingStatus = () => get<MeetingStatus>('/meetings/status')
export const getMeetingNotice = () => get<Notice>('/meetings/notice')
export const listMinutes = async () => (await get<{ minutes: MinutesRow[] }>('/meetings')).minutes
export const getMinutes = (id: string) => get<Minutes>(`/meetings/minutes/${encodeURIComponent(id)}`)

export const startMeeting = (title: string, notice: Notice) =>
  post('start', { noticeId: notice.id, noticeShown: true, consentConfirmed: true, title })
export const endMeeting = (id: string) => post('end', { id })
export const abandonMeeting = () => post('abandon')
export const decideAction = (minutesId: string, actionId: string, decision: 'approve' | 'dismiss') =>
  post('action', { minutesId, actionId, decision })
export const deleteMinutes = (id: string) => post('delete', { id })
export const forgetAllMinutes = () => post('delete')
