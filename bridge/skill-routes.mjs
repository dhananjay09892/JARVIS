/**
 * Settings → Skills, bridge side (plan 19 phase 4): the HTTP routes the Skills
 * screen talks to, kept apart from server.mjs so they can be tested against a
 * temporary folder with no network.
 *
 *   GET  /skills               installed skills (with switch state, pin, rollback), the
 *                              first-party packs and whether each is installed, the pause
 *   POST /skills/review        { pack }            the permission review for a first-party pack
 *   POST /skills/install       { pack, approve }   install after review (approve = reviewId)
 *   POST /skills/paused        { paused }          pause or resume all skills
 *   POST /skills/:id/enabled   { enabled }         the per-skill switch
 *   POST /skills/:id/pin       POST /skills/:id/unpin
 *   POST /skills/:id/rollback
 *   POST /skills/:id/remove    { confirm: true }
 *
 * Rules this module keeps:
 *   - The page can only install a first-party pack by name. It never names a
 *     folder, so it cannot point the registry at arbitrary files.
 *   - Install needs the review id of the files as they are now (the registry
 *     refuses anything else); the page cannot skip the review.
 *   - Every write goes through `gate`, which the bridge points at the kill
 *     switch: while JARVIS is frozen nothing changes. Switching a skill off
 *     or pausing all never needs a confirmation.
 * Replies are short and never echo file content. `handle()` returns
 * `{ status, body }`, or null for a path that is not ours. The server checks
 * the Origin before calling it for anything but GET.
 */
import { SKILL_SETTINGS, listFirstPartyPacks } from './skill-registry.mjs'
import { formatSwitches, parseSwitches } from './agent-settings.mjs'

const SKILL_ID = /^[a-z][a-z0-9-]{0,39}$/
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const reply = (status, body) => ({ status, body })
const fail = (status, reason, extra) => reply(status, { ok: false, reason, ...extra })

/**
 * @param {object} o
 * @param {object} o.registry    createSkillRegistry()
 * @param {object} o.switches    createSkillSwitches()
 * @param {string} o.packsDir    folder of first-party packs (bridge/skills)
 * @param {(patch: object) => void} o.saveSettings
 * @param {(key: string) => string | undefined} o.read  a setting's effective value
 * @param {() => string | null} [o.gate]  a reason when changes are refused
 * @param {() => object} [o.stats]        runner counts, for the list
 */
export function createSkillRoutes({ registry, switches, packsDir, saveSettings, read, gate = () => null, stats = () => ({}) } = {}) {
  if (!registry || !switches || typeof saveSettings !== 'function' || typeof read !== 'function') throw new Error('skill routes: registry, switches, saveSettings and read are needed')
  const packs = () => listFirstPartyPacks(packsDir)
  const packDir = (name) => (typeof name === 'string' && SKILL_ID.test(name) ? packs().find((p) => p.name === name)?.dir : undefined)
  const switchMap = () => parseSwitches(read(SKILL_SETTINGS.switches))

  function snapshot() {
    const installed = registry.list()
    const map = switchMap()
    const byId = new Map(installed.map((s) => [s.id, s]))
    return {
      ok: true,
      paused: switches.isPaused(),
      pausedSetting: /^(1|true|on|yes)$/i.test((read(SKILL_SETTINGS.paused) ?? '').trim()),
      installed: installed.map((s) => ({
        id: s.id, version: s.version, pinned: s.pinned, canRollBack: s.canRollBack, installedAt: s.installedAt,
        on: map.get(s.id) !== false,
        ...(s.manifest
          ? { name: s.manifest.name, description: s.manifest.description, riskTier: s.manifest.riskTier, phrases: s.manifest.triggers.phrases, tools: s.manifest.permissions.tools }
          : { broken: s.broken }),
      })),
      packs: packs().map((p) => ({ name: p.name, installedVersion: byId.get(p.name)?.version ?? null })),
      stats: stats(),
    }
  }

  function write(fn) {
    const why = gate()
    if (why) return fail(423, why)
    return fn()
  }

  const toResult = (r, okExtra = {}) => (r.ok ? reply(200, { ...r, ...okExtra, snapshot: snapshot() }) : fail(400, (r.errors ?? ['refused'])[0], { errors: r.errors }))

  return {
    handle({ method, path, body } = {}) {
      if (path !== '/skills' && !path?.startsWith('/skills/')) return null
      const b = isRecord(body) ? body : {}
      if (path === '/skills' && method === 'GET') return reply(200, snapshot())
      if (method !== 'POST') return fail(405, 'Not supported.')

      if (path === '/skills/review') {
        const dir = packDir(b.pack)
        if (!dir) return fail(404, 'No such first-party pack.')
        const r = registry.review(dir)
        if (!r.ok) return fail(400, r.errors[0], { errors: r.errors })
        const { manifest, ...rest } = r
        return reply(200, { ...rest, id: manifest.id, name: manifest.name, version: manifest.version })
      }
      if (path === '/skills/install') {
        return write(() => {
          const dir = packDir(b.pack)
          if (!dir) return fail(404, 'No such first-party pack.')
          return toResult(registry.install(dir, { approve: b.approve }))
        })
      }
      if (path === '/skills/paused') {
        return write(() => {
          if (typeof b.paused !== 'boolean') return fail(400, 'Send paused: true or false.')
          saveSettings({ [SKILL_SETTINGS.paused]: b.paused ? '1' : '0' })
          return reply(200, { ok: true, snapshot: snapshot() })
        })
      }
      const m = /^\/skills\/([a-z][a-z0-9-]{0,39})\/(enabled|pin|unpin|rollback|remove)$/.exec(path)
      if (!m) return null
      const [, id, action] = m
      return write(() => {
        if (!registry.get(id) && !registry.list().some((s) => s.id === id)) return fail(404, `${id} is not installed.`)
        if (action === 'enabled') {
          if (typeof b.enabled !== 'boolean') return fail(400, 'Send enabled: true or false.')
          const map = switchMap()
          if (b.enabled) map.delete(id); else map.set(id, false)
          saveSettings({ [SKILL_SETTINGS.switches]: formatSwitches(map) })
          return reply(200, { ok: true, snapshot: snapshot() })
        }
        if (action === 'remove') {
          if (b.confirm !== true) return fail(400, 'Removing a skill needs confirm: true.')
          const r = registry.remove(id)
          if (r.ok) {
            const map = switchMap(); map.delete(id)
            saveSettings({ [SKILL_SETTINGS.switches]: formatSwitches(map) })
          }
          return toResult(r)
        }
        return toResult(registry[action](id))
      })
    },
  }
}
