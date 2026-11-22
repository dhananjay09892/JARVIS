// Task C103: the webhook sender wired into the bridge: target list, secret
// shown once, approvals, freeze, audit, the send_webhook tool and its policy.
// A memory vault and a fake transport; no network, account or real secret.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVault, memoryBackend } from '../secrets.mjs'
import { normaliseEntry } from '../audit.mjs'
import { createToolGate, createPolicy, mcpToolOf } from '../policy.mjs'
import { createTaintTracker, guardOutbound } from '../taint.mjs'
import { isVetoed } from '../policy.mjs'
import { createChannelService } from './service.mjs'
import { createKillSwitch } from './kill-switch.mjs'
import { createWebhookService, openTargetStore, WEBHOOK_SERVER, WEBHOOK_SEND_TOOL, MAX_TARGETS, TEST_TEXT } from './webhook-service.mjs'
import { SIGNATURE_HEADER, secretNameFor, verifySignature } from './webhook.mjs'

const quiet = { log() {}, warn() {}, error() {} }
const URL1 = 'https://hooks.example.test/jarvis/abc?token=zzz-private'

function setup({ approve = async () => true, frozen = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-webhook-'))
  const file = join(dir, 'webhooks.json')
  const vault = createVault(memoryBackend())
  const state = { frozen }
  const posts = []
  const audits = []
  const approvals = []
  const store = openTargetStore({ file })
  const svc = createWebhookService({
    store,
    vault,
    requestApproval: async (title, details) => (approvals.push({ title, details }), approve(title, details)),
    isFrozen: () => state.frozen,
    audit: (e) => audits.push(e),
    senderDeps: { post: async (url, headers, body) => (posts.push({ url, headers, body }), { status: 200 }), sleep: async () => {}, log: quiet },
    log: quiet,
  })
  return { svc, store, vault, state, posts, audits, approvals, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const post = (svc, action, body) => svc.handle({ method: 'POST', path: `/channels/webhook/${action}`, body })

test('add: the secret is shown once, kept in the keychain, and never in the file or the list', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  const r = await post(s.svc, 'add', { name: 'My n8n', url: URL1 })
  assert.equal(r.status, 200)
  assert.equal(r.body.target.id, 'my-n8n')
  assert.match(r.body.secret, /^[0-9a-f]{64}$/)
  assert.equal(s.vault.get(secretNameFor('my-n8n')), r.body.secret)
  assert.ok(!readFileSync(s.file, 'utf8').includes(r.body.secret))
  if (process.platform !== 'win32') assert.equal(statSync(s.file).mode & 0o777, 0o600)
  const list = await s.svc.handle({ method: 'GET', path: '/channels/webhook/targets' })
  const text = JSON.stringify(list.body)
  assert.ok(!text.includes(r.body.secret) && !text.includes('zzz-private') && !text.includes('/jarvis/abc'))
  assert.deepEqual(list.body.targets, [{ id: 'my-n8n', name: 'My n8n', host: 'hooks.example.test', preApproved: false, secretSet: true }])
})

test('add refuses http, private addresses, userinfo and a missing name; pre-approve is off unless asked', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  for (const url of ['http://hooks.example.test/x', 'https://127.0.0.1/x', 'https://user:pw@hooks.example.test/x', 'https://localhost/x', 'not a url']) {
    const r = await post(s.svc, 'add', { name: 'x', url })
    assert.equal(r.status, 400, url)
    assert.equal(r.body.ok, false)
  }
  assert.equal((await post(s.svc, 'add', { name: '  ', url: URL1 })).status, 400)
  assert.deepEqual(s.store.list(), [])
  assert.deepEqual(s.vault.names?.() ?? [], [])
  const r = await post(s.svc, 'add', { name: 'a', url: URL1, preApproved: 'yes' })
  assert.equal(r.body.target.preApproved, false)
})

test('add: a duplicate name gets its own id and secret; the list is capped', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  const a = await post(s.svc, 'add', { name: 'Home', url: URL1 })
  const b = await post(s.svc, 'add', { name: 'Home', url: URL1 })
  assert.deepEqual([a.body.target.id, b.body.target.id], ['home', 'home-2'])
  assert.notEqual(a.body.secret, b.body.secret)
  for (let i = 0; i < MAX_TARGETS - 2; i++) assert.equal((await post(s.svc, 'add', { name: `t${i}`, url: URL1 })).status, 200)
  assert.equal((await post(s.svc, 'add', { name: 'one-more', url: URL1 })).status, 400)
})

test('add without a keychain adds nothing; a failing keychain write rolls the target back', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  const noVault = createWebhookService({ store: s.store, vault: createVault(null), log: quiet })
  assert.equal((await post(noVault, 'add', { name: 'x', url: URL1 })).status, 409)
  const broken = createWebhookService({ store: s.store, vault: { get: () => null, set() { throw new Error('boom') }, delete() {} }, log: quiet })
  const r = await post(broken, 'add', { name: 'x', url: URL1 })
  assert.equal(r.status, 500)
  assert.deepEqual(s.store.list(), [])
})

test('remove deletes the target and its secret; an unknown id is a 404', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  await post(s.svc, 'add', { name: 'n8n', url: URL1 })
  assert.equal((await post(s.svc, 'remove', { id: 'nope' })).status, 404)
  assert.equal((await post(s.svc, 'remove', { id: 'n8n' })).status, 200)
  assert.deepEqual(s.store.list(), [])
  assert.equal(s.vault.get(secretNameFor('n8n')), null)
  assert.equal((await post(s.svc, 'test', { id: 'n8n' })).status, 404)
})

test('test button: asks for approval, sends a signed public message, and the receiver can verify it', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  const { body } = await post(s.svc, 'add', { name: 'n8n', url: URL1 })
  const r = await post(s.svc, 'test', { id: 'n8n' })
  assert.deepEqual([r.status, r.body.ok], [200, true])
  assert.equal(s.approvals.length, 1)
  assert.match(s.approvals[0].details, /hooks\.example\.test/)
  assert.ok(!s.approvals[0].details.includes('zzz-private'))
  assert.equal(JSON.parse(s.posts[0].body).text, TEST_TEXT)
  assert.ok(verifySignature(body.secret, s.posts[0].headers[SIGNATURE_HEADER], s.posts[0].body))
})

test('a declined approval sends nothing; a pre-approved target skips the card', async (t) => {
  const no = setup({ approve: async () => false })
  t.after(no.cleanup)
  await post(no.svc, 'add', { name: 'n8n', url: URL1 })
  const r = await post(no.svc, 'test', { id: 'n8n' })
  assert.deepEqual([r.status, r.body.ok], [502, false])
  assert.equal(no.posts.length, 0)

  const pre = setup()
  t.after(pre.cleanup)
  await post(pre.svc, 'add', { name: 'n8n', url: URL1, preApproved: true })
  assert.equal((await post(pre.svc, 'test', { id: 'n8n' })).status, 200)
  assert.equal(pre.approvals.length, 0)
})

test('freeze stops a send before it is approved, and one queued behind an approval card', async (t) => {
  const s = setup({ frozen: true })
  t.after(s.cleanup)
  await post(s.svc, 'add', { name: 'n8n', url: URL1, preApproved: true })
  assert.equal((await post(s.svc, 'test', { id: 'n8n' })).status, 502)
  assert.equal(s.posts.length, 0)

  // Frozen while the owner is still reading the card.
  let release
  const gated = setup({ approve: () => new Promise((r) => (release = r)) })
  t.after(gated.cleanup)
  await post(gated.svc, 'add', { name: 'n8n', url: URL1 })
  const pending = post(gated.svc, 'test', { id: 'n8n' })
  await new Promise((r) => setImmediate(r))
  gated.state.frozen = true
  release(true)
  assert.equal((await pending).status, 502)
  assert.equal(gated.posts.length, 0)
})

test('audit rows are valid channel entries with ids and lengths, never text, address or secret', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  const { body } = await post(s.svc, 'add', { name: 'n8n', url: URL1 })
  await post(s.svc, 'test', { id: 'n8n' })
  assert.equal(s.audits.length, 1)
  const row = normaliseEntry(s.audits[0])
  assert.deepEqual([row.type, row.actor, row.state, row.channel, row.bindingId, row.rule], ['channel', 'system', 'sent', 'webhook', 'n8n', 'delivered'])
  const text = JSON.stringify(s.audits)
  for (const bad of [body.secret, 'zzz-private', 'Test message']) assert.ok(!text.includes(bad))
})

test('the send_webhook tool: public text only, to a listed target, approval per send', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  await post(s.svc, 'add', { name: 'n8n', url: URL1 })
  const ok = await s.svc.sendTool({ target: 'n8n', text: 'Dinner is ready' })
  assert.deepEqual(ok, { sent: true, attempts: 1 })
  assert.equal(s.approvals.length, 1)
  assert.deepEqual(await s.svc.sendTool({ target: 'https://evil.example/x', text: 'hi' }), { sent: false, reason: 'No such target.' })
  assert.equal(s.posts.length, 1)
})

test('the tool is only offered when a target exists, and carries one tool', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  assert.deepEqual(s.svc.toolServer(), {})
  await post(s.svc, 'add', { name: 'n8n', url: URL1 })
  const server = s.svc.toolServer()
  assert.deepEqual(Object.keys(server), [WEBHOOK_SERVER])
  assert.ok(!JSON.stringify(Object.keys(server[WEBHOOK_SERVER])).includes('zzz'))
})

const NAME = `mcp__${WEBHOOK_SERVER}__${WEBHOOK_SEND_TOOL}`
test('policy: denied with writes off, allowed with writes on, other tools on the server never', () => {
  const off = createToolGate({ allowWrites: false })
  const on = createToolGate({ allowWrites: true })
  assert.equal(off(NAME), false)
  assert.equal(on(NAME), true)
  assert.equal(on(`mcp__${WEBHOOK_SERVER}__read_secret`), false)
  const policy = createPolicy({ allowWrites: false })
  assert.equal(policy.decide({ kind: 'tool', name: NAME }).rule, 'webhook-send')
  const frozen = createToolGate({ allowWrites: true, isFrozen: () => true })
  assert.equal(frozen(NAME), false)
  assert.equal(mcpToolOf(NAME), WEBHOOK_SEND_TOOL)
})

test('policy: with taint on, the call waits for an approval card and is refused without one', async () => {
  assert.equal(isVetoed(WEBHOOK_SERVER, WEBHOOK_SEND_TOOL), true)
  const tainted = () => createTaintTracker({ isEffectful: isVetoed, tainted: true })
  const input = { target: 'n8n', text: 'hello' }
  const cards = []
  const refused = await guardOutbound(tainted(), async (title) => (cards.push(title), false), NAME, input)
  assert.equal(typeof refused, 'string')
  assert.equal(cards.length, 1)
  assert.equal(typeof (await guardOutbound(tainted(), undefined, NAME, input)), 'string')
  // An untainted session is not asked here: the sender's own card still is.
  assert.equal(await guardOutbound(createTaintTracker({ isEffectful: isVetoed }), async () => assert.fail('no card'), NAME, input), null)
  assert.equal(await guardOutbound(tainted(), async () => true, NAME, input), null)
})

test('the channel service lists targets in its status and hands the webhook routes over', async (t) => {
  const s = setup()
  t.after(s.cleanup)
  const svc = createChannelService({
    setting: () => undefined,
    openAllowlist: () => ({ list: () => [], close() {} }),
    runTurn: async () => ({ text: '' }),
    killSwitch: createKillSwitch({}),
    webhook: s.svc,
    log: quiet,
  })
  t.after(() => svc.close())
  assert.deepEqual((await svc.handle({ method: 'GET', path: '/channels' })).body.webhook, { targets: [] })
  const added = await svc.handle({ method: 'POST', path: '/channels/webhook/add', body: { name: 'n8n', url: URL1 } })
  assert.equal(added.body.ok, true)
  const status = await svc.handle({ method: 'GET', path: '/channels' })
  assert.equal(status.body.webhook.targets[0].id, 'n8n')
  assert.ok(!JSON.stringify(status.body).includes(added.body.secret))
  assert.equal(await svc.handle({ method: 'POST', path: '/channels/webhook/nope', body: {} }), null)
})
