/**
 * Mission control by voice: find a task from the owner's words, say what is
 * being worked on, and write the brief a resumed task starts from.
 *
 * Pure functions over task snapshots (tasks.mjs). Nothing here starts, stops
 * or grants anything; task-tools.mjs calls the task manager with what these
 * find, and the policy engine decides whether those tools run at all.
 */

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

/** Words that say which kind of thing, not which one: "pause the trip planning task". */
const FILLER = new Set([
  'a', 'an', 'the', 'my', 'that', 'this', 'it', 'one', 'task', 'tasks', 'mission', 'missions', 'job', 'jobs',
  'work', 'on', 'for', 'of', 'to', 'please', 'pause', 'resume', 'cancel', 'stop', 'continue', 'carry',
])

/** A rough stem, so "planning", "plans" and "planned" all find "plan". */
function stem(word) {
  let w = word
  for (const end of ['ing', 'ed', 'es', 's']) {
    if (w.length > end.length + 2 && w.endsWith(end)) { w = w.slice(0, -end.length); break }
  }
  // "plann" → "plan", "stopp" → "stop"
  if (w.length > 3 && w.at(-1) === w.at(-2) && !'aeiou'.includes(w.at(-1))) w = w.slice(0, -1)
  return w
}

/** The words of a text that can tell one task from another, stemmed. */
export function keyWords(text) {
  return (typeof text === 'string' ? text.toLowerCase() : '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER.has(w))
    .map(stem)
}

const wordMatches = (q, t) => q === t || (q.length >= 4 && t.startsWith(q)) || (t.length >= 4 && q.startsWith(t))

/**
 * The one task the owner means, among those `accept` lets through.
 *
 * An exact id wins. Otherwise every key word said must appear in the title;
 * with none said ("pause it"), the only acceptable task is meant. Returns
 * `{ task }`, or `{ reason, candidates? }` in words the voice session can say.
 *
 * @param {object[]} tasks task snapshots
 * @param {string} query an id, or the owner's words
 * @param {{ accept?: (t: object) => boolean, kind?: string }} [o]
 */
export function findTask(tasks, query, { accept = () => true, kind = '' } = {}) {
  const q = clip(query, 200)
  const byId = tasks.find((t) => t.id === q)
  if (byId) return accept(byId) ? { task: byId } : { reason: `That task is not ${kind || 'in a state for that'}.` }
  const pool = tasks.filter(accept)
  const what = kind ? `${kind} task` : 'task'
  if (!pool.length) return { reason: `There is no ${what}.` }
  const words = keyWords(q)
  if (!words.length) {
    return pool.length === 1
      ? { task: pool[0] }
      : { reason: `Which one? There are ${pool.length} ${what}s.`, candidates: pool.slice(0, 5).map((t) => t.title) }
  }
  const hits = pool.filter((t) => {
    const title = keyWords(t.title)
    return words.every((w) => title.some((x) => wordMatches(w, x)))
  })
  if (hits.length === 1) return { task: hits[0] }
  if (hits.length > 1) return { reason: `More than one ${what} matches. Which one?`, candidates: hits.slice(0, 5).map((t) => t.title) }
  return { reason: `No ${what} matches "${clip(q, 60)}".`, candidates: pool.slice(0, 5).map((t) => t.title) }
}

const LIVE = new Set(['queued', 'running', 'waiting_approval', 'waiting_input'])
const HELD = new Set(['paused', 'blocked'])

/** "What are you working on?": live, paused and blocked tasks, newest first, one line each. */
export function workingOn(tasks) {
  const open = tasks
    .filter((t) => LIVE.has(t.status) || HELD.has(t.status))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const items = open.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    percent: t.percent,
    ...(t.agentName && { agent: t.agentName }),
    ...(t.note && { note: t.note }),
    // A blocked task's note is its handoff message; the options are there to read out.
    ...(t.status === 'blocked' && t.blocked && { options: [...t.blocked.options] }),
  }))
  const live = items.filter((t) => !HELD.has(t.status)).length
  const blocked = items.filter((t) => t.status === 'blocked').length
  const paused = items.length - live - blocked
  const parts = []
  if (live) parts.push(`${live} running`)
  if (paused) parts.push(`${paused} paused`)
  if (blocked) parts.push(`${blocked} blocked and waiting for you`)
  return { tasks: items, summary: parts.length ? parts.join(', ') : 'Nothing in progress.' }
}

/**
 * The brief a resumed task starts from: the owner's goal, then what the
 * board recorded before the pause, so the agent checks before repeating any
 * step. It never carries anything the agent held in memory; only the board.
 */
export function resumeBrief(task) {
  const steps = Array.isArray(task.steps) ? task.steps : []
  const done = steps.filter((s) => s.state === 'done').map((s) => s.label)
  const next = steps.find((s) => s.state === 'active')?.label
  const lines = [
    clip(task.goal, 3000),
    '',
    'This task was paused and is now being resumed. You are a new session and cannot see the earlier one.',
  ]
  if (steps.length) lines.push(`Plan so far: ${steps.map((s) => s.label).join('; ')}.`)
  if (done.length) lines.push(`Steps reported done: ${done.join('; ')}.`)
  if (next) lines.push(`It was on: ${next}.`)
  if (task.note) lines.push(`Last note: ${clip(task.note, 160)}.`)
  // It stopped blocked: why, and what the owner picked. The owner's words are theirs; the reason was the worker's.
  if (task.handoff?.reason) {
    lines.push(`It had stopped, blocked, because ${clip(task.handoff.reason, 300)}.`)
    lines.push(task.handoff.choice
      ? `The owner's answer: ${clip(task.handoff.choice, 500)}. Do that. It is not approval for anything else: a plan that needs approval is still shown for it.`
      : 'The owner asked you to try again.')
  }
  lines.push('Check what already exists before redoing a step, and never repeat an action that may already have happened (a message sent, a file written) without checking first.')
  return lines.join('\n').slice(0, 4000)
}
