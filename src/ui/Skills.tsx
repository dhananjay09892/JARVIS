import { useCallback, useEffect, useState } from 'react'
import {
  installPack, listSkills, pauseSkills, pinSkill, removeSkill, reviewPack, rollBackSkill, setSkillEnabled,
  type InstalledSkill, type SkillReply, type SkillReview, type SkillsList,
} from '../lib/skills'

/**
 * Settings → Skills (plan 19 phase 4). Installed skills with a switch, pin,
 * roll back and remove each, a "pause all skills" switch, and the first-party
 * packs. Installing shows the permission review first: what the skill may use,
 * what each step would do now, and anything odd found in its text. The pack is
 * installed only when the owner approves that exact review.
 *
 * Everything shown is plain text (React escapes it). Skills never widen what
 * JARVIS may do: a step that writes waits until "allow actions" is on.
 */

const RISK: Record<string, string> = { low: 'low risk', medium: 'medium risk', high: 'high risk' }
const VERDICT: Record<string, string> = { allow: 'runs', ask: 'asks first', deny: 'waits for “allow actions” or is refused' }

function Installed({ skill, busy, act }: { skill: InstalledSkill; busy: boolean; act: (fn: () => Promise<SkillReply>, ok: string) => void }) {
  const name = skill.name ?? skill.id
  return (
    <li className="conn-card">
      <label>
        <input
          type="checkbox"
          checked={skill.on}
          disabled={busy || Boolean(skill.broken)}
          aria-label={`${name} on or off`}
          onChange={(e) => act(() => setSkillEnabled(skill.id, e.target.checked), `${name} switched ${e.target.checked ? 'on' : 'off'}.`)}
        />{' '}
        <strong>{name}</strong>
      </label>{' '}
      <span className="mem-note">
        v{skill.version}
        {skill.riskTier ? ` · ${RISK[skill.riskTier] ?? skill.riskTier}` : ''}
        {skill.pinned ? ' · pinned' : ''}
      </span>
      {skill.broken ? (
        <p className="mem-note">This skill no longer checks out and will not run: {skill.broken[0]}</p>
      ) : (
        <>
          <p className="mem-note">{skill.description}</p>
          <p className="mem-note">Say: {(skill.phrases ?? []).map((p) => `“${p}”`).join(', ')} · uses {(skill.tools ?? []).join(', ')}</p>
        </>
      )}
      <button disabled={busy} onClick={() => act(() => pinSkill(skill.id, !skill.pinned), skill.pinned ? 'Unpinned.' : 'Pinned: updates are held.')}>
        {skill.pinned ? 'Unpin' : 'Pin version'}
      </button>{' '}
      <button disabled={busy || !skill.canRollBack} onClick={() => act(() => rollBackSkill(skill.id), 'Rolled back, and pinned there.')}>
        Roll back
      </button>{' '}
      <button
        disabled={busy}
        onClick={() => window.confirm(`Remove ${name}?`) && act(() => removeSkill(skill.id), `${name} removed.`)}
      >
        Remove
      </button>
    </li>
  )
}

function Review({ review, busy, approve, cancel }: { review: SkillReview; busy: boolean; approve: () => void; cancel: () => void }) {
  return (
    <div className="conn-card" role="group" aria-label={`Permission review for ${review.name}`}>
      <strong>Review before installing: {review.name}</strong> <span className="mem-note">v{review.version}</span>
      <p className="mem-note">It may use:</p>
      <ul>
        {(review.screen.permissions ?? []).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="mem-note">Its steps, as things stand now:</p>
      <ol>
        {review.steps.map((s) => (
          <li key={s.step}>
            {s.label ?? s.tool} ({s.tool}): {VERDICT[s.verdict] ?? s.verdict}
          </li>
        ))}
      </ol>
      {review.findings.length > 0 && (
        <p role="alert">
          Look closer: {review.findings.map((f) => `${f.where}: ${f.problem}`).join('; ')}
        </p>
      )}
      <button disabled={busy} onClick={approve}>
        Approve and install
      </button>{' '}
      <button disabled={busy} onClick={cancel}>
        Cancel
      </button>
    </div>
  )
}

export function Skills() {
  const [list, setList] = useState<SkillsList | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [review, setReview] = useState<SkillReview | null>(null)
  const [pack, setPack] = useState('')

  const load = useCallback(() => {
    listSkills().then(setList).catch(() => setNote('Could not reach the bridge.'))
  }, [])
  useEffect(load, [load])

  const act = (fn: () => Promise<SkillReply>, ok: string) => {
    setBusy(true)
    void fn()
      .then((r) => {
        if (r.ok) { setNote(ok); if (r.snapshot) setList(r.snapshot); else load() }
        else setNote(r.reason)
      })
      .finally(() => setBusy(false))
  }

  const startReview = (name: string) => {
    setBusy(true)
    setNote('')
    void reviewPack(name)
      .then((r) => {
        if (r.ok) { setReview(r); setPack(name) } else setNote(r.reason)
      })
      .finally(() => setBusy(false))
  }

  const offered = (list?.packs ?? []).filter((p) => p.installedVersion === null)
  return (
    <section aria-label="Skills">
      <h4>Skills</h4>
      <p className="mem-note">
        A skill is a saved routine you start by saying its phrase. It can only use what it asks for, and every step still goes through your permissions.
      </p>
      <label>
        <input
          type="checkbox"
          checked={list?.pausedSetting ?? false}
          disabled={busy || !list}
          onChange={(e) => act(() => pauseSkills(e.target.checked), e.target.checked ? 'All skills paused.' : 'Skills are back on.')}
        />{' '}
        Pause all skills
      </label>
      {list?.paused && !list.pausedSetting && <p className="mem-note">Skills are stopped by the kill switch.</p>}
      {note && <p role="status" className="mem-note">{note}</p>}
      {list && list.installed.length === 0 && <p className="mem-note">No skills installed yet.</p>}
      <ul className="conn-list">
        {(list?.installed ?? []).map((s) => (
          <Installed key={s.id} skill={s} busy={busy} act={act} />
        ))}
      </ul>
      {review ? (
        <Review
          review={review}
          busy={busy}
          cancel={() => setReview(null)}
          approve={() => {
            act(() => installPack(pack, review.reviewId), `${review.name} installed.`)
            setReview(null)
          }}
        />
      ) : (
        offered.length > 0 && (
          <>
            <p className="mem-note">Ready-made skills:</p>
            <ul className="conn-list">
              {offered.map((p) => (
                <li key={p.name} className="conn-card">
                  <strong>{p.name}</strong>{' '}
                  <button disabled={busy} onClick={() => startReview(p.name)}>
                    Review and install
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </section>
  )
}
