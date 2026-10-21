import { useEffect, useState } from 'react'
import { cancelTask, watchTasks, type TaskView } from '../lib/bridge'

const LIVE = new Set<TaskView['status']>(['queued', 'running', 'waiting_approval'])
const LABEL: Record<TaskView['status'], string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  waiting_approval: 'NEEDS APPROVAL',
  done: 'DONE',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
}

const elapsed = (t: TaskView, now: number) => {
  if (!t.startedAt) return ''
  const s = Math.max(0, Math.round(((t.endedAt ?? now) - t.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/** Mission Board: every background task, live, with a way to stop it. */
export function Missions() {
  const [tasks, setTasks] = useState<Record<string, TaskView>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => watchTasks((task) => setTasks((current) => ({ ...current, [task.id]: task }))), [])

  const list = Object.values(tasks).sort((a, b) => (b.startedAt ?? Infinity) - (a.startedAt ?? Infinity))
  const live = list.filter((t) => LIVE.has(t.status)).length
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  if (!list.length) return null
  const dismiss = (id: string) => setTasks(({ [id]: _gone, ...rest }) => rest)

  return (
    <aside className="missions" aria-label="Mission board">
      <button className="missions-head" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        MISSIONS · {live} ACTIVE{list.length > live ? ` · ${list.length - live} ENDED` : ''}
        <span>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && list.map((t) => (
        <section key={t.id} className={`mission mission-${t.status}`}>
          <div className="mission-row" onClick={() => setOpen(open === t.id ? null : t.id)}>
            <b>{t.title}</b>
            <em>{LABEL[t.status]}</em>
          </div>
          <div className="mission-bar" role="progressbar" aria-valuenow={t.percent} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${t.percent}%` }} />
          </div>
          <div className="mission-meta">
            <span>{t.error && !LIVE.has(t.status) && t.status !== 'done' ? t.error : t.note || t.steps.find((s) => s.state === 'active')?.label || ' '}</span>
            <span>{elapsed(t, now)}{t.costUsd != null ? ` · $${t.costUsd.toFixed(2)}` : ''}</span>
          </div>
          {open === t.id && (
            <div className="mission-detail">
              <ol>
                {t.steps.map((s, i) => <li key={i} className={`step-${s.state}`}>{s.label}</li>)}
              </ol>
              <ul>
                {t.log.slice(-6).map((l, i) => <li key={i}><code>{l.kind}</code> {l.text}</li>)}
              </ul>
              {t.result && <p className="mission-result">{t.result}</p>}
            </div>
          )}
          <div className="mission-actions">
            {LIVE.has(t.status)
              ? <button onClick={() => cancelTask(t.id)}>CANCEL</button>
              : <button onClick={() => dismiss(t.id)}>DISMISS</button>}
          </div>
        </section>
      ))}
    </aside>
  )
}
