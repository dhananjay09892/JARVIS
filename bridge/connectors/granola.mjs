/**
 * Granola meeting-notes data connector (task C32; plans/connectors/openjarvis/data-connectors/granola).
 *
 * Paste-a-key pattern, read-only. The owner copies a personal API key (starts
 * with `grn_`; Business or Enterprise plan) from the Granola app and pastes it
 * here; it reaches the credential store only after a test call works.
 *
 * Egress allow-list: public-api.granola.ai, GET only, under /v1/notes.
 *
 * API facts (*verify* against docs.granola.ai before the live check, C41; the
 * docs host could not be reached from the build environment, so these come
 * from search snippets of the official pages):
 *   - Base URL https://public-api.granola.ai, bearer key.
 *   - GET /v1/notes: cursor pagination (`cursor` in, `hasMore` and `cursor`
 *     out), `page_size` up to 30, date filters such as `updated_after`.
 *   - GET /v1/notes/{id}: the note with its summary, attendees and calendar
 *     event. Transcripts need `include=transcript` and are NOT requested here:
 *     this slice syncs the AI summary only (a transcript option would be a
 *     separate, consent-gated follow-up, plan 33).
 *   - Only notes with a generated summary are returned; about 5 requests a
 *     second, so the adapter paces itself.
 * Because exact field names are unconfirmed, the mapper reads the likely
 * variants (summary_markdown / summary_text / summary, snake or camel case)
 * and drops anything it cannot read rather than guessing.
 *
 * Sync: list notes updated since the watermark (minus a short overlap), oldest
 * first, fetch the detail of at most `maxPerSync` of them, and move the
 * watermark only as far as the last note handled, so the rest wait for the
 * next sync. Cursor: `{"v":1,"w":<ms>}`.
 * Deletions upstream are not visible through the list, so none are reported;
 * "erase synced data" in Settings clears the store.
 */
import { createHttp, ConnectorError } from './http.mjs'

export const GRANOLA_HOST = 'public-api.granola.ai'
export const GRANOLA_API = `https://${GRANOLA_HOST}`
const KEY_SHAPE = /^grn_[A-Za-z0-9_-]{16,300}$/
const NOTE_ID = /^[A-Za-z0-9_-]{1,100}$/
const PAGE_SIZE = 30
const MAX_PAGES = 10
const MAX_PER_SYNC = 40
const FIRST_DAYS = 30
const MAX_DAYS = 365
const OVERLAP_MS = 60_000
const PACE_MS = 250
const DAY_MS = 86_400_000

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}
const ms = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

export function parseGranolaCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 200) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || !Number.isFinite(c.w) || c.w <= 0) return null
    return { w: c.w }
  } catch {
    return null
  }
}
export const granolaCursor = ({ w }) => JSON.stringify({ v: 1, w })

export function windowStart({ cursor, since, nowMs }) {
  const floor = nowMs - MAX_DAYS * DAY_MS
  const prev = parseGranolaCursor(cursor)
  let from
  if (prev) from = prev.w - OVERLAP_MS
  else if (Number.isFinite(since) && since > 0) from = since - OVERLAP_MS
  else from = nowMs - FIRST_DAYS * DAY_MS
  return Math.max(floor, Math.min(from, nowMs))
}

function person(p) {
  if (typeof p === 'string') return clean(p, 200)
  if (!p || typeof p !== 'object') return ''
  const name = clean(pick(p, 'name', 'display_name', 'displayName'), 100)
  const email = clean(p.email, 120)
  return name && email ? `${name} <${email}>` : name || email
}

/** A list row or detail object to a Document; null when it has no usable id, time or summary. */
export function noteToDocument(n) {
  if (!n || typeof n !== 'object') return null
  const id = pick(n, 'id')
  if (typeof id !== 'string' || !NOTE_ID.test(id)) return null
  const updatedAt = ms(pick(n, 'updated_at', 'updatedAt')) ?? ms(pick(n, 'created_at', 'createdAt'))
  if (updatedAt === null) return null
  const createdAt = ms(pick(n, 'created_at', 'createdAt'))
  const rawSummary = pick(n, 'summary_markdown', 'summaryMarkdown', 'summary_text', 'summaryText', 'summary')
  const summary = typeof rawSummary === 'string' ? rawSummary.replace(/\u0000/g, '').trim().slice(0, 60_000) : ''
  if (!summary) return null
  const title = clean(pick(n, 'title'), 200) || 'Untitled meeting'
  const owner = person(pick(n, 'owner'))
  const attendeesRaw = pick(n, 'attendees')
  const attendees = (Array.isArray(attendeesRaw) ? attendeesRaw : []).slice(0, 50).map(person).filter(Boolean)
  const when = createdAt ?? updatedAt
  const text = [
    `Meeting notes: ${title} (${new Date(when).toISOString().slice(0, 10)})`,
    attendees.length ? `Attendees: ${attendees.join(', ')}` : '',
    '',
    summary,
  ].join('\n').trim()
  return {
    id: `note:${id}`,
    title,
    text,
    ...(owner ? { author: owner } : {}),
    ...(createdAt !== null ? { createdAt } : {}),
    updatedAt,
    sensitivity: 'work',
    meta: { kind: 'meeting-note', ...(attendees.length ? { attendees: attendees.length } : {}) },
  }
}

const GRANOLA_SEES = [
  'The title, date, attendees and AI summary of your Granola meeting notes.',
  'Not the word-for-word transcripts, and not notes you cannot open in Granola.',
  'Meeting notes can be sensitive. They stay on this device and are only shown to a cloud model if you allow work documents there.',
  'Read-only: JARVIS never changes anything in Granola.',
  'Disconnecting forgets the key here; to cut access fully, also revoke the key in Granola.',
]

/** @param {{ timeoutMs?: number, maxPerSync?: number, paceMs?: number }} [opts] */
export function granolaConnector({ timeoutMs, maxPerSync = MAX_PER_SYNC, paceMs = PACE_MS } = {}) {
  return Object.freeze({
    id: 'granola',
    create({ credentials, fetch, sleep, now }) {
      const api = createHttp({ fetch, sleep, now, allowedHosts: [GRANOLA_HOST], ...(timeoutMs ? { timeoutMs } : {}) })
      let lastSync
      let nextAt = 0

      const keyOrThrow = () => {
        const key = credentials.get('token')
        if (!key) throw new ConnectorError('not-connected')
        return key
      }
      async function get(path, params = {}, key = keyOrThrow()) {
        const wait = nextAt - now()
        if (wait > 0) await sleep(wait)
        nextAt = now() + paceMs
        const qs = new URLSearchParams(params).toString()
        return api.json(`${GRANOLA_API}/v1/notes${path}${qs ? `?${qs}` : ''}`, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'JARVIS-connector' },
        })
      }

      return {
        id: 'granola',
        name: 'Granola meeting notes',
        kind: 'data',
        auth: 'token',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'work',
        setup: {
          sees: GRANOLA_SEES,
          scopes: ['Read access to your notes (personal API key)'],
          steps: [
            'In the Granola desktop app open Settings and find the API keys section (Business or Enterprise plan).',
            'Create a personal API key and copy it. It starts with grn_.',
            'Paste it here. JARVIS tests it first and stores nothing if it fails.',
          ],
          tokenLabel: 'Granola API key',
          helpUrl: 'https://docs.granola.ai/help-center/sharing/integrations/granola-api',
          testQuestion: 'What did we decide in my last meeting?',
        },

        async connect({ token } = {}) {
          const secret = String(token ?? '').trim()
          if (!KEY_SHAPE.test(secret)) throw new ConnectorError('auth', { detail: 'not a Granola key' })
          await get('', { page_size: '1' }, secret)
          credentials.set('token', secret)
          lastSync = undefined
          return { detail: 'Connected to Granola. JARVIS reads your meeting summaries and keeps them on this device.' }
        },

        async disconnect() {
          credentials.delete('token')
          lastSync = undefined
        },

        status() {
          if (!credentials.has('token')) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: 'Connected to Granola (read-only)' }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          await get('', { page_size: '1' })
          return { detail: 'Granola works: JARVIS can read your meeting notes (read-only).' }
        },

        async *sync({ since, cursor } = {}) {
          keyOrThrow()
          const nowMs = now()
          const start = windowStart({ cursor, since, nowMs })
          const rows = []
          const seenUpTo = parseGranolaCursor(cursor)?.w ?? 0 // notes at or before it were handled; the overlap only guards the query
          let next
          for (let page = 0; page < MAX_PAGES; page++) {
            const body = await get('', {
              page_size: String(PAGE_SIZE),
              updated_after: new Date(start).toISOString(),
              ...(next ? { cursor: next } : {}),
            })
            const list = body && pick(body, 'notes', 'data')
            if (!Array.isArray(list)) throw new ConnectorError('bad-response', { detail: 'notes' })
            for (const r of list) {
              const id = r && typeof r.id === 'string' && NOTE_ID.test(r.id) ? r.id : null
              const at = id ? (ms(pick(r, 'updated_at', 'updatedAt')) ?? ms(pick(r, 'created_at', 'createdAt'))) : null
              if (id && at !== null && at >= start && at > seenUpTo) rows.push({ id, at })
            }
            const c = pick(body, 'cursor', 'next_cursor', 'nextCursor')
            next = pick(body, 'hasMore', 'has_more') === true && typeof c === 'string' && c.length <= 2000 ? c : undefined
            if (!next) break
          }
          rows.sort((a, b) => a.at - b.at)
          let watermark = Math.max(start, parseGranolaCursor(cursor)?.w ?? 0)
          const batch = rows.slice(0, maxPerSync)
          for (const row of batch) {
            const detail = await get(`/${encodeURIComponent(row.id)}`)
            const doc = noteToDocument({ ...detail, id: row.id, updated_at: pick(detail ?? {}, 'updated_at', 'updatedAt') ?? new Date(row.at).toISOString() })
            if (doc) yield doc
            watermark = Math.max(watermark, row.at)
          }
          yield { cursor: granolaCursor({ w: rows.length === 0 ? nowMs : watermark }) }
          lastSync = nowMs
        },
      }
    },
  })
}
