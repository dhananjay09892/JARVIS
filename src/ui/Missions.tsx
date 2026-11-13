import { useEffect, useState } from 'react'
import { answerTask, cancelTask, dismissTask, pauseTask, resumeTask, watchTasks, type TaskView } from '../lib/bridge'
import { missionAgent, missionRows } from '../lib/missionAgent'

const LIVE = new Set<TaskView['status']>(['queued', 'running', 'waiting_approval', 'waiting_input'])
const LABEL: Record<TaskView['status'], string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  waiting_approval: 'NEEDS APPROVAL',
  waiting_input: 'NEEDS YOU',
  paused: 'PAUSED',
  blocked: 'BLOCKED',
  done: 'DONE',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  interrupted: 'INTERRUPTED',
}

const elapsed = (t: TaskView, now: number) => {
  if (!t.startedAt) return ''
  const s = Math.max(0, Math.round(((t.endedAt ?? now) - t.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

function Question({ task }: { task: TaskView }) {
  const [text, setText] = useState('')
  const send = () => {
    if (!text.trim()) return
    answerTask(task.id, text.trim())
    setText('')
  }
  return (
    <form className="mission-ask" onSubmit={(e) => { e.preventDefault(); send() }}>
      <p>{task.question}</p>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your answer" aria-label={`Answer for ${task.title}`} />
      <button type="submit">SEND</button>
    </form>
  )
}

/** A blocked task: why it stopped, and a button for each option; picking one resumes it with that choice. */
function Blocked({ task }: { task: TaskView }) {
  return (
    <div className="mission-blocked-ask">
      <p>{task.note}</p>
      {(task.blocked?.options ?? []).map((o, i) => (
        <button key={i} onClick={() => resumeTask(task.id, o)}>{String.fromCharCode(65 + i)} · {o}</button>
      ))}
    </div>
  )
}

/** A task the owner may pause: live, and not started by another agent or run as a team. */
const pausable = (t: TaskView) => LIVE.has(t.status) && !t.parentId && !t.team

/** Mission Board: every background task, live, with a way to pause, resume or stop it. */
export function Missions() {
  const [tasks, setTasks] = useState<Record<string, TaskView>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => watchTasks(
    (task) => setTasks((current) => ({ ...current, [task.id]: task })),
    (id) => setTasks(({ [id]: _gone, ...rest }) => rest),
  ), [])

  const list = Object.values(tasks)
  const rows = missionRows(list)
  const live = list.filter((t) => LIVE.has(t.status)).length
  const paused = list.filter((t) => t.status === 'paused').length
  const blocked = list.filter((t) => t.status === 'blocked').length
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  if (!list.length) return null

  return (
    <aside className="missions" aria-label="Mission board">
      <button className="missions-head" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        MISSIONS · {live} ACTIVE{paused ? ` · ${paused} PAUSED` : ''}{blocked ? ` · ${blocked} BLOCKED` : ''}{list.length > live + paused + blocked ? ` · ${list.length - live - paused - blocked} ENDED` : ''}
        <span>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && rows.map(({ task: t, nested }) => {
        const agent = missionAgent(t)
        return (
          <section key={t.id} className={`mission mission-${t.status}${nested ? ' mission-child' : ''}`} aria-label={`${agent?.aria ?? t.title}${nested ? ', started by another agent' : ''}`}>
            <div className="mission-row" onClick={() => setOpen(open === t.id ? null : t.id)}>
              <b>{t.title}</b>
              {agent && <small className="mission-agent" title={agent.title}>{agent.label}</small>}
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
                  {t.steps.map((s, i) => (
                    <li key={i} className={`step-${s.state}${s.outcome ? ` check-${s.outcome}` : ''}`} title={[s.check && `Check: ${s.check}`, s.evidence].filter(Boolean).join(' — ') || undefined}>
                      {s.label}{s.outcome === 'passed' ? ' ✓' : s.outcome === 'failed' ? ' ✗' : ''}
                    </li>
                  ))}
                </ol>
                <ul>
                  {t.log.slice(-6).map((l, i) => <li key={i}><code>{l.kind}</code> {l.text}</li>)}
                </ul>
                {t.result && <p className="mission-result">{t.result}</p>}
                {t.status === 'done' && t.verified === false && <p className="mission-unverified">Not checked against the goal.</p>}
              </div>
            )}
            {t.status === 'waiting_input' && <Question task={t} />}
            {t.status === 'blocked' && <Blocked task={t} />}
            <div className="mission-actions">
              {pausable(t) && <button onClick={() => pauseTask(t.id)}>PAUSE</button>}
              {t.status === 'paused' && <button onClick={() => resumeTask(t.id)}>RESUME</button>}
              {LIVE.has(t.status) || t.status === 'paused' || t.status === 'blocked'
                ? <button onClick={() => cancelTask(t.id)}>CANCEL</button>
                : <button onClick={() => dismissTask(t.id)}>DISMISS</button>}
            </div>
          </section>
        )
      })}
    </aside>
  )
}
