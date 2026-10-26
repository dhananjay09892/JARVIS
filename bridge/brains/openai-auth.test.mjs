/**
 * Sign in with ChatGPT from Settings (plan 22, task Q55): the bridge routes
 * for start, finish, cancel, sign-out and background consent, the model list
 * with the plan token, and a voice turn on the user's plan, all against
 * mocks of auth.openai.com and the OpenAI API. With API key chosen the
 * OpenAI brain is exactly the Q54 one.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { createServer } from 'node:http'
import { createPolicy } from '../policy.mjs'
import { createVault, scopedVault } from '../secrets.mjs'
import { createBrainRegistry } from './registry.mjs'
import { createOpenAICompatibleBrain, PROFILES } from './openai-compatible.mjs'
import { chooseBrain, toolParams } from './select.mjs'
import { createSiwcAuth, SIWC_SCOPES, SIWC_RESOURCE, DYNAMIC_CLIENT, PRIVACY_NOTICE, MANAGE_USAGE_URL } from './siwc.mjs'
import {
  createOpenAIAuthRoutes, createOpenAIBrainSwitch, listModels, pageError, AUTH_ERROR_WORDS, OPENAI_AUTH_CHOICES, SIWC_VAULT_PREFIX,
} from './openai-auth.mjs'
import { browserCommand, openUrl } from '../open-url.mjs'
import { settingDef } from '../settings-registry.mjs'

const KEY = 'sk-test-0123456789abcdefghij'
const none = () => false
const servers = []
after(() => Promise.all(servers.map((s) => new Promise((resolve) => {
  s.closeAllConnections?.()
  s.close(() => resolve())
}))))

async function listen(handler) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

// ---------------------------------------------------------------- mocks

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc(payload)}`
  return `${head}.${cryptoSign('sha256', Buffer.from(head), privateKey).toString('base64url')}`
}

/** auth.openai.com: OpenID configuration, JWKS, token and revocation. */
async function mockAuth() {
  const state = { challenge: null, nonce: null, revoked: [] }
  state.origin = await listen(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const url = new URL(req.url, 'http://x')
    const form = Object.fromEntries(new URLSearchParams(raw))
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: 'https://auth.openai.com', jwks_uri: `${state.origin}/.well-known/jwks.json`, revocation_endpoint: `${state.origin}/oauth/revoke` })
    }
    if (url.pathname === '/.well-known/jwks.json') return json(200, { keys: [JWK] })
    if (url.pathname === '/oauth/revoke') {
      state.revoked.push(form.token)
      return json(200)
    }
    if (url.pathname !== '/api/accounts/oauth/token' || form.resource !== SIWC_RESOURCE) return json(404, {})
    if (form.grant_type === 'authorization_code') {
      const ok = createHash('sha256').update(form.code_verifier ?? '').digest('base64url') === state.challenge
      if (!ok || form.code !== 'the-code') return json(400, { error: 'invalid_grant' })
      const now = Math.floor(Date.now() / 1000)
      return json(200, {
        access_token: 'plan-token-1', refresh_token: 'rt-1', expires_in: 3600, scope: SIWC_SCOPES.join(' '),
        id_token: jwt({ iss: 'https://auth.openai.com', aud: form.client_id, sub: 'user-1', email: 'tony@example.com', exp: now + 600, iat: now, nonce: state.nonce }),
      })
    }
    return json(400, { error: 'unsupported_grant_type' })
  })
  return state
}

/** Play the browser: OpenAI's page redirects back to the loopback with a code. */
async function playBrowser(url, mock) {
  const u = new URL(url)
  mock.challenge = u.searchParams.get('code_challenge')
  mock.nonce = u.searchParams.get('nonce')
  const back = new URL(u.searchParams.get('redirect_uri'))
  back.searchParams.set('code', 'the-code')
  back.searchParams.set('state', u.searchParams.get('state'))
  back.searchParams.set('scope', SIWC_SCOPES.join(' '))
  if (u.searchParams.get('client_id') === DYNAMIC_CLIENT) back.searchParams.set('client_id', 'client-issued-1')
  await (await fetch(back)).text()
}

/**
 * api.openai.com: `GET /v1/models` and a streamed `POST /v1/responses` that
 * says one line. `models` may be a function (status, body) for error cases.
 */
async function mockApi({ say = 'Good evening.', models = null } = {}) {
  const requests = []
  const origin = await listen(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null })
    if (req.url === '/v1/models') {
      const [status, body] = models ?? [200, { object: 'list', data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'bad id!' }, { id: 'gpt-5' }] }]
      res.writeHead(status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(body))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
    send({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } })
    send({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_0', role: 'assistant', content: [] } })
    send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: say })
    send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } })
    res.end()
  })
  return { url: `${origin}/v1`, requests }
}

/** A vault as the bridge has it, on an in-memory backend. */
function memVault() {
  let text = null
  return createVault({ name: 'mem', label: 'memory', load: () => text, save: (t) => { text = t }, clear: () => { text = null } })
}

const drain = async (run) => {
  const out = []
  for await (const e of run.events) out.push(e)
  return out
}

/** One voice turn's parameters, as server.mjs builds them (no tools needed here). */
function voiceParams(brain, actor = 'voice') {
  const policy = createPolicy({ allowWrites: false, isMemoryTool: none, isWorkflowTool: none, isTaskTool: none, audit: () => {} })
  return { prompt: 'Hello', actor, mcpServers: {}, ...toolParams(brain, {}, { log: null }), systemPrompt: 'You are JARVIS.', model: 'gpt-5', policy, guard: async () => null }
}

/** The bridge's setup: keychain-backed SIWC, the brain switch, the routes. */
async function bridge({ mode = 'apikey', key = KEY, apiOpts = {} } = {}) {
  const auth = await mockAuth()
  const api = await mockApi(apiOpts)
  const vault = memVault()
  const siwc = createSiwcAuth({ store: scopedVault(vault, SIWC_VAULT_PREFIX), authBase: auth.origin })
  const settings = { mode }
  const opened = []
  const brains = createBrainRegistry({ log: null })
  brains.register({
    id: 'claude', label: 'Claude', capabilities: { tools: true, streaming: true, toolGate: 'hook' },
    status: () => ({ installed: true }), startSession: () => ({}),
    converse: () => ({ events: (async function* () { yield { t: 'done', reason: 'complete' } })(), cancel() {}, close() {} }),
  })
  brains.register(createOpenAIBrainSwitch({
    apikey: createOpenAICompatibleBrain({ profile: PROFILES.openai, overrides: { baseUrl: api.url }, getKey: () => key, hasKey: () => Boolean(key), log: null }),
    chatgpt: createOpenAICompatibleBrain({ profile: PROFILES.openai, overrides: { baseUrl: api.url }, auth: 'chatgpt', siwc, log: null }),
    mode: () => settings.mode,
  }))
  const routes = createOpenAIAuthRoutes({
    siwc, mode: () => settings.mode, getKey: () => key, baseUrl: api.url, log: null,
    openUrl: (url) => {
      opened.push(url)
      return true
    },
  })
  const call = (method, path, body) => routes.handle({ method, path, body })
  return { auth, api, vault, siwc, settings, opened, brains, routes, call }
}

// ---------------------------------------------------------------- tests

test('the setting and the switch: API key is the default way to pay', () => {
  assert.deepEqual(OPENAI_AUTH_CHOICES, ['apikey', 'chatgpt'])
  assert.deepEqual(settingDef('JARVIS_OPENAI_AUTH').options, OPENAI_AUTH_CHOICES)
  assert.equal(settingDef('JARVIS_OPENAI_AUTH').default, 'apikey')
  const a = { id: 'openai', capabilities: { toolGate: 'loop' }, status: () => ({ authMode: 'apikey' }), converse: () => 'A' }
  const c = { id: 'openai', capabilities: { toolGate: 'loop' }, status: () => ({ authMode: 'chatgpt' }), converse: () => 'C' }
  const m = { v: undefined }
  const sw = createOpenAIBrainSwitch({ apikey: a, chatgpt: c, mode: () => m.v })
  assert.equal(sw.converse({}), 'A', 'no choice saved: the API key')
  m.v = 'chatgpt'
  assert.equal(sw.converse({}), 'C')
  assert.equal(sw.status().authMode, 'chatgpt')
  m.v = 'something-else'
  assert.equal(sw.converse({}), 'A')
  // No secure storage on this computer, so no sign-in client: never the plan.
  const noPlan = createOpenAIBrainSwitch({ apikey: a, chatgpt: null, mode: () => 'chatgpt' })
  assert.equal(noPlan.converse({}), 'A')
  assert.equal(noPlan.authChoice(), 'apikey')
  const throws = createOpenAIBrainSwitch({ apikey: a, chatgpt: c, mode: () => { throw new Error('db') } })
  assert.equal(throws.converse({}), 'A')
})

test('with API key chosen, a voice turn is the Q54 one: Chat Completions with the key', async () => {
  const b = await bridge({ mode: 'apikey', apiOpts: {} })
  const brain = chooseBrain(b.brains, 'openai')
  const events = await drain(brain.converse(voiceParams(brain)))
  // The Responses mock does not speak Chat Completions, so look at what was sent.
  assert.equal(b.api.requests[0].url, '/v1/chat/completions')
  assert.equal(b.api.requests[0].auth, `Bearer ${KEY}`)
  assert.equal(events.at(-1).t, 'done')
  assert.deepEqual(b.vault.names(), [], 'nothing about ChatGPT is stored')
})

test('Sign in with ChatGPT from Settings end to end: notice, sign in, models, a voice turn on the plan, consent, sign out', async () => {
  const b = await bridge({ mode: 'chatgpt' })

  // What Settings draws first: the notice and the link, not signed in.
  let r = await b.call('GET', '/brains/openai/auth')
  assert.equal(r.status, 200)
  assert.equal(r.body.mode, 'chatgpt')
  assert.equal(r.body.available, true)
  assert.deepEqual(r.body.privacyNotice, PRIVACY_NOTICE)
  assert.equal(r.body.manageUsageUrl, MANAGE_USAGE_URL)
  assert.equal(MANAGE_USAGE_URL, 'https://chatgpt.com/settings/usage', 'the destination OpenAI\'s UI guidelines name')
  assert.equal(r.body.siwc.signedIn, false)

  // The bridge will not start a sign-in the page has not shown the notice for.
  r = await b.call('POST', '/brains/openai/siwc/start', {})
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'notice_needed')
  assert.equal(b.opened.length, 0)

  // Before signing in, there is no plan token for the model list.
  r = await b.call('GET', '/brains/openai/models')
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'not_signed_in')

  r = await b.call('POST', '/brains/openai/siwc/start', { acceptedNotice: true })
  assert.equal(r.status, 200)
  assert.equal(r.body.opened, true)
  assert.equal(b.opened.length, 1, 'the system browser was asked to open the sign-in page')
  assert.equal(r.body.url, b.opened[0])
  assert.equal(r.body.siwc.signingIn, true)
  const finishing = b.call('POST', '/brains/openai/siwc/finish', {})
  await playBrowser(b.opened[0], b.auth)
  r = await finishing
  assert.equal(r.body.signedIn, true)
  assert.equal(r.body.siwc.account, 'tony@example.com')
  assert.equal(r.body.siwc.planUsage, true)
  assert.equal(r.body.siwc.backgroundConsent, false, 'background use is off until the user says yes')

  // The record is in the keychain under its own scoped names; no route ever returns a token.
  assert.ok(b.vault.names().length > 0)
  assert.ok(b.vault.names().every((n) => n.startsWith(SIWC_VAULT_PREFIX)))
  assert.equal(b.vault.get(`${SIWC_VAULT_PREFIX}access_token`), 'plan-token-1')
  r = await b.call('GET', '/brains/openai/auth')
  assert.ok(!JSON.stringify(r.body).includes('plan-token-1') && !JSON.stringify(r.body).includes('rt-1'))

  // The model picker, filled with the plan token.
  r = await b.call('GET', '/brains/openai/models')
  assert.equal(r.body.ok, true)
  assert.equal(r.body.usingPlan, true)
  assert.deepEqual(r.body.models, ['gpt-5', 'gpt-5-mini'], 'deduplicated, sorted, odd ids dropped')
  const modelsReq = b.api.requests.find((q) => q.url === '/v1/models')
  assert.equal(modelsReq.auth, 'Bearer plan-token-1')
  assert.ok(!JSON.stringify(r.body).includes('plan-token-1'))

  // A voice turn runs on the plan: the Responses API, the plan token, never the key.
  const brain = chooseBrain(b.brains, 'openai')
  assert.equal(brain.status().authMode, 'chatgpt')
  let events = await drain(brain.converse(voiceParams(brain)))
  assert.equal(events.filter((e) => e.t === 'text').map((e) => e.delta).join(''), 'Good evening.')
  assert.equal(events.at(-1).reason, 'complete')
  const turn = b.api.requests.find((q) => q.url === '/v1/responses')
  assert.equal(turn.auth, 'Bearer plan-token-1')
  assert.ok(!b.api.requests.some((q) => q.auth === `Bearer ${KEY}`), 'the API key is never used on the plan')

  // A background turn is refused until consent, then allowed; and back.
  events = await drain(brain.converse(voiceParams(brain, 'worker')))
  assert.equal(events.find((e) => e.t === 'error').code, 'consent_needed')
  r = await b.call('POST', '/brains/openai/siwc/background', { allow: 'yes' })
  assert.equal(r.status, 400, 'only a real boolean counts as an answer')
  r = await b.call('POST', '/brains/openai/siwc/background', { allow: true })
  assert.equal(r.body.siwc.backgroundConsent, true)
  events = await drain(brain.converse(voiceParams(brain, 'worker')))
  assert.equal(events.at(-1).reason, 'complete')
  r = await b.call('POST', '/brains/openai/siwc/background', { allow: false })
  assert.equal(r.body.siwc.backgroundConsent, false)

  // Sign out: revoked at OpenAI, forgotten here, consent with it.
  await b.call('POST', '/brains/openai/siwc/background', { allow: true })
  r = await b.call('POST', '/brains/openai/siwc/sign-out', {})
  assert.equal(r.body.ok, true)
  assert.equal(r.body.revokedRemotely, true)
  assert.deepEqual(b.auth.revoked, ['rt-1'])
  assert.equal(r.body.siwc.signedIn, false)
  assert.equal(r.body.siwc.backgroundConsent, false)
  assert.equal(b.vault.get(`${SIWC_VAULT_PREFIX}refresh_token`), null)
  // The next turn says so instead of quietly using the key.
  events = await drain(brain.converse(voiceParams(brain)))
  assert.equal(events.find((e) => e.t === 'error').code, 'auth')
  assert.ok(!b.api.requests.some((q) => q.auth === `Bearer ${KEY}`))
})

test('a sign-in can be cancelled, and finishing then reports it in plain words', async () => {
  const b = await bridge({ mode: 'chatgpt' })
  await b.call('POST', '/brains/openai/siwc/start', { acceptedNotice: true })
  const finishing = b.call('POST', '/brains/openai/siwc/finish', {})
  const r1 = await b.call('POST', '/brains/openai/siwc/cancel', {})
  assert.equal(r1.body.ok, true)
  const r = await finishing
  assert.equal(r.body.signedIn, false)
  assert.equal(r.body.error.code, 'cancelled')
  assert.equal(r.body.error.reason, 'Sign-in was stopped.')
  assert.equal(r.body.siwc.signedIn, false)
})

test('the plan-usage errors reach Settings in plain words', async () => {
  const limit = await bridge({ mode: 'apikey', apiOpts: { models: [429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'x' } }] } })
  let r = await limit.call('GET', '/brains/openai/models')
  assert.equal(r.body.code, 'usage_limit')
  assert.equal(r.body.reason, AUTH_ERROR_WORDS.usage_limit)
  const notEligible = await bridge({ mode: 'apikey', apiOpts: { models: [403, { error: { code: 'subscription_sharing_user_not_eligible' } }] } })
  r = await notEligible.call('GET', '/brains/openai/models')
  assert.equal(r.body.code, 'not_eligible')
  assert.equal(r.body.reason, AUTH_ERROR_WORDS.not_eligible)
  const badKey = await bridge({ mode: 'apikey', apiOpts: { models: [401, { error: { message: `Incorrect API key provided: ${KEY}` } }] } })
  r = await badKey.call('GET', '/brains/openai/models')
  assert.equal(r.body.code, 'auth')
  assert.ok(!JSON.stringify(r.body).includes(KEY), 'a provider message never carries the key back')
  const noKey = await bridge({ mode: 'apikey', key: null })
  r = await noKey.call('GET', '/brains/openai/models')
  assert.equal(r.body.code, 'no_key')
  // consent_needed, from the sign-in client.
  const { SiwcError } = await import('./siwc.mjs')
  assert.deepEqual(pageError(new SiwcError('consent_needed')), { code: 'consent_needed', reason: AUTH_ERROR_WORDS.consent_needed })
})

test('with an API key chosen the model list uses the key', async () => {
  const b = await bridge({ mode: 'apikey' })
  const r = await b.call('GET', '/brains/openai/models')
  assert.equal(r.body.ok, true)
  assert.equal(r.body.usingPlan, false)
  assert.equal(b.api.requests[0].auth, `Bearer ${KEY}`)
})

test('without secure storage there is no sign-in, only the API key', async () => {
  const routes = createOpenAIAuthRoutes({ siwc: null, mode: () => 'chatgpt', openUrl: () => true, log: null })
  let r = await routes.handle({ method: 'GET', path: '/brains/openai/auth' })
  assert.equal(r.body.available, false)
  r = await routes.handle({ method: 'POST', path: '/brains/openai/siwc/start', body: { acceptedNotice: true } })
  assert.equal(r.body.code, 'no_storage')
  assert.equal(await routes.handle({ method: 'GET', path: '/settings' }), null, 'other paths are not ours')
  r = await routes.handle({ method: 'GET', path: '/brains/openai/siwc/start' })
  assert.equal(r.status, 405)
})

test('listModels refuses plain http to another computer', async () => {
  await assert.rejects(listModels({ baseUrl: 'http://example.com/v1', token: 't' }), /https/)
})

test('the browser is opened with a stock program, never a shell, and only for auth.openai.com', async () => {
  const url = 'https://auth.openai.com/api/accounts/authorize?a=1&b=2'
  assert.deepEqual(browserCommand(url, 'win32'), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] })
  assert.deepEqual(browserCommand(url, 'darwin'), { cmd: 'open', args: [url] })
  assert.deepEqual(browserCommand(url, 'linux'), { cmd: 'xdg-open', args: [url] })
  const spawned = []
  const { EventEmitter } = await import('node:events')
  const spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, shell: opts.shell })
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  assert.equal(await openUrl(url, { hosts: ['auth.openai.com'], platform: 'linux', spawn }), true)
  assert.deepEqual(spawned, [{ cmd: 'xdg-open', args: [url], shell: false }])
  for (const bad of ['http://auth.openai.com/x', 'https://evil.example/x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
    await assert.rejects(openUrl(bad, { hosts: ['auth.openai.com'], platform: 'linux', spawn }), Error, bad)
  }
  assert.equal(spawned.length, 1)
})

test('the scoped vault view keeps the sign-in under its own names', () => {
  const vault = memVault()
  vault.set('OPENAI_API_KEY', KEY)
  const view = scopedVault(vault, SIWC_VAULT_PREFIX)
  view.set('access_token', 'a')
  assert.equal(view.get('access_token'), 'a')
  assert.equal(view.get('OPENAI_API_KEY'), null)
  assert.throws(() => view.get('../OPENAI_API_KEY'))
  assert.deepEqual(view.keys(), ['access_token'])
  view.set('access_token', '')
  assert.equal(view.get('access_token'), null, 'an empty value means none')
  view.set('access_token', 'a')
  view.delete('access_token')
  assert.equal(vault.get('OPENAI_API_KEY'), KEY, 'other secrets are untouched')
  assert.throws(() => scopedVault(vault, 'no-slash'))
})
