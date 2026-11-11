import { createSdkMcpServer, tool } from './sdk-server.mjs'
import { z } from 'zod'
import { agentOperations, roster, taskBrief as brief } from './agent-ask.mjs'
import { DELEGATE_SERVER, MAX_WAIT_MS } from './agent-delegation.mjs'
import { findTask, workingOn } from './mission-control.mjs'
import { isActive } from './tasks.mjs'

const ORCHESTRATOR_TOOLS = [
  'spawn_task', 'list_tasks', 'task_status', 'cancel_task', 'pause_task', 'resume_task',
  'draft_agent', 'start_team', 'start_agent', 'list_agents']
export const isTaskTool = (name) => ORCHESTRATOR_TOOLS.includes(name)

const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

/**
 * The orchestrator's side: hand work to a background agent and ask how it is
 * going. Only the voice conversation gets this server. A sub-agent never does;
 * the one agent that may start others (the Coordinator) gets its own,
 * narrower delegateServer below, within agents.maxDepth.
 */
export function taskOperations(manager) {
  return {
    spawn: ({ title, goal }) => {
      const r = manager.spawn({ title, goal })
      return r.ok ? { started: true, ...brief(r.task) } : { started: false, reason: r.reason }
    },
    /** Every task; with `active_only`, what is being worked on now ("what are you working on?"). */
    list: ({ active_only: activeOnly } = {}) => (activeOnly ? workingOn(manager.list()) : { tasks: manager.list().map(brief) }),
    status: ({ id }) => {
      const t = manager.get(id) ?? (typeof id === 'string' ? findTask(manager.list(), id).task : null)
      return t ? { ...brief(t), steps: t.steps, result: t.result || undefined, recent: t.log.slice(-5).map((l) => l.text) } : { found: false }
    },
    cancel: ({ id }) => act(manager, id, { accept: (t) => isActive(t) || t.status === 'paused', kind: 'running or paused' }, (t) => manager.cancel(t.id)),
    /** "Pause the trip planning": the one live task the words name. */
    pause: ({ id }) => act(manager, id, { accept: (t) => isActive(t) && !t.parentId && !t.team, kind: 'running' }, (t) => manager.pause(t.id)),
    /** "Carry on with the trip planning": the one paused task the words name. */
    resume: ({ id }) => act(manager, id, { accept: (t) => t.status === 'paused', kind: 'paused' }, (t) => manager.resume(t.id)),
  }
}

/** Find the task the owner means (mission-control.mjs), then do `fn` to it; the answer names it. */
function act(manager, query, how, fn) {
  const found = findTask(manager.list(), typeof query === 'string' ? query : '', how)
  if (!found.task) return { ok: false, reason: found.reason, ...(found.candidates && { candidates: found.candidates }) }
  const r = fn(found.task)
  const { task: _snap, ...rest } = r
  return { ...rest, id: found.task.id, title: found.task.title }
}

/** The start_agent description, naming the agents that can be asked when the session starts. */
function startAgentText(agents) {
  const on = roster(agents).filter((a) => a.on).slice(0, 20).map((a) => `${a.name} (${a.id})`)
  return 'Start a named agent on a goal, in the background. Use it when the owner asks an agent by name: ' +
    '"ask the researcher to…", "get the writer to…", "have the coder…". Pass the agent and a complete goal, ' +
    'or pass the owner\'s own words as request and they are split for you. Words that name no agent go to the one agent that clearly fits ' +
    'them (the answer says matched); when none clearly does, the answer says so. If the answer says the agent is unknown or off, ' +
    'say so in a sentence; do not start a plain task instead.' +
    (on.length ? ` Agents that can be asked now: ${on.join(', ')}.` : ' No agents are set up yet.')
}

/**
 * The draft_agent tool's work: draft, put the approval card up, answer at
 * once. The card's answer saves (or forgets) the draft later.
 *
 * @param {ReturnType<import('./agent-drafts.mjs').createAgentDrafter> | null} drafts
 * @param {((title: string, details: string) => Promise<boolean>) | null} approve the approval hub
 */
export async function draftAgentTool(drafts, approve, { description } = {}) {
  if (!drafts || typeof approve !== 'function') return { drafted: false, reason: 'Making agents by description is not available.' }
  const { settled: _later, ...out } = await drafts.askToCreate({ description, requestedBy: 'owner' }, approve)
  return out
}

/**
 * @param {object} manager the task manager (tasks.mjs)
 * @param {{ agents?: { list?: Function, isActive: Function } | null, drafts?: object | null, approve?: Function | null }} [o]
 *   the switched agent registry, the agent drafter (agent-drafts.mjs) and the
 *   approval hub's request. Only the voice session builds this server, so
 *   only it can start, list or draft agents.
 */
export function taskServer(manager, { agents = null, drafts = null, approve = null } = {}) {
  const ops = taskOperations(manager)
  const agentOps = agentOperations(manager, agents)
  return createSdkMcpServer({
    name: 'jarvis_tasks',
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'Tasks are background agents that work while you keep talking. Use spawn_task for anything that will take more than a few seconds ' +
      '(research, code changes, multi-step file work); it returns at once. Several can run together. Progress shows on the Mission Board, ' +
      'so do not read it out unless asked. Anything a task needs approving shows its own card, named for the task. ' +
      'When the owner asks what you are working on, call list_tasks with active_only and answer in a sentence or two. ' +
      'pause_task, resume_task and cancel_task take the task\'s id or the owner\'s words for it ("the trip planning"); ' +
      'if the answer asks which one, read out the candidates and ask. A paused task keeps its progress and resumes where the board left it.',
    tools: [
      tool('spawn_task',
        'Start a background agent on a self-contained goal. Write the goal as a complete brief: the agent has no access to this conversation.',
        { title: z.string().min(1).max(60).describe('Short name for the board'), goal: z.string().min(1).max(4000).describe('Everything the agent needs, including paths and what done looks like') },
        async (a) => reply(ops.spawn(a))),
      tool('list_tasks', 'Every task with its status and progress. With active_only, only what is running or paused now, and a short summary.',
        { active_only: z.boolean().optional().describe('Only running and paused tasks: "what are you working on?"') },
        async (a) => reply(ops.list(a))),
      tool('task_status', 'Detail for one task: steps, latest activity and, when finished, the result.',
        { id: z.string().max(200).describe('The task\'s id, or words from its title') }, async (a) => reply(ops.status(a))),
      tool('cancel_task', 'Stop a running, queued or paused task for good.',
        { id: z.string().max(200).describe('The task\'s id, or words from its title') }, async (a) => reply(ops.cancel(a))),
      tool('pause_task', 'Pause a running or queued task: its session stops, its progress is kept, and it can be resumed later. "Pause the trip planning."',
        { id: z.string().max(200).describe('The task\'s id, or words from its title, e.g. "trip planning"; empty when only one task is running') },
        async (a) => reply(ops.pause(a))),
      tool('resume_task', 'Resume a paused task, including one paused by a restart. It carries on from what the board recorded.',
        { id: z.string().max(200).describe('The task\'s id, or words from its title; empty when only one task is paused') },
        async (a) => reply(ops.resume(a))),
      tool('start_agent', startAgentText(agents),
        {
          agent: z.string().max(60).optional().describe('The agent\'s id or name, e.g. researcher'),
          goal: z.string().max(4000).optional().describe('Everything the agent needs; it cannot see this conversation'),
          title: z.string().max(60).optional().describe('Short name for the board'),
          request: z.string().max(4000).optional().describe('The owner\'s own words, e.g. "ask the researcher to compare three desks"'),
        },
        async (a) => reply(agentOps.start(a))),
      tool('list_agents', 'Every named agent, what it is for, and whether it can be asked now; and the teams.', {}, async () => reply(agentOps.list())),
      tool('start_team',
        'Start a team of agents on a goal, in the background, when the owner asks for a team: "get the research team on…" ' +
        '(Researcher, Writer, then a Reviewer check) or "have the dev team…" (two Coders, then a Reviewer check). ' +
        'Pass the team and a complete goal, or the owner\'s own words as request. If the answer says the team cannot run, say why in a sentence.',
        {
          team: z.string().max(40).optional().describe('research or dev'),
          goal: z.string().max(4000).optional().describe('Everything the team needs; it cannot see this conversation'),
          title: z.string().max(60).optional().describe('Short name for the board'),
          request: z.string().max(4000).optional().describe('The owner\'s own words, e.g. "get the research team on standing desks"'),
        },
        async (a) => reply(agentOps.startTeam(a))),
      tool('draft_agent',
        'Draft a new named agent from the owner\'s description, e.g. "make me an agent that watches my GitHub notifications". ' +
        'An approval card shows what it may use; nothing is saved until the owner approves it. Use it only when the owner asks for a new agent. ' +
        'Say the answer\'s "say" line; do not read the card out.',
        { description: z.string().min(1).max(2000).describe('What the agent should do, in the owner\'s words') },
        async (a) => reply(await draftAgentTool(drafts, approve, a))),
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

/**
 * The Coordinator's side of delegation (agent-delegation.mjs), bound to one
 * run: start an agent on its list, and check on (or wait for) one it
 * started. Built only for a run the task manager hands a `delegation` handle,
 * and the task manager checks every rule again on each start; the policy
 * engine refuses these tools to every other session.
 *
 * @param {{ start: Function, check: Function, agents: () => { id: string, name: string }[] }} delegation
 */
export function delegateServer(delegation) {
  const names = delegation.agents().map((a) => `${a.name} (${a.id})`).join(', ')
  return createSdkMcpServer({
    name: DELEGATE_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool('start_agent',
        `Hand part of this task to another agent. It starts in the background and returns its id at once. You may start: ${names}. ` +
        'Write the goal as a complete brief: the agent cannot see your instructions or this conversation. It shares your budget.',
        {
          agent: z.string().min(1).max(60).describe('The agent\'s id or name, from the list'),
          goal: z.string().min(1).max(4000).describe('Everything the agent needs, and what done looks like'),
          title: z.string().max(60).optional().describe('Short name for the board'),
        },
        async (a) => {
          const r = delegation.start(a)
          return reply(r.ok ? { started: true, ...brief(r.task) } : { started: false, reason: r.reason })
        }),
      tool('check_agent',
        'The status and, once it has finished, the result of an agent you started. Pass wait_seconds to wait for it to finish (at most 120).',
        {
          id: z.string().min(1).max(40),
          wait_seconds: z.number().int().min(0).max(MAX_WAIT_MS / 1000).optional(),
        },
        async ({ id, wait_seconds: wait }) => {
          const r = await delegation.check({ id, wait: (wait ?? 0) * 1000 })
          return reply(r.ok ? r.task : { found: false, reason: r.reason })
        }),
    ],
  })
}
