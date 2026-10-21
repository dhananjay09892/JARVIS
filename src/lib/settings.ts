import { BRIDGE_HTTP_URL } from '../config'
import { probeCapabilities } from './capabilities'

export type PublicSettings = {
  ELEVENLABS_API_KEY_set: boolean
  JARVIS_MODEL: string
  JARVIS_EFFORT: string
  JARVIS_VOICE_ID: string
  JARVIS_ALLOW_WRITES: string
  setupDone: string
  storage: string
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

/** Save a patch. Re-probes speech so a new voice key works without a reload. */
export async function saveSettings(patch: Record<string, string>): Promise<PublicSettings> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.reason ?? 'Could not save settings.')
  if ('ELEVENLABS_API_KEY' in patch) await probeCapabilities()
  return data
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
