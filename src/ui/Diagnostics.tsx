import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { fetchTraceStats, traceDiag, type TraceStats } from '../lib/trace'
import { listConnectors, type ConnectorHealth } from '../lib/connectors'
import { fetchSetupStats, WIZARD_STEPS, type SetupStats } from '../lib/setupMetrics'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it. It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 */

type VoiceDiag = {
  engine: string
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  wakes: number
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
  wakeEngine: 'offline' | 'cloud'
  wakeReason: string
  wakeScore: number
  wakePeak: number
  wakeThreshold: number
  wakeFrameMs: number
  falseWakes: number
  droppedAsleep: number
  uploadedAsleepBytes: number
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  nativeBroken: boolean
  rescued: number
  voice: string
  lastText: string
}

/** Milliseconds as seconds, or a dash when there is nothing yet. */
const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(2)}s`)

/** Plan 16's target: median end of speech → first audio ≤ 1.0 s. */
const LATENCY_TARGET_MS = 1000
/** Plan 06 phase 2: at least this share of routed turns on the fast path. */
const FAST_SHARE_TARGET = 0.6
/** Plan 29: setup completion of 85 % or more. */
const SETUP_COMPLETION_TARGET = 0.85
/** How the setup steps read in the panel (WIZARD_STEPS order). */
const STEP_LABELS: Record<string, string> = {
  hardware: 'microphone check',
  claude: 'Claude sign-in',
  voice: 'better voice',
  finish: 'all set',
}

const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s ago` : '—')

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-k">{k}</span>
      <span className={bad ? 'diag-v diag-bad' : 'diag-v'}>{v}</span>
    </div>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const phase = useStore((s) => s.phase)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  // The rolling numbers live in the bridge's trace store, so they survive a
  // reload. Polled slowly: they only move once per turn.
  const [stats, setStats] = useState<TraceStats | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => {
      void fetchTraceStats(50).then((s) => {
        if (alive) setStats(s)
      })
    }
    load()
    const id = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [open])

  // Plan 16 connector health (task C95): cards in attention or error.
  const [health, setHealth] = useState<ConnectorHealth | null | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => {
      listConnectors()
        .then((l) => alive && setHealth(l.health ?? null))
        .catch(() => alive && setHealth(null))
    }
    load()
    const id = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [open])

  // Plan 29 (Q77): the opt-in setup drop-off metric. Only moves when someone
  // runs the wizard or the self-test, so polled slowly.
  const [setup, setSetup] = useState<SetupStats | null | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => {
      void fetchSetupStats(BRIDGE_HTTP_URL).then((st) => alive && setSetup(st))
    }
    load()
    const id = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>

  // The two verdicts worth stating outright, rather than making you infer them
  // from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0 || (t.rescued ?? 0) > 0

  return (
    <div className="diag" aria-live="polite">
      <div className="diag-head">DIAGNOSTICS · D to close</div>

      <div className="diag-verdict">
        <span className={earsOk ? 'diag-ok' : 'diag-bad'}>
          {earsOk ? '● hearing you' : '● not hearing you'}
        </span>
        <span className={mouthOk ? 'diag-ok' : 'diag-bad'}>
          {mouthOk ? '● speaking' : '● no sound produced'}
        </span>
      </div>

      <div className="diag-sec">LISTENING</div>
      <Row k="recogniser" v={v.running ? 'running' : 'STOPPED'} bad={!v.running} />
      <Row k="sessions" v={String(v.sessions ?? 0)} />
      <Row
        k="silent for"
        v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
        bad={(v.idleMs ?? 0) > 15000}
      />
      <Row k="forced restarts" v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
      <Row k="mode" v={`${v.mode ?? '—'} (phase ${phase})`} />
      <Row k="accepted" v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
      <Row k="wakes" v={String(v.wakes ?? 0)} />
      <Row k="last heard" v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : '— nothing yet'} bad={!v.heard} />
      <Row k="last drop" v={v.dropped || '—'} bad={Boolean(v.dropped)} />
      <Row k="error" v={v.lastError || '—'} bad={Boolean(v.lastError)} />

      <div className="diag-sec">WAKE WORD · plan 02</div>
      <Row
        k="listening for his name"
        v={v.wakeEngine === 'offline' ? 'on this computer (offline)' : `CLOUD — ${v.wakeReason || 'offline engine not running'}`}
        bad={v.wakeEngine !== 'offline'}
      />
      {v.wakeEngine === 'offline' && (
        <>
          <Row
            k="score / best / bar"
            v={`${(v.wakeScore ?? 0).toFixed(2)} / ${(v.wakePeak ?? 0).toFixed(2)} / ${(v.wakeThreshold ?? 0).toFixed(2)}`}
          />
          <Row k="ms per 80 ms frame" v={String(v.wakeFrameMs ?? 0)} bad={(v.wakeFrameMs ?? 0) > 40} />
        </>
      )}
      <Row k="false wakes" v={String(v.falseWakes ?? 0)} />
      <Row k="asleep segments kept here" v={String(v.droppedAsleep ?? 0)} />
      {v.wakeEngine !== 'offline' && v.engine === 'browser' ? (
        <Row k="sent while asleep" v="streamed continuously (browser speech service)" bad />
      ) : (
        <Row
          k="sent while asleep"
          v={`${Math.round((v.uploadedAsleepBytes ?? 0) / 1024)} KB`}
          bad={(v.uploadedAsleepBytes ?? 0) > 0}
        />
      )}

      <div className="diag-sec">LATENCY · end of speech → first audio</div>
      {stats?.enabled && stats.latency ? (
        <>
          <Row
            k="median"
            v={`${secs(stats.latency.median)} over ${stats.latency.n} turns`}
            bad={(stats.latency.median ?? 0) > LATENCY_TARGET_MS}
          />
          <Row k="p95" v={secs(stats.latency.p95)} />
          <Row k="errors / interrupted" v={`${stats.errors ?? 0} / ${stats.interrupted ?? 0}`} />
          {stats.reflex && (
            // Plan 06 phase 1: answered on this page with no model call, so
            // kept out of the median above. Any model call here is a bug.
            <Row
              k="quick commands (no AI)"
              v={`${stats.reflex.turns} turns · ${secs(stats.reflex.latency.median)}${stats.reflex.modelCalls ? ` · ${stats.reflex.modelCalls} reached a model` : ''}`}
              bad={stats.reflex.modelCalls > 0}
            />
          )}
          {stats.paths && stats.paths.routed > 0 && (
            // Plan 06 phase 2: which model answered. The plan's target is 60 %
            // or more on the fast path; a fast turn that used a tool is a hint
            // the router guessed low.
            <>
              <Row
                k="fast path"
                v={`${Math.round((stats.paths.fastShare ?? 0) * 100)}% of ${stats.paths.routed} turns · ${secs(stats.paths.fast.latency.median)}${stats.paths.fast.toolTurns ? ` · ${stats.paths.fast.toolTurns} used tools` : ''}`}
                bad={(stats.paths.fastShare ?? 0) < FAST_SHARE_TARGET}
              />
              <Row
                k="deep path"
                v={`${stats.paths.deep.turns} turns · ${secs(stats.paths.deep.latency.median)}${stats.paths.reasons.off ? ' · routing off' : ''}`}
              />
            </>
          )}
        </>
      ) : (
        <Row
          k="median (this session)"
          v={`${secs(traceDiag.localMedianMs)}${stats && !stats.enabled ? ' · traces off' : stats ? '' : ' · bridge unreachable'}`}
          bad={(traceDiag.localMedianMs ?? 0) > LATENCY_TARGET_MS}
        />
      )}
      <Row k="last turn" v={secs(traceDiag.lastLatencyMs)} bad={(traceDiag.lastLatencyMs ?? 0) > LATENCY_TARGET_MS} />
      <Row k="traces not saved" v={String(traceDiag.postFailures)} bad={traceDiag.postFailures > 0} />

      <div className="diag-sec">CONNECTORS · plan 16</div>
      {health ? (
        <>
          <Row
            k="need attention"
            v={`${health.needsAttention} of ${health.total}${health.ids.length ? ` (${health.ids.join(', ')})` : ''}`}
            bad={health.needsAttention > 0}
          />
          <Row k="working / not connected / off" v={`${health.ok} / ${health.disconnected} / ${health.off}`} />
          <Row k="frozen" v={health.frozen ? 'yes, all connectors' : 'no'} bad={health.frozen} />
        </>
      ) : (
        <Row k="status" v={health === undefined ? '…' : 'bridge unreachable'} bad={health === null} />
      )}

      <div className="diag-sec">SETUP · plan 29</div>
      {setup?.enabled && setup.runs !== undefined ? (
        <>
          <Row
            k="setup finished"
            v={
              setup.runs
                ? `${setup.completed} of ${setup.runs} (${Math.round((setup.completionRate ?? 0) * 100)}%) · ${setup.skipped} skipped · ${setup.abandoned} left open`
                : 'no setup runs yet'
            }
            bad={setup.runs > 0 && (setup.completionRate ?? 0) < SETUP_COMPLETION_TARGET}
          />
          {setup.leftAt && (setup.runs ?? 0) > (setup.completed ?? 0) && (
            <Row
              k="where it stopped"
              v={WIZARD_STEPS.filter((st) => setup.leftAt?.[st])
                .map((st) => `${STEP_LABELS[st]} ${setup.leftAt?.[st]}`)
                .join(' · ')}
            />
          )}
          {setup.selftest && (
            <Row
              k="self-test problems"
              v={
                setup.selftest.failures.length
                  ? `${setup.selftest.failures.map((f) => `${f.id} ×${f.count}`).join(', ')} · ${setup.selftest.clean} of ${setup.selftest.runs} checks clean`
                  : `none · ${setup.selftest.runs} checks`
              }
              bad={setup.selftest.failures.length > 0}
            />
          )}
        </>
      ) : (
        <Row
          k="counting"
          v={setup === undefined ? '…' : setup === null ? 'bridge unreachable' : 'off (opt in under Settings → Diagnostics)'}
        />
      )}

      <div className="diag-sec">SPEAKING · press T to test</div>
      <Row k="engine" v={String(t.engine ?? 'system')} />
      <Row k="voice" v={String(t.voice || '—')} />
      <Row k="handed to OS" v={String(t.spoken ?? 0)} />
      <Row k="actually spoke" v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
      <Row k="failures" v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
      <Row k="cloud rescues" v={String(t.rescued ?? 0)} />
      <Row k="error" v={t.lastError || '—'} bad={Boolean(t.lastError)} />
    </div>
  )
}
