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
  const [token, setToken] = useState('')
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)

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

  const tg = st.channels.telegram
  const pairing: PairingState = tg?.pairing ?? { state: 'none' }
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

      <section className="conn-card" aria-labelledby="chan-telegram">
        <h4 id="chan-telegram">Telegram</h4>
        <label>
          <input
            type="checkbox"
            checked={tg?.on ?? false}
            disabled={busy}
            onChange={(e) => void save({ JARVIS_TELEGRAM: e.target.checked ? '1' : '0' })}
          />{' '}
          Use my Telegram bot
        </label>
        <p className="mem-note">
          Create a bot with @BotFather in Telegram and paste its token here. Bot chats are not end-to-end encrypted.
          {tg?.running ? ' Running.' : st.enabled && tg?.on && !tg.tokenSet ? ' Needs a token.' : ''}
          {tg?.health?.lastError ? ` Last problem: ${tg.health.lastError}` : ''}
        </p>
        <div className="mem-add">
          <label>
            Bot token: {tg?.tokenSet ? 'saved ✓' : 'not set'}{' '}
            <input
              type="password"
              autoComplete="off"
              value={token}
              placeholder="123456789:AA…"
              aria-label="Telegram bot token"
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !token.trim()}
            onClick={async () => {
              const r = await save({ TELEGRAM_BOT_TOKEN: token.trim() }, 'Token saved.')
              if (r?.ok) setToken('')
            }}
          >
            Save
          </button>
          {tg?.tokenSet && (
            <>
              <button disabled={busy} onClick={() => void act(() => testChannel('telegram'), (r) => `The token works: @${r.username ?? 'your bot'}.`)}>
                Test
              </button>
              <button disabled={busy} onClick={() => void save({ TELEGRAM_BOT_TOKEN: '' }, 'Token removed.')}>
                Remove
              </button>
            </>
          )}
        </div>

        {tg?.running && (
          <div className="mem-add">
            {pairing.state === 'confirm' ? (
              <>
                <span>
                  Telegram account <strong>{pairing.senderLabel || pairing.senderId}</strong> ({pairing.senderId}) sent the code.
                  Is that you?
                </span>{' '}
                <button disabled={busy} onClick={() => void act(() => confirmPairing('telegram'), () => 'Paired.').then(() => setCode(null))}>
                  Confirm
                </button>
                <button disabled={busy} onClick={() => void act(() => cancelPairing('telegram'), () => 'Cancelled.').then(() => setCode(null))}>
                  Cancel
                </button>
              </>
            ) : code && pairing.state === 'open' ? (
              <>
                <span>
                  Send <code>/pair {code.code}</code> to your bot from your own Telegram account within 10 minutes. The bot will
                  not answer; Confirm appears here.
                </span>{' '}
                <button disabled={busy} onClick={() => void act(() => cancelPairing('telegram'), () => 'Cancelled.').then(() => setCode(null))}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                disabled={busy || bindings.some((b) => b.channel === 'telegram' && b.role === 'owner')}
                onClick={async () => {
                  const r = await act(() => startPairing('telegram'))
                  if (r?.ok && r.code && r.expiresAt) setCode({ code: r.code, expiresAt: r.expiresAt })
                }}
              >
                Pair my Telegram account
              </button>
            )}
          </div>
        )}
      </section>

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

      <label>
        <input
          type="checkbox"
          checked={st.privateTelegram}
          disabled={busy}
          onChange={(e) => void save({ JARVIS_CHANNEL_PRIVATE_TELEGRAM: e.target.checked ? '1' : '0' })}
        />{' '}
        Answer me on Telegram with things from my mail, calendar and files
      </label>
      <p className="mem-note">Off: he says it is private and to look in the app. Vault items never go to a chat.</p>

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
