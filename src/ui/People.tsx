import { useCallback, useEffect, useState } from 'react'
import { forgetPerson, listPeople, recordAndEnrol, setSpeakerEnabled, type Person } from '../lib/speaker.ts'

/**
 * Settings → People (plan 01, Q85). The switch for recognising who is speaking,
 * the people whose voice JARVIS knows with a Delete for each, and a way to add
 * one: name, role, a consent box, then eight seconds of talking. A voiceprint
 * is numbers kept on this computer; Delete removes it for good.
 */

const ROLE_LABEL: Record<string, string> = { owner: 'You (owner)', member: 'Household member', child: 'Child' }

export function People({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => unknown }) {
  const [people, setPeople] = useState<Person[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState('member')
  const [consent, setConsent] = useState(false)

  const load = useCallback(async () => {
    setSpeakerEnabled(on)
    if (!on) {
      setPeople([])
      return
    }
    try {
      const r = await listPeople()
      if (r.ok) setPeople(r.people)
      else setNote(r.reason === 'speaker model not installed' ? 'The voice model is not installed yet; it downloads the first time it is needed.' : '')
    } catch {
      setNote('Could not read the list of people.')
    }
  }, [on])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    setBusy(true)
    setNote('Listening for eight seconds. Please talk normally.')
    try {
      const r = await recordAndEnrol(name.trim(), role, 8000)
      setNote(r.ok ? `Learned ${name.trim()}'s voice.` : r.reason === 'too-short' ? 'That was too short. Please try again.' : 'That did not work.')
      if (r.ok) {
        setName('')
        setConsent(false)
      }
      await load()
    } catch {
      setNote('The microphone could not be used.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: Person) => {
    setBusy(true)
    try {
      setNote((await forgetPerson(p.id)) ? `Deleted ${p.name}'s voiceprint.` : 'That did not work.')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label>
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void onToggle(e.target.checked)} /> Recognise who is
        speaking
      </label>
      <p className="mem-note">
        JARVIS learns each person&apos;s voice to greet them by name and treat strangers as guests. A voiceprint is numbers, kept only on this
        computer, never the recording. Off by default.
      </p>
      {on && (
        <>
          {people.length === 0 ? (
            <p className="mem-note">Nobody yet. Add yourself below, or say &ldquo;learn my voice&rdquo;.</p>
          ) : (
            <ul>
              {people.map((p) => (
                <li key={p.id}>
                  {p.name} · {ROLE_LABEL[p.role] ?? p.role} · {p.clips} {p.clips === 1 ? 'sample' : 'samples'}{' '}
                  <button type="button" disabled={busy} onClick={() => void remove(p)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p>
            <input placeholder="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />{' '}
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="owner">{ROLE_LABEL.owner}</option>
              <option value="member">{ROLE_LABEL.member}</option>
              <option value="child">{ROLE_LABEL.child}</option>
            </select>
          </p>
          <label>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> This person agrees to JARVIS keeping a voiceprint of
            their voice on this computer.
          </label>
          <p>
            <button type="button" disabled={busy || !consent || !name.trim()} onClick={() => void add()}>
              Record 8 seconds and learn this voice
            </button>
          </p>
        </>
      )}
      {note && <p className="mem-note">{note}</p>}
    </>
  )
}
