import { createSdkMcpServer, tool } from './sdk-server.mjs'
import { z } from 'zod'

const ORCHESTRATOR_TOOLS = ['spawn_task', 'list_tasks', 'task_status', 'cancel_task']
export const isTaskTool = (name) => ORCHESTRATOR_TOOLS.includes(name)

const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const brief = (t) => ({ id: t.id, title: t.title, status: t.status, percent: t.percent, note: t.note, error: t.error || undefined })

/**
 * The orchestrator's side: hand work to a background agent and ask how it is
 * going. Only the voice conversation gets this server. A sub-agent never does,
 * so there is exactly one level of delegation and no runaway fan-out.
 */
export function taskOperations(manager) {
  return {
    spawn: ({ title, goal }) => {
      const r = manager.spawn({ title, goal })
      return r.ok ? { started: true, ...brief(r.task) } : { started: false, reason: r.reason }
    },
    list: () => ({ tasks: manager.list().map(brief) }),
    status: ({ id }) => {
      const t = manager.get(id)
      return t ? { ...brief(t), steps: t.steps, result: t.result || undefined, recent: t.log.slice(-5).map((l) => l.text) } : { found: false }
    },
    cancel: ({ id }) => manager.cancel(id),
  }
}

export function taskServer(manager) {
  const ops = taskOperations(manager)
  return createSdkMcpServer({
    name: 'jarvis_tasks',
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'Tasks are background agents that work while you keep talking. Use spawn_task for anything that will take more than a few seconds ' +
      '(research, code changes, multi-step file work); it returns at once. Several can run together. Progress shows on the Mission Board, ' +
      'so do not read it out unless asked. Anything a task needs approving shows its own card, named for the task.',
    tools: [
      tool('spawn_task',
        'Start a background agent on a self-contained goal. Write the goal as a complete brief: the agent has no access to this conversation.',
        { title: z.string().min(1).max(60).describe('Short name for the board'), goal: z.string().min(1).max(4000).describe('Everything the agent needs, including paths and what done looks like') },
        async (a) => reply(ops.spawn(a))),
      tool('list_tasks', 'Every task with its status and progress.', {}, async () => reply(ops.list())),
      tool('task_status', 'Detail for one task: steps, latest activity and, when finished, the result.', { id: z.string() }, async (a) => reply(ops.status(a))),
      tool('cancel_task', 'Stop a running or queued task.', { id: z.string() }, async (a) => reply(ops.cancel(a))),
    ],
  })
}

/**
 * The sub-agent's side, bound to one task. Calling this is how it shows a plan
 * and moves along it; the board is only as accurate as these calls.
 */
export function progressServer(report, ask) {
  return createSdkMcpServer({
    name: 'jarvis_task',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool('report_progress',
        'Show progress on the Mission Board. Call it FIRST with a plan (2-8 short steps), then again as you start each step with its 1-based number and a one-line note.',
        {
          plan: z.array(z.string().max(80)).max(12).optional().describe('Step labels; send once, at the start'),
          step: z.number().int().min(1).optional().describe('1-based number of the step you are now on'),
          note: z.string().max(160).optional().describe('One line on what you are doing right now'),
        },
        async (a) => reply(report(a))),
      tool('ask_owner',
        'Ask the owner ONE short question when you cannot continue without a decision. It waits for their typed answer on the board. Do not use it for things you can reasonably decide yourself.',
        { question: z.string().min(1).max(500) },
        async ({ question }) => {
          const answer = await ask(question)
          return reply(answer === null
            ? { answered: false, note: 'No answer. Proceed on your best judgement, or stop and say what is missing.' }
            : { answered: true, answer })
        }),
    ],
  })
}
