/**
 * Oura Ring data connector (task C26; plans/connectors/openjarvis/data-connectors/oura).
 *
 * Paste-a-token pattern, read-only, health data. Everything it stores is
 * sensitivity `health`: the document tool leaves health documents out unless
 * the owner's vault setting allows them, so nothing from Oura reaches a cloud
 * model by default. There is deliberately no live tool: the only way to read
 * Oura data is through the stored, vault-gated documents.
 *
 * Egress allow-list: api.ouraring.com, GET only, under /v2/usercollection/.
 *
 * Auth note (*verify* before the live check, C27): Oura retired personal
 * access tokens at the end of 2025 and now issues OAuth2 access tokens
 * (authorize at cloud.ouraring.com, token exchange at api.ouraring.com; about
 * 30 days, with a refresh token). This adapter takes whichever access token the
 * owner pastes and validates it with a test call. A guided OAuth sign-in with
 * refresh is a separate follow-up task; until then a pasted token works until
 * Oura expires it, and the adapter then reports "Reconnect".
 *
 * Mapping (plan 38 Document), three kinds, all built by this adapter from
 * numbers and fixed labels, plus the owner's own tag comments:
 *   sleep:<id>      daily sleep score and its contributors
 *   readiness:<id>  daily readiness score, contributors, temperature deviation
 *   tag:<id>        a tag the owner wrote in the Oura app (type and comment)
 * `day` is Oura's local calendar day; updatedAt is that day's noon UTC, so a
 * day's score being re-finalised later just overwrites the same document id.
 *
 * Sync: re-reads a short window (3 days back from the last sync, so scores
 * that Oura finalises late are refreshed; 30 days on the first run, never more
 * than 90) and upserts by id. Cursor: `{"v":1,"u":<oura user id>,"d":"YYYY-MM-DD"}`;
 * a cursor from another Oura account is ignored. Oura data is not deleted
 * upstream in practice, so this adapter never reports deletions; "erase
 * synced data" in Settings clears the store.
 */
import { createHttp, ConnectorError } from './http.mjs'

export const OURA_HOST = 'api.ouraring.com'
export const OURA_API = `https://${OURA_HOST}`
const BASE = '/v2/usercollection'
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{20,400}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[A-Za-z0-9_-]{1,100}$/
const FIRST_DAYS = 30
const MAX_DAYS = 90
const OVERLAP_DAYS = 3
const MAX_PAGES = 5
const DAY_MS = 86_400_000

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const dayMs = (day) => (DAY.test(String(day)) ? Date.parse(`${day}T12:00:00Z`) : null)
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

/** Contributor keys are fixed labels; the values are numbers. Anything else is dropped. */
const label = (k) => String(k).replace(/_/g, ' ')
function contributors(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''
  return Object.entries(obj)
    .filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && num(v) !== null)
    .slice(0, 12)
    .map(([k, v]) => `${label(k)} ${v}`)
    .join(', ')
}

export function parseOuraCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 1000) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.u !== 'string' || !DAY.test(String(c.d))) return null
    return { u: c.u.slice(0, 100), d: c.d }
  } catch {
    return null
  }
}
export const ouraCursor = ({ u = '', d }) => JSON.stringify({ v: 1, u, d })

/** First day of the window to read. */
export function windowStart({ cursor, since, nowMs, user }) {
  const floor = nowMs - MAX_DAYS * DAY_MS
  const prev = parseOuraCursor(cursor)
  let from
  if (prev && prev.u === user) from = dayMs(prev.d) - OVERLAP_DAYS * DAY_MS
  else if (Number.isFinite(since) && since > 0) from = since - OVERLAP_DAYS * DAY_MS
  else from = nowMs - FIRST_DAYS * DAY_MS
  return dayOf(Math.max(floor, Math.min(from, nowMs)))
}

export function sleepToDocument(r) {
  if (!r || typeof r.id !== 'string' || !ID.test(r.id)) return null
  const at = dayMs(r.day)
  if (at === null) return null
  const score = num(r.score)
  const parts = contributors(r.contributors)
  return {
    id: `sleep:${r.id}`,
    title: `Sleep ${r.day}`,
    text: [`Sleep score for ${r.day}: ${score ?? 'not scored'}.`, parts ? `Contributors: ${parts}.` : ''].filter(Boolean).join('\n'),
    updatedAt: at,
    sensitivity: 'health',
    meta: { kind: 'sleep', day: r.day, ...(score !== null ? { score } : {}) },
  }
}

export function readinessToDocument(r) {
  if (!r || typeof r.id !== 'string' || !ID.test(r.id)) return null
  const at = dayMs(r.day)
  if (at === null) return null
  const score = num(r.score)
  const parts = contributors(r.contributors)
  const dev = num(r.temperature_deviation)
  return {
    id: `readiness:${r.id}`,
    title: `Readiness ${r.day}`,
    text: [
      `Readiness score for ${r.day}: ${score ?? 'not scored'}.`,
      parts ? `Contributors: ${parts}.` : '',
      dev !== null ? `Temperature deviation: ${dev} °C.` : '',
    ].filter(Boolean).join('\n'),
    updatedAt: at,
    sensitivity: 'health',
    meta: { kind: 'readiness', day: r.day, ...(score !== null ? { score } : {}) },
  }
}

export function tagToDocument(r) {
  if (!r || typeof r.id !== 'string' || !ID.test(r.id)) return null
  const day = r.start_day ?? r.day
  const at = dayMs(day)
  if (at === null) return null
  const type = /^[a-z_]{1,60}$/.test(String(r.tag_type_code ?? '')) ? label(r.tag_type_code) : 'tag'
  const comment = clean(r.comment, 1000)
  return {
    id: `tag:${r.id}`,
    title: `Tag ${day}: ${type}`,
    text: `Tag on ${day}: ${type}.${comment ? `\nYour note: ${comment}` : ''}`,
    updatedAt: at,
    sensitivity: 'health',
    meta: { kind: 'tag', day },
  }
}

const KINDS = [
  { path: 'daily_sleep', map: sleepToDocument },
  { path: 'daily_readiness', map: readinessToDocument },
  { path: 'enhanced_tag', map: tagToDocument },
]

const OURA_SEES = [
  'Your daily sleep and readiness scores from Oura, with their contributors, and the tags you write in the Oura app.',
  'Not heart-rate series, workouts, or your profile details such as email, age or weight.',
  'This is health data. It stays on this device: JARVIS does not show it to a cloud model unless you allow health data there.',
  'Read-only: JARVIS never changes anything in your Oura account.',
  'Disconnecting forgets the token here; to cut access fully, also revoke it in your Oura account.',
]

/** @param {{ timeoutMs?: number }} [opts] */
export function ouraConnector({ timeoutMs } = {}) {
  return Object.freeze({
    id: 'oura',
    create({ credentials, fetch, sleep, now }) {
      const api = createHttp({ fetch, sleep, now, allowedHosts: [OURA_HOST], ...(timeoutMs ? { timeoutMs } : {}) })
      let lastSync

      const tokenOrThrow = () => {
        const token = credentials.get('token')
        if (!token) throw new ConnectorError('not-connected')
        return token
      }
      const get = (path, params = {}, token = tokenOrThrow()) => {
        const qs = new URLSearchParams(params).toString()
        return api.json(`${OURA_API}${BASE}/${path}${qs ? `?${qs}` : ''}`, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'JARVIS-connector' },
        })
      }
      const userOf = async (token) => {
        const info = await get('personal_info', {}, token)
        const id = clean(info?.id, 100)
        if (!id) throw new ConnectorError('bad-response', { detail: 'personal_info' })
        return id
      }

      return {
        id: 'oura',
        name: 'Oura Ring',
        kind: 'data',
        auth: 'token',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R2',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'health',
        setup: {
          sees: OURA_SEES,
          scopes: ['Read access to daily sleep, daily readiness and tags'],
          steps: [
            'Sign in at cloud.ouraring.com and open the developer pages. Oura now issues OAuth access tokens; old personal access tokens no longer work.',
            'Create an access token or app with only the daily, personal and tag read scopes.',
            'Paste the access token here. JARVIS tests it first and stores nothing if it fails.',
          ],
          tokenLabel: 'Oura access token',
          helpUrl: 'https://cloud.ouraring.com/docs/authentication',
          testQuestion: 'How did I sleep?',
        },

        async connect({ token } = {}) {
          const secret = String(token ?? '').trim()
          if (!TOKEN_SHAPE.test(secret)) throw new ConnectorError('auth', { detail: 'not an access token' })
          const user = await userOf(secret)
          credentials.set('token', secret)
          credentials.set('user', user)
          lastSync = undefined
          return { detail: 'Connected to Oura. JARVIS reads your sleep and readiness scores and keeps them on this device.' }
        },

        async disconnect() {
          credentials.delete('token')
          credentials.delete('user')
          lastSync = undefined
        },

        status() {
          if (!credentials.has('token')) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: 'Connected to Oura (read-only, health data kept local)' }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          await get('personal_info')
          return { detail: 'Oura works: JARVIS can read your sleep and readiness scores (read-only).' }
        },

        async *sync({ since, cursor } = {}) {
          tokenOrThrow()
          const nowMs = now()
          const user = credentials.get('user') ?? ''
          const start = windowStart({ cursor, since, nowMs, user })
          const end = dayOf(nowMs + DAY_MS)
          for (const kind of KINDS) {
            let next
            for (let page = 0; page < MAX_PAGES; page++) {
              const body = await get(kind.path, { start_date: start, end_date: end, ...(next ? { next_token: next } : {}) })
              if (!body || !Array.isArray(body.data)) throw new ConnectorError('bad-response', { detail: kind.path })
              for (const row of body.data) {
                const doc = kind.map(row)
                if (doc) yield doc
              }
              next = typeof body.next_token === 'string' && body.next_token.length <= 2000 ? body.next_token : undefined
              if (!next) break
            }
          }
          yield { cursor: ouraCursor({ u: user, d: dayOf(nowMs) }) }
          lastSync = nowMs
        },
      }
    },
  })
}
