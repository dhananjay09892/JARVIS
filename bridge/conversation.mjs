/**
 * One connection's view of persistent memory.
 *
 * The WebSocket and the Claude Agent SDK session are transient; the
 * conversation they serve is not. This binds a socket to a stored conversation
 * (resuming the one the browser names, or starting a new one), persists each
 * turn as it happens, and builds the bounded memory block that is placed ahead
 * of the owner's words.
 *
 * Replies are only ever stored as 'complete' when the brain reported a successful
 * result for a turn nobody interrupted. Everything else is stored as what it
 * was — interrupted or failed — together with the text produced so far.
 */
import { createJournal } from './journal.mjs'

const FLUSH_MS = 1500
/** If an abandoned turn never reports a result, stop waiting after this. */
const ABANDON_TTL_MS = 30_000

export function detectProject(prompt, names) {
  let best = null
  for (const name of names) {
    if (name.length < 3) continue
    const variants = new Set([name, name.replace(/[-_.]+/g, ' ')])
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i').test(prompt) && (!best || name.length > best.length)) best = name
    }
  }
  return best
}

export function createSessionMemory({ memory, requestedId, listProjects = () => [], log = console }) {
  const conversation = memory.getConversation(requestedId) ?? memory.createConversation()
  const resumed = conversation.id === requestedId

  /** Memory items already shown to this agent session, to avoid repeats. */
  const seen = new Set()
  let first = true
  let project = conversation.project || ''
  /** The turn the SDK is working on, or null. */
  let turn = null
  let abandoned = 0
  let abandonedAt = 0

  const safe = (what, fn, fallback = undefined) => {
    try { return fn() } catch (err) { log.error(`[jarvis] memory ${what} failed:`, err.message); return fallback }
  }

  const setProject = (name) => {
    if (!name || name.toLowerCase() === project.toLowerCase()) return
    project = name
    safe('project', () => memory.setConversationProject(conversation.id, name))
  }

  const journal = createJournal(memory, {
    conversation: () => conversation.id,
    turn: () => turn,
    onProject: setProject,
  })

  const flush = (force = false) => {
    if (!turn || turn.replyId == null) return
    const t = Date.now()
    if (!force && t - turn.flushedAt < FLUSH_MS) return
    turn.flushedAt = t
    safe('partial save', () => memory.updatePartial(turn.replyId, turn.text))
  }

  const finish = (status) => {
    if (!turn) return
    const done = turn
    turn = null
    safe('finish reply', () => memory.finishReply(done.replyId, status, done.text))
    journal.endTurn()
  }

  /** Ends the turn in flight as interrupted; its late output must be ignored. */
  const abandon = () => {
    if (!turn) return
    const began = turn.started
    turn.interrupted = true
    finish('interrupted')
    // The brain will still end that turn with a done; it must not close the next one.
    if (began) { abandoned += 1; abandonedAt = Date.now() }
  }

  const staleOutput = () => {
    if (abandoned > 0 && Date.now() - abandonedAt > ABANDON_TTL_MS) abandoned = 0
    return abandoned > 0
  }

  return {
    id: conversation.id,
    resumed,

    /** Sent to the browser so its transcript can be redrawn after a refresh. */
    snapshot() {
      const messages = safe('snapshot', () => memory.messages(conversation.id, 16), [])
        .filter((m) => m.status !== 'pending' && (m.text || m.role === 'user'))
      return { id: conversation.id, resumed, project: project || null, messages }
    },

    /**
     * Stores the owner's message. Returns null for a retry of a turn already
     * seen. Otherwise returns `start()`, to be called when the agent is
     * actually given the turn; it returns the text to send.
     */
    receive({ id, text, preface = '' }) {
      const stored = safe('begin turn', () => memory.beginTurn(conversation.id, id, text), { duplicate: false, replyId: null, userId: Number.MAX_SAFE_INTEGER })
      if (stored.duplicate) return null
      return {
        start() {
          // A turn that never got a result is over now, whatever the SDK says.
          abandon()
          turn = { id, userText: text, replyId: stored.replyId, text: '', started: false, flushedAt: 0, interrupted: false }
          const named = detectProject(text, safe('projects', listProjects, []))
          if (named) setProject(named)
          const context = safe('context', () => memory.buildContext({
            conversationId: conversation.id, prompt: text, project, restore: first, beforeMessageId: stored.userId, seen,
          }), { text: '' })
          first = false
          const parts = [preface, context.text].filter(Boolean)
          return parts.length ? `${parts.join('\n\n')}${context.text ? "\n\nThe owner's message:\n" : '\n\n'}${text}` : text
        },
      }
    },

    delta(text) {
      if (!turn || staleOutput()) return
      turn.text += text
      turn.started = true
      flush()
    },
    /** A `tool_call` BrainEvent. */
    toolCall(event) { if (turn && !staleOutput()) journal.toolCall(event) },
    /** A `tool_result` BrainEvent. */
    toolResult(event) { if (!staleOutput()) journal.toolResult(event) },
    /** Marks that the SDK has begun producing output for the turn. */
    noteActivity() { if (turn) turn.started = true },

    /** The brain ended a turn: its `done` BrainEvent ({ reason }). */
    done(event) {
      if (staleOutput()) { abandoned -= 1; return }
      if (!turn) return
      const reason = event?.reason
      finish(turn.interrupted || reason === 'cancelled' ? 'interrupted' : reason === 'complete' ? 'complete' : 'failed')
    },

    /** Barge-in or stop. Whatever was produced so far is kept, labelled partial. */
    interrupt: abandon,

    /** The session died with a turn in flight. */
    fail() { if (turn) finish('failed'); else journal.endTurn() },
    /** The socket closed. */
    close() {
      if (turn) finish('interrupted')
      else journal.endTurn()
      safe('pending sweep', () => memory.interruptPending(conversation.id))
    },

    // -----------------------------------------------------------------------
    // Requests from the Memory panel (over the same origin-checked socket)
    // -----------------------------------------------------------------------
    handleOp(msg) {
      const str = (v, n = 600) => (typeof v === 'string' ? v.slice(0, n) : '')
      const int = (v) => (Number.isInteger(v) ? v : null)
      switch (msg.op) {
        case 'overview': {
          return {
            current: conversation.id,
            project: project || null,
            memories: memory.listMemories({ limit: 200 }),
            conversations: memory.listConversations(50),
            projects: memory.listEventProjects(),
            stats: memory.stats(),
            storage: memory.path,
          }
        }
        case 'events': return { events: memory.listEvents(str(msg.project, 80), 100) }
        case 'add': return memory.remember({
          text: str(msg.text, 600), scope: msg.scope === 'project' ? 'project' : 'personal', project: str(msg.project, 80),
          source: 'added in the memory panel', conversationId: conversation.id,
        })
        case 'update': return int(msg.id) ? memory.updateMemory(msg.id, str(msg.text, 600)) : { ok: false, reason: 'Bad id.' }
        case 'forget': return { ok: int(msg.id) ? memory.forget(msg.id) : false }
        case 'delete_conversation': {
          if (typeof msg.id !== 'string') return { ok: false }
          const ok = memory.deleteConversation(msg.id)
          return { ok, activeDeleted: ok && msg.id === conversation.id }
        }
        case 'delete_project_events': return { ok: true, removed: memory.deleteProjectEvents(str(msg.project, 80)) }
        case 'delete_event': return { ok: int(msg.id) ? memory.deleteEvent(msg.id) : false }
        case 'wipe':
          if (msg.confirm !== 'ERASE ALL') return { ok: false, reason: 'Confirmation text did not match.' }
          memory.wipe()
          return { ok: true, activeDeleted: true }
        default: return { ok: false, reason: 'Unknown operation.' }
      }
    },

    currentProject: () => project,
  }
}
