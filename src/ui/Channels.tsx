import { useCallback, useEffect, useState } from 'react'
import {
  cancelPairing,
  confirmPairing,
  freezeAll,
  getChannels,
  revokeBinding,
  startPairing,
  testChannel,
  unfreezeAll,
  type ChannelReply,
  type ChannelsStatus,
  type PairingState,
} from '../lib/channels'
import {
  CHANNEL_CARDS,
  clearPatch,
  privateAnswers,
  privatePatch,
  runningNote,
  switchPatch,
  tokenPatch,
  type ChannelCardSpec,
} from '../lib/channelsView'
import { saveSettings } from '../lib/settings'

/**
 * Settings → Channels (plan 20 phase 2, Q79; spec §4.2 and §10). The master
 * switch, Telegram's switch and bot token (with a Test button), pairing with
 * Confirm / Cancel, the people who are paired with revoke and last seen, and
 * the freeze button. Everything here is off until you turn it on.
 *
 * The token is sent once and cleared from the page; the bridge keeps it in the
 * keychain and only ever says whether one is set. Ids are shown masked.
 */

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : 'never')

const ROLE_LABEL: Record<string, string> = { owner: 'You (owner)', member: 'Household member', child: 'Child', guest: 'Guest' }

const NOTICE_LABEL: Record<string, string> = {
  'pairing-match': 'Someone sent the pairing code. Check it is you, then Confirm.',
  'pairing-burnt': 'Too many wrong pairing codes: that code no longer works. Start again.',
  'unknown-senders': 'People you have not paired are messaging the bot. They get no answer.',
  'frozen-from-chat': 'You froze JARVIS from chat.',
}

export function Channels() {
  const [st, setSt] = useState<ChannelsStatus | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<{ code: string; expiresAt: number; channel: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setSt(await getChannels())
    } catch {
      setNote('Could not read the channels.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // While a pairing code is showing, look for the match every two seconds.
  useEffect(() => {
    if (!code) return
    const t = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(t)
  }, [code, load])

  const act = async (fn: () => Promise<ChannelReply>, done?: (r: ChannelReply) => string) => {
    setBusy(true)
    setNote('')
    try {
      const r = await fn()
      setNote(r.ok ? (done?.(r) ?? '') : (r.reason ?? 'That did not work.'))
      await load()
      return r
    } finally {
      setBusy(false)
    }
  }

  const save = (patch: Record<string, string>, done = 'Saved.') =>
    act(async () => {
      try {
        await saveSettings(patch)
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'Could not save.' }
      }
    }, () => done)

  if (!st) return note ? <p className="mem-note">{note}</p> : null

  const bindings = st.bindings.filter((b) => b.status === 'active')

  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={st.enabled}
          disabled={busy}
          onChange={(e) => void save({ JARVIS_CHANNELS: e.target.checked ? '1' : '0' })}
        />{' '}
        Let paired people message JARVIS from a chat app
      </label>
      <p className="mem-note">
        Off by default. When on, messages and replies pass through the chat app&apos;s servers; DISCLAIMER.txt says what
        leaves this computer. People you have not paired get no answer at all.
      </p>

      {st.frozen.frozen ? (
        <p className="mem-note">
          <strong>Frozen</strong>{st.frozen.source === 'chat' ? ' from chat' : ''} at {when(st.frozen.at)}: every tool is refused
          and channels are silent.{' '}
          <button disabled={busy} onClick={() => window.confirm('Unfreeze JARVIS?') && void act(unfreezeAll, () => 'Unfrozen.')}>
            Unfreeze
          </button>
        </p>
      ) : (
        <button disabled={busy} onClick={() => void act(freezeAll, () => 'Frozen. Only this screen can unfreeze.')}>
          Freeze JARVIS
        </button>
      )}

      {CHANNEL_CARDS.map((spec) => (
        <ChannelCard
          key={spec.id}
          spec={spec}
          st={st}
          busy={busy}
          bindings={bindings}
          code={code?.channel === spec.id ? code : null}
          setCode={(c) => setCode(c ? { ...c, channel: spec.id } : null)}
          act={act}
          save={save}
        />
      ))}

      {bindings.length > 0 && (
        <fieldset className="conn-grants">
          <legend className="mem-note">Paired</legend>
          {bindings.map((b) => (
            <div key={b.id} className="mem-add">
              <span>
                {ROLE_LABEL[b.role] ?? b.role} · {b.channel} · {b.sender} · last seen {when(b.lastSeenAt)}
                {b.expiresAt ? ` · until ${when(b.expiresAt)}` : ''}
              </span>{' '}
              <button
                disabled={busy}
                onClick={() => window.confirm('Revoke? Their next message gets no answer.') && void act(() => revokeBinding(b.id), () => 'Revoked.')}
              >
                Revoke
              </button>
            </div>
          ))}
        </fieldset>
      )}

      {st.notices.slice(-3).map((n) => (
        <p key={`${n.kind}-${n.at}`} className="mem-note">
          {when(n.at)}: {NOTICE_LABEL[n.kind] ?? n.kind}
        </p>
      ))}
      {st.stats.totals.received + st.stats.totals.rejected > 0 && (
        <p className="mem-note">
          Since JARVIS started: {st.stats.totals.received} messages handled, {st.stats.totals.unknown} from people not paired,
          {' '}{st.stats.totals.sent} replies sent
          {st.stats.latencyMs.p50 !== null ? `, typical answer in ${(st.stats.latencyMs.p50 / 1000).toFixed(1)} s` : ''}.
        </p>
      )}
      {note && <p className="mem-note">{note}</p>}
    </>
  )
}

type Act = (fn: () => Promise<ChannelReply>, done?: (r: ChannelReply) => string) => Promise<ChannelReply>

function ChannelCard({
  spec,
  st,
  busy,
  bindings,
  code,
  setCode,
  act,
  save,
}: {
  spec: ChannelCardSpec
  st: ChannelsStatus
  busy: boolean
  bindings: ChannelsStatus['bindings']
  code: { code: string; expiresAt: number } | null
  setCode: (c: { code: string; expiresAt: number } | null) => void
  act: Act
  save: (patch: Record<string, string>, done?: string) => Promise<ChannelReply>
}) {
  const [typed, setTyped] = useState<Record<string, string>>({})
  const ch = st.channels[spec.id]
  const pairing: PairingState = ch?.pairing ?? { state: 'none' }
  const heading = `chan-${spec.id}`
  const note = runningNote(st.enabled, ch, spec)
  const anyTyped = spec.secrets.some((s) => tokenPatch(s, typed[s.setting] ?? ''))

  const saveTokens = async () => {
    const patch = Object.assign({}, ...spec.secrets.map((s) => tokenPatch(s, typed[s.setting] ?? '')))
    const r = await save(patch, spec.secrets.length > 1 ? 'Tokens saved.' : 'Token saved.')
    if (r?.ok) setTyped({})
  }

  return (
    <section className="conn-card" aria-labelledby={heading}>
      <h4 id={heading}>{spec.title}</h4>
      <label>
        <input
          type="checkbox"
          checked={ch?.on ?? false}
          disabled={busy}
          onChange={(e) => void save(switchPatch(spec, e.target.checked))}
        />{' '}
        {spec.switchLabel}
      </label>
      <p className="mem-note">
        {spec.intro}
        {note ? ` ${note}` : ''}
      </p>
      <div className="mem-add">
        {spec.secrets.map((s) => (
          <label key={s.setting}>
            {s.label}{' '}
            <input
              type="password"
              autoComplete="off"
              value={typed[s.setting] ?? ''}
              placeholder={s.placeholder}
              aria-label={`${spec.title} ${s.label.toLowerCase()}`}
              onChange={(e) => setTyped((t) => ({ ...t, [s.setting]: e.target.value }))}
            />
          </label>
        ))}
        <span>{ch?.tokenSet ? 'saved ✓' : 'not set'}</span>{' '}
        <button disabled={busy || !anyTyped} onClick={() => void saveTokens()}>
          Save
        </button>
        {ch?.tokenSet && (
          <>
            <button
              disabled={busy}
              onClick={() => void act(() => testChannel(spec.id), (r) => `The ${spec.secrets.length > 1 ? 'tokens work' : 'token works'}: ${r.username ? '@' + r.username : 'your ' + spec.title + ' app'}.`)}
            >
              Test
            </button>
            <button disabled={busy} onClick={() => void save(clearPatch(spec), 'Removed.')}>
              Remove
            </button>
          </>
        )}
      </div>

      {ch?.running && (
        <div className="mem-add">
          {pairing.state === 'confirm' ? (
            <>
              <span>
                {spec.accountNoun} <strong>{pairing.senderLabel || pairing.senderId}</strong> ({pairing.senderId}) sent the code.
                Is that you?
              </span>{' '}
              <button disabled={busy} onClick={() => void act(() => confirmPairing(spec.id), () => 'Paired.').then(() => setCode(null))}>
                Confirm
              </button>
              <button disabled={busy} onClick={() => void act(() => cancelPairing(spec.id), () => 'Cancelled.').then(() => setCode(null))}>
                Cancel
              </button>
            </>
          ) : code && pairing.state === 'open' ? (
            <>
              <span>
                {spec.pairInstruction(code.code)} It will not answer; Confirm appears here.
              </span>{' '}
              <button disabled={busy} onClick={() => void act(() => cancelPairing(spec.id), () => 'Cancelled.').then(() => setCode(null))}>
                Cancel
              </button>
            </>
          ) : (
            <button
              disabled={busy || bindings.some((b) => b.channel === spec.id && b.role === 'owner')}
              onClick={async () => {
                const r = await act(() => startPairing(spec.id))
                if (r?.ok && r.code && r.expiresAt) setCode({ code: r.code, expiresAt: r.expiresAt })
              }}
            >
              Pair my {spec.title} account
            </button>
          )}
        </div>
      )}

      <label>
        <input
          type="checkbox"
          checked={privateAnswers(spec, st)}
          disabled={busy}
          onChange={(e) => void save(privatePatch(spec, e.target.checked))}
        />{' '}
        {spec.privateLabel}
      </label>
      <p className="mem-note">Off: he says it is private and to look in the app. Vault items never go to a chat.</p>
    </section>
  )
}
