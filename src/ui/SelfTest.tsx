import { useCallback, useEffect, useRef, useState } from 'react'
import { chosenMic, openDeviceId, setChosenMic } from '../lib/audio'
import { micOptions, type MicOption } from '../lib/micChoice'
import {
  diagnoseCamera,
  diagnoseChoice,
  diagnoseDevice,
  diagnoseQuiet,
  diagnoseSpeaker,
  diagnoseVoice,
  problemIds,
  summarise,
  worst,
  type Finding,
} from '../lib/selftest'
import { checkCamera, isFinding, openMicSession, type MicSession } from '../lib/selftestRunner'

/**
 * "Microphone and speakers" (plan 29 phase 2, Q31): the wizard's hardware
 * check, also offered from Settings so it can be run again any time.
 *
 * About fifteen seconds: a quiet moment (noise floor), one spoken line
 * (voice level), a test sound (speakers, and how much the microphone hears
 * them). Every problem comes with what to do about it. Skippable: the wizard's
 * own Next button moves on whatever the result.
 *
 * Q77 added the "Microphone" choice above the test (used by the test and by
 * JARVIS's own listening, see src/lib/micChoice.ts), an optional camera
 * check, and `onFinished`, which hands the ids of what was found wrong to the
 * opt-in setup metric (never titles: they can name a device).
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

export function SelfTest({ onFinished }: { onFinished?: (problemIds: string[]) => void } = {}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [findings, setFindings] = useState<Finding[]>([])
  const [mics, setMics] = useState<MicOption[]>([])
  const [mic, setMic] = useState(chosenMic())
  const [micNote, setMicNote] = useState('')
  const [cam, setCam] = useState<{ busy: boolean; findings: Finding[]; still: string }>({ busy: false, findings: [], still: '' })

  const listMics = useCallback(async () => {
    const devices = await navigator.mediaDevices?.enumerateDevices?.().catch((): MediaDeviceInfo[] => [])
    setMics(micOptions(devices ?? []))
  }, [])

  // Names appear once the microphone has been allowed, and the list changes
  // when a headset is plugged in or out.
  useEffect(() => {
    void listMics()
    const md = navigator.mediaDevices
    md?.addEventListener?.('devicechange', listMics)
    return () => md?.removeEventListener?.('devicechange', listMics)
  }, [listMics])

  const chooseMic = (id: string) => {
    setMic(id)
    const reload = setChosenMic(id)
    setMicNote(reload ? 'Saved. JARVIS is already listening on the old microphone: reload the page to switch.' : 'Saved.')
  }

  const finish = (list: Finding[]) => {
    setFindings(list)
    setPhase('done')
    onFinished?.(problemIds(list))
  }
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
      finish([opened])
      return
    }
    session.current = opened
    void listMics()
    const { facts } = opened
    const found: Finding[] = [...diagnoseChoice(opened.fellBack), ...diagnoseDevice(facts)]
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
    finish([...findings, ...diagnoseSpeaker(heard, e.quietFloor, e.during)])
  }

  const testCamera = async () => {
    setCam({ busy: true, findings: [], still: '' })
    const { facts, still } = await checkCamera()
    const found = diagnoseCamera(facts)
    setCam({ busy: false, findings: found, still })
    onFinished?.(problemIds(found))
  }

  const list = (fs: Finding[]) => (
    <ul className="selftest-list" aria-live="polite">
      {fs.map((f) => (
        <li key={f.id} className={`selftest-${f.severity}`}>
          <b aria-hidden="true">{ICON[f.severity]}</b> {f.title}
          {f.fix && <div className="mem-note">{f.fix}</div>}
        </li>
      ))}
    </ul>
  )

  // The device the open stream is on, to mark it in the list.
  const listening = openDeviceId()

  const verdict = worst(findings)
  const running = phase !== 'idle' && phase !== 'done'

  return (
    <div className="selftest">
      <p className="mem-note">
        A fifteen-second check that JARVIS can hear you and you can hear him. Nothing is recorded or sent anywhere.
      </p>
      <label>
        Microphone{' '}
        <select disabled={running} value={mic} onChange={(e) => chooseMic(e.target.value)} aria-describedby="mic-choice-note">
          <option value="">Windows default</option>
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.id === listening ? ' (in use)' : ''}
            </option>
          ))}
          {mic && !mics.some((m) => m.id === mic) && <option value={mic}>Chosen microphone (not plugged in)</option>}
        </select>
      </label>
      <p id="mic-choice-note" className="mem-note">
        {micNote ? `${micNote} ` : ''}Used for the wake word, voice detection, the clap and this test. Without an ElevenLabs
        key JARVIS uses the browser&apos;s own speech recognition, which always listens on the Windows default
        (Settings → System → Sound → Input).
        {mics.length > 0 && mics.every((m) => /^Microphone \d+$/.test(m.label)) ? ' Names appear after the first test.' : ''}
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
      {findings.length > 0 && list(findings)}
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

      <p className="mem-note">
        Camera (optional): only for hand gestures and “look at this”. The check looks at one frame on this page and
        keeps nothing.
      </p>
      {cam.still && <img className="selftest-still" src={cam.still} alt="What the camera sees" width={160} height={90} />}
      {cam.findings.length > 0 && list(cam.findings)}
      <button disabled={cam.busy || running} onClick={() => void testCamera()}>
        {cam.busy ? 'Checking the camera…' : 'Test camera'}
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
