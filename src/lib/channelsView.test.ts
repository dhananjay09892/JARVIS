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
  tokenPatch,
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

test('every card names a channel the bridge knows and settings it registers', () => {
  assert.deepEqual(CHANNEL_CARDS.map((c) => c.id).sort(), Object.keys(CHANNEL_SWITCHES).sort())
  for (const c of CHANNEL_CARDS) {
    assert.equal(c.switchSetting, CHANNEL_SWITCHES[c.id])
    for (const id of [c.switchSetting, c.privateSetting, ...c.secrets.map((s) => s.setting)]) {
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
