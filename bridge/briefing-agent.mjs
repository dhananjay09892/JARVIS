/**
 * The Morning Briefing as an agent (roster #7): a scheduled named agent on
 * top of the briefing the bridge already builds (briefing.mjs), not a second
 * briefing.
 *
 *   - When: daily at the briefing time the owner set in Settings → Alerts
 *     ("Offer the briefing at", JARVIS_BRIEFING_TIME). With no time set it
 *     keeps the time in its file. With the briefing switched off it does not
 *     run. Like every scheduled agent it is off until switched on.
 *   - What: one read-only tool, `get_morning_briefing`, which returns the
 *     briefing exactly as `briefing.morning()` would build it now (weather,
 *     calendar, mail, overnight jobs and held alerts from the synced
 *     connector documents, by plain rules), in the owner's reply language and
 *     script. It uses `preview()`, so the briefing is not marked given: the
 *     owner is still offered it and can still ask for it.
 *   - The result: the tool's output is kept per task, and when a scheduled
 *     run ends the alert carries that briefing, not the model's words. So
 *     what is shown or said is the same text the existing path gives, and
 *     nothing a mail or calendar entry says can be turned into something else
 *     on the way. The alert is a normal, private one for the owner, so the
 *     notification policy decides whether and how it reaches them.
 *
 * Connector text in the briefing is untrusted. The tool hands it to the model
 * inside an <untrusted_data> envelope; the briefing itself only ever clips it.
 * Nothing here sends anything, writes memory or changes a setting.
 *
 * Like briefing.mjs this has no package imports, so it is tested alone;
 * server.mjs turns `serverSpec()` into the SDK server.
 */
import { BRIEFING_SERVER, BRIEFING_TOOL_NAMES } from './policy.mjs'
import { parseBriefingTime } from './briefing.mjs'
import { replyLanguage } from './language-profile.mjs'
import { wrapUntrusted } from './untrusted.mjs'

export { BRIEFING_SERVER, BRIEFING_TOOL_NAMES }
export const MORNING_BRIEFING_ID = 'morning-briefing'
export const BRIEFING_TOOL = BRIEFING_TOOL_NAMES[0]
export const BRIEFING_TOOL_ID = `mcp__${BRIEFING_SERVER}__${BRIEFING_TOOL}`
/** Briefings kept for runs that have not ended yet. */
export const MAX_KEPT = 20
/** The longest alert body; a full briefing is well under this. */
export const MAX_BODY = 4000

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The cron line for a briefing time: "07:30" → "30 7 * * *". null for "off"
 * or anything malformed.
 */
export function briefingCron(time) {
  const at = parseBriefingTime(time)
  return at === null ? null : `${at % 60} ${Math.floor(at / 60)} * * *`
}

/**
 * The schedule the Morning Briefing runs on: the briefing time when one is
 * set, else the time in its file; null (it does not run) when the briefing is
 * switched off. Any other agent keeps its own schedule.
 */
export function briefingSchedule(agent, { enabled = true, time = 'off' } = {}) {
  if (agent?.id !== MORNING_BRIEFING_ID) return agent?.schedule ?? null
  if (enabled === false) return null
  return briefingCron(time) ?? agent.schedule ?? null
}

/**
 * The language and script a briefing nobody asked for is said in: the
 * owner's reply language. "Mirror" has nothing to mirror, so it falls back to
 * the main language, as a turn would.
 */
export function briefingLanguage(profile) {
  const lang = replyLanguage(profile, '') ?? profile?.primary ?? 'en'
  return { lang, script: profile?.script === 'roman' ? 'roman' : 'native' }
}

/** The briefing's sections as plain text, one per line, in order. */
export function briefingText(out) {
  const sections = Array.isArray(out?.sections) ? out.sections : []
  return sections.map((s) => String(s?.say ?? '').trim()).filter(Boolean).join('\n')
}

/**
 * The briefing tool and what it handed out, per task.
 *
 * @param {object} o
 * @param {{ preview: Function }} o.briefing the bridge's briefing (briefing.mjs createBriefing)
 * @param {() => { lang: string, script: string }} [o.language] the owner's briefing language, live
 * @param {() => string | undefined} [o.locale] the clock style, when known
 */
export function createBriefingRuns({ briefing, language = () => ({ lang: 'en', script: 'native' }), locale = () => undefined, log = console } = {}) {
  /** task id → the briefing its run was given (latest call wins) */
  const kept = new Map()

  const keep = (taskId, out) => {
    kept.delete(taskId)
    kept.set(taskId, out)
    while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value)
  }

  /** The briefing now, as the existing path would build it, or `{ ok: false, reason }`. */
  function read() {
    let lang
    try {
      lang = language() ?? {}
    } catch {
      lang = {}
    }
    try {
      const out = briefing.preview({ lang: lang.lang, script: lang.script, locale: locale() })
      return isObject(out) ? out : { ok: false, reason: 'I could not put the briefing together.' }
    } catch (err) {
      log.error?.('[jarvis] morning briefing agent could not read the briefing:', err?.message ?? err)
      return { ok: false, reason: 'I could not put the briefing together.' }
    }
  }

  /** The tool's answer for a task: the briefing, wrapped as untrusted data. */
  function call(taskId) {
    const out = read()
    if (!out.ok) return { isError: true, content: [{ type: 'text', text: `Briefing: ${out.reason ?? 'not available'}` }] }
    if (typeof taskId === 'string' && taskId) keep(taskId, out)
    const text = [`Language: ${out.lang}`, briefingText(out)].join('\n')
    return { content: [{ type: 'text', text: wrapUntrusted(text, `${BRIEFING_SERVER}:${BRIEFING_TOOL}`) }] }
  }

  return {
    call,
    /**
     * What one task's server is made of (server.mjs builds the SDK server
     * from it): its name, instructions and its one tool, which takes no
     * arguments. Without a task id the tool still answers but keeps nothing.
     */
    serverSpec(taskId = null) {
      return {
        name: BRIEFING_SERVER,
        instructions: 'get_morning_briefing returns the morning briefing as JARVIS would say it now. It only reads; it sends nothing.',
        tools: [{
          name: BRIEFING_TOOL,
          description: 'The morning briefing as JARVIS would say it right now: weather, today\'s calendar, new mail, overnight jobs and held alerts, from the connectors that are set up, in the owner\'s language. Read-only. Call it once.',
          handler: async () => call(taskId),
        }],
      }
    },
    /** What a task was handed, if anything. */
    get(taskId) {
      return kept.get(taskId) ?? null
    },
    /**
     * The alert for a Morning Briefing run that ended with a briefing in
     * hand: the briefing itself. null for any other run (the caller then
     * uses the usual alert). Forgets the briefing either way once the run
     * has ended.
     */
    notification(task, at) {
      if (!isObject(task) || typeof task.id !== 'string') return null
      const out = kept.get(task.id) ?? null
      if (task.status !== 'queued' && task.status !== 'running') kept.delete(task.id)
      if (task.agentId !== MORNING_BRIEFING_ID || task.status !== 'done' || !out) return null
      const body = briefingText(out).slice(0, MAX_BODY)
      if (!body) return null
      return {
        v: 1,
        id: `agent-run-${task.id}`,
        ts: at,
        source: 'briefing',
        urgency: 'normal',
        audience: ['owner'],
        privacy: 'private',
        title: 'Your morning briefing is ready',
        body,
      }
    },
  }
}
