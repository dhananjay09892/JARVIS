import type { WebhookTarget } from './channels'

/**
 * The outbound webhook card in Settings → Channels (task C103): what the form
 * checks before it asks the bridge, and the words for a target. The bridge
 * decides for real (https only, no private addresses); this only saves a round
 * trip for the obvious mistakes and never sees a secret except the one shown
 * once after "add".
 */

export const MAX_NAME = 60

/** A problem with the add form, or null when it can be sent. */
export function webhookFormProblem(name: string, url: string): string | null {
  if (!name.trim()) return 'Give the target a name.'
  if (name.trim().length > MAX_NAME) return `Keep the name under ${MAX_NAME} characters.`
  const raw = url.trim()
  if (!raw) return 'Paste the webhook address.'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'That is not a web address.'
  }
  if (u.protocol !== 'https:') return 'The address must start with https://.'
  if (u.username || u.password) return 'Leave the user name and password out of the address.'
  return null
}

/** One line for the list: name, host and whether it asks each time. Never the path or query. */
export const targetLine = (t: WebhookTarget): string =>
  `${t.name} · ${t.host} · ${t.preApproved ? 'sends without asking' : 'asks you before each send'}${t.secretSet ? '' : ' · signing secret missing'}`

export const SECRET_NOTE =
  'Copy this signing secret now into the receiver (it checks the X-Jarvis-Signature header). It is stored in the keychain and will not be shown again.'

export const PRE_APPROVE_WARNING =
  'Turn this on only for a receiver you trust: JARVIS will post public text to it without asking each time. Private and health or finance details never go out this way.'
