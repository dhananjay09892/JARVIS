import { useCallback, useEffect, useState } from 'react'
import {
  BrainAuthError,
  cancelChatGPTSignIn,
  finishChatGPTSignIn,
  getOpenAIAuth,
  getOpenAIModels,
  setChatGPTBackgroundConsent,
  signOutChatGPT,
  startChatGPTSignIn,
  type OpenAIAuthState,
} from '../lib/settings'

/**
 * Settings → Brains → OpenAI, paid with the user's ChatGPT plan (plan 22,
 * task Q55). The bridge does the sign-in (bridge/brains/openai-auth.mjs and
 * siwc.mjs) and keeps it in the OS keychain; this panel only shows the state.
 *
 * Following the SIWC terms and OpenAI's UI guidelines: the privacy notice is
 * shown before the "Continue with ChatGPT" button, "Using ChatGPT plan" and a
 * "Manage usage" link sit by the model picker, and when the usage limit is
 * reached Manage usage is the main action. Background use is a separate
 * switch, off until the user turns it on.
 */
export function OpenAISignIn({
  model,
  defaultModel,
  onModel,
}: {
  model: string
  defaultModel: string
  onModel: (model: string) => void
}) {
  const [auth, setAuth] = useState<OpenAIAuthState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [link, setLink] = useState('')
  const [models, setModels] = useState<string[] | null>(null)

  const fail = (err: unknown) => {
    setErrorCode(err instanceof BrainAuthError ? err.code : '')
    setNote(err instanceof Error ? err.message : 'That did not work.')
  }

  const refresh = useCallback(async () => {
    try {
      setAuth(await getOpenAIAuth())
    } catch (err) {
      fail(err)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signedIn = Boolean(auth?.siwc?.signedIn)

  // The model picker is filled from the models this plan can use.
  useEffect(() => {
    if (!signedIn) {
      setModels(null)
      return
    }
    let live = true
    getOpenAIModels().then(
      (r) => live && setModels(r.models),
      (err) => {
        if (!live) return
        setModels([])
        fail(err)
      },
    )
    return () => {
      live = false
    }
  }, [signedIn])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setNote('')
    setErrorCode('')
    try {
      await fn()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const signIn = () =>
    act(async () => {
      const started = await startChatGPTSignIn()
      setAuth(started)
      setLink(started.opened ? '' : started.url)
      setNote(
        started.opened
          ? 'Finish signing in on the OpenAI page that opened in your browser.'
          : 'Your browser did not open. Use the link below to sign in.',
      )
      const done = await finishChatGPTSignIn()
      setAuth(done)
      setLink('')
      if (done.signedIn) setNote('Signed in with ChatGPT. Applies from the next conversation.')
      else if (done.error) {
        setErrorCode(done.error.code)
        setNote(done.error.reason)
      }
    })

  /** Stop a sign-in that is waiting on the browser; the waiting call then reports it. */
  const cancel = async () => {
    try {
      await cancelChatGPTSignIn()
    } catch (err) {
      fail(err)
    }
  }

  const signOut = () =>
    act(async () => {
      const out = await signOutChatGPT()
      setAuth(out)
      setNote(out.detail ?? 'Signed out of ChatGPT.')
    })

  const consent = (allow: boolean) => act(async () => setAuth(await setChatGPTBackgroundConsent(allow)))

  if (!auth) return <p className="mem-note">{note || 'Checking your ChatGPT sign-in…'}</p>

  const manage = (
    <a href={auth.manageUsageUrl} target="_blank" rel="noopener noreferrer">
      Manage usage
    </a>
  )
  const status = auth.siwc
  const usageLimit = errorCode === 'usage_limit'

  if (!auth.available) {
    return (
      <p className="mem-note">
        This computer has no secure credential storage, so a ChatGPT sign-in cannot be kept here. Choose API key
        instead.
      </p>
    )
  }

  return (
    <>
      {!signedIn && (
        <>
          {auth.privacyNotice.map((line) => (
            <p key={line} className="mem-note">
              {line}
            </p>
          ))}
          <div className="mem-add">
            {status?.signingIn ? (
              <button onClick={() => void cancel()}>
                Cancel sign-in
              </button>
            ) : (
              <button disabled={busy} onClick={() => void signIn()}>
                Continue with ChatGPT
              </button>
            )}
          </div>
          {link && (
            <p className="mem-note">
              <a href={link} target="_blank" rel="noopener noreferrer">
                Open the OpenAI sign-in page
              </a>
            </p>
          )}
        </>
      )}

      {signedIn && status && (
        <>
          <p className="mem-note">
            Signed in with ChatGPT{status.account ? ` as ${status.account}` : ''}. Using ChatGPT plan · {manage}
          </p>
          <div className="mem-add">
            <label>
              OpenAI model{' '}
              <select aria-label="OpenAI model" value={model || defaultModel} onChange={(e) => onModel(e.target.value)}>
                {[...new Set([model || defaultModel, ...(models ?? [])])].map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === defaultModel ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {models === null && <span className="mem-note"> loading models…</span>}
          </div>
          <label>
            <input
              type="checkbox"
              checked={status.backgroundConsent}
              disabled={busy}
              onChange={(e) => void consent(e.target.checked)}
            />{' '}
            Let background tasks use my ChatGPT plan
          </label>
          <p className="mem-note">
            Off by default. When it is off, only what you ask JARVIS yourself uses your plan.
          </p>
          <div className="mem-add">
            <button disabled={busy} onClick={() => void signOut()}>
              Sign out of ChatGPT
            </button>
          </div>
        </>
      )}

      {!busy && status?.error && !note && <p className="mem-note">{status.error.message}</p>}
      {note && (
        <p role="status" className="mem-note">
          {note}
          {usageLimit && (
            <>
              {' '}
              <a className="primary" href={auth.manageUsageUrl} target="_blank" rel="noopener noreferrer">
                Manage usage
              </a>
            </>
          )}
        </p>
      )}
    </>
  )
}
