/**
 * Citation checks for research reports.
 *
 * An agent that reads the web and hands back a report (the Researcher, or an
 * owner's agent shaped like it) must say where each claim came from. The
 * report's format is set by the agent's instructions: claims carry numbered
 * markers like [1], and a "Sources" section lists each number once.
 *
 * These checks are plain text rules, with no model call. They never decide
 * anything on their own: the reviewer pass (agent-review.mjs) is handed the
 * problems found here as notes to weigh beside the run's evidence, so an
 * honest "I could not find a source for this" can still pass.
 */

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

/** Tools that read the open web. An agent with one of them and a report output must cite. */
export const WEB_READ_TOOLS = Object.freeze(['WebSearch', 'WebFetch'])

/** At most this many problems are reported, so a long report cannot flood the reviewer. */
export const MAX_CITATION_PROBLEMS = 6

/** A heading line that opens the sources list: "Sources", "## References:", "**Sources**". */
const SOURCES_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(sources|references|citations)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/im
/** One entry in the sources list: "[1] …", "- [2] …", "1. …". */
const SOURCE_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\[(\d{1,3})\]|(\d{1,3})[.)])[ \t]*(.*)$/
/** A citation marker in the body: [1], [12]. Not a Markdown link's text: "[1](…)". */
const MARKER = /\[(\d{1,3})\](?!\()/g
/** Something shaped like a link with a scheme. */
const SCHEME = /\b([a-z][a-z0-9+.-]{1,15}):(?:\/\/)?\S/i
const WEB_LINK = /\bhttps?:\/\/[^\s<>"')\]]+/i

/**
 * Does this agent's report need citations? Yes when it reads the open web and
 * its output is a report.
 *
 * @param {object | null} def a checked AgentDefinition
 */
export function needsCitations(def) {
  if (!isRecord(def) || def.output !== 'report' || !Array.isArray(def.tools)) return false
  return def.tools.some((t) => WEB_READ_TOOLS.includes(t))
}

/**
 * Read the citations in a report.
 *
 * @param {string} text
 * @returns {{ hasSection: boolean, sources: { n: number, ref: string, link: string | null }[], cited: number[] }}
 *   `cited` holds the marker numbers used before the Sources section, in order of first use.
 */
export function readCitations(text) {
  const s = typeof text === 'string' ? text : ''
  const heading = SOURCES_HEADING.exec(s)
  const body = heading ? s.slice(0, heading.index) : s
  const sources = []
  if (heading) {
    const rest = s.slice(heading.index + heading[0].length).split(/\r?\n/)
    for (const line of rest) {
      if (!line.trim()) continue
      const m = SOURCE_LINE.exec(line)
      if (!m) {
        // A new heading ends the list; other stray lines are skipped.
        if (/^[ \t]*#{1,6}[ \t]/.test(line)) break
        continue
      }
      const n = Number(m[1] ?? m[2])
      const ref = clip(m[3], 300)
      const link = WEB_LINK.exec(ref)?.[0] ?? null
      sources.push({ n, ref, link })
    }
  }
  const cited = []
  for (const m of body.matchAll(MARKER)) {
    const n = Number(m[1])
    if (!cited.includes(n)) cited.push(n)
  }
  return { hasSection: Boolean(heading), sources, cited }
}

/**
 * Problems with a report's citations, in words the reviewer and the agent can
 * act on. An empty list means none were found.
 *
 * @param {string} text the agent's report
 * @returns {string[]}
 */
export function citationProblems(text) {
  const { hasSection, sources, cited } = readCitations(text)
  const problems = []
  if (!hasSection) {
    problems.push('The report has no "Sources" section, so its claims cannot be traced to a source.')
  } else if (!sources.length) {
    problems.push('The "Sources" section lists no sources.')
  }
  if (sources.length && !cited.length) {
    problems.push('No claim in the report points to a source with a marker like [1].')
  }
  const listed = new Set(sources.map((x) => x.n))
  const missing = cited.filter((n) => !listed.has(n))
  if (missing.length) {
    problems.push(`The report cites ${missing.map((n) => `[${n}]`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the Sources list.`)
  }
  const seen = new Set()
  for (const src of sources) {
    if (seen.has(src.n)) problems.push(`Source [${src.n}] is listed more than once.`)
    seen.add(src.n)
    if (!src.ref) { problems.push(`Source [${src.n}] is empty.`); continue }
    const scheme = SCHEME.exec(src.ref)
    if (scheme && !src.link && !/^(notion|drive|obsidian|memory)$/i.test(scheme[1])) {
      problems.push(`Source [${src.n}] is not a web (http or https) link or a named note or file.`)
    }
  }
  const unused = sources.filter((x) => !cited.includes(x.n)).map((x) => `[${x.n}]`)
  if (cited.length && unused.length) {
    problems.push(`Source${unused.length === 1 ? '' : 's'} ${unused.join(', ')} ${unused.length === 1 ? 'is' : 'are'} listed but never cited.`)
  }
  return [...new Set(problems)].slice(0, MAX_CITATION_PROBLEMS)
}
