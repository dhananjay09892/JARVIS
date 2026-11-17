import { useCallback, useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import {
  DAY_NAMES, EVERY_LABEL, addSchedule, emptyPick, getSchedules, lastRun, removeSchedule, scheduleRequest, setScheduleOn,
  type Every, type WhenPick, type ScheduledMission,
} from '../lib/missionSchedules'

/**
 * Settings → Scheduled missions (plan 13 phase 7, Q129). The saved recurring
 * and event-driven missions, each with a switch and a Remove, and a form to
 * add one with a plain-words picker ("Every week, on Friday, at 16:00"). Each
 * run is an ordinary mission: the same limits and approvals apply, and it can
 * be paused from the Mission Board. A mission made by voice appears here only
 * after the owner approves its card.
 */
export function MissionSchedules() {
  const [list, setList] = useState<ScheduledMission[] | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [pick, setPick] = useState<WhenPick>(emptyPick)

  const refresh = useCallback(async () => setList(await getSchedules(BRIDGE_HTTP_URL)), [])
  useEffect(() => { void refresh() }, [refresh])

  const run = async (job: () => Promise<{ ok: boolean; reason?: string }>, done: string) => {
    setBusy(true)
    const r = await job()
    setNote(r.ok ? done : r.reason ?? 'That did not work.')
    setBusy(false)
    if (r.ok) await refresh()
    return r.ok
  }

  const add = async () => {
    const req = scheduleRequest(title, goal, pick)
    if (!req.ok) return setNote(req.reason)
    if (await run(() => addSchedule(BRIDGE_HTTP_URL, req.body), 'Saved. It starts counting from now.')) {
      setTitle('')
      setGoal('')
    }
  }

  const set = (over: Partial<WhenPick>) => setPick((p) => ({ ...p, ...over }))

  return (
    <div className="mission-schedules">
      <p className="mem-note">
        Missions that run on their own, on a schedule or when something happens. Each run is an ordinary mission: same limits, same approvals.
        Missed times while JARVIS is off are made up once. Nothing runs while missions are paused or frozen.
      </p>
      {list === null && <p className="mem-note">Could not reach the bridge, or it is an older version.</p>}
      {list?.length === 0 && <p className="mem-note">None yet.</p>}
      {list && list.length > 0 && (
        <ul className="mem-list">
          {list.map((s) => (
            <li key={s.id}>
              <label>
                <input type="checkbox" checked={s.enabled} disabled={busy} aria-label={`${s.title} is on`}
                  onChange={(e) => void run(() => setScheduleOn(BRIDGE_HTTP_URL, s.id, e.target.checked), e.target.checked ? 'Switched on.' : 'Switched off.')} />{' '}
                <b>{s.title}</b> · {s.words}
              </label>
              <div className="mem-note">{s.goal}{lastRun(s) ? ` · ${lastRun(s)}` : ''}</div>
              <button disabled={busy} aria-label={`Remove ${s.title}`}
                onClick={() => void run(() => removeSchedule(BRIDGE_HTTP_URL, s.id), 'Removed.')}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="mem-add" onSubmit={(e) => { e.preventDefault(); void add() }}>
        <input value={title} maxLength={60} placeholder="Name, e.g. Friday status report" aria-label="Scheduled mission name"
          onChange={(e) => setTitle(e.target.value)} disabled={busy} />{' '}
        <input value={goal} maxLength={1000} placeholder="What it should do (it cannot see your conversations)" aria-label="Scheduled mission goal"
          onChange={(e) => setGoal(e.target.value)} disabled={busy} />{' '}
        <select value={pick.every} aria-label="How often" disabled={busy} onChange={(e) => set({ every: e.target.value as Every })}>
          {(Object.keys(EVERY_LABEL) as Every[]).map((k) => <option key={k} value={k}>{EVERY_LABEL[k]}</option>)}
        </select>{' '}
        {pick.every === 'week' && (
          <select value={pick.day} aria-label="Day of the week" disabled={busy} onChange={(e) => set({ day: e.target.value })}>
            {DAY_NAMES.map((d) => <option key={d}>{d}</option>)}
          </select>
        )}
        {pick.every === 'month' && (
          <select value={pick.dayOfMonth} aria-label="Day of the month" disabled={busy} onChange={(e) => set({ dayOfMonth: e.target.value })}>
            {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={String(i + 1)}>on the {i + 1}</option>)}
          </select>
        )}
        {pick.every === 'hours' && (
          <select value={pick.hours} aria-label="Every how many hours" disabled={busy} onChange={(e) => set({ hours: e.target.value })}>
            {[1, 2, 3, 4, 6, 8, 12].map((n) => <option key={n} value={String(n)}>{n === 1 ? 'every hour' : `every ${n} hours`}</option>)}
          </select>
        )}
        {['day', 'weekday', 'weekend', 'week', 'month'].includes(pick.every) && (
          <input type="time" value={pick.time} aria-label="Time of day" disabled={busy} onChange={(e) => set({ time: e.target.value })} />
        )}{' '}
        <button type="submit" disabled={busy}>Add</button>
      </form>
      {note && <p className="mem-note" role="status">{note}</p>}
    </div>
  )
}
