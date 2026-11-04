// Which named agent runs a task on the Mission Board (agents phase A1).
import type { TaskView } from './bridge'

export type MissionAgent = { label: string; title: string; aria: string }

/** The board's tag for a task run by a named agent, or null for a plain task. */
export function missionAgent(task: Pick<TaskView, 'title' | 'agentName'>): MissionAgent | null {
  const name = typeof task.agentName === 'string' ? task.agentName.trim().slice(0, 60) : ''
  if (!name) return null
  return { label: name.toUpperCase(), title: `Run by the ${name} agent`, aria: `${task.title}, by ${name}` }
}
