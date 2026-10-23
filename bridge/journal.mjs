/**
 * Turns real tool activity into project-journal rows.
 *
 * Rows come from what the brain reports — a `tool_call` BrainEvent and the
 * `tool_result` that answers it (brains/events.mjs) — never from what the
 * model says it did. A call
 * is written as "requested" the moment it is seen and only moves on when its
 * result arrives:
 *
 *   completed    the tool reported success
 *   verified     a recognised test/build/lint command exited 0 (the exit code
 *                is all that is known; output is not parsed)
 *   failed       the tool reported an error, or the owner did not approve
 *   interrupted  the turn or connection ended first — the outcome is UNKNOWN,
 *                and an approved command may still have run
 *
 * Only tools that change something are recorded. Reads and listings are not.
 */

const WORKSPACE = 'mcp__jarvis_workspace__'
const DEVELOPMENT = 'mcp__jarvis_development__'

/** First folder of a workspace-relative path: the repository. */
export function projectOf(path) {
  const first = String(path ?? '').split(/[\\/]/).filter(Boolean)[0]
  return first && first !== '.' && first !== '..' ? first : null
}

/** Only a single, simple statement counts: `npm test; rm x` proves nothing. */
const VERIFYING = /^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|npx\s+(?:tsc|vitest|jest|oxlint|eslint)|node\s+--test|python\s+-m\s+pytest|pytest|cargo\s+(?:test|build|check)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build)|tsc|vitest|jest|oxlint|eslint)\b/i
export function isVerifyingCommand(command) {
  const c = String(command ?? '').trim()
  return !/[;&|\n\r`]|\$\(/.test(c) && VERIFYING.test(c)
}

/** What a tool call is, or null when it is not worth a journal entry. */
export function describeCall(name, input = {}) {
  if (name === `${WORKSPACE}write_file`) {
    const project = projectOf(input.path)
    const creating = !input.expectedSha256
    return project && { kind: 'file_write', project, summary: `${creating ? 'create' : 'edit'} ${input.path}` }
  }
  if (name === `${WORKSPACE}delete_file`) {
    const project = projectOf(input.path)
    return project && { kind: 'file_delete', project, summary: `delete ${input.path}` }
  }
  if (name === `${DEVELOPMENT}run_command`) {
    const project = projectOf(input.cwd)
    return project && {
      kind: 'command', project, command: input.command,
      summary: `command in ${input.cwd}: ${String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 240)}`,
    }
  }
  if (name === `${DEVELOPMENT}push_branch`) {
    const project = projectOf(input.cwd)
    return project && { kind: 'push', project, summary: `push HEAD from ${input.cwd} to ${input.remote}/${input.branch}` }
  }
  return null
}

/** A tool_result event's output as text: the bounded detail, else the one-line summary. */
export function resultText(event) {
  if (typeof event?.detail === 'string') return event.detail
  return typeof event?.summary === 'string' ? event.summary : ''
}

/** The journal outcome for a finished call. */
export function classifyResult(call, isError, text) {
  if (isError) {
    if (/not approved/i.test(text)) {
      return { status: 'failed', detail: 'Not approved (rejected, expired, or interrupted); it did not run.' }
    }
    return { status: 'failed', detail: String(text).replace(/\s+/g, ' ').trim().slice(0, 400) }
  }
  if (call.kind === 'command' && isVerifyingCommand(call.command)) {
    return { status: 'verified', detail: 'Exited with code 0 (output not parsed).' }
  }
  if (call.kind === 'file_write') {
    try {
      const r = JSON.parse(text)
      return { status: 'completed', detail: `${r.bytes} bytes, sha256 ${String(r.sha256).slice(0, 12)}…` }
    } catch { /* fall through */ }
  }
  if (call.kind === 'command' || call.kind === 'push') return { status: 'completed', detail: 'Exited with code 0.' }
  return { status: 'completed', detail: '' }
}

/**
 * One per connection. `turn()` supplies the conversation and turn in progress
 * so rows are tied to the right place; `onProject` hears which repository a
 * turn is touching.
 */
export function createJournal(memory, { conversation, turn, onProject }) {
  const calls = new Map()
  const requested = new Set()

  const safe = (fn) => {
    try { return fn() } catch (err) { console.error('[jarvis] memory journal failed:', err.message) }
  }

  return {
    /** A `tool_call` BrainEvent: { id, name, args }. */
    toolCall(event) {
      if (!event?.id || calls.has(event.id)) return
      const call = describeCall(event.name, event.args)
      if (!call) return
      safe(() => {
        const t = turn()
        // The owner's request is journaled once per project per turn, as
        // "requested" only — what followed is in the rows beneath it.
        if (t?.userText && !requested.has(call.project)) {
          requested.add(call.project)
          memory.recordEvent({
            project: call.project, conversationId: conversation(), turnId: t.id, kind: 'request',
            summary: `owner asked: ${t.userText.replace(/\s+/g, ' ').slice(0, 300)}`, status: 'requested',
          })
        }
        call.eventId = memory.recordEvent({
          project: call.project, conversationId: conversation(), turnId: t?.id ?? null, callId: event.id,
          kind: call.kind, summary: call.summary, status: 'requested',
        })
        calls.set(event.id, call)
        onProject?.(call.project)
      })
    },
    /** A `tool_result` BrainEvent: { id, ok, summary, detail? }. */
    toolResult(event) {
      const call = calls.get(event?.id)
      if (!call || call.eventId == null) return
      calls.delete(event.id)
      safe(() => {
        const { status, detail } = classifyResult(call, event.ok !== true, resultText(event))
        memory.finishEvent(call.eventId, status, detail)
      })
    },
    /** A turn or connection ended: anything still open has an unknown outcome. */
    endTurn() {
      calls.clear()
      requested.clear()
      safe(() => {
        const id = conversation()
        if (id) memory.interruptOpenEvents(id)
      })
    },
  }
}
