// Which named agent runs a task on the Mission Board (agents phase A1).
import type { TaskView } from './bridge'

export type MissionAgent = { label: string; title: string; aria: string }

/** The board's tag for a task run by a named agent, or null for a plain task. */
export function missionAgent(task: Pick<TaskView, 'title' | 'agentName' | 'team'>): MissionAgent | null {
  // A team run is tagged with the team, not the Coordinator that runs it.
  const team = typeof task.team?.name === 'string' ? task.team.name.trim().slice(0, 60) : ''
  if (team) return { label: team.toUpperCase(), title: `Run by the ${team}`, aria: `${task.title}, by the ${team}` }
  const name = typeof task.agentName === 'string' ? task.agentName.trim().slice(0, 60) : ''
  if (!name) return null
  return { label: name.toUpperCase(), title: `Run by the ${name} agent`, aria: `${task.title}, by ${name}` }
}

export type MissionRow<T> = { task: T; nested: boolean }

/**
 * The board's order: newest first, with each task an agent started
 * (delegation) right under the task that started it, oldest child first.
 * A child whose parent is no longer on the board stands on its own.
 */
export function missionRows<T extends Pick<TaskView, 'id' | 'createdAt' | 'parentId'>>(tasks: T[]): MissionRow<T>[] {
  const ids = new Set(tasks.map((t) => t.id))
  const isChild = (t: T) => typeof t.parentId === 'string' && t.parentId !== t.id && ids.has(t.parentId)
  const children = new Map<string, T[]>()
  for (const t of tasks) {
    if (!isChild(t)) continue
    const list = children.get(t.parentId as string) ?? []
    list.push(t)
    children.set(t.parentId as string, list)
  }
  const rows: MissionRow<T>[] = []
  const top = tasks.filter((t) => !isChild(t)).sort((a, b) => b.createdAt - a.createdAt)
  for (const t of top) {
    rows.push({ task: t, nested: false })
    for (const c of (children.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)) rows.push({ task: c, nested: true })
  }
  return rows
}
