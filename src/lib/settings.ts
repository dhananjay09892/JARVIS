import { BRIDGE_HTTP_URL } from '../config'
import { probeCapabilities } from './capabilities'

export type PublicSettings = {
  ELEVENLABS_API_KEY_set: boolean
  JARVIS_MODEL: string
  JARVIS_EFFORT: string
  JARVIS_VOICE_ID: string
  JARVIS_ALLOW_WRITES: string
  JARVIS_TRACES: string
  JARVIS_AUDIT: string
  /** 'offline' | 'cloud' — plan 02. '' means the default (offline). */
  JARVIS_WAKE_WORD: string
  /** 'low' | 'medium' | 'high' — plan 02. '' means the default (medium). */
  JARVIS_WAKE_SENSITIVITY: string
  setupDone: string
  storage: string
}

/** One entry of the bridge's settings registry (plan 39), as GET /settings/schema serves it. */
export type SettingDef = {
  id: string
  section: string
  label: string
  help: string
  type: 'string' | 'enum' | 'boolean' | 'secret'
  options?: string[]
  pattern?: string
  default: string
  scope: 'global' | 'person' | 'device'
  risk: 'normal' | 'sensitive' | 'dangerous'
  apply: 'live' | 'restart' | 'reconnect'
  visibleIn: 'simple' | 'advanced'
  secret: boolean
}

export type SettingsSchema = {
  v: 1
  sections: { id: string; label: string }[]
  settings: SettingDef[]
}

/** What a save returns: the new settings, plus which changes are already in force. */
export type SaveResult = PublicSettings & {
  appliedLive: string[]
  needsRestart: string[]
  overridden: string[]
}

export type SetupStatus = {
  claudeInstalled: boolean
  claudeVersion: string
  claudeLoggedIn: boolean
}

export async function getSettings(): Promise<PublicSettings> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/settings`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read settings.')
  return res.json()
}

export async function getSettingsSchema(): Promise<SettingsSchema> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/settings/schema`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('Could not read the settings list.')
  return res.json()
}

/**
 * Save a validated, all-or-nothing patch. Re-probes speech so a new voice key
 * works without a reload. Older bridges without the PATCH route answer 404 or
 * 405, so fall back to POST and assume every change needs a restart.
 */
export async function saveSettings(patch: Record<string, string>): Promise<SaveResult> {
  const send = (method: 'PATCH' | 'POST') =>
    fetch(`${BRIDGE_HTTP_URL}/settings`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
  let res = await send('PATCH').catch(() => null)
  if (!res || res.status === 404 || res.status === 405) res = await send('POST')
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.reason ?? 'Could not save settings.')
  if ('ELEVENLABS_API_KEY' in patch) await probeCapabilities()
  return {
    appliedLive: [],
    overridden: [],
    ...data,
    needsRestart: Array.isArray(data.needsRestart) ? data.needsRestart : Object.keys(patch),
  }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/setup/status`, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error('Could not check your Claude sign-in.')
  return res.json()
}

export async function testElevenLabs(): Promise<{ ok: boolean; reason?: string }> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/setup/test-elevenlabs`, { method: 'POST' })
  return res.json()
}

export async function startClaudeLogin(): Promise<void> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/setup/claude-login`, { method: 'POST' })
  if (!res.ok) throw new Error('Could not open the Claude sign-in page.')
}
