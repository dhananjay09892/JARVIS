import { BRIDGE_HTTP_URL } from '../config'

/**
 * Settings → Connectors (task C03): the page's side of bridge/connectors/routes.mjs.
 * Nothing here ever holds a stored secret: the bridge only says which
 * credentials are set. A pasted token is sent once, to connect, and dropped.
 */

export type ConnectorState = 'ok' | 'attention' | 'error' | 'disconnected'
export type ConnectPattern = 'oauth' | 'token' | 'local' | 'none'
export type Capability = 'read' | 'write' | 'subscribe'
export type CredentialBackend = 'keychain' | 'dev-file' | 'memory' | 'unavailable'

export type ConnectorSetup = {
  sees: string[]
  scopes?: string[]
  steps?: string[]
  tokenLabel?: string
  helpUrl?: string
  localWhy?: string
  testQuestion?: string
}

export type ConnectorCard = {
  id: string
  name: string
  kind: 'data' | 'channel' | 'tool-provider'
  auth: string
  risk: 'R0' | 'R1' | 'R2' | 'R3'
  platforms: string[]
  capabilities: Record<Capability, boolean>
  pattern: ConnectPattern
  setup: ConnectorSetup | null
  canTest: boolean
  erasable: boolean
  grants: Record<Capability, boolean> | null
  disabled: boolean
  credentials: { backend: CredentialBackend; keys: { key: string; set: true }[] }
  tools: { name: string; capability: Capability }[]
  status: { state: ConnectorState; detail: string; lastSync?: number; code?: string }
  credentialBackend: CredentialBackend
}

export type ConnectorsList = {
  frozen: boolean
  credentialBackend: CredentialBackend
  connectors: ConnectorCard[]
  failures: { id: string; error: string }[]
}

/** What every change returns: the changed card, or a plain-language reason. */
export type ConnectorReply = {
  ok: boolean
  reason?: string
  code?: string
  frozen?: boolean
  detail?: string
  erased?: boolean
  result?: { account?: string; detail?: string; url?: string }
  connector?: ConnectorCard
}

export async function listConnectors(): Promise<ConnectorsList> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/connectors`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read the connectors.')
  return res.json()
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<ConnectorReply> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/connectors${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const data = (await res.json().catch(() => ({}))) as ConnectorReply
  if (!res.ok && data.ok !== false) return { ok: false, reason: 'That did not work.' }
  return data
}

const at = (id: string, action: string) => `/${encodeURIComponent(id)}/${action}`

export const connectConnector = (id: string, fields: Record<string, unknown>) => post(at(id, 'connect'), fields)
export const testConnector = (id: string) => post(at(id, 'test'))
export const disconnectConnector = (id: string, eraseData: boolean) => post(at(id, 'disconnect'), { eraseData })
export const eraseConnector = (id: string) => post(at(id, 'erase'), { confirm: true })
export const setConnectorEnabled = (id: string, enabled: boolean) => post(at(id, 'enabled'), { enabled })
export const setConnectorGrant = (id: string, capability: Capability, granted: boolean, confirm = false) =>
  post(at(id, 'grants'), { capability, granted, confirm })
export const setConnectorsFrozen = (frozen: boolean, confirm = false) => post('/freeze', { frozen, confirm })
