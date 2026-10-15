import { useCallback, useEffect, useRef, useState } from 'react'
import { memoryRequest, newConversation } from '../lib/bridge'
import { useStore } from '../store'

type MemoryRow = {
  id: number
  scope: 'personal' | 'project'
  project: string
  text: string
  source: string
  created_at: string
  updated_at: string
}
type ConversationRow = { id: string; title: string | null; project: string | null; updated_at: string; messages: number }
type ProjectRow = { project: string; project_key: string; n: number; last: string }
type EventRow = { id: number; kind: string; summary: string; detail: string; status: string; updated_at: string }
type Overview = {
  current: string
  project: string | null
  memories: MemoryRow[]
  conversations: ConversationRow[]
  projects: ProjectRow[]
  stats: { conversations: number; messages: number; memories: number; events: number }
  storage: string
  ok?: boolean
  reason?: string
}
type Tab = 'memories' | 'journal' | 'workflows' | 'conversations' | 'privacy'
type StepRow = { index: number; type: string; status: string; detail: string }
type WorkflowRow = {
  id: string
  name: string
  description: string
  scheduleTime: string | null
  enabled: boolean
  running: boolean
  steps: { type: string; path?: string; cwd?: string; command?: string; remote?: string; branch?: string }[]
}
type RunRow = { id: string; workflow: string; trigger: string; status: string; startedAt: string; steps: StepRow[] }

const day = (iso: string) => iso.slice(0, 10)

/**
 * Inspect, correct and delete what JARVIS has saved. Talks to the bridge over
 * the same origin-checked WebSocket as everything else; there is no HTTP
 * endpoint for memory.
 */
export function Memory() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('memories')
  const [data, setData] = useState<Overview | null>(null)
  const [message, setMessage] = useState('')
  const [events, setEvents] = useState<EventRow[]>([])
  const [project, setProject] = useState('')
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<'personal' | 'project'>('personal')
  const [draftProject, setDraftProject] = useState('')
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  const [confirm, setConfirm] = useState('')
  const [flows, setFlows] = useState<{ workflows: WorkflowRow[]; runs: RunRow[]; waiting: number } | null>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async () => {
    try {
      const overview = await memoryRequest<Overview>('overview')
      if (overview.ok === false) throw new Error(overview.reason ?? 'Memory is not running.')
      setData(overview)
      setMessage('')
      return overview
    } catch (err) {
      setData(null)
      setMessage(err instanceof Error ? err.message : 'Memory is unavailable.')
      return null
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh().then((overview) => {
      if (overview && !project) setProject(overview.project ?? overview.projects[0]?.project ?? '')
    })
    closeButton.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refresh])

  useEffect(() => {
    if (!open || tab !== 'journal' || !project) return setEvents([])
    void memoryRequest<{ events: EventRow[] }>('events', { project }).then((r) => setEvents(r.events ?? []))
  }, [open, tab, project, data])

  useEffect(() => {
    if (!open || tab !== 'workflows') return
    const load = () => void memoryRequest<{ workflows: WorkflowRow[]; runs: RunRow[]; waiting: number; ok?: boolean; reason?: string }>('wf_list')
      .then((r) => (r.ok === false ? setMessage(r.reason ?? 'Workflows are not running.') : setFlows(r)))
    load()
    const timer = window.setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [open, tab])

  if (!open) {
    return (
      <button className="mem-open" onClick={() => setOpen(true)} aria-label="Open memory">
        MEMORY
      </button>
    )
  }

  const act = async (op: string, args: Record<string, unknown>, done?: string) => {
    try {
      const r = await memoryRequest<{ ok?: boolean; reason?: string; duplicate?: boolean; activeDeleted?: boolean }>(op, args)
      if (r.ok === false) setMessage(r.reason ?? 'That did not work.')
      else setMessage(r.duplicate ? 'Already saved.' : (done ?? ''))
      if (r.activeDeleted) {
        await newConversation()
        useStore.getState().setTurns([])
      }
      await refresh()
      return r.ok !== false
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Request failed.')
      return false
    }
  }

  return (
    <div className="approval-backdrop mem-backdrop">
      <section
        className="approval-card mem-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mem-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
      >
        <header className="mem-head">
          <h2 id="mem-title">Memory</h2>
          <button ref={closeButton} onClick={() => setOpen(false)}>Close</button>
        </header>
        <nav className="mem-tabs" aria-label="Memory sections">
          {(['memories', 'journal', 'workflows', 'conversations', 'privacy'] as Tab[]).map((t) => (
            <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        {message && <p role="status" className="mem-note">{message}</p>}
        {!data && <p>Memory is not available.</p>}

        {data && tab === 'memories' && (
          <>
            <p className="mem-note">
              Only what you asked to keep. Say “remember that…”, “what do you remember about me”, or “forget…”, or use this list.
            </p>
            <ul className="mem-list">
              {data.memories.length === 0 && <li className="mem-note">Nothing saved yet.</li>}
              {data.memories.map((m) => (
                <li key={m.id}>
                  {editing?.id === m.id ? (
                    <>
                      <input
                        value={editing.text}
                        maxLength={500}
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                      />
                      <button onClick={async () => { if (await act('update', { id: m.id, text: editing.text }, 'Updated.')) setEditing(null) }}>Save</button>
                      <button onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="mem-text">{m.text}</span>
                      <small>
                        #{m.id} · {m.scope === 'project' ? `project ${m.project}` : 'personal'} · saved {day(m.created_at)} · {m.source}
                      </small>
                      <button onClick={() => setEditing({ id: m.id, text: m.text })}>Edit</button>
                      <button onClick={() => void act('forget', { id: m.id }, 'Forgotten.')}>Forget</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <form
              className="mem-add"
              onSubmit={async (e) => {
                e.preventDefault()
                if (await act('add', { text: draft, scope, project: draftProject }, 'Saved.')) setDraft('')
              }}
            >
              <input value={draft} maxLength={500} placeholder="Remember this…" onChange={(e) => setDraft(e.target.value)} />
              <select value={scope} onChange={(e) => setScope(e.target.value as 'personal' | 'project')}>
                <option value="personal">personal</option>
                <option value="project">project</option>
              </select>
              {scope === 'project' && (
                <input value={draftProject} maxLength={80} placeholder="Repository folder" onChange={(e) => setDraftProject(e.target.value)} />
              )}
              <button type="submit" disabled={draft.trim().length < 3}>Save</button>
            </form>
          </>
        )}

        {data && tab === 'journal' && (
          <>
            <p className="mem-note">
              Recorded from real tool results, not from what the model said. “interrupted” means the outcome is unknown; “verified” means a test or build command exited 0.
            </p>
            {data.projects.length === 0 ? (
              <p className="mem-note">No project activity recorded yet.</p>
            ) : (
              <>
                <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
                  {data.projects.map((p) => (
                    <option key={p.project_key} value={p.project}>{p.project} ({p.n})</option>
                  ))}
                </select>
                <ul className="mem-list">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="mem-text"><b>{e.status}</b> · {e.summary}</span>
                      <small>{e.updated_at.slice(0, 16).replace('T', ' ')}{e.detail ? ` · ${e.detail}` : ''}</small>
                      <button onClick={() => void act('delete_event', { id: e.id }, 'Entry deleted.')}>Delete</button>
                    </li>
                  ))}
                </ul>
                <button onClick={() => void act('delete_project_events', { project }, 'Journal cleared.')}>
                  Delete this project’s journal
                </button>
              </>
            )}
          </>
        )}

        {data && tab === 'workflows' && (
          <>
            <p className="mem-note">
              Ask JARVIS to create or change a workflow; you approve the whole recipe first. Scheduled runs happen only while the bridge is running. Steps that run commands or push ask for approval on every run and wait if you are away
              {flows && flows.waiting > 0 ? ` — ${flows.waiting} waiting now` : ''}.
            </p>
            <ul className="mem-list">
              {flows?.workflows.length === 0 && <li className="mem-note">No workflows yet.</li>}
              {flows?.workflows.map((w) => {
                const last = flows.runs.find((r) => r.workflow === w.name)
                return (
                  <li key={w.id}>
                    <span className="mem-text">
                      <b>{w.name}</b> — {w.scheduleTime ? `daily ${w.scheduleTime}` : 'manual'}{w.enabled ? '' : ' (disabled)'}{w.running ? ' · running' : ''}
                    </span>
                    <small>
                      {w.steps.length} steps ({w.steps.filter((x) => x.type === 'run_command' || x.type === 'push_branch').length} need approval each run)
                      {last ? ` · last run ${last.startedAt.slice(0, 16).replace('T', ' ')}: ${last.status}` : ''}
                    </small>
                    <button disabled={w.running} onClick={() => void act('wf_run', { id: w.id }, 'Started; approvals will appear as they are needed.')}>Run now</button>
                    <button onClick={() => void act('wf_enable', { id: w.id, enabled: !w.enabled }, w.enabled ? 'Disabled.' : 'Enabled.')}>{w.enabled ? 'Disable' : 'Enable'}</button>
                    <button onClick={() => void act('wf_delete', { id: w.id }, 'Workflow deleted.')}>Delete</button>
                  </li>
                )
              })}
            </ul>
            {flows && flows.runs.length > 0 && (
              <>
                <h3>Recent runs</h3>
                <ul className="mem-list">
                  {flows.runs.slice(0, 8).map((r) => (
                    <li key={r.id}>
                      <span className="mem-text"><b>{r.status}</b> · {r.workflow} · {r.trigger}</span>
                      <small>{r.startedAt.slice(0, 16).replace('T', ' ')} · {r.steps.map((x) => `${x.index}:${x.status}`).join(' ')}</small>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {data && tab === 'conversations' && (
          <>
            <button
              onClick={async () => {
                await newConversation()
                useStore.getState().setTurns([])
                setOpen(false)
              }}
            >
              New conversation
            </button>
            <ul className="mem-list">
              {data.conversations.map((c) => (
                <li key={c.id}>
                  <span className="mem-text">{c.title ?? '(empty)'}{c.id === data.current ? ' — current' : ''}</span>
                  <small>{day(c.updated_at)} · {c.messages} messages{c.project ? ` · ${c.project}` : ''}</small>
                  <button onClick={() => void act('delete_conversation', { id: c.id }, 'Conversation deleted.')}>Delete</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {data && tab === 'privacy' && (
          <>
            <ul className="mem-note mem-facts">
              <li>Stored only on this computer, in <code>{data.storage}</code>, outside the project folder. It is not committed to Git and is not exported anywhere.</li>
              <li>Nothing is deleted automatically unless JARVIS_MEMORY_RETENTION_DAYS is set. Deleting here removes the text from the database file.</li>
              <li>When a memory is retrieved for a question it is sent to the model provider, like anything else you say to JARVIS.</li>
              <li>Credentials are filtered by pattern; that is not perfect, so do not tell JARVIS secrets.</li>
              <li>Memory never grants permission. Every command, deletion and push still asks for approval each time.</li>
            </ul>
            <p className="mem-note">
              {data.stats.conversations} conversations · {data.stats.messages} messages · {data.stats.memories} memories · {data.stats.events} journal entries
            </p>
            <form
              className="mem-add"
              onSubmit={async (e) => {
                e.preventDefault()
                if (await act('wipe', { confirm }, 'Everything erased.')) setConfirm('')
              }}
            >
              <input value={confirm} placeholder="Type ERASE ALL to confirm" onChange={(e) => setConfirm(e.target.value)} />
              <button type="submit" disabled={confirm !== 'ERASE ALL'}>Erase all memory</button>
            </form>
          </>
        )}
      </section>
    </div>
  )
}
