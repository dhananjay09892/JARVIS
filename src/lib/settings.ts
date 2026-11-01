import { BRIDGE_HTTP_URL } from '../config'
import { probeCapabilities } from './capabilities'

export type PublicSettings = {
  ELEVENLABS_API_KEY_set: boolean
  /** Whether a Claude API key is saved (ADR 001, Q42). The key itself never reaches the page. */
  ANTHROPIC_API_KEY_set: boolean
  /** 'subscription' | 'apikey' — how Claude is paid for. '' means the default (subscription). */
  JARVIS_CLAUDE_AUTH: string
  /** 'claude' | 'openai' — which brain answers (plan 25, Q54). '' means the default (claude). */
  JARVIS_BRAIN: string
  /** Whether an OpenAI API key is saved. The key itself never reaches the page. */
  OPENAI_API_KEY_set: boolean
  /** 'apikey' | 'chatgpt' — how the OpenAI brain is paid for (plan 22, Q55). '' means the default (apikey). */
  JARVIS_OPENAI_AUTH: string
  /** The OpenAI model used when JARVIS_BRAIN is 'openai'. '' means the default. */
  JARVIS_OPENAI_MODEL: string
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
  /** '1' | '0' — speak the first phrase early and warm the voice connection (plan 05). '' means on. */
  JARVIS_QUICK_START: string
  /** '1' | '0' — quick commands answered without the AI (plan 06, Q25). '' means on. */
  JARVIS_REFLEXES: string
  /** '1' | '0' — fast/deep routing (plan 06 phase 2, Q26). '' means on. */
  JARVIS_ROUTING: string
  /** The Claude model for the fast path. '' means the default. */
  JARVIS_FAST_MODEL: string
  /** 'en' | 'gu' | 'hi' — the owner's main language (plan 28, Q30). '' means the default (en). */
  JARVIS_LANG_PRIMARY: string
  /** 'none' | 'en' | 'gu' | 'hi' — a second language. '' means the default (none). */
  JARVIS_LANG_SECONDARY: string
  /** 'primary' | 'mirror' | 'en' | 'gu' | 'hi' — which language replies are in. '' means the default (primary). */
  JARVIS_REPLY_LANGUAGE: string
  /** 'native' | 'roman' — how Gujarati and Hindi replies are written. '' means the default (native). */
  JARVIS_TEXT_SCRIPT: string
  /** '1' | '0' — opt-in setup drop-off metric (plan 29, Q77). '' means the default (off). */
  JARVIS_SETUP_METRICS: string
  /** '1' | '0' — JARVIS may bring things up on his own (plan 12, Q33). '' means the default (on). */
  JARVIS_ALERTS: string
  /** 'HH:MM-HH:MM' local time, or 'off' (plan 12, Q33). '' means the default (22:00-07:00). */
  JARVIS_QUIET_HOURS: string
  /** '1' | '0' — the morning briefing answers "brief me" (plan 12, Q34). '' means the default (on). */
  JARVIS_BRIEFING: string
  /** '1' | '0' — the briefing names who new mail is from (plan 12, Q34). '' means the default (off). */
  JARVIS_BRIEFING_MAIL: string
  setupDone: string
  storage: string
  /** Restart-only settings saved but not yet in force (plan 39 phase 4). Older bridges omit it. */
  restartPending?: string[]
  /** Whether the bridge can restart itself (it was started by the launcher or `npm start`). */
  canRestart?: boolean
  /** Where API keys are kept, e.g. "Windows protected storage (DPAPI)" — plan 39 phase 3. */
  secretStorage?: string
  /** False when this computer has no secure store: keys can then only come from the environment. */
  secretStorageAvailable?: boolean
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

/**
 * What a save returns: the new settings, plus when each change takes effect —
 * now (`appliedLive`), from the next conversation (`nextConversation`), or
 * after a restart (`needsRestart`).
 */
export type SaveResult = PublicSettings & {
  appliedLive: string[]
  nextConversation: string[]
  needsRestart: string[]
  overridden: string[]
}

export type SetupStatus = {
  claudeInstalled: boolean
  claudeVersion: string
  claudeLoggedIn: boolean
  /** 'subscription' | 'apikey'. Older bridges omit it (subscription). */
  claudeAuthMode?: string
  /** Whether the chosen way in is ready: signed in, or a key saved. */
  claudeAuthenticated?: boolean
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
    nextConversation: [],
    overridden: [],
    ...data,
    needsRestart: Array.isArray(data.needsRestart) ? data.needsRestart : Object.keys(patch),
  }
}

/**
 * Ask the bridge to restart so restart-only settings take effect. It answers
 * first, then exits; the launcher starts it again and the page reconnects.
 */
export async function restartBridge(): Promise<void> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/settings/restart`, { method: 'POST' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.reason ?? 'Could not restart JARVIS.')
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

// ---- Settings → Brains: Sign in with ChatGPT (plan 22, Q55) ------------
// The bridge keeps the sign-in in the OS keychain; the page only ever sees
// whether it is signed in, the account's email and the consent answer.

/** The sign-in state, as bridge/brains/siwc.mjs `status()` reports it. Never a token. */
export type SiwcStatus = {
  signedIn: boolean
  signingIn: boolean
  planUsage: boolean
  backgroundConsent: boolean
  account: string | null
  manageUsageUrl: string
  error?: { code: string; message: string }
}

export type OpenAIAuthState = {
  ok: boolean
  /** 'apikey' | 'chatgpt' */
  mode: string
  /** False when this computer has no secure storage, so no sign-in can be kept. */
  available: boolean
  siwc: SiwcStatus | null
  privacyNotice: string[]
  manageUsageUrl: string
}

/** A refused request: `code` for the page's logic, `reason` in plain words. */
export class BrainAuthError extends Error {
  code: string
  constructor(code: string, reason: string) {
    super(reason)
    this.code = code
  }
}

async function brainCall<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20000): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BRIDGE_HTTP_URL}/brains/openai/${path}`, {
      method,
      ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new BrainAuthError('network', 'Cannot reach the JARVIS bridge. Is it running?')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new BrainAuthError(data.code ?? 'error', data.reason ?? 'That did not work.')
  return data as T
}

export const getOpenAIAuth = () => brainCall<OpenAIAuthState>('GET', 'auth')

/** Start a sign-in. The bridge opens the system browser; `url` is the fallback link. */
export const startChatGPTSignIn = () =>
  brainCall<OpenAIAuthState & { opened: boolean; url: string }>('POST', 'siwc/start', { acceptedNotice: true })

/** Wait (up to the bridge's five minutes) for the browser half to finish. */
export const finishChatGPTSignIn = () =>
  brainCall<OpenAIAuthState & { signedIn: boolean; error?: { code: string; reason: string } }>('POST', 'siwc/finish', {}, 6 * 60_000)

export const cancelChatGPTSignIn = () => brainCall<OpenAIAuthState>('POST', 'siwc/cancel', {})

export const signOutChatGPT = () =>
  brainCall<OpenAIAuthState & { revokedRemotely: boolean; detail?: string }>('POST', 'siwc/sign-out', {})

export const setChatGPTBackgroundConsent = (allow: boolean) =>
  brainCall<OpenAIAuthState>('POST', 'siwc/background', { allow })

/** The models the chosen key or plan can use (`GET /v1/models` through the bridge). */
export const getOpenAIModels = () => brainCall<{ ok: boolean; models: string[]; usingPlan: boolean }>('GET', 'models')
