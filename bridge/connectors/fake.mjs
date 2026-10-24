/**
 * A fake connector that proves the framework end to end (task C01). It talks
 * to "https://api.fake-connector.invalid" — a host that cannot exist — so it
 * only ever works against the fake fetch in testpack.mjs. It is never
 * registered by the bridge itself.
 *
 * It is shaped like a real paste-a-token data connector:
 *   connect({ token })  checks the token with GET /v1/me, then stores it
 *   sync({ cursor })    pages through GET /v1/items?cursor=…
 *   test()              GET /v1/me again: the Settings card's Test button (C03)
 *   tools               read:  search_items   (GET /v1/search?q=)
 *                       write: create_note    (POST /v1/notes) — denied by default
 */
import { createHttp, ConnectorError } from './http.mjs'

export const FAKE_HOST = 'api.fake-connector.invalid'
const BASE = `https://${FAKE_HOST}/v1`

export const fakeConnector = Object.freeze({
  id: 'fake',
  /** @param {{ credentials: any, fetch: typeof fetch, sleep: (ms: number) => Promise<void>, now: () => number }} ctx */
  create({ credentials, fetch, sleep, now }) {
    const http = createHttp({ fetch, sleep, now, allowedHosts: [FAKE_HOST] })
    let lastSync

    const token = () => {
      const t = credentials.get('api_token')
      if (!t) throw new ConnectorError('not-connected')
      return t
    }
    const get = (path) => http.json(`${BASE}${path}`, { headers: { authorization: `Bearer ${token()}` } })

    return {
      id: 'fake',
      name: 'Fake connector',
      kind: 'data',
      auth: 'token',
      platforms: ['win', 'mac', 'linux'],
      risk: 'R1',
      capabilities: { read: true, write: true, subscribe: false },
      defaultSensitivity: 'personal',
      setup: {
        sees: ['Your fake items: title, text, author and when each was last changed.'],
        scopes: ['items:read', 'notes:write (only if you grant write)'],
        steps: ['Open the fake service settings.', 'Create an API token.', 'Paste it below and press Connect.'],
        tokenLabel: 'Fake API token',
        helpUrl: `https://${FAKE_HOST}/settings/tokens`,
        testQuestion: 'What fake items do I have?',
      },

      async connect({ token: pasted } = {}) {
        if (typeof pasted !== 'string' || !pasted.trim()) throw new ConnectorError('auth', { detail: 'empty token' })
        const me = await http.json(`${BASE}/me`, { headers: { authorization: `Bearer ${pasted.trim()}` } })
        credentials.set('api_token', pasted.trim())
        return { account: typeof me?.name === 'string' ? me.name.slice(0, 100) : 'connected' }
      },

      async disconnect() {
        credentials.delete('api_token')
      },

      async test() {
        const me = await get('/me')
        return { detail: `Signed in as ${typeof me?.name === 'string' ? me.name.slice(0, 100) : 'someone'}.` }
      },

      status() {
        return credentials.has('api_token')
          ? { state: 'ok', detail: 'Connected', lastSync }
          : { state: 'disconnected', detail: 'Not connected' }
      },

      async *sync({ cursor } = {}) {
        let next = cursor ?? ''
        for (let page = 0; page < 100; page++) {
          const body = await get(`/items?cursor=${encodeURIComponent(next)}`)
          if (!body || !Array.isArray(body.items)) throw new ConnectorError('bad-response', { detail: 'no items' })
          for (const item of body.items) {
            yield {
              id: String(item.id),
              title: item.title,
              text: String(item.body ?? ''),
              author: item.author,
              updatedAt: Date.parse(item.updated) || undefined,
              url: item.url,
            }
          }
          if (typeof body.next_cursor === 'string' && body.next_cursor) {
            next = body.next_cursor
            yield { cursor: next }
          } else break
        }
        lastSync = now()
      },

      tools() {
        return [
          {
            name: 'search_items',
            capability: 'read',
            description: 'Search the fake items by keyword.',
            run: async ({ query } = {}) => get(`/search?q=${encodeURIComponent(String(query ?? '').slice(0, 200))}`),
          },
          {
            name: 'create_note',
            capability: 'write',
            description: 'Create a note in the fake service.',
            run: async ({ text } = {}) =>
              http.json(`${BASE}/notes`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
                body: JSON.stringify({ text: String(text ?? '').slice(0, 2000) }),
              }),
          },
        ]
      },
    }
  },
})
