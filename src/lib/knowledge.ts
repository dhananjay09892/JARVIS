import { BRIDGE_HTTP_URL } from '../config'
import type { KnowledgeStats } from './knowledgeView'

export * from './knowledgeView'

/** Settings → Knowledge: the page's side of the bridge's /knowledge routes. Counts only. */

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/knowledge/stats`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read the knowledge base.')
  return res.json()
}

async function post(path: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/knowledge/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok && data.ok !== false) return { ok: false, reason: 'That did not work.' }
    return data
  } catch {
    return { ok: false, reason: 'The bridge did not answer.' }
  }
}

export const indexKnowledgeNow = () => post('index')
export const forgetKnowledgeIndex = () => post('forget')
