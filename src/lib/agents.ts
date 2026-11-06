import { BRIDGE_HTTP_URL } from '../config'
import type { AgentDetail, AgentDraft, AgentReply, AgentTemplate, AgentsList } from './agentsView'

/**
 * Settings → Agents (agents phase A3): the page's side of
 * bridge/agent-routes.mjs. Types and pure helpers are in agentsView.ts.
 *
 * The page only ever sends the owner's own edits. The bridge checks every
 * write exactly as it checks a file at load, refuses anything wider than the
 * installed tools and connectors, and the policy engine still decides every
 * tool call an agent makes; nothing here grants anything.
 */

export * from './agentsView'

export async function listAgents(): Promise<AgentsList> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/agents`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read the agents.')
  return res.json()
}

export async function getAgent(id: string): Promise<AgentDetail> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/agents/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read that agent.')
  return res.json()
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<AgentReply> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/agents${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => ({}))) as AgentReply
  if (!res.ok && data.ok !== false) return { ok: false, reason: 'That did not work.' }
  return data
}

const at = (id: string, action: string) => `/${encodeURIComponent(id)}/${action}`

export const setAgentEnabled = (id: string, enabled: boolean, confirm = false) =>
  post(at(id, 'enabled'), confirm ? { enabled, confirm: true } : { enabled })
export const copyAgent = (id: string, newId: string, name?: string) =>
  post(at(id, 'copy'), name ? { id: newId, name } : { id: newId })
export const deleteAgent = (id: string) => post(at(id, 'delete'), { confirm: true })
export const updateAgentFile = (id: string, file: string) => post(at(id, 'update'), { file })
export const updateAgentDefinition = (id: string, definition: Record<string, unknown>) =>
  post(at(id, 'update'), { definition })
export const reloadAgents = () => post('/reload')


export async function listTemplates(): Promise<AgentTemplate[]> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/agents/templates`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read the templates.')
  return ((await res.json()) as { templates: AgentTemplate[] }).templates
}

export async function listDrafts(): Promise<AgentDraft[]> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/agents/drafts`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) return []
  return ((await res.json()) as { drafts: AgentDraft[] }).drafts
}

export const createAgent = (definition: Record<string, unknown>) => post('', { definition })
/** JARVIS drafts the agent; nothing is saved until the draft is approved. A draft takes a model turn. */
export async function draftAgent(description: string): Promise<AgentReply & { draft?: AgentDraft }> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/agents/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description }),
    signal: AbortSignal.timeout(180_000),
  })
  const data = (await res.json().catch(() => ({}))) as AgentReply & { draft?: AgentDraft }
  if (!res.ok && data.ok !== false) return { ok: false, reason: 'That did not work.' }
  return data
}
export const approveDraft = (draftId: string) => post(`/drafts/${encodeURIComponent(draftId)}/approve`)
export const discardDraft = (draftId: string) => post(`/drafts/${encodeURIComponent(draftId)}/discard`)
