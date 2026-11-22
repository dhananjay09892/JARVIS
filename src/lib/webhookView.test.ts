// Settings → Channels, outbound webhook card (C103): the form checks, the list
// line, and a round trip through the real bridge service for the screen's
// contract (secret shown once, address never listed). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webhookFormProblem, targetLine, SECRET_NOTE, MAX_NAME } from './webhookView.ts'
// @ts-expect-error plain JS bridge modules, no type declarations
import { createWebhookService } from '../../bridge/channels/webhook-service.mjs'
// @ts-expect-error plain JS bridge modules, no type declarations
import { createVault, memoryBackend } from '../../bridge/secrets.mjs'

test('the form catches the obvious mistakes before asking the bridge', () => {
  assert.equal(webhookFormProblem('', 'https://h.example/x'), 'Give the target a name.')
  assert.equal(webhookFormProblem('a'.repeat(MAX_NAME + 1), 'https://h.example/x')?.startsWith('Keep the name'), true)
  assert.equal(webhookFormProblem('n8n', ''), 'Paste the webhook address.')
  assert.equal(webhookFormProblem('n8n', 'hooks'), 'That is not a web address.')
  assert.equal(webhookFormProblem('n8n', 'http://h.example/x'), 'The address must start with https://.')
  assert.match(webhookFormProblem('n8n', 'https://u:p@h.example/x') ?? '', /user name/)
  assert.equal(webhookFormProblem(' n8n ', ' https://h.example/x '), null)
})

test('the list line shows the host and the approval mode, never the path', () => {
  const t = { id: 'n8n', name: 'n8n', host: 'hooks.example.test', preApproved: false, secretSet: true }
  assert.equal(targetLine(t), 'n8n · hooks.example.test · asks you before each send')
  assert.match(targetLine({ ...t, preApproved: true }), /sends without asking/)
  assert.match(targetLine({ ...t, secretSet: false }), /secret missing/)
})

test('add → secret shown once → list without it → test → remove, as the card drives it', async () => {
  const targets: Array<Record<string, unknown>> = []
  const vault = createVault(memoryBackend())
  const svc = createWebhookService({
    store: {
      list: () => targets,
      get: (id: string) => targets.find((t) => t.id === id) ?? null,
      add: (t: { name: string; url: string }) => {
        const u = new URL(t.url)
        const row = { id: 'n8n', name: t.name, url: t.url, host: u.host, preApproved: false }
        targets.push(row)
        return row
      },
      remove: (id: string) => targets.splice(0, targets.length, ...targets.filter((t) => t.id !== id)) && true,
    },
    vault,
    requestApproval: async () => true,
    senderDeps: { post: async () => ({ status: 200 }), sleep: async () => {} },
    log: { log() {}, warn() {}, error() {} },
  })
  const add = await svc.handle({ method: 'POST', path: '/channels/webhook/add', body: { name: 'n8n', url: 'https://hooks.example.test/p?token=abc' } })
  assert.equal(add.body.ok, true)
  assert.match(add.body.secret, /^[0-9a-f]{64}$/)
  assert.match(SECRET_NOTE, /will not be shown again/)
  const list = await svc.handle({ method: 'GET', path: '/channels/webhook/targets' })
  assert.ok(!JSON.stringify(list.body).includes(add.body.secret))
  assert.ok(!JSON.stringify(list.body).includes('token=abc'))
  assert.equal(targetLine(list.body.targets[0]), 'n8n · hooks.example.test · asks you before each send')
  assert.equal((await svc.handle({ method: 'POST', path: '/channels/webhook/test', body: { id: 'n8n' } })).body.ok, true)
  assert.equal((await svc.handle({ method: 'POST', path: '/channels/webhook/remove', body: { id: 'n8n' } })).body.ok, true)
  assert.deepEqual((await svc.handle({ method: 'GET', path: '/channels/webhook/targets' })).body.targets, [])
})
