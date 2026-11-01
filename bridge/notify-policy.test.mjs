// Plan 12 building block 2 (Q33): the notification policy engine.
// "Done when": quiet hours are respected in tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBus, checkNotification } from './bus.mjs'
import {
  ACTIVITIES,
  DEFAULT_QUIET_HOURS,
  QUIET_HOURS_PATTERN,
  alertsOn,
  createNotifier,
  decide,
  inQuietHours,
  minutesUntilEnd,
  parseQuietHours,
} from './notify-policy.mjs'

const silent = { error() {} }
const tick = () => new Promise((r) => setImmediate(r))
const MIN = 60_000
// Midnight of a fixed day in "bridge local time"; the tests pass `minute`
// explicitly so they do not depend on the machine's time zone.
const DAY0 = 1_766_000_000_000 - (1_766_000_000_000 % (24 * 60 * MIN))
const at = (hh, mm = 0) => ({ now: DAY0 + (hh * 60 + mm) * MIN, minute: hh * 60 + mm })

const OWNER = { personId: 'owner', role: 'owner' }
const PARTNER = { personId: 'asha', role: 'member' }
const GUEST = { personId: 'guest', role: 'guest' }

let seq = 0
const alert = (over = {}) => ({
  v: 1, id: `n-${++seq}`, ts: DAY0, source: 'task', urgency: 'normal', audience: ['owner'],
  privacy: 'public', title: 'Build finished', body: 'All tests passed.', ...over,
})
const QH = parseQuietHours(DEFAULT_QUIET_HOURS)
const ctx = (time, over = {}) => ({ ...time, enabled: true, quietHours: QH, ...over })

test('every sample alert is a valid Notification', () => {
  assert.deepEqual(checkNotification(alert()), { ok: true })
  assert.equal(checkNotification({ ...alert(), urgency: 'loud' }).ok, false)
  assert.equal(checkNotification({ ...alert(), audience: [] }).ok, false)
})

// ---- quiet hours ---------------------------------------------------------

test('quiet hours parse, may cross midnight, and can be switched off', () => {
  assert.deepEqual(parseQuietHours('22:00-07:00'), { start: 1320, end: 420 })
  assert.deepEqual(parseQuietHours('13:30-14:15'), { start: 810, end: 855 })
  for (const v of ['off', '', '7-9', '24:00-07:00', '22:00-07:60', '10:00-10:00', undefined, 5]) {
    assert.equal(parseQuietHours(v), null, String(v))
  }
  assert.ok(QUIET_HOURS_PATTERN.test(DEFAULT_QUIET_HOURS) && QUIET_HOURS_PATTERN.test('off'))
  const night = parseQuietHours('22:00-07:00')
  assert.ok(inQuietHours(night, 22 * 60) && inQuietHours(night, 23 * 60 + 59) && inQuietHours(night, 0) && inQuietHours(night, 6 * 60 + 59))
  assert.ok(!inQuietHours(night, 7 * 60) && !inQuietHours(night, 12 * 60) && !inQuietHours(night, 21 * 60 + 59))
  const lunch = parseQuietHours('13:00-14:00')
  assert.ok(inQuietHours(lunch, 13 * 60 + 30) && !inQuietHours(lunch, 14 * 60) && !inQuietHours(lunch, 12 * 60))
  assert.equal(inQuietHours(null, 0), false)
  assert.equal(minutesUntilEnd(night, 23 * 60), 8 * 60)
  assert.equal(minutesUntilEnd(night, 6 * 60 + 30), 30)
})

test('quiet hours hold every non-urgent alert until they end', () => {
  for (const urgency of ['info', 'normal', 'important']) {
    for (const time of [at(22), at(23, 30), at(3), at(6, 59)]) {
      const d = decide(alert({ urgency }), ctx(time))
      assert.equal(d.verdict, 'hold', `${urgency} at ${time.minute}`)
      assert.equal(d.rule, 'quiet-hours')
      assert.deepEqual(d.channels, [])
      assert.equal(d.holdUntil, DAY0 + (time.minute >= 22 * 60 ? 24 * 60 + 7 * 60 : 7 * 60) * MIN)
    }
  }
})

test('urgent alerts break quiet hours; nothing else does', () => {
  const d = decide(alert({ urgency: 'urgent', title: 'Smoke alarm' }), ctx(at(3)))
  assert.equal(d.verdict, 'deliver')
  assert.deepEqual(d.channels, ['speak', 'hud'])
  assert.equal(d.rule, 'urgent')
})

test('outside quiet hours the same alerts go out', () => {
  assert.equal(decide(alert({ urgency: 'important' }), ctx(at(7))).verdict, 'deliver')
  assert.equal(decide(alert({ urgency: 'normal' }), ctx(at(21, 59))).verdict, 'deliver')
})

test('quiet hours set to off hold nothing', () => {
  const d = decide(alert({ urgency: 'important' }), ctx(at(3), { quietHours: parseQuietHours('off') }))
  assert.equal(d.verdict, 'deliver')
})

test('someone asleep holds non-urgent alerts even outside quiet hours', () => {
  assert.equal(decide(alert({ urgency: 'important' }), ctx(at(14), { activity: 'sleep' })).rule, 'asleep')
  assert.equal(decide(alert({ urgency: 'urgent' }), ctx(at(14), { activity: 'sleep' })).verdict, 'deliver')
})

// ---- urgency, presence, privacy, activity ----------------------------------

test('free and alone: important speaks, normal is a card, info waits', () => {
  const free = ctx(at(10), { presence: [OWNER], activity: 'idle' })
  assert.deepEqual(decide(alert({ urgency: 'important' }), free), {
    verdict: 'deliver', channels: ['speak', 'hud'], redact: false, rule: 'important', reason: 'Important, so it is said now.',
  })
  assert.deepEqual(decide(alert({ urgency: 'normal' }), free).channels, ['hud'])
  const info = decide(alert({ urgency: 'info' }), free)
  assert.equal(info.verdict, 'hold')
  assert.equal(info.rule, 'low-priority')
})

test('nobody it is for is here: held for when they are', () => {
  const d = decide(alert({ urgency: 'important' }), ctx(at(10), { presence: [PARTNER] }))
  assert.equal(d.verdict, 'hold')
  assert.equal(d.rule, 'away')
  assert.equal(decide(alert({ urgency: 'important' }), ctx(at(10), { presence: [] })).rule, 'away')
})

test('household alerts reach any member but not a guest', () => {
  const house = { audience: ['household'], urgency: 'important' }
  assert.equal(decide(alert(house), ctx(at(10), { presence: [PARTNER] })).verdict, 'deliver')
  assert.equal(decide(alert(house), ctx(at(10), { presence: [GUEST] })).rule, 'away')
})

test('a private alert waits while someone outside its audience is here', () => {
  const p = { privacy: 'private', urgency: 'important' }
  assert.equal(decide(alert(p), ctx(at(10), { presence: [OWNER, GUEST] })).rule, 'private-company')
  assert.equal(decide(alert(p), ctx(at(10), { presence: [OWNER, PARTNER] })).rule, 'private-company')
  const alone = decide(alert(p), ctx(at(10), { presence: [OWNER] }))
  assert.equal(alone.verdict, 'deliver')
  assert.equal(alone.redact, false)
  // A public alert does not care who else is here.
  assert.equal(decide(alert({ urgency: 'important' }), ctx(at(10), { presence: [OWNER, GUEST] })).verdict, 'deliver')
})

test('presence unknown (today): private alerts go out redacted, public ones in full', () => {
  const p = decide(alert({ privacy: 'private', urgency: 'important' }), ctx(at(10)))
  assert.equal(p.verdict, 'deliver')
  assert.equal(p.redact, true)
  assert.equal(decide(alert({ urgency: 'important' }), ctx(at(10))).redact, false)
})

test('urgent private alerts go out at once but redacted when others may hear', () => {
  const u = { privacy: 'private', urgency: 'urgent' }
  assert.equal(decide(alert(u), ctx(at(3), { presence: [OWNER, GUEST] })).redact, true)
  assert.equal(decide(alert(u), ctx(at(3))).redact, true)
  assert.equal(decide(alert(u), ctx(at(3), { presence: [OWNER] })).redact, false)
})

test('meetings, calls and focus: only important shows, silently', () => {
  for (const activity of ['meeting', 'call', 'focus']) {
    const c = ctx(at(11), { presence: [OWNER], activity })
    const imp = decide(alert({ urgency: 'important' }), c)
    assert.equal(imp.verdict, 'deliver', activity)
    assert.deepEqual(imp.channels, ['hud'])
    assert.equal(imp.rule, 'busy-silent')
    for (const urgency of ['normal', 'info']) assert.equal(decide(alert({ urgency }), c).rule, 'busy', `${activity} ${urgency}`)
    assert.deepEqual(decide(alert({ urgency: 'urgent' }), c).channels, ['speak', 'hud'])
  }
})

test('mid-conversation: never spoken over you', () => {
  const c = ctx(at(11), { activity: 'conversation' })
  for (const urgency of ['important', 'normal']) {
    const d = decide(alert({ urgency }), c)
    assert.deepEqual(d.channels, ['hud'], urgency)
    assert.equal(d.rule, 'in-conversation')
  }
  assert.equal(decide(alert({ urgency: 'info' }), c).verdict, 'hold')
})

test('alerts off, expired, and unknown activity', () => {
  assert.equal(decide(alert({ urgency: 'urgent' }), ctx(at(10), { enabled: false })).rule, 'alerts-off')
  assert.equal(decide(alert({ urgency: 'urgent', expiresAt: at(10).now }), ctx(at(10))).rule, 'expired')
  assert.equal(decide(alert({ expiresAt: at(10).now + 1 }), ctx(at(10))).verdict, 'deliver')
  assert.equal(decide(alert(), ctx(at(10), { activity: 'dancing' })).rule, 'normal')
  assert.ok(ACTIVITIES.includes('unknown'))
  assert.equal(alertsOn(undefined), true)
  assert.equal(alertsOn('1'), true)
  assert.equal(alertsOn('0'), false)
})

test('every decision says why, in a sentence', () => {
  const ctxs = [ctx(at(3)), ctx(at(10)), ctx(at(10), { presence: [] }), ctx(at(10), { activity: 'meeting' }), ctx(at(10), { enabled: false })]
  for (const c of ctxs) {
    for (const urgency of ['info', 'normal', 'important', 'urgent']) {
      for (const privacy of ['public', 'private']) {
        const d = decide(alert({ urgency, privacy }), c)
        assert.match(d.reason, /^[A-Z].+\.$/)
        assert.ok(typeof d.rule === 'string' && d.rule.length > 0)
        assert.equal(d.verdict === 'deliver', d.channels.length > 0)
      }
    }
  }
})

// ---- the notifier on the bus ------------------------------------------------

function setup(over = {}) {
  let clock = at(23)
  const bus = createBus({ now: () => clock.now, log: silent })
  const topics = []
  bus.subscribe('notification.*', (e) => topics.push([e.topic, e.payload.id]))
  const settings = { enabled: true, quiet: DEFAULT_QUIET_HOURS, ...over.settings }
  const signals = { ...over.signals }
  const n = createNotifier({
    bus,
    enabled: () => settings.enabled,
    quietHours: () => settings.quiet,
    context: () => signals,
    now: () => clock.now,
    minute: () => clock.minute,
    log: silent,
    ...over.options,
  })
  return { bus, n, topics, settings, signals, set: (t) => { clock = t } }
}

test('the notifier holds alerts in quiet hours and gives them when quiet hours end', async () => {
  const { n, topics, set } = setup()
  const got = []
  n.addChannel((alertIn, d) => got.push([alertIn.id, d.channels]))
  const a = alert({ urgency: 'important' })
  assert.ok(n.submit(a).ok)
  await tick()
  assert.equal(got.length, 0)
  assert.deepEqual(n.held().map((h) => [h.id, h.rule]), [[a.id, 'quiet-hours']])
  assert.equal(n.held()[0].holdUntil, DAY0 + (24 + 7) * 60 * MIN)

  set({ now: DAY0 + (24 + 6) * 60 * MIN, minute: 6 * 60 }) // 06:00 next day: still quiet
  assert.equal(n.tick(), 0)
  assert.equal(got.length, 0)

  set({ now: DAY0 + (24 + 7) * 60 * MIN, minute: 7 * 60 }) // 07:00: quiet hours over
  assert.equal(n.tick(), 1)
  assert.deepEqual(got, [[a.id, ['speak', 'hud']]])
  assert.equal(n.held().length, 0)
  await tick()
  assert.deepEqual(topics, [['notification.created', a.id], ['notification.delivered', a.id]])
  const s = n.stats()
  assert.equal(s.delivered, 1)
  assert.deepEqual(s.rules, { 'quiet-hours': 1, important: 1 })
})

test('an urgent alert in quiet hours is delivered at once', async () => {
  const { n, topics } = setup()
  const got = []
  n.addChannel((a) => got.push(a.id))
  const a = alert({ urgency: 'urgent', title: 'Water leak' })
  n.submit(a)
  await tick()
  assert.deepEqual(got, [a.id])
  await tick()
  assert.deepEqual(topics.map((t) => t[0]), ['notification.created', 'notification.delivered'])
})

test('a held alert that expires during quiet hours is dropped, not given late', async () => {
  const { n, topics, set } = setup()
  n.addChannel(() => assert.fail('must not be delivered'))
  const a = alert({ urgency: 'important', expiresAt: DAY0 + (24 + 1) * 60 * MIN })
  n.submit(a)
  await tick()
  set({ now: DAY0 + (24 + 7) * 60 * MIN, minute: 7 * 60 })
  assert.equal(n.tick(), 1)
  await tick()
  assert.deepEqual(topics.map((t) => t[0]), ['notification.created', 'notification.suppressed'])
  assert.equal(n.stats().rules.expired, 1)
})

test('with no delivery channel attached, deliverable alerts are kept, not lost or said', async () => {
  const { n, set } = setup()
  set(at(10))
  const a = alert({ urgency: 'important' })
  n.submit(a)
  await tick()
  assert.deepEqual(n.held().map((h) => h.rule), ['no-channel'])
  assert.equal(n.tick(), 0)
  assert.deepEqual(n.stats().decided, { deliver: 1, hold: 0, suppress: 0 }, 'ticking does not count it again')
  const got = []
  n.addChannel((x) => got.push(x.id))
  assert.equal(n.tick(), 1)
  assert.deepEqual(got, [a.id])
})

test('alerts switched off: suppressed, never delivered; live, so turning them on takes effect at once', async () => {
  const { n, topics, settings, set } = setup({ settings: { enabled: false } })
  set(at(10))
  const got = []
  n.addChannel((x) => got.push(x.id))
  n.submit(alert({ urgency: 'urgent' }))
  await tick()
  await tick()
  assert.deepEqual(got, [])
  assert.deepEqual(topics.map((t) => t[0]), ['notification.created', 'notification.suppressed'])
  settings.enabled = true
  n.submit(alert({ urgency: 'urgent' }))
  await tick()
  assert.equal(got.length, 1)
})

test('changing quiet hours applies to the next decision', async () => {
  const { n, settings, set } = setup()
  set(at(13, 30))
  settings.quiet = '13:00-14:00'
  n.submit(alert({ urgency: 'important' }))
  await tick()
  assert.equal(n.held()[0].rule, 'quiet-hours')
})

test('a channel that throws is counted and the alert is kept for another try', async () => {
  const { n, set } = setup()
  set(at(10))
  n.addChannel(() => { throw new Error('speaker unplugged') })
  n.submit(alert({ urgency: 'important' }))
  await tick()
  assert.equal(n.stats().channelErrors, 1)
  assert.equal(n.held()[0].rule, 'channel-failed')
})

test('the held list is capped; the least urgent, oldest alert goes first', async () => {
  const { n } = setup({ options: { maxHeld: 2 } })
  const info = alert({ urgency: 'info' })
  const imp1 = alert({ urgency: 'important' })
  const imp2 = alert({ urgency: 'important' })
  n.submit(imp1)
  n.submit(info)
  n.submit(imp2)
  await tick()
  assert.deepEqual(n.held().map((h) => h.id).sort(), [imp1.id, imp2.id].sort())
  assert.equal(n.stats().rules.overflow, 1)
})

test('the same alert raised again replaces the held copy', async () => {
  const { n } = setup()
  const a = alert({ urgency: 'normal' })
  n.submit(a)
  n.submit({ ...a, title: 'Build finished (again)' })
  await tick()
  assert.equal(n.held().length, 1)
  assert.equal(n.held()[0].title, 'Build finished (again)')
})

test('an invalid alert never reaches the policy', async () => {
  const { n } = setup()
  assert.equal(n.submit({ ...alert(), urgency: 'loud' }).ok, false)
  await tick()
  assert.deepEqual(n.stats().decided, { deliver: 0, hold: 0, suppress: 0 })
})

test('stats hold counts only, never a title or body', async () => {
  const { n } = setup()
  n.submit(alert({ title: 'Secret title words', body: 'secret body words' }))
  await tick()
  const s = JSON.stringify(n.stats())
  assert.ok(!s.includes('Secret title') && !s.includes('secret body'), s)
})

test('stop unsubscribes from the bus', async () => {
  const { n } = setup()
  n.stop()
  n.submit(alert())
  await tick()
  assert.equal(n.held().length, 0)
})

test('check() decides without raising: nothing counted, kept or published (Q78)', async () => {
  const { n, topics, set, settings } = setup()
  set(at(23)) // quiet hours
  assert.equal(n.check(alert()).rule, 'quiet-hours')
  set(at(9))
  assert.equal(n.check(alert()).verdict, 'deliver')
  settings.enabled = false
  assert.equal(n.check(alert()).rule, 'alerts-off')
  await tick()
  assert.deepEqual(topics, [])
  assert.equal(n.held().length, 0)
  assert.deepEqual(n.stats().decided, { deliver: 0, hold: 0, suppress: 0 })
})
