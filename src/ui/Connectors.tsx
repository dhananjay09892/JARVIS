import { useCallback, useEffect, useState } from 'react'
import {
  connectConnector,
  disconnectConnector,
  eraseConnector,
  listConnectors,
  setClassRetention,
  setConnectorEnabled,
  setConnectorGrant,
  setConnectorOptions,
  setConnectorRetention,
  setConnectorsFrozen,
  setVaultAllowed,
  syncConnector,
  testConnector,
  type Capability,
  type ConnectorCard,
  type ConnectorOptionValue,
  type ConnectorOptions,
  type ConnectorReply,
  type ConnectorsList,
  type CredentialBackend,
  type DocumentPrefs,
  type SensitivityClass,
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

type Act = (fn: () => Promise<ConnectorReply>, done?: (r: ConnectorReply) => string) => Promise<ConnectorReply | null>

/** Retention choices offered (days); the current value is added if it is not one of them. */
const RETENTION_CHOICES = [7, 30, 90, 180, 365, 730, 1825]

const CLASS_LABEL: Record<SensitivityClass, string> = {
  public: 'Public pages and feeds',
  personal: 'Personal notes and files',
  work: 'Work documents',
  messages: 'Messages from other people',
  contacts: 'Contacts',
  finance: 'Money (vault)',
  health: 'Health (vault)',
  location: 'Places and location',
}

const daysLabel = (d: number) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${d} days`)
const removedNote = (r: ConnectorReply) => (r.removed ? `Saved. ${r.removed} older document${r.removed === 1 ? '' : 's'} deleted.` : 'Saved.')

/** A days picker; `defaultLabel` adds a "use the default" choice (value ''). */
function DaysSelect({
  value,
  label,
  defaultLabel,
  busy,
  onPick,
}: {
  value: number | null
  label: string
  defaultLabel?: string
  busy: boolean
  onPick: (days: number | null) => void
}) {
  const choices = value !== null && !RETENTION_CHOICES.includes(value) ? [...RETENTION_CHOICES, value].sort((a, b) => a - b) : RETENTION_CHOICES
  return (
    <select
      aria-label={label}
      disabled={busy}
      value={value === null ? '' : String(value)}
      onChange={(e) => onPick(e.target.value === '' ? null : Number(e.target.value))}
    >
      {defaultLabel && <option value="">{defaultLabel}</option>}
      {choices.map((d) => (
        <option key={d} value={String(d)}>
          {daysLabel(d)}
        </option>
      ))}
    </select>
  )
}

/**
 * Synced documents (task C95): whether the brain may read health and finance
 * documents (off by default, confirmed to turn on), and how long each kind of
 * document is kept. A shorter time deletes older documents at once, so it asks.
 */
function DocumentsSection({ docs, busy, act }: { docs: DocumentPrefs; busy: boolean; act: Act }) {
  const vault = (on: boolean) => {
    if (on) {
      const sure = window.confirm(
        'Let the brain read your synced health and finance documents? With a cloud brain, the parts it reads leave this computer. You can turn this off at any time.',
      )
      if (!sure) return
    }
    void act(() => setVaultAllowed(on, on), () => (on ? 'Health and finance documents may be read.' : 'Health and finance documents stay on this computer.'))
  }
  const classDays = (cls: SensitivityClass, days: number | null) => {
    const next = days ?? docs.retention.defaults[cls]
    const shorter = next < docs.retention.classes[cls]
    if (shorter && !window.confirm(`Keep ${CLASS_LABEL[cls].toLowerCase()} for ${daysLabel(next)}? Older ones are deleted now.`)) return
    void act(() => setClassRetention(cls, days, shorter), removedNote)
  }
  return (
    <section className="conn-card" aria-labelledby="conn-docs">
      <h4 id="conn-docs">Synced documents</h4>
      <label>
        <input type="checkbox" checked={docs.allowVault} disabled={busy} onChange={(e) => vault(e.target.checked)} /> Show health
        and finance documents to the brain
      </label>
      <p className="mem-note">Off by default: they stay on this computer and searches say how many were left out.</p>
      <fieldset className="conn-grants">
        <legend className="mem-note">Keep documents for</legend>
        {(Object.keys(CLASS_LABEL) as SensitivityClass[]).map((cls) => (
          <label key={cls}>
            {CLASS_LABEL[cls]}{' '}
            <DaysSelect
              value={docs.retention.classes[cls]}
              label={`Keep ${CLASS_LABEL[cls]} for`}
              busy={busy}
              onPick={(d) => classDays(cls, d === docs.retention.defaults[cls] ? null : d)}
            />
          </label>
        ))}
      </fieldset>
    </section>
  )
}

/**
 * A connector's own settings (task C97), drawn from the fields the bridge
 * sends: a list (one entry per line), one line of text (task C16) or a
 * switch. Saving a change erases what the connector kept and syncs it again
 * from the start, so it asks first.
 */
function OptionsSection({ card, options, busy, act }: { card: ConnectorCard; options: ConnectorOptions; busy: boolean; act: Act }) {
  const fromValues = (v: Record<string, ConnectorOptionValue>) =>
    Object.fromEntries(
      options.fields.map((f) => [
        f.key,
        f.type === 'list'
          ? (Array.isArray(v[f.key]) ? (v[f.key] as string[]).join('\n') : '')
          : f.type === 'text'
            ? (typeof v[f.key] === 'string' ? (v[f.key] as string) : '')
            : v[f.key] === true,
      ]),
    )
  // The parent keys this section by the saved values, so a save starts a fresh draft.
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() => fromValues(options.values))

  const save = () => {
    const next: Record<string, ConnectorOptionValue> = {}
    for (const f of options.fields) {
      const v = draft[f.key]
      next[f.key] = f.type === 'list'
        ? String(v ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
        : f.type === 'text'
          ? String(v ?? '').trim()
          : v === true
    }
    if (JSON.stringify(next) === JSON.stringify(options.values)) return
    if (!window.confirm(`Save these ${card.name} settings? What JARVIS kept from ${card.name} is erased and synced again from the start.`)) return
    void act(() => setConnectorOptions(card.id, next, true), (r) => (r.erased ? 'Saved. Press Sync now to fetch again.' : 'Saved.'))
  }

  return (
    <fieldset className="conn-grants">
      <legend className="mem-note">Settings</legend>
      {options.fields.map((f) =>
        f.type === 'text' ? (
          <label key={f.key}>
            {f.label}{' '}
            <input
              type="text"
              autoComplete="off"
              maxLength={f.max}
              aria-label={`${card.name}: ${f.label}`}
              disabled={busy}
              value={String(draft[f.key] ?? '')}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
            {f.help && <span className="mem-note"> {f.help}</span>}
          </label>
        ) : f.type === 'list' ? (
          <label key={f.key}>
            {f.label}
            <textarea
              rows={3}
              aria-label={`${card.name}: ${f.label}`}
              disabled={busy}
              value={String(draft[f.key] ?? '')}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
            {f.help && <span className="mem-note"> {f.help}</span>}
          </label>
        ) : (
          <label key={f.key}>
            <input
              type="checkbox"
              disabled={busy}
              checked={draft[f.key] === true}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })}
            />{' '}
            {f.label}
            {f.help && <span className="mem-note"> {f.help}</span>}
          </label>
        ),
      )}
      <button disabled={busy} onClick={save}>
        Save settings
      </button>
    </fieldset>
  )
}

/** Paste a token or key (pattern 2), with an account name first when the card asks for one. */
function TokenFlow({ card, busy, onConnect }: FlowProps) {
  const [draft, setDraft] = useState('')
  const [account, setAccount] = useState('')
  const [server, setServer] = useState('')
  const label = card.setup?.tokenLabel ?? 'Token or key'
  const accountLabel = card.setup?.accountLabel
  const serverLabel = accountLabel ? card.setup?.serverLabel : undefined
  const ready = Boolean(draft.trim()) && (!accountLabel || Boolean(account.trim()))
  return (
    <div className="mem-add">
      {accountLabel && (
        <input
          type={serverLabel ? 'text' : 'email'}
          autoComplete="off"
          placeholder={accountLabel}
          aria-label={accountLabel}
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        />
      )}
      {serverLabel && (
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={serverLabel}
          aria-label={serverLabel}
          value={server}
          onChange={(e) => setServer(e.target.value)}
        />
      )}
      <input
        type="password"
        autoComplete="off"
        placeholder={`Paste ${label}`}
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        disabled={busy || !ready}
        onClick={async () => {
          const body = accountLabel ? { token: draft, account, ...(serverLabel && server.trim() ? { server: server.trim() } : {}) } : { token: draft }
          const ok = await onConnect(body)
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

/**
 * Guided sign-in (pattern 1): the bridge hands back a consent page to open.
 * Providers that need the owner's own OAuth client (Google: `setup.clientLabel`)
 * show its two fields; they are sent once with Connect and then cleared. Left
 * empty, Connect reuses the client already saved.
 */
function OAuthFlow({ card, busy, onConnect, signInUrl }: FlowProps & { signInUrl: string | null }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const clientLabel = card.setup?.clientLabel
  const connect = async () => {
    const fields = clientId.trim() ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() } : {}
    const ok = await onConnect(fields)
    setClientSecret('')
    if (ok) setClientId('')
    return ok
  }
  return (
    <>
      {clientLabel && (
        <div className="mem-add">
          <input
            autoComplete="off"
            placeholder={`${clientLabel}: client ID (leave empty to reuse the saved one)`}
            aria-label={`${clientLabel} client ID`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            type="password"
            autoComplete="off"
            placeholder="Client secret"
            aria-label={`${clientLabel} client secret`}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
      )}
      <button disabled={busy} onClick={connect}>
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
  act: Act
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

      {card.documents && (
        <div className="mem-add">
          <span className="mem-note">
            {card.documents.count} document{card.documents.count === 1 ? '' : 's'} kept here · keep for
          </span>{' '}
          <DaysSelect
            value={card.documents.retentionDays}
            label={`Keep ${card.name} documents for`}
            defaultLabel="each kind’s default"
            busy={busy}
            onPick={(days) => {
              const current = card.documents?.retentionDays ?? null
              const mayDelete = days === null ? current !== null : current === null || days < current
              if (mayDelete && !window.confirm(`Change how long ${card.name} documents are kept? Older ones may be deleted now.`)) return
              void act(() => setConnectorRetention(card.id, days, mayDelete), removedNote)
            }}
          />
        </div>
      )}

      {card.options && (
        <OptionsSection key={JSON.stringify(card.options.values)} card={card} options={card.options} busy={busy} act={act} />
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
        {card.canSync && connected && card.documents !== undefined && card.documents !== null && (
          <button
            disabled={busy}
            onClick={() => act(() => syncConnector(card.id), (r) => `Synced: ${r.saved ?? 0} new or updated${r.removed ? `, ${r.removed} removed` : ''}.`)}
          >
            Sync now
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
      {list.health && list.health.needsAttention > 0 && (
        <p className="mem-note" role="status">
          {list.health.needsAttention} connector{list.health.needsAttention === 1 ? ' needs' : 's need'} attention:{' '}
          {list.health.ids.join(', ')}
        </p>
      )}
      {list.documents?.available && <DocumentsSection docs={list.documents} busy={busy} act={act} />}
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
