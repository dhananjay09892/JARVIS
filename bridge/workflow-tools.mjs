import { createSdkMcpServer, tool } from './sdk-server.mjs'
import { z } from 'zod'
import { describeWorkflow, validateWorkflow } from './workflows.mjs'

const TOOLS = ['list_workflows', 'create_workflow', 'update_workflow', 'delete_workflow', 'run_workflow', 'workflow_runs']
export const isWorkflowTool = (name) => TOOLS.includes(name)

const step = z.object({
  type: z.enum(['read_file', 'list_files', 'run_command', 'push_branch']),
  path: z.string().optional().describe('read_file / list_files: workspace-relative path including the repository name'),
  cwd: z.string().optional().describe('run_command / push_branch: workspace-relative repository directory'),
  command: z.string().optional().describe('run_command: the exact PowerShell command'),
  remote: z.string().optional(),
  branch: z.string().optional(),
  label: z.string().optional(),
})

/**
 * What each tool does. Every change to a stored recipe goes through `approve`
 * (the per-connection browser card) with the full recipe shown, and nothing is
 * written unless it returns true. Running a workflow starts it but does not
 * skip any step's own approval.
 */
export function workflowOperations({ store, engine, approve }) {
  const find = (name) => {
    const w = store.get(name)
    if (!w) throw new Error(`No workflow named "${name}".`)
    return w
  }
  const declined = { saved: false, reason: 'The owner did not approve it.' }
  return {
    list: () => ({ workflows: store.list().map((w) => ({ name: w.name, description: w.description, scheduleTime: w.scheduleTime, enabled: w.enabled, running: engine.isActive(w.id), steps: w.steps })) }),
    async create(args) {
      const v = validateWorkflow({ ...args, scheduleTime: args.scheduleTime ?? null })
      if (!v.ok) return { saved: false, reason: v.reason }
      if (store.get(v.value.name)) return { saved: false, reason: 'A workflow with that name exists; use update_workflow.' }
      if (await approve('Create workflow', describeWorkflow(v.value)) !== true) return declined
      store.create(v.value)
      return { saved: true, name: v.value.name }
    },
    async update({ name, newName, description, scheduleTime, enabled, steps }) {
      const old = find(name)
      const v = validateWorkflow({
        name: newName ?? old.name,
        description: description ?? old.description,
        scheduleTime: scheduleTime === undefined ? old.scheduleTime : (scheduleTime === '' ? null : scheduleTime),
        enabled: enabled ?? old.enabled,
        steps: steps ?? old.steps,
      })
      if (!v.ok) return { saved: false, reason: v.reason }
      if (engine.isActive(old.id)) return { saved: false, reason: 'It is running now; try again when it finishes.' }
      const clash = store.get(v.value.name)
      if (clash && clash.id !== old.id) return { saved: false, reason: 'Another workflow already has that name.' }
      if (await approve('Change workflow', `BEFORE
${describeWorkflow(old)}

AFTER
${describeWorkflow(v.value)}`) !== true) return declined
      store.update(old.id, v.value)
      return { saved: true, name: v.value.name }
    },
    async remove({ name }) {
      const w = find(name)
      if (await approve('Delete workflow', `Delete this workflow and its run history?

${describeWorkflow(w)}`) !== true) return { deleted: false, reason: 'The owner did not approve it.' }
      return { deleted: store.remove(w.id) }
    },
    async run({ name }) {
      const r = await engine.run(find(name), 'manual')
      return r.ok ? { started: true, runId: r.runId } : { started: false, reason: r.reason }
    },
    runs: ({ name }) => ({ runs: store.runs(name ? find(name).id : undefined, 8) }),
  }
}

export function workflowServer(deps) {
  const ops = workflowOperations(deps)
  const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
  const guard = (fn) => async (args) => {
    try {
      return reply(await fn(args))
    } catch (err) {
      console.error('[jarvis] workflow tool failed:', err)
      return { isError: true, content: [{ type: 'text', text: `Workflow operation failed: ${err.message}` }] }
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_workflows',
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'Workflows are stored recipes of structured steps (read_file, list_files, run_command, push_branch), run on demand or daily at a local time. ' +
      'Creating, changing or deleting one shows the owner a card with the whole recipe; if they reject it nothing is saved. ' +
      'run_command and push_branch steps ask for approval again on every run, scheduled or not. You cannot approve, pre-approve or skip any approval, ' +
      'and a workflow never makes anything allowed. Say plainly when something is waiting for approval.',
    tools: [
      tool('list_workflows', 'List saved workflows with their schedule and steps.', {}, guard(ops.list)),
      tool('create_workflow',
        'Propose a new workflow. The owner must approve the displayed recipe before it is saved. scheduleTime is a 24-hour local time like "08:30" for a daily run, or omit for manual only.',
        { name: z.string().min(1).max(60), description: z.string().max(500).optional(), scheduleTime: z.string().optional(), steps: z.array(step).min(1).max(20) },
        guard(ops.create)),
      tool('update_workflow',
        'Propose a change to an existing workflow. Give the full replacement for anything you change (steps replaces all steps; scheduleTime "" removes the schedule). The owner must approve the before and after.',
        { name: z.string(), newName: z.string().max(60).optional(), description: z.string().max(500).optional(), scheduleTime: z.string().optional(), enabled: z.boolean().optional(), steps: z.array(step).min(1).max(20).optional() },
        guard(ops.update)),
      tool('delete_workflow', 'Propose deleting a workflow and its run history. The owner must approve.', { name: z.string() }, guard(ops.remove)),
      tool('run_workflow',
        'Start a workflow now. Returns at once; read-only steps run immediately and each run_command / push_branch step shows its own approval card and waits for the owner.',
        { name: z.string() }, guard(ops.run)),
      tool('workflow_runs', 'Recent runs and per-step outcomes, as recorded by the bridge.', { name: z.string().optional() }, guard(ops.runs)),
    ],
  })
}
