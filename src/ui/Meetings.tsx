import { useCallback, useEffect, useState } from 'react'
import type { PublicSettings } from '../lib/settings'
import {
  abandonMeeting, canStart, decideAction, deleteMinutes, endMeeting, forgetAllMinutes, getMeetingNotice, getMeetingStatus,
  getMinutes, keepDaysProblem, listMinutes, meetingStatsText, minutesRowText, startMeeting,
  type MeetingStatus, type Minutes, type MinutesRow, type Notice,
} from '../lib/meetings'

/**
 * Settings → Meetings (plan 33). Switch meeting minutes on, choose how long to
 * keep them, start and end a capture (the notice is shown first and the box
 * must be ticked), read the minutes, approve or dismiss each action item, and
 * delete minutes. Approving only marks the item. Everything is plain text.
 * Feeding live speech into a capture is a later step: until then lines arrive
 * through the bridge's /meetings/segment route.
 */
export function Meetings({ settings, busy, patchSetting }: {
  settings: PublicSettings | null
  busy: boolean
  patchSetting: (change: Record<string, string>) => Promise<boolean>
}) {
  const [status, setStatus] = useState<MeetingStatus | null>(null)
  const [rows, setRows] = useState<MinutesRow[]>([])
  const [open, setOpen] = useState<Minutes | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [noticeShown, setNoticeShown] = useState(false)
  const [consent, setConsent] = useState(false)
  const [title, setTitle] = useState('')
  const [days, setDays] = useState('')
  const [note, setNote] = useState('')
  const [working, setWorking] = useState(false)

  const on = (settings?.JARVIS_MEETINGS ?? '0') === '1'
  const keep = settings?.JARVIS_MEETINGS_KEEP_DAYS || '30'
  const capturing = status?.capturing ?? null

  const load = useCallback(() => {
    getMeetingStatus().then(setStatus).catch(() => setStatus(null))
    listMinutes().then(setRows).catch(() => setRows([]))
  }, [])
  useEffect(load, [load, on])
  useEffect(() => {
    if (!on) return
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [on, load])

  const showNotice = () => {
    getMeetingNotice().then((n) => { setNotice(n); setNoticeShown(true) }).catch(() => setNote('Could not read the notice, so capture cannot start.'))
  }

  const act = (fn: () => Promise<{ ok: boolean; reason?: string }>, ok: string, after?: () => void) => {
    setWorking(true)
    setNote('')
    void fn()
      .then((r) => { setNote(r.ok ? ok : (r.reason ?? 'That did not work.')); if (r.ok) after?.() })
      .finally(() => { setWorking(false); load() })
  }

  const disabled = busy || working || !settings
  return (
    <section aria-label="Meetings">
      <h4>Meetings</h4>
      <p className="mem-note">
        Turn a meeting you start into written minutes: a summary, decisions and action items that wait for your approval. Only text is kept, never the sound, and minutes stay on this computer. Switched off, nothing is captured and saved minutes are deleted.
      </p>
      <label>
        <input
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => {
            if (!e.target.checked && !window.confirm('Switch off and delete all saved minutes?')) return
            void patchSetting({ JARVIS_MEETINGS: e.target.checked ? '1' : '0' }).then((ok) => {
              if (ok && !e.target.checked) { void abandonMeeting().then(() => forgetAllMinutes()).finally(load); setNoticeShown(false); setConsent(false) }
              else load()
            })
          }}
        />{' '}
        Make meeting minutes
      </label>
      {on && (
        <>
          <p>
            <label>
              Keep minutes for{' '}
              <input
                type="text"
                inputMode="numeric"
                size={4}
                value={days || keep}
                disabled={disabled}
                aria-label="Days to keep minutes"
                onChange={(e) => setDays(e.target.value)}
              />{' '}
              days
            </label>{' '}
            <button
              disabled={disabled || !days || days === keep}
              onClick={() => {
                const problem = keepDaysProblem(days)
                if (problem) return setNote(problem)
                void patchSetting({ JARVIS_MEETINGS_KEEP_DAYS: days.trim() }).then((ok) => { if (ok) setDays(''); load() })
              }}
            >
              Save
            </button>
          </p>

          {capturing ? (
            <p>
              <strong>Capturing: {capturing.title}</strong> <span className="mem-note">({capturing.lines} lines)</span>{' '}
              <button disabled={disabled} onClick={() => act(() => endMeeting(capturing.id), 'Meeting ended. The minutes are below.')}>
                End and make minutes
              </button>{' '}
              <button disabled={disabled} onClick={() => act(abandonMeeting, 'Dropped. No minutes were made.')}>
                Drop it
              </button>
            </p>
          ) : (
            <div>
              {!noticeShown ? (
                <button disabled={disabled} onClick={showNotice}>Start a meeting…</button>
              ) : (
                <div className="conn-card" role="group" aria-label="Recording notice">
                  <p><strong>Before you start</strong></p>
                  <p>{notice?.text}</p>
                  <label>
                    <input type="checkbox" checked={consent} disabled={disabled} onChange={(e) => setConsent(e.target.checked)} />{' '}
                    Everyone on the call knows and agrees
                  </label>
                  <br />
                  <label>
                    Title{' '}
                    <input type="text" value={title} maxLength={120} placeholder="Meeting" disabled={disabled} onChange={(e) => setTitle(e.target.value)} />
                  </label>{' '}
                  <button
                    disabled={disabled || !notice || !canStart({ enabled: on, noticeShown, consent, capturing: false })}
                    onClick={() => notice && act(() => startMeeting(title, notice), 'Capture started.', () => { setNoticeShown(false); setConsent(false); setTitle('') })}
                  >
                    Start
                  </button>{' '}
                  <button disabled={disabled} onClick={() => { setNoticeShown(false); setConsent(false) }}>Cancel</button>
                </div>
              )}
            </div>
          )}

          <ul className="conn-list">
            {rows.length === 0 && <li>No minutes yet.</li>}
            {rows.map((r) => (
              <li key={r.id} className="conn-card">
                <strong>{minutesRowText(r)}</strong> <span className="mem-note">{new Date(r.endedAt).toLocaleString()}</span>
                <br />
                <button disabled={disabled} onClick={() => void getMinutes(r.id).then(setOpen).catch(() => setNote('Could not open the minutes.'))}>Read</button>{' '}
                <button
                  disabled={disabled}
                  onClick={() => window.confirm('Delete these minutes?') && act(() => deleteMinutes(r.id), 'Deleted.', () => setOpen((m) => (m?.id === r.id ? null : m)))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>

          {open && (
            <div className="conn-card" role="region" aria-label={`Minutes: ${open.title}`}>
              <p><strong>{open.title}</strong> <button onClick={() => setOpen(null)}>Close</button></p>
              {open.summary.length > 0 && (<><p className="mem-note">Summary</p><ul>{open.summary.map((s, i) => <li key={i}>{s}</li>)}</ul></>)}
              {open.decisions.length > 0 && (<><p className="mem-note">Decisions</p><ul>{open.decisions.map((s, i) => <li key={i}>{s}</li>)}</ul></>)}
              <p className="mem-note">Action items (approving only marks them; nothing is created or sent)</p>
              {open.actions.length === 0 && <p>None found.</p>}
              <ul>
                {open.actions.map((a) => (
                  <li key={a.id}>
                    {a.text}{a.owner ? ` · ${a.owner}` : ''}{a.due ? ` · by ${a.due}` : ''} <span className="mem-note">{a.state}</span>{' '}
                    {a.state === 'pending' && (
                      <>
                        <button disabled={disabled} onClick={() => act(() => decideAction(open.id, a.id, 'approve'), 'Approved.', () => void getMinutes(open.id).then(setOpen))}>Approve</button>{' '}
                        <button disabled={disabled} onClick={() => act(() => decideAction(open.id, a.id, 'dismiss'), 'Dismissed.', () => void getMinutes(open.id).then(setOpen))}>Dismiss</button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {note && <p role="status" className="mem-note">{note}</p>}
      <p className="mem-note">{meetingStatsText(status)}</p>
    </section>
  )
}
