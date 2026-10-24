import { useCallback, useEffect, useState } from 'react'
import {
  connectConnector,
  disconnectConnector,
  eraseConnector,
  listConnectors,
  setConnectorEnabled,
  setConnectorGrant,
  setConnectorsFrozen,
  testConnector,
  type Capability,
  type ConnectorCard,
  type ConnectorReply,
  type ConnectorsList,
  type CredentialBackend,
} from '../lib/connectors'

/**
 * Settings → Connectors (task C03; plan 39 section 6). One card per connector
 * the bridge registered: status dot, what it can see, scopes, last sync, Test,
 * Disconnect, Erase data, its own on/off switch, and the permissions it holds.
 * Connecting uses one of three reusable flows, picked by the connector's auth
 * kind: guided sign-in (OAuth), paste a token, or grant local access.
 *
 * Pasted tokens are sent once and cleared from the page; the bridge keeps them
 * in the credential store and only ever says "set".
 */

const STATE_LABEL: Record<string, string> = {
  ok: 'working',
  attention: 'needs attention',
  error: 'error',
  disconnected: 'not connected',
}

const CAPABILITY_LABEL: Record<Capability, string> = {
  read: 'Read',
  write: 'Make changes (each one still asks you)',
  subscribe: 'Sync in the background',
}

function backendNote(b: CredentialBackend) {
  if (b === 'keychain') return 'Keys and tokens are kept in this computer’s secure keychain.'
  if (b === 'dev-file') return 'DEV-ONLY: keys and tokens are kept in a plain file outside the repository, not encrypted. Do not use real accounts you care about.'
  if (b === 'memory') return 'Keys and tokens are kept in memory only and are forgotten when JARVIS stops.'
  return 'Secure key storage arrives with the OS keychain. Until then, connectors that need a key or token cannot be connected.'
}

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : 'never')

/** Paste a token or key (pattern 2). */
function TokenFlow({ card, busy, onConnect }: FlowProps) {
  const [draft, setDraft] = useState('')
  const label = card.setup?.tokenLabel ?? 'Token or key'
  return (
    <div className="mem-add">
      <input
        type="password"
        autoComplete="off"
        placeholder={`Paste ${label}`}
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        disabled={busy || !draft.trim()}
        onClick={async () => {
          const ok = await onConnect({ token: draft })
          setDraft('')
          return ok
        }}
      >
        Connect
      </button>
    </div>
  )
}

/** Grant local access (pattern 3): say why and what, then ask. */
function LocalFlow({ card, busy, onConnect }: FlowProps) {
  const [path, setPath] = useState('')
  const [agreed, setAgreed] = useState(false)
  return (
    <>
      {card.setup?.localWhy && <p className="mem-note">{card.setup.localWhy}</p>}
      {card.auth === 'filesystem' && (
        <div className="mem-add">
          <input
            placeholder="Folder (leave empty for the default)"
            aria-label={`${card.name} folder`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </div>
      )}
      <label>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I understand what{' '}
        {card.name} will read.
      </label>{' '}
      <button
        disabled={busy || !agreed}
        onClick={() => onConnect(path.trim() ? { confirmed: true, path: path.trim() } : { confirmed: true })}
      >
        Grant access
      </button>
    </>
  )
}

/** Guided sign-in (pattern 1): the bridge hands back a consent page to open. */
function OAuthFlow({ busy, onConnect, signInUrl }: FlowProps & { signInUrl: string | null }) {
  return (
    <>
      <button disabled={busy} onClick={() => onConnect({})}>
        Connect
      </button>
      {signInUrl && (
        <p className="mem-note">
          <a href={signInUrl} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
          , finish there, then press Test.
        </p>
      )}
    </>
  )
}

type FlowProps = {
  card: ConnectorCard
  busy: boolean
  onConnect: (fields: Record<string, unknown>) => Promise<boolean>
}

function Card({
  card,
  frozen,
  busy,
  act,
}: {
  card: ConnectorCard
  frozen: boolean
  busy: boolean
  act: (fn: () => Promise<ConnectorReply>, done?: (r: ConnectorReply) => string) => Promise<ConnectorReply | null>
}) {
  const [signInUrl, setSignInUrl] = useState<string | null>(null)
  const state = card.status.state
  const connected = state !== 'disconnected' && (card.credentials.keys.length > 0 || card.pattern !== 'token')
  const setup = card.setup

  const onConnect = async (fields: Record<string, unknown>) => {
    const r = await act(
      () => connectConnector(card.id, fields),
      (x) => (x.result?.url ? 'Open the sign-in page to finish.' : `Connected${x.result?.account ? ` as ${x.result.account}` : ''}.`),
    )
    if (r?.result?.url) setSignInUrl(r.result.url)
    return Boolean(r?.ok)
  }

  const flow =
    card.pattern === 'token' ? (
      <TokenFlow card={card} busy={busy || frozen} onConnect={onConnect} />
    ) : card.pattern === 'local' ? (
      <LocalFlow card={card} busy={busy || frozen} onConnect={onConnect} />
    ) : card.pattern === 'oauth' ? (
      <OAuthFlow card={card} busy={busy || frozen} onConnect={onConnect} signInUrl={signInUrl} />
    ) : null

  const grant = (cap: Capability, on: boolean) => {
    if (on && cap === 'write') {
      const sure = window.confirm(
        `Let ${card.name} make changes? JARVIS will still ask you before every change, and only while “take real actions” is on.`,
      )
      if (!sure) return
    }
    void act(() => setConnectorGrant(card.id, cap, on, on && cap === 'write'), () => 'Saved.')
  }

  return (
    <article className="conn-card" aria-labelledby={`conn-${card.id}`}>
      <h4 id={`conn-${card.id}`}>
        <span className={`conn-dot conn-${state}`} aria-hidden="true" /> {card.name}{' '}
        <span className="mem-note">
          · {STATE_LABEL[state] ?? state} · risk {card.risk}
        </span>
      </h4>
      {card.status.detail && <p className="mem-note" role="status">{card.status.detail}</p>}
      <p className="mem-note">Last sync: {when(card.status.lastSync)}</p>

      {setup && (
        <>
          <p className="mem-note">What this connector can see:</p>
          <ul className="conn-list">
            {setup.sees.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {setup.scopes && setup.scopes.length > 0 && (
            <p className="mem-note">Permissions it asks for: {setup.scopes.join(', ')}</p>
          )}
        </>
      )}

      {!connected && (
        <>
          {setup?.steps && setup.steps.length > 0 && (
            <ol className="conn-list">
              {setup.steps.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          )}
          {setup?.helpUrl && (
            <p className="mem-note">
              <a href={setup.helpUrl} target="_blank" rel="noopener noreferrer">
                Open the provider page
              </a>
            </p>
          )}
          {flow}
        </>
      )}

      {connected && setup?.testQuestion && (
        <p className="mem-note">Try asking: “{setup.testQuestion}”</p>
      )}

      <div className="mem-add">
        {card.canTest && (
          <button disabled={busy} onClick={() => act(() => testConnector(card.id), (r) => r.detail ?? 'Working.')}>
            Test
          </button>
        )}
        {card.pattern !== 'none' && (
          <button
            disabled={busy}
            onClick={() => {
              const erase = card.erasable && window.confirm(`Also erase what JARVIS saved from ${card.name}? Press Cancel to keep it.`)
              void act(() => disconnectConnector(card.id, erase), (r) => (r.erased ? 'Disconnected and erased.' : 'Disconnected.'))
            }}
          >
            Disconnect
          </button>
        )}
        {card.erasable && (
          <button
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Erase everything JARVIS saved from ${card.name}? It stays connected.`)) {
                void act(() => eraseConnector(card.id), () => 'Erased.')
              }
            }}
          >
            Erase data
          </button>
        )}
        <label>
          <input
            type="checkbox"
            checked={!card.disabled}
            disabled={busy}
            onChange={(e) => act(() => setConnectorEnabled(card.id, e.target.checked), () => (e.target.checked ? 'Turned on.' : 'Turned off.'))}
          />{' '}
          On
        </label>
      </div>

      {card.grants && (
        <fieldset className="conn-grants">
          <legend className="mem-note">Allowed to</legend>
          {(Object.keys(CAPABILITY_LABEL) as Capability[])
            .filter((cap) => card.capabilities[cap])
            .map((cap) => (
              <label key={cap}>
                <input
                  type="checkbox"
                  checked={card.grants?.[cap] === true}
                  disabled={busy}
                  onChange={(e) => grant(cap, e.target.checked)}
                />{' '}
                {CAPABILITY_LABEL[cap]}
              </label>
            ))}
        </fieldset>
      )}
    </article>
  )
}

export function Connectors() {
  const [list, setList] = useState<ConnectorsList | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setList(await listConnectors())
    } catch {
      setNote('Could not read the connectors.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<ConnectorReply>, done?: (r: ConnectorReply) => string) => {
    setBusy(true)
    setNote('')
    try {
      const r = await fn()
      setNote(r.ok ? (done?.(r) ?? '') : (r.reason ?? 'That did not work.'))
      await load()
      return r
    } catch {
      setNote('Cannot reach the JARVIS bridge. Is it running?')
      return null
    } finally {
      setBusy(false)
    }
  }

  if (!list) return note ? <p className="mem-note">{note}</p> : null

  const freeze = () => {
    if (list.frozen) {
      if (window.confirm('Unfreeze every connector?')) void act(() => setConnectorsFrozen(false, true), () => 'Connectors unfrozen.')
    } else void act(() => setConnectorsFrozen(true), () => 'Every connector is frozen.')
  }

  return (
    <>
      <p className="mem-note">{backendNote(list.credentialBackend)}</p>
      <button disabled={busy} onClick={freeze} aria-pressed={list.frozen}>
        {list.frozen ? 'Unfreeze all connectors' : 'Freeze all connectors'}
      </button>
      {note && <p role="status" className="mem-note">{note}</p>}
      {list.connectors.length === 0 && <p className="mem-note">No connectors yet.</p>}
      {list.connectors.map((c) => (
        <Card key={c.id} card={c} frozen={list.frozen} busy={busy} act={act} />
      ))}
      {list.failures.length > 0 && (
        <p className="mem-note">
          Could not load: {list.failures.map((f) => f.id).join(', ')} (see Diagnostics).
        </p>
      )}
    </>
  )
}
