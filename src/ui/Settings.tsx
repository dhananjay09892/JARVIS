import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BACKEND } from '../config'
import {
  getSettings,
  getSettingsSchema,
  getSetupStatus,
  saveSettings,
  startClaudeLogin,
  testElevenLabs,
  type PublicSettings,
  type SaveResult,
  type SettingDef,
  type SettingsSchema,
  type SetupStatus,
} from '../lib/settings'

/**
 * Settings and first-run setup, in one dialog.
 *
 * The first time JARVIS opens (setupDone is not "1") it shows a three-step
 * wizard: Claude sign-in, an optional voice key, then done. Afterwards the same
 * button opens the full settings form. Every step can be skipped — nothing
 * here is required for JARVIS to run on the browser's own speech.
 */

/**
 * What happens to microphone audio while JARVIS waits for his name. Keep this
 * in step with DISCLAIMER.txt and voice.ts: the wake word is matched on a cloud
 * transcript today, so this must not claim on-device wake detection until plan
 * 02's offline engine ships. bridge/disclosure.test.mjs checks the wording.
 */
const LISTENING_NOTE = [
  'The wake word is not detected on this computer yet. After you click INITIALISE, JARVIS keeps the microphone open until you close it, and sends what it hears to a speech service to listen for “Hey Jarvis”, even while asleep.',
  'With an ElevenLabs key, sound loud enough to be speech is sent to ElevenLabs. Without one, your browser streams the microphone to its own speech service (Google in Chrome, Microsoft in Edge).',
  'Close JARVIS when you do not want it listening. An offline wake word is planned.',
]

const listeningNote = (
  <>
    {LISTENING_NOTE.map((line) => (
      <p key={line} className="mem-note">
        {line}
      </p>
    ))}
  </>
)

/**
 * What the dialog falls back to if the bridge's settings registry
 * (GET /settings/schema, plan 39) cannot be read. The bridge validates every
 * save either way; the schema only decides what the controls offer.
 */
const FALLBACK: Record<string, Pick<SettingDef, 'default' | 'options' | 'help'>> = {
  JARVIS_MODEL: { default: 'claude-opus-5', help: '' },
  JARVIS_EFFORT: { default: 'high', options: ['low', 'medium', 'high', 'xhigh'], help: '' },
  JARVIS_ALLOW_WRITES: {
    default: '0',
    help: 'Off by default: JARVIS can look at things but changes nothing.',
  },
}

/** The registry entry for a setting, or the built-in fallback. */
function def(schema: SettingsSchema | null, id: string) {
  return schema?.settings.find((d) => d.id === id) ?? FALLBACK[id]
}

/** Status line after a save, from what the bridge says took effect. */
function savedNote(r: SaveResult) {
  if (r.overridden.length) return `Saved, but an environment variable overrides ${r.overridden.join(', ')}.`
  if (r.needsRestart.length) return 'Saved. Restart JARVIS to apply.'
  return 'Saved.'
}

export function Settings() {
  const [open, setOpen] = useState(false)
  const [wizard, setWizard] = useState(false)
  const [step, setStep] = useState(0)
  const [s, setS] = useState<PublicSettings | null>(null)
  const [schema, setSchema] = useState<SettingsSchema | null>(null)
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await getSettings()
      setS(next)
      return next
    } catch {
      setNote('Cannot reach the JARVIS bridge. Is it running?')
      return null
    }
  }, [])

  useEffect(() => {
    if (BACKEND !== 'bridge') return
    getSettingsSchema().then(setSchema, () => setSchema(null))
    void load().then((next) => {
      if (next && next.setupDone !== '1') {
        setWizard(true)
        setOpen(true)
      }
    })
  }, [load])

  const checkClaude = useCallback(async () => {
    setStatus(null)
    try {
      setStatus(await getSetupStatus())
    } catch {
      setNote('Could not check your Claude sign-in.')
    }
  }, [])

  useEffect(() => {
    if (open && (step === 0 || !wizard)) void checkClaude()
  }, [open, step, wizard, checkClaude])

  if (BACKEND !== 'bridge') return null

  const run = async (fn: () => Promise<unknown>, done = '') => {
    setBusy(true)
    setNote('')
    try {
      const out = await fn()
      setNote(typeof out === 'string' ? out : done)
      return true
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That did not work.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const patch = (change: Record<string, string>, done: string) =>
    run(async () => setS(await saveSettings(change)), done)

  /** Save a Brain or Actions control and say whether it is already in force. */
  const patchSetting = (change: Record<string, string>) =>
    run(async () => {
      const result = await saveSettings(change)
      setS(result)
      return savedNote(result)
    })

  const model = def(schema, 'JARVIS_MODEL')
  const effort = def(schema, 'JARVIS_EFFORT')
  const writes = def(schema, 'JARVIS_ALLOW_WRITES')

  const saveKey = async () => {
    if (!(await patch({ ELEVENLABS_API_KEY: keyDraft }, 'Key saved.'))) return
    setKeyDraft('')
    const t = await testElevenLabs()
    setNote(t.ok ? 'Key saved and working. JARVIS will use the ElevenLabs voice.' : `Key saved, but: ${t.reason}`)
  }

  const finish = async () => {
    await patch({ setupDone: '1' }, '')
    setWizard(false)
    setOpen(false)
  }

  const close = () => {
    if (wizard) void finish()
    else setOpen(false)
  }

  if (!open) {
    return (
      <button className="mem-open" onClick={() => setOpen(true)} aria-label="Open settings">
        SETTINGS
      </button>
    )
  }

  const claudeLine = !status
    ? 'Checking your Claude sign-in…'
    : !status.claudeInstalled
      ? 'Claude was not found on this computer. Reinstall JARVIS to fix it.'
      : !status.claudeLoggedIn
        ? 'Not signed in yet. Press Sign in, finish in the browser window that opens, then press Check again.'
        : `Claude is ready (version ${status.claudeVersion.split(' ')[0]}).`

  const keyBlock = (
    <>
      <p className="mem-note">
        Optional. An ElevenLabs key gives JARVIS a much better voice and sharper hearing. Without it he uses your
        browser&apos;s own speech. The key stays on this computer.
      </p>
      <p className="mem-note">Key: {s?.ELEVENLABS_API_KEY_set ? 'saved ✓' : 'not set'}</p>
      <div className="mem-add">
        <input
          type="password"
          autoComplete="off"
          placeholder="Paste ElevenLabs API key"
          aria-label="ElevenLabs API key"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <button disabled={busy || !keyDraft.trim()} onClick={saveKey}>Save key</button>
        {s?.ELEVENLABS_API_KEY_set && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const t = await testElevenLabs()
                  if (!t.ok) throw new Error(t.reason)
                }, 'Key works.')
              }
            >
              Test key
            </button>
            <button disabled={busy} onClick={() => patch({ ELEVENLABS_API_KEY: '' }, 'Key removed.')}>
              Remove
            </button>
          </>
        )}
      </div>
    </>
  )

  // Portalled to <body>: inside .hud this dialog is stacked below the full-screen
  // INITIALISE button, so a first-time user could not see the wizard.
  return createPortal(
    <div className="approval-backdrop mem-backdrop hud-modal">
      <section
        className="approval-card mem-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="set-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
      >
        <header className="mem-head">
          <h2 id="set-title">{wizard ? `Welcome — step ${step + 1} of 3` : 'Settings'}</h2>
          <button onClick={close}>{wizard ? 'Skip setup' : 'Close'}</button>
        </header>
        {note && <p role="status" className="mem-note">{note}</p>}

        {wizard && step === 0 && (
          <>
            <h3>1 · Claude</h3>
            <p className="mem-note">JARVIS thinks with your own Claude account. There is no API key to copy.</p>
            <p role="status">{claudeLine}</p>
            <button
              disabled={busy}
              onClick={() => run(startClaudeLogin, 'Finish signing in in the browser window, then press Check again.')}
            >
              Sign in
            </button>
            <button onClick={checkClaude}>Check again</button>
            <button onClick={() => setStep(1)}>Next</button>
          </>
        )}
        {wizard && step === 1 && (
          <>
            <h3>2 · Better voice (optional)</h3>
            {keyBlock}
            <p>
              <button onClick={() => setStep(0)}>Back</button>
              <button onClick={() => setStep(2)}>{s?.ELEVENLABS_API_KEY_set ? 'Next' : 'Skip'}</button>
            </p>
          </>
        )}
        {wizard && step === 2 && (
          <>
            <h3>3 · All set</h3>
            <p>
              Click INITIALISE, allow the microphone when your browser asks, then say <b>“Hey Jarvis”</b>. You can
              change any of this later under SETTINGS.
            </p>
            {listeningNote}
            <button onClick={() => setStep(1)}>Back</button>
            <button disabled={busy} onClick={finish}>Finish</button>
          </>
        )}

        {!wizard && s && (
          <>
            <h3>Claude</h3>
            <p role="status">{claudeLine}</p>
            <button
              disabled={busy}
              onClick={() => run(startClaudeLogin, 'Finish signing in in the browser window, then press Check again.')}
            >
              Sign in
            </button>
            <button onClick={checkClaude}>Check again</button>

            <h3>Voice</h3>
            {keyBlock}

            <h3>Listening</h3>
            {listeningNote}

            <h3>Brain</h3>
            <div className="mem-add">
              <label>
                Model{' '}
                <input
                  defaultValue={s.JARVIS_MODEL}
                  placeholder={model.default}
                  aria-label="Model"
                  title={model.help || undefined}
                  onBlur={(e) =>
                    e.target.value !== s.JARVIS_MODEL && patchSetting({ JARVIS_MODEL: e.target.value })
                  }
                />
              </label>
              <label>
                Effort{' '}
                <select
                  aria-label="Effort"
                  title={effort.help || undefined}
                  value={s.JARVIS_EFFORT}
                  onChange={(e) => patchSetting({ JARVIS_EFFORT: e.target.value })}
                >
                  <option value="">default ({effort.default})</option>
                  {(effort.options ?? []).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            </div>

            <h3>Actions</h3>
            <label>
              <input
                type="checkbox"
                checked={s.JARVIS_ALLOW_WRITES === '1'}
                onChange={(e) => patchSetting({ JARVIS_ALLOW_WRITES: e.target.checked ? '1' : '0' })}
              />{' '}
              Let JARVIS take real actions (run commands, change files, click and type in the browser)
            </label>
            <p className="mem-note">{writes.help} Applies after a restart.</p>

            <p className="mem-note">Saved in {s.storage}</p>
            <button
              onClick={() => {
                setStep(0)
                setWizard(true)
              }}
            >
              Run setup wizard again
            </button>
          </>
        )}
      </section>
    </div>,
    document.body,
  )
}
