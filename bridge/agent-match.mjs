/**
 * Picking an agent for a request that does not name one.
 *
 * "Ask the researcher to…" names its agent and agent-ask.mjs handles it. When
 * the owner just says what they want ("compare three standing desks",
 * "draft a reply to the landlord"), the Coordinator can still hand it to the
 * right specialist: `matchAgent` scores each candidate on plain word rules,
 * with no model call, and returns the clear winner or nothing.
 *
 *   - The starter agents have hint patterns (STARTER_HINTS), weighted so a
 *     specific word ("inbox", "pull request") outweighs a general one
 *     ("write", "check").
 *   - Any agent, the owner's own included, also scores on words its
 *     description shares with the request, so a new agent can be found
 *     without code changes.
 *   - Only a clear winner is returned: a score of at least MIN_SCORE and
 *     ahead of the runner-up. A tie or a weak match returns no agent and the
 *     closest candidates, so the caller asks rather than guesses.
 *
 * Matching only chooses whom to ask. It grants nothing: the agent still has
 * to be on, the task manager re-checks it, and what it may do is still its
 * definition, narrowed by the runtime and decided call by call by policy.mjs.
 * Only Node built-ins are used, so this can be tested on its own.
 */

/** The lowest score that counts as a match. */
export const MIN_SCORE = 2
/** How many close candidates come back when there is no clear winner. */
export const MAX_CANDIDATES = 3
/** The most a description's shared words add to a score. */
export const DESCRIPTION_CAP = 3
const MAX_TEXT = 4000

/**
 * Hint patterns for the starter agents, by id: `[pattern, weight]`. Patterns
 * are matched against the lowercased request; `\b` keeps them to whole words.
 */
export const STARTER_HINTS = Object.freeze({
  researcher: Object.freeze([
    [/\bresearch(?:es|ing)?\b/, 3],
    [/\b(?:find|look|dig) (?:out|up|into)\b/, 2],
    [/\bcompar(?:e|es|ing|ison)\b/, 2],
    [/\b(?:sources?|citations?|cite|evidence|studies|papers?)\b/, 2],
    [/\b(?:investigate|what (?:is|are) the best|pros and cons|options for)\b/, 2],
    [/\b(?:search the web|on the web|online|reviews of)\b/, 1],
  ]),
  writer: Object.freeze([
    [/\bdraft(?:s|ing)?\b/, 3],
    [/\b(?:letter|cover letter|essay|blog post|speech|toast|bio|thank[- ]you note|announcement)\b/, 2],
    [/\b(?:email|e-mail|message|note|document|doc)\b/, 1],
    [/\b(?:write|writing|rewrite|reword|polish|proofread)\b/, 1],
    [/\bsummar(?:y|ise|ize|ies|ising|izing)\b/, 1],
  ]),
  reviewer: Object.freeze([
    [/\b(?:review|fact[- ]check|double[- ]check|sanity[- ]check|critique)\b/, 3],
    [/\b(?:verify|check (?:this|that|whether|if)|is (?:this|that) (?:right|correct|accurate))\b/, 2],
  ]),
  coder: Object.freeze([
    [/\b(?:code|coding|codebase|repo|repository|pull request|pr|commit|branch|refactor)\b/, 3],
    [/\b(?:bug|failing tests?|unit tests?|stack trace|compile|build error|lint)\b/, 3],
    [/\b(?:script|function|api|endpoint|typescript|javascript|python|react)\b/, 2],
    [/\b(?:fix|implement|debug)\b/, 1],
  ]),
  'inbox-triager': Object.freeze([
    [/\b(?:inbox|unread|triage)\b/, 3],
    [/\b(?:my|today'?s|new) (?:mail|emails|messages|chats|slack)\b/, 2],
    [/\b(?:urgent|priorit(?:y|ise|ize))\b/, 1],
  ]),
  'morning-briefing': Object.freeze([
    [/\b(?:briefing|brief me|rundown)\b/, 3],
    [/\b(?:my day|today'?s (?:agenda|schedule|plan)|what'?s on today|this morning)\b/, 2],
    [/\b(?:weather|calendar|agenda)\b/, 1],
  ]),
  'memory-curator': Object.freeze([
    [/\b(?:memories|my memory|your memory)\b/, 3],
    [/\b(?:duplicates?|stale|out of date|outdated) (?:facts?|memories|entries|notes)\b/, 2],
    [/\b(?:what (?:do|should) you remember|forget about|tidy up)\b/, 1],
  ]),
})

// Short, common words that say nothing about which agent fits.
const STOP = new Set(('a an and any are as at be but by can could do for from get have help i in into is it its me my ' +
  'need of on or our please so some that the their them then this to up us want we what when which who will with would you your ' +
  'agent agents jarvis things thing stuff make made just also about all one').split(' '))

const words = (text) => String(text ?? '').toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []

/** Content words, with a plain plural/verb ending trimmed so "desks" meets "desk". */
function stems(text) {
  const out = new Set()
  for (const w of words(text)) {
    if (w.length < 3 || STOP.has(w)) continue
    out.add(w.replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, '') || w)
  }
  return out
}

/** One candidate's score for the request, with the hints that counted. */
function scoreOne(agent, text, requestStems) {
  let score = 0
  const hits = []
  for (const [pattern, weight] of STARTER_HINTS[agent.id] ?? []) {
    const m = pattern.exec(text)
    if (m) { score += weight; hits.push(m[0]) }
  }
  // Description overlap: a point a shared word, at most DESCRIPTION_CAP, so
  // a wordy description cannot outvote two specific hints.
  let shared = 0
  for (const s of stems(`${agent.name ?? ''} ${agent.description ?? ''}`)) if (requestStems.has(s)) shared += 1
  score += Math.min(DESCRIPTION_CAP, shared)
  return { score, hits }
}

/**
 * The agent a request is for, or none.
 *
 * @param {{ id: string, name?: string, description?: string, on?: boolean }[]} entries
 *   the candidates (roster entries, or a delegate allow-list). Entries with
 *   `on: false` are never picked.
 * @param {string} request the owner's words
 * @returns {{ agent: object | null, score: number, why: string[], candidates: { id: string, name: string, score: number }[] }}
 */
export function matchAgent(entries, request) {
  const none = { agent: null, score: 0, why: [], candidates: [] }
  if (typeof request !== 'string' || !request.trim() || !Array.isArray(entries)) return none
  const text = request.toLowerCase().slice(0, MAX_TEXT)
  const requestStems = stems(text)
  const scored = entries
    .filter((a) => a && typeof a.id === 'string' && a.on !== false)
    .map((a) => ({ a, ...scoreOne(a, text, requestStems) }))
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score || String(x.a.id).localeCompare(String(y.a.id)))
  const candidates = scored.slice(0, MAX_CANDIDATES).map((s) => ({ id: s.a.id, name: s.a.name ?? s.a.id, score: s.score }))
  const [top, next] = scored
  if (!top || top.score < MIN_SCORE || (next && next.score >= top.score)) return { ...none, candidates }
  return { agent: top.a, score: top.score, why: top.hits, candidates }
}
