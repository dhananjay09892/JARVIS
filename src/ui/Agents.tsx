import { useCallback, useEffect, useState } from 'react'
import {
  MODE_LABEL,
  PAGE_SIZE,
  UNUSED_DAYS,
  budgetText,
  connectorsText,
  copyAgent,
  costText,
  definitionPatch,
  deleteAgent,
  filterAgents,
  getAgent,
  isAgentId,
  isUnused,
  listAgents,
  modeText,
  pageOf,
  readBudget,
  reloadAgents,
  replyText,
  reviewChoice,
  setAgentEnabled,
  successText,
  suggestCopyId,
  updateAgentDefinition,
  updateAgentFile,
  type AgentCard,
  type AgentDetail,
  type AgentEdits,
  type AgentReply,
  type AgentsList,
} from '../lib/agents'

/**
 * Settings → Agents (agents phase A3; plan 39). The roster from the bridge,
 * a page of 50 at a time, each with its on/off switch, run numbers and an
 * "unused for 30 days" hint; one agent's detail with how it runs, its tools,
 * connectors, budget and review, its recent runs and cost; copy, delete and
 * edit for the owner's own agents. Built-in agents can be read, copied and
 * switched, never changed.
 *
 * Everything shown is plain text (React escapes it); an agent's instructions
 * and file are shown in a <pre> or a <textarea>, never as HTML. The bridge
 * checks every change and says why it refused one; the policy engine still
 * decides every tool call an agent makes.
 */

type Act = (fn: () => Promise<AgentReply>, done?: (r: AgentReply) => string) => Promise<AgentReply | null>

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : 'never')

function Row({ agent, busy, act, open }: { agent: AgentCard; busy: boolean; act: Act; open: (id: string) => void }) {
  const toggle = (on: boolean) => {
    let confirm = false
    if (on && agent.runsUnasked) {
      confirm = window.confirm(
        `Switch on ${agent.name}? It runs without being asked (${MODE_LABEL[agent.mode]}), within its budget, and every action still goes through your permissions.`,
      )
      if (!confirm) return
    }
    void act(() => setAgentEnabled(agent.id, on, confirm), () => `${agent.name} switched ${on ? 'on' : 'off'}.`)
  }
  const s = agent.stats
  return (
    <li className="conn-card">
      <label>
        <input
          type="checkbox"
          checked={agent.switchedOn}
          disabled={busy}
          aria-label={`${agent.name} on or off`}
          onChange={(e) => toggle(e.target.checked)}
        />{' '}
        <strong>{agent.name}</strong>
      </label>{' '}
      <span className="mem-note">
        {MODE_LABEL[agent.mode] ?? agent.mode}
        {agent.readOnly ? ' · built-in' : agent.createdBy === 'agent' ? ' · made by an agent' : ' · yours'}
      </span>
      <p className="mem-note">{agent.description}</p>
      {!agent.active && agent.inactiveDetail && <p className="mem-note">Not active: {agent.inactiveDetail}</p>}
      <p className="mem-note">
        {s.runs} recent run{s.runs === 1 ? '' : 's'} · {successText(s)} · {s.minutes} min · {costText(s.costUsd)} · last run{' '}
        {when(s.lastRunAt)}
      </p>
      {isUnused(s) && (
        <p className="mem-note" role="note">
          Not used for over {UNUSED_DAYS} days. Switch it off or delete it if you no longer need it.
        </p>
      )}
      <button disabled={busy} onClick={() => open(agent.id)}>
        Details
      </button>
    </li>
  )
}

/** Name, description, review and budget, for the owner's own agents. */
function EditForm({ detail, busy, act, saved }: { detail: AgentDetail; busy: boolean; act: Act; saved: () => void }) {
  const d = detail.definition
  const [name, setName] = useState(d.name)
  const [description, setDescription] = useState(d.description)
  const [review, setReview] = useState(reviewChoice(detail))
  const [ownBudget, setOwnBudget] = useState(Boolean(d.budget))
  const [calls, setCalls] = useState(String(d.budget?.maxToolCalls ?? 40))
  const [minutes, setMinutes] = useState(String(d.budget?.maxMinutes ?? 20))
  const [cost, setCost] = useState(String(d.budget?.maxCostUsd ?? 1))
  const [error, setError] = useState('')

  const save = async () => {
    const edits: AgentEdits = { name, description, review }
    if (ownBudget) {
      const read = readBudget(calls, minutes, cost)
      if ('error' in read) return setError(read.error)
      edits.budget = read.budget
    } else edits.budget = null
    setError('')
    const r = await act(() => updateAgentDefinition(d.id, definitionPatch(detail, edits)), () => 'Saved.')
    if (r?.ok) saved()
  }

  return (
    <fieldset className="conn-grants">
      <legend>Edit</legend>
      <label>
        Name <input value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        What it does{' '}
        <input value={description} maxLength={500} disabled={busy} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Check its work{' '}
        <select value={review} disabled={busy} onChange={(e) => setReview(e.target.value as 'default' | 'on' | 'off')}>
          <option value="default">Follow the setting above</option>
          <option value="on">Always</option>
          <option value="off">Never</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={ownBudget} disabled={busy} onChange={(e) => setOwnBudget(e.target.checked)} /> Its own budget
      </label>
      {ownBudget && (
        <div className="mem-add">
          <label>
            Tool calls <input inputMode="numeric" value={calls} disabled={busy} onChange={(e) => setCalls(e.target.value)} />
          </label>
          <label>
            Minutes <input inputMode="decimal" value={minutes} disabled={busy} onChange={(e) => setMinutes(e.target.value)} />
          </label>
          <label>
            Cost ($) <input inputMode="decimal" value={cost} disabled={busy} onChange={(e) => setCost(e.target.value)} />
          </label>
        </div>
      )}
      {error && <p className="mem-note" role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void save()}>
        Save
      </button>
    </fieldset>
  )
}

/** The whole file as text: tools, connectors, how it runs and its instructions. */
function FileEditor({ detail, busy, act, saved }: { detail: AgentDetail; busy: boolean; act: Act; saved: () => void }) {
  const [text, setText] = useState(detail.file)
  const save = async () => {
    const r = await act(() => updateAgentFile(detail.definition.id, text), () => 'Saved.')
    if (r?.ok) saved()
  }
  return (
    <fieldset className="conn-grants">
      <legend>Edit the file</legend>
      <p className="mem-note">
        Tools and connectors can only be ones JARVIS has; anything else is refused and nothing is saved.
      </p>
      <textarea
        aria-label={`${detail.definition.name} file`}
        value={text}
        rows={14}
        spellCheck={false}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
      />
      <button disabled={busy || text === detail.file} onClick={() => void save()}>
        Save file
      </button>
    </fieldset>
  )
}

function Detail({
  id,
  roster,
  busy,
  act,
  close,
  version,
}: {
  id: string
  roster: AgentCard[]
  busy: boolean
  act: Act
  close: () => void
  version: number
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<'' | 'form' | 'file'>('')

  const load = useCallback(async () => {
    try {
      setDetail(await getAgent(id))
      setError('')
    } catch {
      setError('Could not read that agent.')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load, version])

  if (error) return <p className="mem-note">{error}</p>
  if (!detail || detail.definition.id !== id) return null
  const d = detail.definition
  const a = detail.agent

  const copy = () => {
    const suggested = suggestCopyId(id, roster.map((r) => r.id))
    const next = window.prompt('Id for the copy (lowercase letters, digits and dashes):', suggested)
    if (next === null) return
    const clean = next.trim()
    if (!isAgentId(clean)) {
      window.alert('Use lowercase letters, digits and dashes, starting with a letter (up to 40).')
      return
    }
    void act(() => copyAgent(id, clean), () => `Copied to ${clean}. Copies are yours to edit.`)
  }
  const remove = () => {
    if (!window.confirm(`Delete ${d.name}? Its file is removed; its past runs stay in the history.`)) return
    void act(() => deleteAgent(id), () => `${d.name} deleted.`).then((r) => r?.ok && close())
  }
  const saved = () => {
    setEditing('')
    void load()
  }

  return (
    <section className="conn-card" aria-labelledby="agent-detail">
      <h4 id="agent-detail">{d.name}</h4>
      <p className="mem-note">{d.description}</p>
      <dl>
        <dt>Runs</dt>
        <dd>{modeText(d)}</dd>
        <dt>Switch</dt>
        <dd>{a.switchedOn ? 'on' : 'off'}{a.active ? '' : ` (not active${a.inactiveDetail ? `: ${a.inactiveDetail}` : ''})`}</dd>
        <dt>Tools</dt>
        <dd>{d.tools.length ? d.tools.join(', ') : 'none'}</dd>
        <dt>Connectors</dt>
        <dd>{connectorsText(d.connectors)}</dd>
        <dt>Memory</dt>
        <dd>{d.memory === 'propose' ? 'reads and suggests (you approve)' : d.memory}</dd>
        <dt>Budget</dt>
        <dd>{budgetText(d.budget)}</dd>
        <dt>Checked by the reviewer</dt>
        <dd>{reviewChoice(detail) === 'default' ? `follows the setting (${a.review ? 'on' : 'off'})` : a.review ? 'always' : 'never'}</dd>
        {d.delegate.length > 0 && (
          <>
            <dt>May hand work to</dt>
            <dd>{d.delegate.join(', ')}</dd>
          </>
        )}
        <dt>Brain</dt>
        <dd>
          {d.brain}
          {d.model !== 'default' ? ` (${d.model})` : ''}
        </dd>
        <dt>Made by</dt>
        <dd>{d.createdBy === 'builtin' ? 'JARVIS (built-in, read-only)' : d.createdBy === 'agent' ? `an agent${d.requestedBy ? ` (${d.requestedBy})` : ''}` : 'you'}</dd>
      </dl>
      <details>
        <summary>Instructions</summary>
        <pre className="mem-note">{d.body}</pre>
      </details>

      <h5>Recent runs</h5>
      <p className="mem-note">
        {a.stats.runs} run{a.stats.runs === 1 ? '' : 's'} · {successText(a.stats)} · {a.stats.minutes} min · {costText(a.stats.costUsd)}
      </p>
      {detail.runs.length === 0 ? (
        <p className="mem-note">No recent runs.</p>
      ) : (
        <ul>
          {detail.runs.map((r) => (
            <li key={r.id} className="mem-note">
              {when(r.startedAt ?? r.createdAt)} · {r.status}
              {r.minutes !== null ? ` · ${r.minutes} min` : ''}
              {r.costUsd ? ` · ${costText(r.costUsd)}` : ''} · {r.title}
              {r.error ? ` · ${r.error}` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="mem-add">
        <button disabled={busy} onClick={copy}>
          Copy
        </button>
        {!a.readOnly && (
          <>
            <button disabled={busy} aria-pressed={editing === 'form'} onClick={() => setEditing(editing === 'form' ? '' : 'form')}>
              Edit
            </button>
            <button disabled={busy} aria-pressed={editing === 'file'} onClick={() => setEditing(editing === 'file' ? '' : 'file')}>
              Edit file
            </button>
            <button disabled={busy} onClick={remove}>
              Delete
            </button>
          </>
        )}
        <button onClick={close}>Close</button>
      </div>
      {a.readOnly && <p className="mem-note">Built-in agents cannot be changed. Copy one to make your own version.</p>}
      {a.createdBy === 'agent' && !a.readOnly && (
        <p className="mem-note">This agent was made by an agent: after a change it waits for your approval again.</p>
      )}
      {editing === 'form' && <EditForm key={detail.file} detail={detail} busy={busy} act={act} saved={saved} />}
      {editing === 'file' && <FileEditor key={detail.file} detail={detail} busy={busy} act={act} saved={saved} />}
    </section>
  )
}

export function Agents() {
  const [list, setList] = useState<AgentsList | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const load = useCallback(async () => {
    try {
      setList(await listAgents())
    } catch {
      setNote('Could not read the agents.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act: Act = async (fn, done) => {
    setBusy(true)
    setNote('')
    try {
      const r = await fn()
      setNote(r.ok ? (done?.(r) ?? '') : replyText(r))
      await load()
      setVersion((v) => v + 1)
      return r
    } catch {
      setNote('Cannot reach the JARVIS bridge. Is it running?')
      return null
    } finally {
      setBusy(false)
    }
  }

  if (!list) return note ? <p className="mem-note">{note}</p> : null

  const roster = filterAgents(list.agents, query)
  const shown = pageOf(roster, page)

  return (
    <>
      {list.limits.paused && <p className="mem-note" role="status">All agents are paused.</p>}
      {note && (
        <p role="status" className="mem-note">
          {note}
        </p>
      )}
      <div className="mem-add">
        <input
          type="search"
          placeholder="Find an agent"
          aria-label="Find an agent"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(0)
          }}
        />
        <button disabled={busy} onClick={() => void act(reloadAgents, () => 'Agent files read again.')}>
          Read files again
        </button>
      </div>
      {open && <Detail id={open} roster={list.agents} busy={busy} act={act} close={() => setOpen(null)} version={version} />}
      {list.agents.length === 0 && <p className="mem-note">No agents yet.</p>}
      {list.agents.length > 0 && roster.length === 0 && <p className="mem-note">No agent matches.</p>}
      <ul className="agent-roster">
        {shown.items.map((a) => (
          <Row key={a.id} agent={a} busy={busy} act={act} open={setOpen} />
        ))}
      </ul>
      {shown.pages > 1 && (
        <div className="mem-add">
          <button disabled={shown.page === 0} onClick={() => setPage(shown.page - 1)}>
            Previous
          </button>{' '}
          <span className="mem-note">
            Page {shown.page + 1} of {shown.pages} ({roster.length} agents, {PAGE_SIZE} a page)
          </span>{' '}
          <button disabled={shown.page >= shown.pages - 1} onClick={() => setPage(shown.page + 1)}>
            Next
          </button>
        </div>
      )}
      {list.refused.length > 0 && (
        <details>
          <summary className="mem-note">
            {list.refused.length} agent file{list.refused.length === 1 ? ' was' : 's were'} not loaded
          </summary>
          <ul>
            {list.refused.map((r) => (
              <li key={`${r.source}/${r.file}`} className="mem-note">
                {r.file}: {r.reasons.slice(0, 3).join('; ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
