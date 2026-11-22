import { BRIDGE_HTTP_URL } from '../config'

/**
 * Settings → Channels (plan 20, Q79): what the bridge's channels service
 * (bridge/channels/service.mjs) reports, and its buttons. The bot token is
 * saved through the ordinary settings PATCH and never comes back: the bridge
 * only says whether one is set. Sender ids come back masked.
 */

export type PairingState =
  | { state: 'none' | 'expired' | 'used' }
  | { state: 'open' | 'burnt'; role: string; expiresAt: number; misses: number }
  | { state: 'confirm'; role: string; senderId: string; senderLabel: string }

export type ChannelBindingView = {
  id: string
  channel: string
  role: 'owner' | 'member' | 'child' | 'guest'
  sender: string
  senderId: string
  status: 'active' | 'revoked'
  boundAt: number
  lastSeenAt?: number
  expiresAt?: number
}

export type ChannelStats = {
  enabled: boolean
  running: string
  totals: Record<string, number>
  unauthorisedActions: number
  latencyMs: { n: number; p50: number | null; p95: number | null }
  deliverySuccess: number | null
  today: Record<string, number>
}

/** An outbound webhook target as the bridge reports it: no address path, no secret. */
export type WebhookTarget = { id: string; name: string; host: string; preApproved: boolean; secretSet: boolean }

export type ChannelsStatus = {
  ok: true
  enabled: boolean
  privateTelegram: boolean
  privateSlack?: boolean
  limits: string
  frozen: { frozen: boolean; source?: 'chat' | 'hud'; at?: number }
  channels: Record<string, {
    on: boolean
    tokenSet: boolean
    running: boolean
    health: { ok: boolean; running: boolean; lastPollAt?: number; lastError?: string; sentThisMonth?: number } | null
    /** SMS only: the monthly message limit and what has been sent this month (null when not running). */
    cap?: number
    sentThisMonth?: number | null
    pairing: PairingState
  }>
  bindings: ChannelBindingView[]
  notices: { kind: string; channel: string; at: number }[]
  stats: ChannelStats
  /** Outbound webhook targets (C103); null when the bridge is older. */
  webhook?: { targets: WebhookTarget[] } | null
}

export type ChannelReply = {
  ok: boolean
  reason?: string
  code?: string
  expiresAt?: number
  username?: string
  /** Webhook add only: the signing secret, in this one answer and nowhere else. */
  secret?: string
  target?: WebhookTarget
}

export async function getChannels(): Promise<ChannelsStatus> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/channels`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read the channels.')
  return res.json()
}

async function post(action: string, body: Record<string, unknown> = {}): Promise<ChannelReply> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/channels/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  if (!res) return { ok: false, reason: 'JARVIS is not answering.' }
  const data = (await res.json().catch(() => ({}))) as ChannelReply
  if (!res.ok && data.ok !== false) return { ok: false, reason: 'That did not work.' }
  return data
}

export const testChannel = (channel: string) => post('test', { channel })
export const startPairing = (channel: string) => post('pair', { channel })
export const confirmPairing = (channel: string) => post('pair/confirm', { channel })
export const cancelPairing = (channel: string) => post('pair/cancel', { channel })
export const revokeBinding = (id: string) => post('revoke', { id })
export const freezeAll = () => post('freeze')
export const unfreezeAll = () => post('unfreeze')

export const addWebhook = (name: string, url: string, preApproved: boolean) => post('webhook/add', { name, url, preApproved })
export const removeWebhook = (id: string) => post('webhook/remove', { id })
export const testWebhook = (id: string) => post('webhook/test', { id })
