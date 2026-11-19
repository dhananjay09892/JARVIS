/**
 * Settings → Channels (C101): what differs from one chat app to the next, as
 * data, so the card is one component for every channel. The setting ids must
 * match bridge/settings-registry.mjs; channelsView.test.ts checks they do.
 */

export type ChannelSecret = {
  /** Setting id the token is saved under (sent once, never read back). */
  setting: string
  label: string
  placeholder: string
}

export type ChannelCardSpec = {
  id: 'telegram' | 'slack'
  title: string
  /** Per-channel on/off switch. */
  switchSetting: string
  switchLabel: string
  secrets: ChannelSecret[]
  intro: string
  /** Switch for answers that draw on mail, calendar and files; absent = none. */
  privateSetting: string
  privateLabel: string
  /** Default of the private-answers switch when the setting is unset. */
  privateDefault: boolean
  /** What the owner sends from their own account, given the code. */
  pairInstruction: (code: string) => string
  accountNoun: string
}

export const CHANNEL_CARDS: readonly ChannelCardSpec[] = [
  {
    id: 'telegram',
    title: 'Telegram',
    switchSetting: 'JARVIS_TELEGRAM',
    switchLabel: 'Use my Telegram bot',
    secrets: [{ setting: 'TELEGRAM_BOT_TOKEN', label: 'Bot token', placeholder: '123456789:AA…' }],
    intro: 'Create a bot with @BotFather in Telegram and paste its token here. Bot chats are not end-to-end encrypted.',
    privateSetting: 'JARVIS_CHANNEL_PRIVATE_TELEGRAM',
    privateLabel: 'Answer me on Telegram with things from my mail, calendar and files',
    privateDefault: true,
    pairInstruction: (code) => `Send /pair ${code} to your bot from your own Telegram account within 10 minutes.`,
    accountNoun: 'Telegram account',
  },
  {
    id: 'slack',
    title: 'Slack',
    switchSetting: 'JARVIS_SLACK',
    switchLabel: 'Use my Slack app',
    secrets: [
      { setting: 'SLACK_BOT_TOKEN', label: 'Bot token', placeholder: 'xoxb-…' },
      { setting: 'SLACK_APP_TOKEN', label: 'App-level token', placeholder: 'xapp-…' },
    ],
    intro:
      'Create a Slack app in your own workspace, turn on Socket Mode, and paste its bot token and app-level token here. No public address is needed. Slack and your workspace admins can read these messages.',
    privateSetting: 'JARVIS_CHANNEL_PRIVATE_SLACK',
    privateLabel: 'Answer me on Slack with things from my mail, calendar and files',
    privateDefault: false,
    pairInstruction: (code) => `Send /pair ${code} to the app in a direct message from your own Slack account within 10 minutes.`,
    accountNoun: 'Slack account',
  },
]

export const channelCard = (id: string) => CHANNEL_CARDS.find((c) => c.id === id)

/** The private-answers switch as the status reports it. */
export function privateAnswers(spec: ChannelCardSpec, st: { privateTelegram?: boolean; privateSlack?: boolean }): boolean {
  const v = spec.id === 'slack' ? st.privateSlack : st.privateTelegram
  return typeof v === 'boolean' ? v : spec.privateDefault
}

/** A token field the owner has typed into is saved only when it is not blank. */
export function tokenPatch(secret: ChannelSecret, typed: string): Record<string, string> | null {
  const v = typed.trim()
  return v ? { [secret.setting]: v } : null
}

/** Removing a channel's credentials clears every one of its tokens. */
export function clearPatch(spec: ChannelCardSpec): Record<string, string> {
  return Object.fromEntries(spec.secrets.map((s) => [s.setting, '']))
}

export const privatePatch = (spec: ChannelCardSpec, on: boolean) => ({ [spec.privateSetting]: on ? '1' : '0' })

export const switchPatch = (spec: ChannelCardSpec, on: boolean) => ({ [spec.switchSetting]: on ? '1' : '0' })

/** The one-line state under the intro. */
export function runningNote(
  masterOn: boolean,
  ch: { on?: boolean; tokenSet?: boolean; running?: boolean; health?: { lastError?: string } | null } | undefined,
  spec: ChannelCardSpec,
): string {
  const parts: string[] = []
  if (ch?.running) parts.push('Running.')
  else if (masterOn && ch?.on && !ch.tokenSet) parts.push(spec.secrets.length > 1 ? 'Needs both tokens.' : 'Needs a token.')
  if (ch?.health?.lastError) parts.push(`Last problem: ${ch.health.lastError}`)
  return parts.join(' ')
}
