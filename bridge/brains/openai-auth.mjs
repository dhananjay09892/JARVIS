/**
 * How the OpenAI brain is paid for, chosen in Settings → Brains (plan 22,
 * task Q55).
 *
 * The OpenAI profile has two adapters (openai-compatible.mjs): one on the
 * user's own API key (Chat Completions, the default) and one on their ChatGPT
 * plan through Sign in with ChatGPT (Responses API, siwc.mjs). The bridge
 * registers one brain, `openai`, that hands each new conversation to the
 * adapter the `JARVIS_OPENAI_AUTH` setting names. With 'apikey' (the default)
 * it is exactly the API-key adapter of Q54: nothing changes. It never falls
 * back from one way of paying to the other on its own (OpenAI: "must not
 * silently switch to another billing path").
 *
 * This file also has the bridge routes Settings uses for the sign-in itself
 * (start, finish, cancel, sign out, background consent) and the model list,
 * kept out of server.mjs so the tests drive them against mocks. No route ever
 * returns a token; the sign-in record stays in the OS keychain (secrets.mjs,
 * Q20) under its own scoped names.
 */
import { MANAGE_USAGE_URL, PRIVACY_NOTICE, SiwcError } from './siwc.mjs'
import { RESPONSES_ERRORS, checkBaseUrl, scrub } from './openai-compatible.mjs'

export const OPENAI_AUTH_CHOICES = Object.freeze(['apikey', 'chatgpt'])

/** The vault prefix the sign-in record is filed under (secrets.mjs `scopedVault`). */
export const SIWC_VAULT_PREFIX = 'brain/openai-siwc/'

/** Model ids Settings may offer: the same rule as the JARVIS_OPENAI_MODEL setting. */
const MODEL_ID = /^[\w.:-]{1,80}$/
const MAX_MODELS = 200

/**
 * Plain words for the errors Settings shows (and a turn may end with). The
 * plan-usage ones follow OpenAI's SIWC UI guidelines: for the usage limit,
 * Manage usage is the action to offer.
 */
export const AUTH_ERROR_WORDS = Object.freeze({
  usage_limit: 'Your ChatGPT plan has reached its usage limit for JARVIS. Open Manage usage to check or change it.',
  not_eligible: 'ChatGPT plan usage is not available for this account or workspace. Use an API key instead, or ask the workspace admin.',
  consent_needed: 'Background tasks may not use your ChatGPT plan until you allow it in Settings → Brains.',
  notice_needed: 'Read the privacy notice first, then press Continue with ChatGPT.',
  no_storage: 'This computer has no secure credential storage, so a ChatGPT sign-in cannot be kept here. Use an API key from the environment instead.',
  no_key: 'No OpenAI API key is saved yet.',
  auth: 'OpenAI did not accept the sign-in or key. Sign in again, or check the key.',
  network: 'Could not reach OpenAI. Check the internet connection and try again.',
  provider: 'OpenAI had a problem just now. Try again in a moment.',
})

/**
 * The `openai` brain: the API-key adapter or the ChatGPT-plan adapter, by
 * `mode()`, read again for every new conversation. Both are tool-loop brains
 * with the same capabilities, so the registry's policy contract is the same
 * whichever one runs.
 */
export function createOpenAIBrainSwitch({ apikey, chatgpt = null, mode = () => 'apikey' }) {
  if (!apikey || typeof apikey.converse !== 'function') throw new Error('The OpenAI brain needs its API-key adapter.')
  const pick = () => {
    let m = 'apikey'
    try {
      m = mode()
    } catch {
      m = 'apikey'
    }
    return m === 'chatgpt' && chatgpt ? chatgpt : apikey
  }
  return Object.freeze({
    id: apikey.id,
    label: 'OpenAI',
    capabilities: apikey.capabilities,
    /** Which way of paying the next conversation uses: 'apikey' or 'chatgpt'. */
    authChoice: () => (pick() === apikey ? 'apikey' : 'chatgpt'),
    status: () => pick().status(),
    startSession: (params) => pick().converse(params),
    converse: (params) => pick().converse(params),
  })
}

/** A brain or sign-in error as `{ code, reason }` for the page. Never carries a token. */
export function pageError(err, secret = null) {
  if (err instanceof SiwcError) {
    if (err.code === 'consent_needed') return { code: 'consent_needed', reason: AUTH_ERROR_WORDS.consent_needed }
    return { code: err.code, reason: err.message }
  }
  const code = typeof err?.code === 'string' ? err.code : 'provider'
  const words = AUTH_ERROR_WORDS[code]
  return { code, reason: words ?? scrub(String(err?.message ?? AUTH_ERROR_WORDS.provider), secret).slice(0, 300) }
}

/**
 * The models this key or plan token can use: `GET <baseUrl>/models`. Returns
 * sorted ids, or throws `{ code }` (an Error with a code the page shows in
 * plain words). The token is only ever put in this request's header.
 */
export async function listModels({ baseUrl = 'https://api.openai.com/v1', token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const base = checkBaseUrl(baseUrl)
  let res
  try {
    res = await fetchImpl(`${base}/models`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw Object.assign(new Error('network'), { code: 'network' })
  }
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const known = RESPONSES_ERRORS[body?.error?.code]
    const code = known ? known.code : res.status === 401 || res.status === 403 ? 'auth' : 'provider'
    throw Object.assign(new Error(code), { code })
  }
  const data = Array.isArray(body?.data) ? body.data : []
  const ids = new Set()
  for (const m of data) {
    if (typeof m?.id === 'string' && MODEL_ID.test(m.id)) ids.add(m.id)
    if (ids.size >= MAX_MODELS) break
  }
  return [...ids].sort()
}

const ok = (body) => ({ status: 200, body: { ok: true, ...body } })
const refused = (status, err) => ({ status, body: { ok: false, ...err } })

/**
 * Settings → Brains routes for the OpenAI sign-in, all under `/brains/openai/`.
 * `handle()` returns `{ status, body }`, or null for a path that is not ours.
 * The server checks the Origin for every POST before calling it.
 *
 *   GET  /brains/openai/auth             the choice, the sign-in state, notice and Manage usage link
 *   POST /brains/openai/siwc/start       { acceptedNotice: true } → opens the system browser
 *   POST /brains/openai/siwc/finish      waits for the browser to finish → the new state
 *   POST /brains/openai/siwc/cancel
 *   POST /brains/openai/siwc/sign-out
 *   POST /brains/openai/siwc/background  { allow: boolean }
 *   GET  /brains/openai/models           the models the chosen key or plan can use
 *
 * @param {{
 *   siwc: object|null,         the SIWC client (siwc.mjs), or null when there is no secure storage
 *   mode: () => string,        the JARVIS_OPENAI_AUTH choice
 *   openUrl: (url: string) => (boolean|Promise<boolean>), opens the system browser
 *   getKey: () => (string|null), the API key
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 *   log?: object,
 * }} deps
 */
export function createOpenAIAuthRoutes({ siwc, mode, openUrl, getKey = () => null, baseUrl = 'https://api.openai.com/v1', fetch: fetchImpl = globalThis.fetch, log = console }) {
  const choice = () => {
    try {
      const m = mode()
      return OPENAI_AUTH_CHOICES.includes(m) ? m : 'apikey'
    } catch {
      return 'apikey'
    }
  }
  const state = () => {
    let s = null
    if (siwc) {
      try {
        s = siwc.status()
      } catch {
        s = null
      }
    }
    return {
      mode: choice(),
      available: Boolean(siwc),
      siwc: s,
      privacyNotice: PRIVACY_NOTICE,
      manageUsageUrl: MANAGE_USAGE_URL,
    }
  }
  const noStorage = () => refused(409, { code: 'no_storage', reason: AUTH_ERROR_WORDS.no_storage })

  return {
    async handle({ method, path, body }) {
      if (!path.startsWith('/brains/openai/')) return null

      if (path === '/brains/openai/auth' && method === 'GET') return ok(state())

      if (path === '/brains/openai/models' && method === 'GET') {
        const plan = choice() === 'chatgpt'
        let token = null
        try {
          if (plan) {
            if (!siwc) return noStorage()
            token = await siwc.accessToken({ background: false })
          } else {
            token = getKey()
            if (!token) return refused(409, { code: 'no_key', reason: AUTH_ERROR_WORDS.no_key })
          }
          return ok({ models: await listModels({ baseUrl, token, fetch: fetchImpl }), usingPlan: plan })
        } catch (err) {
          return refused(502, pageError(err, token))
        }
      }

      if (!path.startsWith('/brains/openai/siwc/')) return null
      if (method !== 'POST') return { status: 405, body: { ok: false, reason: 'Use POST.' } }
      if (!siwc) return noStorage()
      const what = path.slice('/brains/openai/siwc/'.length)
      try {
        switch (what) {
          case 'start': {
            // The terms: a privacy notice before any data is processed. The
            // page shows it with the button; the bridge holds it to that.
            if (body?.acceptedNotice !== true) return refused(400, { code: 'notice_needed', reason: AUTH_ERROR_WORDS.notice_needed })
            const { url } = await siwc.begin()
            let opened = false
            try {
              opened = Boolean(await openUrl(url))
            } catch (err) {
              log?.error?.('[jarvis] could not open the browser for Sign in with ChatGPT:', err?.message ?? err)
            }
            // The URL carries no secret (PKCE sends only the challenge), so the
            // page may offer it as a link when no browser opened.
            return ok({ opened, url, ...state() })
          }
          case 'finish':
            try {
              await siwc.waitForSignIn()
            } catch (err) {
              return ok({ signedIn: false, error: pageError(err), ...state() })
            }
            return ok({ signedIn: true, ...state() })
          case 'cancel':
            siwc.cancel()
            return ok(state())
          case 'sign-out': {
            const out = await siwc.signOut()
            return ok({ revokedRemotely: out.revokedRemotely, ...(out.detail && { detail: out.detail }), ...state() })
          }
          case 'background':
            if (typeof body?.allow !== 'boolean') return refused(400, { code: 'bad_request', reason: 'Send { allow: true } or { allow: false }.' })
            siwc.setBackgroundConsent(body.allow)
            return ok(state())
          default:
            return { status: 404, body: { ok: false, reason: 'Not found.' } }
        }
      } catch (err) {
        if (!(err instanceof SiwcError) && /secure storage|secret store/i.test(String(err?.message))) return noStorage()
        return refused(err instanceof SiwcError ? 409 : 500, pageError(err))
      }
    },
  }
}
