/**
 * The Watcher as an agent (roster #9): a continuous named agent that tells
 * the owner when something they asked to hear about turns up in their GitHub
 * notifications, their RSS feeds or on a web page.
 *
 *   - What to watch: the owner's watch rules, one per line or separated by
 *     `;`, in Settings → Agents ("Watcher rules", JARVIS_WATCHES):
 *
 *       github repo=acme/api reason=review_requested,mention
 *       github kind="pull request" words=security
 *       rss feed=example.com words="claude,open source"
 *       page url=https://shop.example/desk words="in stock"
 *
 *     `github` and `rss` match the documents those connectors already synced
 *     (connectors/github_notifications.mjs, connectors/news_rss.mjs), from
 *     the last day; the Watcher makes no request of its own to GitHub or the
 *     feeds. `page` fetches the owner's own address through the bridge's
 *     outbound gate (net.mjs: https or http only, no local network, a size
 *     and time limit) and matches when one of the words appears on the page
 *     after not being there before. A rule the Watcher does not understand is
 *     skipped and named in the result; nothing else is guessed.
 *   - How: one read-only tool, `check_watches`, that takes no arguments. The
 *     matching is plain rules in this file, not the model's judgement, so the
 *     same item always gives the same answer.
 *   - Once only: an item that was alerted is remembered (its connector, its
 *     id and when it last changed) in a small state file, for 30 days. A
 *     repeat raises nothing; an item that changed since (a new comment on a
 *     thread) is new again. What a run found is only remembered once that run
 *     ends well and its alert is raised, so a run that fails loses nothing.
 *   - The alert: carries the matches the tool found, not the model's words,
 *     so nothing an issue title, a feed or a page says can be turned into
 *     something else on the way. It is a normal, private alert for the owner;
 *     the notification policy (notify-policy.mjs) decides whether and how it
 *     reaches them. A run with nothing new raises nothing at all.
 *   - Budget: the Watcher's file must set one (every continuous agent must),
 *     and a run that ends on it stops the loop until the owner switches the
 *     agent off and on (agent-triggers.mjs).
 *
 * Everything the tool returns is untrusted: it reaches the model inside an
 * <untrusted_data> envelope and is clipped and stripped of control
 * characters. Nothing here sends anything, writes memory, marks a GitHub
 * thread read or changes a setting.
 *
 * Like briefing-agent.mjs this has no package imports, so it is tested alone;
 * server.mjs turns `serverSpec()` into the SDK server.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { renameWithRetry } from './atomic-rename.mjs'
import { join } from 'node:path'
import { WATCH_SERVER, WATCH_TOOL_NAMES } from './policy.mjs'
import { settingsDir } from './settings.mjs'
import { wrapUntrusted } from './untrusted.mjs'
import { fetchText } from './net.mjs'

export { WATCH_SERVER, WATCH_TOOL_NAMES }
export const WATCHER_ID = 'watcher'
export const WATCH_TOOL = WATCH_TOOL_NAMES[0]
export const WATCH_TOOL_ID = `mcp__${WATCH_SERVER}__${WATCH_TOOL}`
export const WATCHES_SETTING = 'JARVIS_WATCHES'

/** The connector each watch source reads, by its synced documents. */
export const WATCH_SOURCES = Object.freeze({ github: 'github_notifications', rss: 'news_rss', page: null })
/** At most this many rules are read, and this many of them may be pages. */
export const MAX_WATCHES = 20
export const MAX_PAGE_WATCHES = 5
/** Only documents that changed in this window are looked at. */
export const LOOKBACK_MS = 24 * 60 * 60 * 1000
/** Documents read per connector per check. */
export const MAX_DOCS = 200
/** Matches handed out per run; the rest wait for the next run. */
export const MAX_MATCHES = 10
/** How long an alerted item is remembered, and how many are. */
export const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_SEEN = 5000
/** A watched page larger than this, or slower than this, is not read. */
export const PAGE_MAX_BYTES = 1_000_000
export const PAGE_TIMEOUT_MS = 10_000
/** Checks kept for runs that have not ended yet. */
export const MAX_KEPT = 20
const MAX_WORDS = 10
const MAX_WORD = 60
const MAX_LINE = 240
const MAX_BODY = 1500

const KEYS = Object.freeze({
  github: ['repo', 'reason', 'kind', 'words'],
  rss: ['feed', 'words'],
  page: ['url', 'words'],
})
const REPO = /^[A-Za-z0-9_.-]{1,100}\/(?:[A-Za-z0-9_.-]{1,100}|\*)$/
const REASON = /^[a-z_]{1,40}$/
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const sha = (s) => createHash('sha256').update(s).digest('hex')
const oneLine = (s, n) => String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const fold = (s) => oneLine(s, 100_000).toLowerCase()
const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean)

/** Splits one rule into words, keeping "quoted values" whole. */
function tokens(rule) {
  const out = []
  const re = /([a-z]+)=(?:"([^"]*)"|'([^']*)'|(\S+))|(\S+)/gi
  let m
  while ((m = re.exec(rule))) {
    if (m[5] !== undefined) out.push({ bare: m[5] })
    else out.push({ key: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' })
  }
  return out
}

/** One rule, or `{ error }`. */
function parseRule(text) {
  const [first, ...rest] = tokens(text)
  const source = String(first?.bare ?? '').toLowerCase()
  if (!Object.hasOwn(KEYS, source)) return { error: `"${oneLine(text, 40)}": start with github, rss or page` }
  const watch = { id: `w${sha(`${source}\u0000${oneLine(text, 1000).toLowerCase()}`).slice(0, 10)}`, source, words: [] }
  for (const t of rest) {
    if (t.bare !== undefined || !KEYS[source].includes(t.key)) {
      return { error: `"${oneLine(text, 40)}": ${source} watches take ${KEYS[source].join(', ')}` }
    }
    const v = t.value.trim()
    if (!v) return { error: `"${oneLine(text, 40)}": ${t.key} is empty` }
    if (t.key === 'words') {
      watch.words = list(v).map((w) => fold(w).slice(0, MAX_WORD)).filter(Boolean).slice(0, MAX_WORDS)
    } else if (t.key === 'repo') {
      if (!REPO.test(v)) return { error: `"${oneLine(text, 40)}": repo is owner/name or owner/*` }
      watch.repo = v.toLowerCase()
    } else if (t.key === 'reason') {
      watch.reasons = list(v).map((r) => r.toLowerCase())
      if (!watch.reasons.every((r) => REASON.test(r))) return { error: `"${oneLine(text, 40)}": reason is a GitHub reason like mention` }
    } else if (t.key === 'kind') {
      watch.kinds = list(v).map((k) => k.toLowerCase().replace(/[\s_-]+/g, ''))
    } else if (t.key === 'feed') {
      watch.feed = fold(v).slice(0, 200)
    } else if (t.key === 'url') {
      let u
      try { u = new URL(v) } catch { u = null }
      if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) {
        return { error: `"${oneLine(text, 40)}": url is an https address` }
      }
      watch.url = u.href
    }
  }
  if (source === 'page' && (!watch.url || !watch.words.length)) {
    return { error: `"${oneLine(text, 40)}": a page watch needs url= and words=` }
  }
  return { watch }
}

/**
 * The owner's watch rules. Unknown sources and keys are refused rule by rule,
 * never guessed; duplicates are kept once.
 *
 * @param {string} text the setting's value ("none" or empty for no rules)
 * @returns {{ watches: object[], errors: string[] }}
 */
export function parseWatches(text) {
  const raw = typeof text === 'string' ? text : ''
  if (!raw.trim() || raw.trim().toLowerCase() === 'none') return { watches: [], errors: [] }
  const watches = []
  const errors = []
  let pages = 0
  for (const line of raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    if (watches.length >= MAX_WATCHES) { errors.push(`only the first ${MAX_WATCHES} rules are used`); break }
    const r = parseRule(line)
    if (r.error) { errors.push(r.error); continue }
    if (watches.some((w) => w.id === r.watch.id)) continue
    if (r.watch.source === 'page' && ++pages > MAX_PAGE_WATCHES) { errors.push(`only ${MAX_PAGE_WATCHES} page watches are used`); continue }
    watches.push(r.watch)
  }
  return { watches, errors }
}

const hasWord = (haystack, words) => !words.length || words.some((w) => haystack.includes(w))

/** The stored text of a document, out of its untrusted envelope. */
function bodyOf(doc) {
  const t = String(doc?.text ?? '')
  const m = /^<untrusted_data\b[^>]*>\n?([\s\S]*?)\n?<\/untrusted_data>\s*$/.exec(t)
  return m ? m[1] : t
}

/** Does this synced document match this watch? */
export function matchesDocument(watch, doc) {
  if (!isObject(watch) || !isObject(doc)) return false
  const meta = isObject(doc.meta) ? doc.meta : {}
  if (watch.source === 'github') {
    const repo = String(meta.repo ?? '').toLowerCase()
    if (watch.repo) {
      const [owner, name] = watch.repo.split('/')
      if (name === '*' ? !repo.startsWith(`${owner}/`) : repo !== watch.repo) return false
    }
    if (watch.reasons && !watch.reasons.includes(String(meta.reason ?? ''))) return false
    if (watch.kinds && !watch.kinds.includes(String(meta.type ?? '').toLowerCase())) return false
    return hasWord(fold(doc.title), watch.words)
  }
  if (watch.source === 'rss') {
    if (watch.feed && !fold(`${meta.feed ?? ''} ${meta.feedUrl ?? ''}`).includes(watch.feed)) return false
    return hasWord(fold(`${doc.title ?? ''} ${bodyOf(doc)}`), watch.words)
  }
  return false
}

/** A page's visible text, roughly: no scripts, styles or tags. */
export function pageText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
}

/** The words of a page watch found on the page, in the rule's order. */
export const pageWords = (watch, text) => watch.words.filter((w) => fold(text).includes(w))

/** Fetches a watched page through the outbound gate (net.mjs). */
async function defaultFetchPage(url) {
  const { text } = await fetchText(url, { maxBytes: PAGE_MAX_BYTES, timeoutMs: PAGE_TIMEOUT_MS })
  return text
}

export const watchStateFile = (env = process.env) => join(settingsDir(env), 'agent-watcher.json')

/**
 * What the Watcher has already alerted: item keys with the time they were
 * alerted, and per page watch whether its words were on the page last time.
 * Keys and booleans only, no titles. With no `file` it lives in memory, for
 * tests. Reading never throws; a failed write is logged and the bridge
 * carries on.
 */
export function createWatchState({ file = null, now = () => Date.now(), log = console } = {}) {
  const seen = new Map()
  const pages = new Map()
  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const [k, t] of Object.entries(isObject(raw?.seen) ? raw.seen : {}).slice(0, MAX_SEEN)) {
        if (typeof k === 'string' && k.length <= 300 && Number.isFinite(t)) seen.set(k, t)
      }
      for (const [k, v] of Object.entries(isObject(raw?.pages) ? raw.pages : {}).slice(0, MAX_WATCHES)) {
        if (/^w[0-9a-f]{10}$/.test(k) && typeof v === 'boolean') pages.set(k, v)
      }
    } catch {
      log.warn?.('[jarvis] watcher state unreadable; starting fresh')
    }
  }
  const prune = () => {
    const cutoff = now() - SEEN_TTL_MS
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k)
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value)
  }
  const save = () => {
    if (!file) return
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ v: 1, seen: Object.fromEntries(seen), pages: Object.fromEntries(pages) })}\n`, { mode: 0o600 })
      renameWithRetry(tmp, file)
    } catch (err) {
      log.error?.('[jarvis] watcher state write failed:', err?.message ?? err)
    }
  }
  return {
    has: (key) => {
      const t = seen.get(key)
      return t !== undefined && t >= now() - SEEN_TTL_MS
    },
    /** Was this page watch's word on the page at the last check that counted? */
    pageMatched: (id) => pages.get(id) === true,
    /** Remember a finished check: the items alerted and each page's state. */
    commit({ keys = [], pageStates = {} } = {}) {
      const t = now()
      for (const k of keys) { seen.delete(k); seen.set(k, t) }
      for (const [id, v] of Object.entries(pageStates)) pages.set(id, v === true)
      prune()
      save()
    },
    size: () => seen.size,
  }
}

const describe = {
  github: (doc) => {
    const meta = isObject(doc.meta) ? doc.meta : {}
    return `GitHub · ${oneLine(meta.repo, 100) || 'notification'} · ${oneLine(doc.title, 200)}`
  },
  rss: (doc) => {
    const meta = isObject(doc.meta) ? doc.meta : {}
    return `RSS · ${oneLine(meta.feed, 60) || 'feed'} · ${oneLine(doc.title, 200)}`
  },
}

/**
 * The Watcher's tool and what each run found.
 *
 * @param {object} o
 * @param {{ recent: Function, state: Function } | null} o.store the connector document store (connectors/store.mjs)
 * @param {() => string} o.watches the watch rules (JARVIS_WATCHES), live
 * @param {ReturnType<typeof createWatchState>} [o.state]
 * @param {(url: string) => Promise<string>} [o.fetchPage] reads a watched page (net.mjs by default)
 * @param {() => number} [o.now]
 */
export function createWatchRuns({
  store = null, watches = () => '', state = createWatchState(), fetchPage = defaultFetchPage, now = () => Date.now(), log = console,
} = {}) {
  /** task id → what its latest check found and would remember */
  const kept = new Map()
  const keep = (taskId, out) => {
    kept.delete(taskId)
    kept.set(taskId, out)
    while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value)
  }

  /** Synced documents of one connector from the last day, or null when it has never synced. */
  function docsOf(connectorId) {
    if (!store) return null
    try {
      const docs = store.recent(connectorId, { since: now() - LOOKBACK_MS, limit: MAX_DOCS })
      const synced = store.state?.(connectorId)?.lastSync
      if (!docs.length && (synced === null || synced === undefined)) return null
      return docs
    } catch (err) {
      log.warn?.(`[jarvis] watcher could not read ${connectorId}:`, err?.message ?? err)
      return null
    }
  }

  /**
   * One check against the rules now. Changes nothing: what it would remember
   * is returned as `pending` and only kept once the run ends well.
   *
   * @returns {Promise<{ matches: object[], more: number, notes: string[], pending: { keys: string[], pageStates: object } }>}
   */
  async function check() {
    let rules
    try { rules = parseWatches(watches()) } catch { rules = { watches: [], errors: ['the rules could not be read'] } }
    const notes = [...rules.errors]
    const matches = []
    const pending = { keys: [], pageStates: {} }
    let more = 0
    const add = (m) => {
      if (matches.length < MAX_MATCHES) { matches.push(m); pending.keys.push(m.key) } else more++
    }
    if (!rules.watches.length) notes.push('no watch rules are set (Settings → Agents → Watcher rules)')

    for (const source of ['github', 'rss']) {
      const mine = rules.watches.filter((w) => w.source === source)
      if (!mine.length) continue
      const connectorId = WATCH_SOURCES[source]
      const docs = docsOf(connectorId)
      if (docs === null) { notes.push(`${source === 'github' ? 'GitHub notifications have' : 'RSS feeds have'} not synced yet`); continue }
      for (const doc of docs) {
        if (typeof doc?.id !== 'string' || !Number.isFinite(doc.updatedAt)) continue
        const key = `${connectorId}:${doc.id}:${doc.updatedAt}`
        if (state.has(key)) continue
        const hit = mine.filter((w) => matchesDocument(w, doc))
        if (!hit.length) continue
        add({ key, source, watch: hit[0].id, line: oneLine(describe[source](doc), MAX_LINE), url: oneLine(doc.url, 500) || null })
      }
    }

    for (const w of rules.watches.filter((x) => x.source === 'page')) {
      let found
      try {
        found = pageWords(w, pageText(await fetchPage(w.url)))
      } catch (err) {
        notes.push(`${new URL(w.url).host} could not be read`)
        log.warn?.(`[jarvis] watcher could not read a page: ${oneLine(err?.message ?? err, 120)}`)
        continue
      }
      pending.pageStates[w.id] = found.length > 0
      if (!found.length || state.pageMatched(w.id)) continue
      add({ key: `page:${w.id}`, source: 'page', watch: w.id, line: oneLine(`Page · ${new URL(w.url).host} · now says "${found.join('", "')}"`, MAX_LINE), url: w.url })
    }
    // A page whose match could not be alerted this run (over the cap) is not marked as seen.
    for (const id of Object.keys(pending.pageStates)) {
      if (pending.pageStates[id] && !state.pageMatched(id) && !pending.keys.includes(`page:${id}`)) delete pending.pageStates[id]
    }
    return { matches, more, notes, pending }
  }

  /** The tool's answer for a task: the matches, wrapped as untrusted data. */
  async function call(taskId) {
    let out
    try {
      out = await check()
    } catch (err) {
      log.error?.('[jarvis] watcher check failed:', err?.message ?? err)
      return { isError: true, content: [{ type: 'text', text: 'Watch: the check could not be run.' }] }
    }
    if (typeof taskId === 'string' && taskId) keep(taskId, out)
    const n = out.matches.length
    const text = [
      n ? `Watch: ${n} new` : 'Watch: nothing new',
      ...out.matches.map((m) => `- ${m.line}${m.url ? ` · ${m.url}` : ''}`),
      ...(out.more ? [`(${out.more} more wait for the next run)`] : []),
      ...(out.notes.length ? ['', ...out.notes.map((x) => `Note: ${oneLine(x, 160)}`)] : []),
    ].join('\n')
    return { content: [{ type: 'text', text: wrapUntrusted(text, `${WATCH_SERVER}:${WATCH_TOOL}`) }] }
  }

  return {
    check,
    call,
    /**
     * What one task's server is made of (server.mjs builds the SDK server
     * from it). Without a task id the tool still answers but keeps nothing.
     */
    serverSpec(taskId = null) {
      return {
        name: WATCH_SERVER,
        instructions: 'check_watches checks the owner\'s watch rules and returns only what is new. It only reads; it sends nothing.',
        tools: [{
          name: WATCH_TOOL,
          description: 'Checks the owner\'s watch rules (GitHub notifications, RSS feeds, web pages) and returns the items that match and have not been alerted before. Read-only; takes no arguments. Call it once.',
          handler: async () => call(taskId),
        }],
      }
    },
    /** What a task's latest check found, if anything. */
    get(taskId) {
      return kept.get(taskId) ?? null
    },
    /**
     * The alert for a Watcher run that ended:
     *   - undefined: not a Watcher run, or it did not end well, or it never
     *     checked; the caller uses the usual alert;
     *   - null: it checked and found nothing new; nothing is raised;
     *   - the alert, naming each new match.
     * A run that ended well has what it found remembered, so a repeat is
     * never alerted again. The check is forgotten once the run has ended.
     */
    notification(task, at) {
      if (!isObject(task) || typeof task.id !== 'string') return undefined
      const out = kept.get(task.id) ?? null
      if (task.status === 'queued' || task.status === 'running') return undefined
      kept.delete(task.id)
      if (task.agentId !== WATCHER_ID || task.status !== 'done' || !out) return undefined
      try { state.commit(out.pending) } catch (err) { log.error?.('[jarvis] watcher state could not be kept:', err?.message ?? err) }
      const n = out.matches.length
      if (!n) return null
      const lines = out.matches.map((m) => `- ${m.line}`)
      if (out.more) lines.push(`(${out.more} more next time)`)
      return {
        v: 1,
        id: `agent-run-${task.id}`,
        ts: at,
        source: 'agent',
        urgency: 'normal',
        audience: ['owner'],
        privacy: 'private',
        title: `Watcher: ${n} new match${n === 1 ? '' : 'es'}`,
        body: lines.join('\n').slice(0, MAX_BODY),
      }
    },
  }
}
