/**
 * Slack (task C14): the README's acceptance tests and the vetting test pack
 * (auth failure, revoked token, injection fixture, rate limit, offline,
 * erase, no writes, kill switches), against a fake Slack Web API. No real
 * workspace.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slackConnector, SLACK_HOST, SLACK_SCOPES, slackText, messageToDocument, parseSlackCursor, slackError, msToTs,
} from './slack.mjs'
import { createConnectorRegistry, connectorToolName } from './registry.mjs'
import { createConnectorRoutes, syncConnectorInto } from './routes.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { connectorTestPack, createFakeFetch, captureLog, INJECTION_TEXT, ATTACKER_HOST } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

/**
 * Fixture tokens in Slack's shape; not real. Built at run time so secret
 * scanners do not mistake the fixtures for leaked tokens.
 */
const fixtureToken = (kind, tail) => [kind, '1111111111', '2222222222', tail].join('-')
const TOKEN = fixtureToken('xoxb', 'fixtureFixtureFixture00')
const WRONG = fixtureToken('xoxb', 'wrongWrongWrongWrong000')
const NOW = Date.parse('2026-10-27T12:00:00Z')
const BASE = NOW / 1000 - 5 * 86_400
/** A Slack ts n minutes after the fixture's start (five days ago). */
const ts = (n) => (BASE + n * 60).toFixed(6)
const READ_METHODS = ['auth.test', 'users.conversations', 'conversations.history', 'conversations.replies', 'users.info']

const msg = (n, text, extra = {}) => ({ type: 'message', user: 'U0ALICE', text, ts: ts(n), ...extra })
/** Slack escapes &, < and > in message text. */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function fixture() {
  return {
    channels: [
      { id: 'C0GENERAL', name: 'general', is_private: false },
      { id: 'G0SECRET', name: 'secret-project', is_private: true },
    ],
    history: {
      C0GENERAL: [
        msg(1, 'Hello team'),
        msg(2, 'Ship it on Friday, <@U0BOB>? See <https://example.com/plan|the plan>', { reply_count: 1, thread_ts: ts(2) }),
        { type: 'message', subtype: 'channel_join', user: 'U0BOB', text: '<@U0BOB> has joined the channel', ts: ts(3) },
        msg(4, 'Here is the deck', { user: 'U0BOB', files: [{ name: 'deck.pdf' }] }),
      ],
      G0SECRET: [msg(5, 'Budget is 10k &amp; rising')],
    },
    replies: { [`C0GENERAL/${ts(2)}`]: [msg(6, 'Friday works', { user: 'U0BOB', thread_ts: ts(2) })] },
    users: { U0ALICE: 'Alice', U0BOB: 'Bob' },
  }
}

/**
 * A fake slack.com Web API. Errors are HTTP 200 `{ ok: false }` like Slack's.
 * Records every call.
 */
function fakeSlack({ data = fixture(), injection, pageSize = 1000, token = TOKEN, error } = {}) {
  const seen = []
  const parent = (key) => data.history[key.split('/')[0]]?.find((m) => m.ts === key.split('/')[1])
  const respond = ({ url, init = {} }) => {
    const u = new URL(url)
    const method = u.pathname.replace(/^\/api\//, '')
    const q = Object.fromEntries(u.searchParams)
    seen.push({ method, http: init.method ?? 'GET', q, headers: init.headers ?? {} })
    if (u.hostname !== SLACK_HOST) return { status: 404, body: {} }
    if (error) return { body: { ok: false, error } }
    if ((init.headers ?? {}).Authorization !== `Bearer ${token}`) return { body: { ok: false, error: 'invalid_auth' } }
    if (method === 'auth.test') {
      return { body: { ok: true, url: 'https://fixture-team.slack.com/', team: 'Fixture Team', user: 'jarvis', team_id: 'T0FIX', user_id: 'U0JARVIS', bot_id: 'B0JARVIS' } }
    }
    if (method === 'users.conversations') {
      assert.equal(q.types, 'public_channel,private_channel')
      return { body: { ok: true, channels: data.channels, response_metadata: { next_cursor: '' } } }
    }
    if (method === 'conversations.history') {
      if (!data.channels.some((c) => c.id === q.channel)) return { body: { ok: false, error: 'not_in_channel' } }
      let list = [...(data.history[q.channel] ?? [])].sort((a, z) => Number(z.ts) - Number(a.ts))
      if (q.oldest) list = list.filter((m) => Number(m.ts) > Number(q.oldest))
      if (q.latest) list = list.filter((m) => Number(m.ts) < Number(q.latest))
      // Like Slack's, the cursor points at a message, so new arrivals do not shift it.
      const before = q.cursor ? q.cursor.slice(2) : null
      const first = list[0]?.ts
      if (before) list = list.filter((m) => Number(m.ts) < Number(before))
      const size = Math.min(Number(q.limit ?? 100), pageSize)
      const page = list.slice(0, size).map((m) => ({ ...m, text: injection && m.ts === first ? esc(injection) : m.text }))
      const more = size < list.length
      return { body: { ok: true, messages: page, has_more: more, response_metadata: { next_cursor: more ? `h:${page.at(-1).ts}` : '' } } }
    }
    if (method === 'conversations.replies') {
      const key = `${q.channel}/${q.ts}`
      const p = parent(key)
      if (!p) return { body: { ok: false, error: 'thread_not_found' } }
      const replies = (data.replies[key] ?? []).filter((m) => !q.oldest || Number(m.ts) > Number(q.oldest))
      return { body: { ok: true, messages: [p, ...replies], has_more: false } }
    }
    if (method === 'users.info') {
      const name = data.users[q.user]
      return name
        ? { body: { ok: true, user: { id: q.user, name: name.toLowerCase(), real_name: name, profile: { display_name: name } } } }
        : { body: { ok: false, error: 'user_not_found' } }
    }
    return { body: { ok: false, error: 'unknown_method' } }
  }
  return { respond, seen, data }
}

const factory = slackConnector({ minIntervalMs: 0 })

for (const [name, run] of connectorTestPack({
  factory,
  credential: { key: 'token', value: TOKEN },
  respond: ({ url, init, injection }) => fakeSlack({ injection }).respond({ url, init }),
  onlyHosts: [SLACK_HOST],
})) test(name, run)

function setup(fake = fakeSlack(), { connected = true, opts } = {}) {
  const credentials = createMemoryCredentialStore()
  if (connected) credentials.set('slack', 'token', TOKEN)
  const { fetch, calls } = createFakeFetch((url, init) => fake.respond({ url, init }))
  const { log, lines } = captureLog()
  const sleeps = []
  let clock = NOW
  const registry = createConnectorRegistry({
    credentials, fetch, log, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
  })
  assert.equal(registry.register(opts ? slackConnector({ minIntervalMs: 0, ...opts }) : factory).ok, true)
  return { registry, credentials, calls, lines, sleeps, seen: fake.seen }
}

test('slack: the card is a read-only paste-a-token connector with the smallest scopes', () => {
  const { registry } = setup(fakeSlack(), { connected: false })
  const card = registry.list().find((c) => c.id === 'slack')
  assert.equal(card.pattern, 'token')
  assert.equal(card.risk, 'R1')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual([...SLACK_SCOPES], ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'users:read'])
  const all = [...card.setup.scopes, ...card.setup.steps].join(' ')
  assert.ok(!/chat:write|im:|mpim:|:write/.test(all), 'no write or DM scope is asked for')
  assert.ok(card.setup.sees.some((l) => /invited/.test(l)), 'the "invite the bot" trap is explained')
  assert.ok(card.setup.steps.some((l) => /\/invite @JARVIS/.test(l)))
  assert.deepEqual(card.tools.map((t) => [t.name, t.capability]), [['list_channels', 'read'], ['read_recent_messages', 'read']])
  assert.equal(card.status.state, 'disconnected')
})

test('slack: connect from Settings stores the token only after auth.test works', async () => {
  const { registry, credentials, lines } = setup(fakeSlack(), { connected: false })
  const routes = createConnectorRoutes({ registry, persist: () => {}, log: { warn() {}, error() {} } })
  const call = (body) => routes.handle({ method: 'POST', path: '/connectors/slack/connect', body })

  for (const junk of ['not-a-token', fixtureToken('xoxp', 'userTokenUserToken00'), 'xapp-1-A0000-1111-abcdefabcdefabcdef']) {
    const r = await call({ token: junk })
    assert.equal(r.body.ok, false, junk)
    assert.equal(r.body.code, 'auth')
  }
  const wrong = await call({ token: WRONG })
  assert.equal(wrong.body.ok, false)
  assert.equal(wrong.body.code, 'auth', 'Slack answers 200 { ok: false, error: invalid_auth }')
  assert.deepEqual(credentials.describe('slack').keys, [], 'a refused token stores nothing')

  const ok = await call({ token: `  ${TOKEN} ` })
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body))
  assert.equal(ok.body.result.account, 'Fixture Team')
  assert.equal(credentials.get('slack', 'token'), TOKEN)
  assert.equal(ok.body.connector.status.state, 'ok')
  for (const t of [JSON.stringify(wrong.body), JSON.stringify(ok.body), ...lines]) {
    assert.ok(!t.includes(TOKEN) && !t.includes(WRONG), 'no token in replies or logs')
  }
})

test('slack: sync a fixture workspace: channels the bot is in, threads, names, links', async () => {
  const { registry, seen } = setup()
  const r = await registry.sync('slack')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const byId = new Map(r.documents.map((d) => [d.id, d]))
  assert.deepEqual([...byId.keys()].sort(), [
    `C0GENERAL-${ts(1)}`, `C0GENERAL-${ts(2)}`, `C0GENERAL-${ts(4)}`, `C0GENERAL-${ts(6)}`, `G0SECRET-${ts(5)}`,
  ].sort(), 'the join event is left out; the thread reply is in')

  const plan = byId.get(`C0GENERAL-${ts(2)}`)
  assert.equal(plan.title, '#general · Alice')
  assert.equal(plan.author, 'Alice')
  assert.equal(plan.createdAt, Number(ts(2)) * 1000)
  assert.equal(plan.updatedAt, Number(ts(2)) * 1000)
  assert.equal(plan.sensitivity, 'messages')
  assert.equal(plan.url, `https://fixture-team.slack.com/archives/C0GENERAL/p${ts(2).replace('.', '')}`)
  assert.equal(plan.untrusted, true)
  assert.ok(isWrapped(plan.text))
  assert.ok(plan.text.includes('Ship it on Friday, @Bob? See the plan (https://example.com/plan)'), plan.text)
  assert.equal(plan.meta.channel, 'general')
  assert.equal(plan.meta.replies, 1)

  const reply = byId.get(`C0GENERAL-${ts(6)}`)
  assert.equal(reply.title, '#general · Bob (thread reply)')
  assert.equal(reply.meta.thread, ts(2))
  assert.match(reply.url, new RegExp(`\\?thread_ts=${ts(2).replace('.', '\\.')}&cid=C0GENERAL$`))

  assert.ok(byId.get(`C0GENERAL-${ts(4)}`).text.includes('[file: deck.pdf (not opened)]'))
  const secret = byId.get(`G0SECRET-${ts(5)}`)
  assert.equal(secret.title, '#secret-project · Alice')
  assert.ok(secret.text.includes('Budget is 10k & rising'))

  // Read methods only, all GET, all on slack.com.
  assert.ok(seen.every((c) => READ_METHODS.includes(c.method) && c.http === 'GET'), JSON.stringify(seen.map((c) => c.method)))
  assert.ok(seen.every((c) => !('token' in c.q)), 'the token goes in the header, never in the URL')
  // Names are looked up once each.
  assert.equal(seen.filter((c) => c.method === 'users.info').length, 2)
})

test('slack: incremental sync through the store fetches only new messages and replies', async () => {
  const fake = fakeSlack()
  const { registry, seen } = setup(fake)
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.deepEqual(await syncConnectorInto(registry, store, 'slack'), { ok: true, saved: 5, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'slack'), { ok: true, saved: 0, removed: 0, skipped: 0 })
    const hist = seen.filter((c) => c.method === 'conversations.history' && c.q.channel === 'C0GENERAL').at(-1)
    assert.equal(hist.q.oldest, ts(4), 'the watermark is the newest message seen')
    // A new message, and a new reply in the old thread.
    fake.data.history.C0GENERAL.push(msg(10, 'One more thing'))
    fake.data.replies[`C0GENERAL/${ts(2)}`].push(msg(11, 'Agreed', { thread_ts: ts(2) }))
    assert.deepEqual(await syncConnectorInto(registry, store, 'slack'), { ok: true, saved: 2, removed: 0, skipped: 0 })
    assert.deepEqual(await syncConnectorInto(registry, store, 'slack'), { ok: true, saved: 0, removed: 0, skipped: 0 })
    assert.equal(store.search('agreed', { connectors: ['slack'] }).length, 1)
  } finally {
    store.close?.()
  }
})

test('slack: a burst bigger than one sync carries on next time without a gap', async () => {
  const data = fixture()
  data.history.C0GENERAL = [msg(1, 'first')]
  data.history.G0SECRET = []
  const fake = fakeSlack({ data, pageSize: 2 })
  const { registry } = setup(fake, { opts: { maxPagesPerChannel: 1 } })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    assert.equal((await syncConnectorInto(registry, store, 'slack')).saved, 1)
    for (let n = 20; n < 25; n++) data.history.C0GENERAL.push(msg(n, `burst ${n}`))
    assert.equal((await syncConnectorInto(registry, store, 'slack')).saved, 2, 'newest two first')
    data.history.C0GENERAL.push(msg(30, 'arrived mid-way'))
    assert.equal((await syncConnectorInto(registry, store, 'slack')).saved, 2, 'continues from the Slack cursor')
    assert.equal((await syncConnectorInto(registry, store, 'slack')).saved, 1, 'the last of the burst')
    assert.equal((await syncConnectorInto(registry, store, 'slack')).saved, 1, 'then the message that arrived meanwhile')
    assert.equal((await syncConnectorInto(registry, store, 'slack')).saved, 0)
    for (const n of [1, 20, 21, 22, 23, 24, 30]) assert.ok(store.get('slack', `C0GENERAL-${ts(n)}`), `message ${n} stored`)
  } finally {
    store.close?.()
  }
})

test('slack: first sync honours since and the initial cap; the cursor is ours alone', async () => {
  const data = fixture()
  data.history.C0GENERAL = [1, 2, 3, 4, 5].map((n) => msg(n * 100, `m${n}`))
  data.history.G0SECRET = []
  data.replies = {}
  const capped = setup(fakeSlack({ data }), { opts: { maxInitial: 3 } })
  const r = await capped.registry.sync('slack')
  assert.deepEqual(r.documents.map((d) => d.text.match(/m\d/)[0]).sort(), ['m3', 'm4', 'm5'], 'the newest 3')

  const since = setup(fakeSlack({ data }))
  const s = await since.registry.sync('slack', { since: Number(ts(350)) * 1000 })
  assert.deepEqual(s.documents.map((d) => d.text.match(/m\d/)[0]).sort(), ['m4', 'm5'])

  const junk = setup(fakeSlack({ data }))
  const j = await junk.registry.sync('slack', { cursor: '{"v":1,"w":5}' })
  assert.equal(j.ok, true, 'a cursor that is not ours starts over')
  assert.equal(parseSlackCursor('not json'), null)
  assert.equal(parseSlackCursor(JSON.stringify({ v: 1, ch: { 'bad id': { w: ts(1) }, C0GENERAL: { w: 'x' } } })).ch.C0GENERAL, undefined)
})

test('slack: channels are taken in turns', async () => {
  const fake = fakeSlack()
  const { registry, seen } = setup(fake, { opts: { maxChannelsPerSync: 1 } })
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    await syncConnectorInto(registry, store, 'slack')
    await syncConnectorInto(registry, store, 'slack')
    const order = seen.filter((c) => c.method === 'conversations.history').map((c) => c.q.channel)
    assert.deepEqual(order, ['C0GENERAL', 'G0SECRET'])
  } finally {
    store.close?.()
  }
})

test('slack: a channel the bot left is skipped, not fatal', async () => {
  const fake = fakeSlack()
  const { registry, seen } = setup(fake)
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  try {
    await syncConnectorInto(registry, store, 'slack')
    // Removed between listing and reading (Slack: not_in_channel).
    fake.data.channels = fake.data.channels.filter((c) => c.id !== 'G0SECRET')
    fake.data.history.C0GENERAL.push(msg(40, 'still here'))
    const r = await syncConnectorInto(registry, store, 'slack')
    assert.equal(r.ok, true)
    assert.equal(r.saved, 1)
    assert.ok(!seen.slice(-5).some((c) => c.q.channel === 'G0SECRET'), 'a left channel is not read')
  } finally {
    store.close?.()
  }
})

test('slack: not_in_channel while reading skips that channel only', async () => {
  const data = fixture()
  const fake = fakeSlack({ data })
  const respond = fake.respond
  fake.respond = (req) => (new URL(req.url).searchParams.get('channel') === 'G0SECRET' && req.url.includes('conversations.history')
    ? { body: { ok: false, error: 'not_in_channel' } }
    : respond(req))
  const { registry } = setup(fake)
  const r = await registry.sync('slack')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.ok(r.documents.every((d) => d.id.startsWith('C0GENERAL-')))
  assert.ok(r.documents.length > 0)
})

test('slack: a revoked or uninstalled token asks the owner to reconnect, no secret leaked', async () => {
  for (const error of ['token_revoked', 'account_inactive']) {
    const { registry, lines } = setup(fakeSlack({ error }))
    const r = await registry.sync('slack')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'revoked', error)
    assert.match(r.error.message, /Reconnect/)
    assert.equal(registry.status('slack').state, 'attention')
    for (const t of [JSON.stringify(r), ...lines, JSON.stringify(registry.list())]) assert.ok(!t.includes(TOKEN))
  }
  const { registry } = setup(fakeSlack({ error: 'missing_scope' }))
  assert.equal((await registry.sync('slack')).error.code, 'auth')
})

test('slack: requests are paced to about 50 a minute; ok:false ratelimited is a rate limit', async () => {
  const { registry, sleeps } = setup(fakeSlack(), { opts: { minIntervalMs: 1_200 } })
  const r = await registry.sync('slack')
  assert.equal(r.ok, true)
  assert.ok(sleeps.length > 3 && sleeps.every((ms) => ms === 1_200), JSON.stringify(sleeps))
  const limited = setup(fakeSlack({ error: 'ratelimited' }))
  assert.equal((await limited.registry.sync('slack')).error.code, 'rate-limit')
})

test('slack: injection in a message and a display name is neutralised and changes nothing', async () => {
  const data = fixture()
  data.users.U0BOB = `Bob ${INJECTION_TEXT.slice(0, 80)}`
  const fake = fakeSlack({ data, injection: INJECTION_TEXT })
  const { registry, calls } = setup(fake)
  const before = registry.grants.of('slack')
  const r = await registry.sync('slack')
  assert.equal(r.ok, true)
  const hit = r.documents.find((d) => d.text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))
  assert.ok(hit, 'Slack-escaped markup is unescaped, then neutralised by the wrapper')
  for (const d of r.documents) {
    assert.equal((d.text.match(/<\/untrusted_data>/g) ?? []).length, 1)
    assert.ok(!/<system>/i.test(d.text))
    assert.ok(!/<\/?(system|untrusted_data)/i.test(d.title))
    if (d.author) assert.ok(!/<\/?(system|untrusted_data)/i.test(d.author))
  }
  assert.deepEqual(registry.grants.of('slack'), before)
  assert.ok(calls.every((c) => new URL(c.url).hostname === SLACK_HOST && new URL(c.url).hostname !== ATTACKER_HOST))
})

test('slack: disconnect forgets the token; the next sync is not-connected', async () => {
  const erased = []
  const credentials = createMemoryCredentialStore()
  credentials.set('slack', 'token', TOKEN)
  const registry = createConnectorRegistry({ credentials, fetch: async () => { throw new Error('no network') }, log: { warn() {}, error() {} }, onErase: (id) => erased.push(id) })
  registry.register(factory)
  const r = await registry.disconnect('slack', { eraseData: true })
  assert.equal(r.ok, true)
  assert.deepEqual(erased, ['slack'])
  assert.deepEqual(credentials.describe('slack').keys, [])
  assert.equal(registry.status('slack').state, 'disconnected')
  assert.equal((await registry.sync('slack')).error.code, 'not-connected')
})

test('slack: the read tools are bounded and wrapped', async () => {
  const data = fixture()
  data.history.C0GENERAL = Array.from({ length: 30 }, (_, i) => msg(i + 1, `note ${i + 1}`))
  const { registry, seen } = setup(fakeSlack({ data }))
  const recent = connectorToolName('slack', 'read', 'read_recent_messages')
  const tool = registry.tools().find((t) => t.name.endsWith(recent))
  assert.ok(tool, 'offered once read is granted')
  assert.equal(tool.readOnly, true)
  const res = await registry.callTool(recent, { channel: '#General', limit: 50 })
  assert.equal(res.isError, undefined, JSON.stringify(res))
  const text = res.content[0].text
  assert.ok(isWrapped(text))
  assert.match(text, /note 30/)
  assert.equal(seen.at(-1).method, 'users.info')
  assert.equal(seen.filter((c) => c.method === 'conversations.history').at(-1).q.limit, '20', 'limit is capped at 20')

  const none = await registry.callTool(recent, { channel: 'random' })
  assert.match(none.content[0].text, /not in that channel/)

  const list = await registry.callTool(connectorToolName('slack', 'read', 'list_channels'), {})
  assert.match(list.content[0].text, /secret-project/)
})

test('slack: the Test button explains a bot that is in no channels', async () => {
  const data = fixture()
  data.channels = []
  const { registry } = setup(fakeSlack({ data }))
  const r = await registry.test('slack')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(r.detail ?? r.result?.detail, /\/invite @JARVIS/)
})

test('slack: mapping helpers', () => {
  const names = { U1: 'Ann' }
  assert.equal(slackText('hi <@U1> and <@U2|bo> in <#C1|ops> <!here>', (id) => names[id]), 'hi @Ann and @bo in #ops @here')
  assert.equal(slackText('<https://a.example/x>'), 'https://a.example/x')
  assert.equal(slackText('<mailto:a@b.example|a@b.example>'), 'mailto:a@b.example')
  assert.equal(slackText('<!subteam^S1|@devs> &lt;b&gt; &amp;'), '@devs <b> &')
  assert.equal(slackText('<!date^1700000000^{date}|Nov 14>'), 'Nov 14')
  const ctx = { channelId: 'C0OPS', channelName: 'ops', author: 'Ann' }
  assert.equal(messageToDocument({ type: 'message', subtype: 'channel_leave', text: 'x', ts: ts(1) }, ctx), null)
  assert.equal(messageToDocument({ type: 'message', text: '', ts: ts(1) }, ctx), null)
  assert.equal(messageToDocument({ type: 'message', text: 'x', ts: 'nope' }, ctx), null)
  const edited = messageToDocument({ type: 'message', subtype: 'bot_message', text: 'build green', ts: ts(1), edited: { ts: ts(9) } }, ctx)
  assert.equal(edited.updatedAt, Number(ts(9)) * 1000)
  assert.equal(edited.url, undefined, 'no link without the team URL')
  const att = messageToDocument({ type: 'message', text: '', ts: ts(1), attachments: [{ title: 'Alert', fallback: 'CPU high' }] }, ctx)
  assert.equal(att.text, '[attachment: Alert] CPU high')
  assert.equal(slackError('token_revoked').code, 'revoked')
  assert.equal(slackError('invalid_auth').code, 'auth')
  assert.equal(slackError('internal_error').code, 'server')
  assert.equal(slackError('channel_not_found').slack, 'channel_not_found')
  assert.equal(msToTs(1_700_000_000_123), '1700000000.123000')
})
