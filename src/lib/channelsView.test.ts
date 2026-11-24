// Settings → Channels (C101): the per-channel card data matches the bridge's
// settings registry and channel service, and the Slack card's pairing round
// trip works against the real service with a fake adapter. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL_CARDS,
  channelCard,
  clearPatch,
  privateAnswers,
  privatePatch,
  runningNote,
  switchPatch,
  numberPatch,
  tokenPatch,
  usageNote,
} from './channelsView.ts'
// @ts-expect-error plain JS bridge modules, no type declarations
import { CHANNEL_SWITCHES } from '../../bridge/channels/service.mjs'
// @ts-expect-error plain JS bridge modules, no type declarations
import { REGISTRY } from '../../bridge/settings-registry.mjs'

const registryIds = new Set(
  (Array.isArray(REGISTRY) ? REGISTRY : Object.values(REGISTRY ?? {})).map((s: { id: string }) => s.id),
)
const slack = channelCard('slack')!
const telegram = channelCard('telegram')!
const sms = channelCard('sms')!
const discord = channelCard('discord')!

test('every card names a channel the bridge knows and settings it registers', () => {
  assert.deepEqual(CHANNEL_CARDS.map((c) => c.id).sort(), Object.keys(CHANNEL_SWITCHES).sort())
  for (const c of CHANNEL_CARDS) {
    assert.equal(c.switchSetting, CHANNEL_SWITCHES[c.id])
    for (const id of [c.switchSetting, c.privateSetting, ...(c.numbers ?? []).map((n) => n.setting), ...c.secrets.map((s) => s.setting)].filter(Boolean) as string[]) {
      assert.ok(registryIds.has(id), `${id} is in the settings registry`)
    }
  }
})

test('Slack needs two tokens and clearing removes both', () => {
  assert.deepEqual(slack.secrets.map((s) => s.setting), ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])
  assert.deepEqual(clearPatch(slack), { SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' })
  assert.deepEqual(clearPatch(telegram), { TELEGRAM_BOT_TOKEN: '' })
})

test('a token is saved trimmed, and a blank field saves nothing', () => {
  assert.deepEqual(tokenPatch(slack.secrets[0], '  xoxb-1  '), { SLACK_BOT_TOKEN: 'xoxb-1' })
  assert.equal(tokenPatch(slack.secrets[1], '   '), null)
})

test('switch patches are 1 or 0', () => {
  assert.deepEqual(switchPatch(slack, true), { JARVIS_SLACK: '1' })
  assert.deepEqual(privatePatch(slack, false), { JARVIS_CHANNEL_PRIVATE_SLACK: '0' })
})

test('private answers default: Telegram on, Slack off, and the status wins', () => {
  assert.equal(privateAnswers(telegram, {}), true)
  assert.equal(privateAnswers(slack, {}), false)
  assert.equal(privateAnswers(slack, { privateSlack: true }), true)
  assert.equal(privateAnswers(telegram, { privateTelegram: false }), false)
})

test('the pairing text is the /pair command with the code, per app', () => {
  assert.match(slack.pairInstruction('ABC123'), /\/pair ABC123/)
  assert.match(slack.pairInstruction('ABC123'), /Slack/)
  assert.match(telegram.pairInstruction('ABC123'), /Telegram/)
})

test('the state note says what is missing and the last problem', () => {
  assert.equal(runningNote(true, { on: true, tokenSet: false, running: false }, slack), 'Needs both tokens.')
  assert.equal(runningNote(true, { on: true, tokenSet: false, running: false }, telegram), 'Needs a token.')
  assert.equal(runningNote(false, { on: true, tokenSet: false }, slack), '')
  assert.equal(runningNote(true, { running: true, health: { lastError: 'invalid_auth' } }, slack), 'Running. Last problem: invalid_auth')
  assert.equal(runningNote(true, undefined, slack), '')
})

test('SMS card: four fields, cleared together, no private-answers switch', () => {
  assert.deepEqual(sms.secrets.map((s) => s.setting), ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'TWILIO_WEBHOOK_URL'])
  assert.deepEqual(clearPatch(sms), { TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_PHONE_NUMBER: '', TWILIO_WEBHOOK_URL: '' })
  assert.deepEqual(switchPatch(sms, true), { JARVIS_SMS: '1' })
  assert.equal(sms.privateSetting, undefined)
  assert.deepEqual(privatePatch(sms, true), {}, 'nothing can turn private answers on for SMS')
  assert.equal(privateAnswers(sms, { privateTelegram: true, privateSlack: true }), false)
  assert.equal(tokenPatch(sms.secrets[0], '  '), null)
  assert.deepEqual(tokenPatch(sms.secrets[2], ' +15551234567 '), { TWILIO_PHONE_NUMBER: '+15551234567' })
  assert.match(sms.pairInstruction('ABCD2345'), /\/pair ABCD2345/)
})

test('SMS card: the cap is saved only when it is a valid whole number, and matches the registry', () => {
  const cap = sms.numbers![0]
  assert.equal(numberPatch(cap, '0'), null)
  assert.equal(numberPatch(cap, '-3'), null)
  assert.equal(numberPatch(cap, '12.5'), null)
  assert.equal(numberPatch(cap, '100000'), null)
  assert.equal(numberPatch(cap, ''), null)
  assert.deepEqual(numberPatch(cap, ' 80 '), { JARVIS_SMS_MONTHLY_CAP: '80' })
  const reg = (Array.isArray(REGISTRY) ? REGISTRY : Object.values(REGISTRY)).find((r: { id: string }) => r.id === cap.setting) as { pattern: RegExp; default: string }
  assert.equal(reg.pattern.source, cap.pattern.source)
  assert.equal(reg.default, cap.fallback)
})

test('SMS card shows the count against the cap, or just the cap when it is not running', () => {
  assert.equal(usageNote({ cap: 50, sentThisMonth: 12 }), '12 of 50 messages sent this month.')
  assert.equal(usageNote({ cap: 50, sentThisMonth: null }), 'Limit: 50 messages a month.')
  assert.equal(usageNote(undefined), '')
  assert.match(runningNote(true, { on: true, tokenSet: false }, sms), /every field/)
})

test('Discord has one token, no private-answers switch and a plain pairing line', () => {
  assert.deepEqual(clearPatch(discord), { DISCORD_BOT_TOKEN: '' })
  assert.equal(discord.privateSetting, undefined)
  assert.ok(discord.noPrivateNote)
  assert.match(discord.pairInstruction('ABC123'), /\/pair ABC123/)
  assert.equal(privateAnswers(discord, {}), false)
})
