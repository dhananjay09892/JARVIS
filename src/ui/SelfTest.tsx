import { useEffect, useRef, useState } from 'react'
import {
  diagnoseDevice,
  diagnoseQuiet,
  diagnoseSpeaker,
  diagnoseVoice,
  summarise,
  worst,
  type Finding,
} from '../lib/selftest'
import { isFinding, openMicSession, type MicSession } from '../lib/selftestRunner'

/**
 * "Microphone and speakers" (plan 29 phase 2, Q31): the wizard's hardware
 * check, also offered from Settings so it can be run again any time.
 *
 * About fifteen seconds: a quiet moment (noise floor), one spoken line
 * (voice level), a test sound (speakers, and how much the microphone hears
 * them). Every problem comes with what to do about it. Skippable: the wizard's
 * own Next button moves on whatever the result.
 */

type Phase = 'idle' | 'opening' | 'quiet' | 'voice' | 'sound' | 'heard' | 'done'

const PROMPT: Partial<Record<Phase, string>> = {
  opening: 'Opening the microphone… allow it if the browser asks.',
  quiet: 'Stay quiet for two seconds…',
  voice: 'Now say, in your normal voice: “Hey Jarvis, what time is it?”',
  sound: 'Playing a test sound…',
  heard: 'Did you hear the test sound?',
}

const ICON = { ok: '✓', warn: '!', fail: '✗' } as const

export function SelfTest() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [findings, setFindings] = useState<Finding[]>([])
  const session = useRef<MicSession | null>(null)
  const echo = useRef<{ quietFloor: number; during: { floor: number } } | null>(null)

  // Never leave the microphone open if the dialog closes mid-test.
  useEffect(() => () => session.current?.close(), [])

  const stop = () => {
    session.current?.close()
    session.current = null
  }

  const run = async () => {
    stop()
    setFindings([])
    setPhase('opening')
    const opened = await openMicSession()
    if (isFinding(opened)) {
      setFindings([opened])
      setPhase('done')
      return
    }
    session.current = opened
    const { facts } = opened
    const found: Finding[] = [...diagnoseDevice(facts)]
    setFindings([...found])

    setPhase('quiet')
    const quiet = summarise(await opened.measure(2000))
    const quietFindings = diagnoseQuiet(facts, quiet)
    // A muted device already explains the silence; don't say it twice.
    const muted = found.some((f) => f.id === 'mic-muted')
    found.push(...quietFindings.filter((f) => !(muted && f.id === 'mic-silent')))
    setFindings([...found])
    const dead = quietFindings.some((f) => f.id === 'mic-silent' || f.id === 'mic-wrong-device')

    if (!dead) {
      setPhase('voice')
      const speech = summarise(await opened.measure(3500))
      found.push(...diagnoseVoice(facts, quiet.floor, speech))
      setFindings([...found])
    }

    setPhase('sound')
    const during = summarise(await opened.playAndMeasure(2000))
    stop()
    echo.current = { quietFloor: quiet.floor, during: dead ? { floor: quiet.floor } : during }
    setPhase('heard')
  }

  const answer = (heard: boolean) => {
    const e = echo.current ?? { quietFloor: 0, during: { floor: 0 } }
    setFindings((f) => [...f, ...diagnoseSpeaker(heard, e.quietFloor, e.during)])
    setPhase('done')
  }

  const verdict = worst(findings)
  const running = phase !== 'idle' && phase !== 'done'

  return (
    <div className="selftest">
      <p className="mem-note">
        A fifteen-second check that JARVIS can hear you and you can hear him. Nothing is recorded or sent anywhere.
      </p>
      {PROMPT[phase] && (
        <p role="status" className="selftest-prompt">
          {PROMPT[phase]}
        </p>
      )}
      {phase === 'heard' && (
        <p>
          <button onClick={() => answer(true)}>Yes, I heard it</button>
          <button onClick={() => answer(false)}>No</button>
          <button onClick={() => void replay()}>Play it again</button>
        </p>
      )}
      {findings.length > 0 && (
        <ul className="selftest-list" aria-live="polite">
          {findings.map((f) => (
            <li key={f.id} className={`selftest-${f.severity}`}>
              <b aria-hidden="true">{ICON[f.severity]}</b> {f.title}
              {f.fix && <div className="mem-note">{f.fix}</div>}
            </li>
          ))}
        </ul>
      )}
      {phase === 'done' && (
        <p role="status">
          {verdict === 'ok'
            ? 'Microphone and speakers look good.'
            : verdict === 'warn'
              ? 'JARVIS will work, with the notes above.'
              : 'Fix the problem above, then test again. You can also skip this and come back from Settings.'}
        </p>
      )}
      <button disabled={running} onClick={() => void run()}>
        {phase === 'idle' ? 'Test microphone and speakers' : 'Test again'}
      </button>
    </div>
  )

  /** Replay just the sound (and re-measure the echo) before answering. */
  async function replay() {
    const again = await openMicSession()
    if (isFinding(again)) return
    session.current = again
    setPhase('sound')
    const during = summarise(await again.playAndMeasure(2000))
    stop()
    if (echo.current) echo.current = { ...echo.current, during }
    setPhase('heard')
  }
}
