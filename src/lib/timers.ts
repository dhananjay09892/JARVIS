/**
 * Kitchen timers for the reflex layer (plan 06, phase 1).
 *
 * Held on the page, so they work with no network and no model. They survive
 * a page reload: each timer's end time is kept in the browser's local
 * storage, and timers that ended while the page was closed are dropped (they
 * cannot ring late in a useful way). Nothing here leaves the machine.
 *
 * The clock, the scheduler and the storage are injected, so tests drive time
 * directly (timers.test.ts).
 */
import { MAX_TIMERS, MAX_TIMER_MS, type TimerView } from './reflex.ts'

export type TimerDeps = {
  now: () => number
  schedule: (fn: () => void, ms: number) => unknown
  unschedule: (handle: unknown) => void
  /** Called when a timer finishes. */
  onFire: (t: TimerView) => void
  storage?: { get(): string | null; set(v: string): void } | null
  newId?: () => string
}

export type Timers = {
  start(ms: number, label?: string): TimerView | null
  cancel(ids: string[]): number
  list(): TimerView[]
}

const STORAGE_SHAPE = (v: unknown): v is TimerView =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as TimerView).id === 'string' &&
  Number.isFinite((v as TimerView).ms) &&
  Number.isFinite((v as TimerView).endsAt) &&
  ((v as TimerView).label === undefined || typeof (v as TimerView).label === 'string')

export function makeTimers(deps: TimerDeps): Timers {
  const running = new Map<string, { view: TimerView; handle: unknown }>()
  let seq = 0
  const newId = deps.newId ?? (() => `t${deps.now().toString(36)}${(seq++).toString(36)}`)

  const save = () => {
    try {
      deps.storage?.set(JSON.stringify([...running.values()].map((r) => r.view)))
    } catch {
      /* storage is a convenience: a timer still rings without it */
    }
  }

  const arm = (view: TimerView) => {
    const handle = deps.schedule(() => {
      running.delete(view.id)
      save()
      deps.onFire(view)
    }, Math.max(0, view.endsAt - deps.now()))
    running.set(view.id, { view, handle })
  }

  // Bring back timers from before a reload; drop the ones that already ended.
  try {
    const raw = deps.storage?.get()
    const saved: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(saved)) {
      for (const v of saved.filter(STORAGE_SHAPE).slice(0, MAX_TIMERS)) {
        if (v.endsAt > deps.now() && v.endsAt - deps.now() <= MAX_TIMER_MS) {
          arm({ id: v.id, ms: v.ms, endsAt: v.endsAt, ...(v.label ? { label: v.label.slice(0, 40) } : {}) })
        }
      }
    }
  } catch {
    /* unreadable storage starts with no timers */
  }
  save()

  return {
    start(ms, label) {
      if (running.size >= MAX_TIMERS || !(ms >= 1000 && ms <= MAX_TIMER_MS)) return null
      const view: TimerView = { id: newId(), ms, endsAt: deps.now() + ms, ...(label ? { label } : {}) }
      arm(view)
      save()
      return view
    },
    cancel(ids) {
      let n = 0
      for (const id of ids) {
        const r = running.get(id)
        if (!r) continue
        deps.unschedule(r.handle)
        running.delete(id)
        n++
      }
      if (n) save()
      return n
    },
    list() {
      return [...running.values()].map((r) => r.view).sort((a, b) => a.endsAt - b.endsAt)
    },
  }
}

/** The page's timers, on the real clock and local storage. */
export function browserTimers(onFire: (t: TimerView) => void): Timers {
  const KEY = 'jarvis.timers'
  return makeTimers({
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    unschedule: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onFire,
    storage: {
      get: () => {
        try {
          return localStorage.getItem(KEY)
        } catch {
          return null
        }
      },
      set: (v) => {
        try {
          localStorage.setItem(KEY, v)
        } catch {
          /* private window or blocked storage: timers just won't survive a reload */
        }
      },
    },
  })
}
