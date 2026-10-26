import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BACKEND } from '../config'
import { Connectors } from './Connectors'
import { OpenAISignIn } from './OpenAISignIn'
import { setReflexesEnabled } from '../lib/reflex'
import {
  getSettings,
  getSettingsSchema,
  getSetupStatus,
  restartBridge,
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
 * in step with DISCLAIMER.txt, the README and src/lib/wake/router.ts (the code
 * that keeps asleep audio here). bridge/disclosure.test.mjs checks the wording.
 */
const LISTENING_NOTE = [
  'After you click INITIALISE, JARVIS keeps the microphone open until you close it. The offline wake word listens for “Hey Jarvis” on this computer, so while he is asleep what the microphone hears stays here.',
  'Once he hears his name, what you say is sent to be turned into text: to ElevenLabs if you added a key, otherwise to your browser’s own speech service (Google in Chrome, Microsoft in Edge).',
  'If you turn the offline wake word off, or it cannot start, JARVIS falls back to cloud listening and shows a CLOUD LISTENING badge: sound heard while he is asleep is then sent to that same speech service to find his name. Close JARVIS when you do not want it listening.',
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
  JARVIS_WAKE_WORD: { default: 'offline', options: ['offline', 'cloud'], help: '' },
  JARVIS_WAKE_SENSITIVITY: { default: 'medium', options: ['low', 'medium', 'high'], help: '' },
  JARVIS_REFLEXES: { default: '1', help: '' },
  JARVIS_MODEL: { default: 'claude-opus-5', help: '' },
  JARVIS_CLAUDE_AUTH: { default: 'subscription', options: ['subscription', 'apikey'], help: '' },
  JARVIS_BRAIN: { default: 'claude', options: ['claude', 'openai'], help: '' },
  JARVIS_OPENAI_AUTH: { default: 'apikey', options: ['apikey', 'chatgpt'], help: '' },
  JARVIS_OPENAI_MODEL: { default: 'gpt-5-mini', help: '' },
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
  if (r.nextConversation.length) return 'Saved. Applies from the next conversation.'
  return 'Saved.'
}

/**
 * "Restart JARVIS to apply", with one button (plan 39 phase 4). Shown while a
 * restart-only setting is saved but not yet in force, inside and outside the
 * dialog. Without a launcher to start it again the bridge cannot restart
 * itself, and the banner says so instead of offering the button.
 */
function RestartBanner({
  s,
  schema,
  busy,
  onRestart,
}: {
  s: PublicSettings | null
  schema: SettingsSchema | null
  busy: boolean
  onRestart: () => void
}) {
  const pending = s?.restartPending ?? []
  if (!pending.length) return null
  const names = pending.map((id) => schema?.settings.find((d) => d.id === id)?.label ?? id).join(', ')
  return (
    <div role="status" className="mem-note restart-banner">
      Restart JARVIS to apply: {names}.{' '}
      {s?.canRestart ? (
        <button disabled={busy} onClick={onRestart}>
          Restart JARVIS
        </button>
      ) : (
        'Stop JARVIS and start it again.'
      )}
    </div>
  )
}

export function Settings() {
  const [open, setOpen] = useState(false)
  const [wizard, setWizard] = useState(false)
  const [step, setStep] = useState(0)
  const [s, setS] = useState<PublicSettings | null>(null)
  const [schema, setSchema] = useState<SettingsSchema | null>(null)
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [claudeKeyDraft, setClaudeKeyDraft] = useState('')
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState('')
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
  const claudeAuth = def(schema, 'JARVIS_CLAUDE_AUTH')
  const brainChoice = def(schema, 'JARVIS_BRAIN')
  const openaiModel = def(schema, 'JARVIS_OPENAI_MODEL')
  const openaiAuthDef = def(schema, 'JARVIS_OPENAI_AUTH')
  const effort = def(schema, 'JARVIS_EFFORT')
  const writes = def(schema, 'JARVIS_ALLOW_WRITES')
  const wakeWord = def(schema, 'JARVIS_WAKE_WORD')
  const wakeSensitivity = def(schema, 'JARVIS_WAKE_SENSITIVITY')
  const reflexes = def(schema, 'JARVIS_REFLEXES')

  const saveKey = async () => {
    if (!(await patch({ ELEVENLABS_API_KEY: keyDraft }, 'Key saved.'))) return
    setKeyDraft('')
    const t = await testElevenLabs()
    setNote(t.ok ? 'Key saved and working. JARVIS will use the ElevenLabs voice.' : `Key saved, but: ${t.reason}`)
  }

  /**
   * Restart the bridge, wait for the new one to answer, then reload the page:
   * some restart-only settings (the wake word) are read by the page when it
   * starts, so "Restart JARVIS" restarts both halves.
   */
  const restart = () =>
    run(async () => {
      await restartBridge()
      setNote('Restarting JARVIS…')
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        try {
          const next = await getSettings()
          if (!next.restartPending?.length) {
            window.location.reload()
            return 'JARVIS restarted.'
          }
        } catch {
          /* still starting */
        }
      }
      return 'JARVIS is taking a while to come back. Check that it is running.'
    })

  const finish = async () => {
    await patch({ setupDone: '1' }, '')
    setWizard(false)
    setOpen(false)
  }

  const close = () => {
    if (wizard) void finish()
    else setOpen(false)
  }

  const banner = <RestartBanner s={s} schema={schema} busy={busy} onRestart={() => void restart()} />

  if (!open) {
    return (
      <>
        <button className="mem-open" onClick={() => setOpen(true)} aria-label="Open settings">
          SETTINGS
        </button>
        {/* Portalled like the dialog, so the HUD cannot stack over it. */}
        {s?.restartPending?.length ? createPortal(<div className="restart-float hud-modal">{banner}</div>, document.body) : null}
      </>
    )
  }

  /** Save the Claude API key, then re-check Claude so the line above says whether it is ready. */
  const saveClaudeKey = async () => {
    if (!(await patchSetting({ ANTHROPIC_API_KEY: claudeKeyDraft }))) return
    setClaudeKeyDraft('')
    void checkClaude()
  }

  /** Save the OpenAI API key (plan 25, Q54). It goes to the OS keychain; the page only learns "saved". */
  const saveOpenaiKey = async () => {
    if (!(await patchSetting({ OPENAI_API_KEY: openaiKeyDraft }))) return
    setOpenaiKeyDraft('')
  }

  const authMode = s?.JARVIS_CLAUDE_AUTH || claudeAuth.default
  const activeBrain = s?.JARVIS_BRAIN || brainChoice.default
  const openaiAuth = s?.JARVIS_OPENAI_AUTH || openaiAuthDef.default
  const claudeLine = !status
    ? 'Checking your Claude sign-in…'
    : !status.claudeInstalled
      ? 'Claude was not found on this computer. Reinstall JARVIS to fix it.'
      : status.claudeAuthMode === 'apikey'
        ? status.claudeAuthenticated
          ? `Claude is ready on your API key (version ${status.claudeVersion.split(' ')[0]}). Usage is billed to that key.`
          : 'Claude is set to use an API key, but none is saved. Add one under Brain in Settings.'
        : !status.claudeLoggedIn
          ? 'Not signed in yet. Press Sign in, finish in the browser window that opens, then press Check again.'
          : `Claude is ready (version ${status.claudeVersion.split(' ')[0]}).`

  const keyBlock = (
    <>
      <p className="mem-note">
        Optional. An ElevenLabs key gives JARVIS a much better voice and sharper hearing. Without it he uses your
        browser&apos;s own speech. The key stays on this computer.
      </p>
      <p className="mem-note">
        Key: {s?.ELEVENLABS_API_KEY_set ? 'saved ✓' : 'not set'}
        {s?.secretStorageAvailable && s.secretStorage ? ` · kept in ${s.secretStorage}` : ''}
        {s?.secretStorageAvailable === false ? ' · this computer has no secure key storage, so a key cannot be saved here' : ''}
      </p>
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
        {!wizard && banner}

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
            <div className="mem-add">
              <label>
                Offline wake word{' '}
                <select
                  aria-label="Offline wake word"
                  title={wakeWord.help || undefined}
                  value={s.JARVIS_WAKE_WORD || wakeWord.default}
                  onChange={(e) => patchSetting({ JARVIS_WAKE_WORD: e.target.value })}
                >
                  <option value="offline">on — asleep audio stays on this computer</option>
                  <option value="cloud">off — cloud listening</option>
                </select>
              </label>
              <label>
                Sensitivity{' '}
                <select
                  aria-label="Wake sensitivity"
                  title={wakeSensitivity.help || undefined}
                  value={s.JARVIS_WAKE_SENSITIVITY || wakeSensitivity.default}
                  disabled={(s.JARVIS_WAKE_WORD || wakeWord.default) !== 'offline'}
                  onChange={(e) => patchSetting({ JARVIS_WAKE_SENSITIVITY: e.target.value })}
                >
                  {(wakeSensitivity.options ?? []).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mem-note">Wake word changes apply the next time you start JARVIS.</p>
            <label title={reflexes.help || undefined}>
              <input
                type="checkbox"
                checked={(s.JARVIS_REFLEXES || reflexes.default) !== '0'}
                onChange={(e) => {
                  const on = e.target.checked
                  setReflexesEnabled(on)
                  patchSetting({ JARVIS_REFLEXES: on ? '1' : '0' })
                }}
              />{' '}
              Quick commands: stop, volume, timers, time and date answered instantly, without the AI
            </label>

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

            <div className="mem-add">
              <label>
                Claude sign-in{' '}
                <select
                  aria-label="Claude sign-in"
                  title={claudeAuth.help || undefined}
                  value={authMode}
                  onChange={(e) => {
                    const mode = e.target.value
                    void run(async () => {
                      const result = await saveSettings({ JARVIS_CLAUDE_AUTH: mode })
                      setS(result)
                      void checkClaude()
                      return savedNote(result)
                    })
                  }}
                >
                  <option value="subscription">your Claude subscription (default)</option>
                  <option value="apikey">your own API key</option>
                </select>
              </label>
            </div>
            {authMode === 'apikey' && (
              <>
                <p className="mem-note">
                  Uses your own Anthropic API key instead of your subscription; usage is billed to that key&apos;s
                  account. Key: {s.ANTHROPIC_API_KEY_set ? 'saved ✓' : 'not set'}
                  {s.secretStorageAvailable && s.secretStorage ? ` · kept in ${s.secretStorage}` : ''}
                  {s.secretStorageAvailable === false ? ' · this computer has no secure key storage, so a key cannot be saved here' : ''}
                </p>
                <div className="mem-add">
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste Anthropic API key (sk-ant-…)"
                    aria-label="Claude API key"
                    value={claudeKeyDraft}
                    onChange={(e) => setClaudeKeyDraft(e.target.value)}
                  />
                  <button disabled={busy || !claudeKeyDraft.trim()} onClick={saveClaudeKey}>Save key</button>
                  {s.ANTHROPIC_API_KEY_set && (
                    <button disabled={busy} onClick={() => patchSetting({ ANTHROPIC_API_KEY: '' })}>
                      Remove
                    </button>
                  )}
                </div>
              </>
            )}
            <p className="mem-note">Claude sign-in changes apply from the next conversation.</p>

            <div className="mem-add">
              <label>
                Brain{' '}
                <select
                  aria-label="Brain"
                  title={brainChoice.help || undefined}
                  value={activeBrain}
                  onChange={(e) => patchSetting({ JARVIS_BRAIN: e.target.value })}
                >
                  <option value="claude">Claude (default)</option>
                  <option value="openai">OpenAI, with your API key or ChatGPT plan</option>
                </select>
              </label>
            </div>
            {activeBrain === 'openai' && (
              <div className="mem-add">
                <label>
                  OpenAI sign-in{' '}
                  <select
                    aria-label="OpenAI sign-in"
                    title={openaiAuthDef.help || undefined}
                    value={openaiAuth}
                    onChange={(e) => patchSetting({ JARVIS_OPENAI_AUTH: e.target.value })}
                  >
                    <option value="apikey">your own API key (default)</option>
                    <option value="chatgpt">Sign in with ChatGPT</option>
                  </select>
                </label>
              </div>
            )}
            {activeBrain === 'openai' && openaiAuth === 'chatgpt' && (
              <OpenAISignIn
                model={s.JARVIS_OPENAI_MODEL}
                defaultModel={openaiModel.default}
                onModel={(m) => m !== s.JARVIS_OPENAI_MODEL && patchSetting({ JARVIS_OPENAI_MODEL: m })}
              />
            )}
            {activeBrain === 'openai' && openaiAuth !== 'chatgpt' && (
              <>
                <p className="mem-note">
                  What you say, and what tools read for you, is sent to OpenAI and billed to your key. Background
                  tasks stay on Claude for now. Key: {s.OPENAI_API_KEY_set ? 'saved ✓' : 'not set'}
                  {s.secretStorageAvailable && s.secretStorage ? ` · kept in ${s.secretStorage}` : ''}
                  {s.secretStorageAvailable === false ? ' · this computer has no secure key storage, so a key cannot be saved here' : ''}
                </p>
                <div className="mem-add">
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste OpenAI API key (sk-…)"
                    aria-label="OpenAI API key"
                    value={openaiKeyDraft}
                    onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                  />
                  <button disabled={busy || !openaiKeyDraft.trim()} onClick={saveOpenaiKey}>Save key</button>
                  {s.OPENAI_API_KEY_set && (
                    <button disabled={busy} onClick={() => patchSetting({ OPENAI_API_KEY: '' })}>
                      Remove
                    </button>
                  )}
                </div>
                <div className="mem-add">
                  <label>
                    OpenAI model{' '}
                    <input
                      defaultValue={s.JARVIS_OPENAI_MODEL}
                      placeholder={openaiModel.default}
                      aria-label="OpenAI model"
                      title={openaiModel.help || undefined}
                      onBlur={(e) =>
                        e.target.value !== s.JARVIS_OPENAI_MODEL && patchSetting({ JARVIS_OPENAI_MODEL: e.target.value })
                      }
                    />
                  </label>
                </div>
              </>
            )}
            <p className="mem-note">Brain changes apply from the next conversation.</p>

            <h3>Actions</h3>
            <label>
              <input
                type="checkbox"
                checked={s.JARVIS_ALLOW_WRITES === '1'}
                onChange={(e) => patchSetting({ JARVIS_ALLOW_WRITES: e.target.checked ? '1' : '0' })}
              />{' '}
              Let JARVIS take real actions (run commands, change files, click and type in the browser)
            </label>
            <p className="mem-note">{writes.help} Applies after a restart (the banner above has the button).</p>

            <h3>Connectors</h3>
            <Connectors />

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
