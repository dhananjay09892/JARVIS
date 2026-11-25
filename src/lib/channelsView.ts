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
  /** Shown as plain text instead of dots (a phone number, a web address). Still never read back. */
  plain?: boolean
}

/** An ordinary (non-secret) setting shown in the card, such as a spending cap. */
export type ChannelNumber = {
  setting: string
  label: string
  /** Value the bridge uses when the setting is unset. */
  fallback: string
  pattern: RegExp
  hint: string
}

export type ChannelCardSpec = {
  id: 'telegram' | 'slack' | 'discord' | 'sms'
  title: string
  /** Per-channel on/off switch. */
  switchSetting: string
  switchLabel: string
  secrets: ChannelSecret[]
  intro: string
  /** Switch for answers that draw on mail, calendar and files; absent = the channel never gives them. */
  privateSetting?: string
  privateLabel?: string
  /** Default of the private-answers switch when the setting is unset. */
  privateDefault?: boolean
  /** Shown instead of the private-answers switch when there is none. */
  noPrivateNote?: string
  /** Limits the owner can change, such as a monthly message cap. */
  numbers?: ChannelNumber[]
  /** "@name" for chat apps, a plain name for the SMS account. */
  testName?: (username?: string) => string
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
  {
    id: 'discord',
    title: 'Discord',
    switchSetting: 'JARVIS_DISCORD',
    switchLabel: 'Use my Discord bot',
    secrets: [{ setting: 'DISCORD_BOT_TOKEN', label: 'Bot token', placeholder: 'Bot token from the Bot page' }],
    intro:
      'Create an application and bot at discord.com/developers, copy the bot token from its Bot page, and paste it here. No public address is needed and no privileged intent is required: JARVIS only listens to direct messages. Discord can read these messages.',
    noPrivateNote: 'Over Discord JARVIS never sends answers from your mail, calendar or files, and never asks for approvals. Look in the app for those.',
    pairInstruction: (code) => `Send /pair ${code} to your bot in a direct message from your own Discord account within 10 minutes.`,
    accountNoun: 'Discord account',
  },
  {
    id: 'sms',
    title: 'SMS',
    switchSetting: 'JARVIS_SMS',
    switchLabel: 'Use my Twilio number',
    secrets: [
      { setting: 'TWILIO_ACCOUNT_SID', label: 'Account SID', placeholder: 'AC…' },
      { setting: 'TWILIO_AUTH_TOKEN', label: 'Auth token', placeholder: '32 characters' },
      { setting: 'TWILIO_PHONE_NUMBER', label: 'Twilio number', placeholder: '+15551234567', plain: true },
      { setting: 'TWILIO_WEBHOOK_URL', label: 'Webhook address', placeholder: 'https://…/inbound/sms', plain: true },
    ],
    intro:
      'Text JARVIS from your own phone through your own Twilio number. Point the number\'s incoming-message webhook at the web address below, which must end in /inbound/sms and reach this computer through a relay or tunnel you set up. SMS is not encrypted, the sender can be faked, and Twilio charges for every message.',
    noPrivateNote: 'Over SMS JARVIS never sends answers from your mail, calendar or files, and never asks for approvals. Look in the app for those.',
    numbers: [
      {
        setting: 'JARVIS_SMS_MONTHLY_CAP',
        label: 'Messages JARVIS may send per month',
        fallback: '50',
        pattern: /^[1-9]\d{0,4}$/,
        hint: 'A whole number from 1 to 99999.',
      },
    ],
    testName: (u) => (u ? `Twilio account "${u}"` : 'your Twilio account'),
    pairInstruction: (code) => `Send /pair ${code} as a text message to your Twilio number from your own phone within 10 minutes.`,
    accountNoun: 'phone number',
  },
]

export const channelCard = (id: string) => CHANNEL_CARDS.find((c) => c.id === id)

/** The private-answers switch as the status reports it. */
export function privateAnswers(spec: ChannelCardSpec, st: { privateTelegram?: boolean; privateSlack?: boolean }): boolean {
  if (!spec.privateSetting) return false
  const v = spec.id === 'slack' ? st.privateSlack : st.privateTelegram
  return typeof v === 'boolean' ? v : (spec.privateDefault ?? false)
}

/** A typed number is saved only when it is valid; null otherwise. */
export function numberPatch(n: ChannelNumber, typed: string): Record<string, string> | null {
  const v = typed.trim()
  return n.pattern.test(v) ? { [n.setting]: v } : null
}

/** "12 of 50 sent this month", or just the limit when the count is not known. */
export function usageNote(ch: { cap?: number; sentThisMonth?: number | null } | undefined): string {
  if (!ch || typeof ch.cap !== 'number') return ''
  return typeof ch.sentThisMonth === 'number'
    ? `${ch.sentThisMonth} of ${ch.cap} messages sent this month.`
    : `Limit: ${ch.cap} messages a month.`
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

export const privatePatch = (spec: ChannelCardSpec, on: boolean): Record<string, string> =>
  spec.privateSetting ? { [spec.privateSetting]: on ? '1' : '0' } : {}

export const switchPatch = (spec: ChannelCardSpec, on: boolean) => ({ [spec.switchSetting]: on ? '1' : '0' })

/** The one-line state under the intro. */
export function runningNote(
  masterOn: boolean,
  ch: { on?: boolean; tokenSet?: boolean; running?: boolean; health?: { lastError?: string } | null } | undefined,
  spec: ChannelCardSpec,
): string {
  const parts: string[] = []
  if (ch?.running) parts.push('Running.')
  else if (masterOn && ch?.on && !ch.tokenSet) parts.push(spec.secrets.length > 2 ? 'Needs every field below.' : spec.secrets.length > 1 ? 'Needs both tokens.' : 'Needs a token.')
  if (ch?.health?.lastError) parts.push(`Last problem: ${ch.health.lastError}`)
  return parts.join(' ')
}
