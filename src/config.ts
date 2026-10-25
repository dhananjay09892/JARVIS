/**
 * JARVIS configuration.
 *
 * Everything here is read from Vite env vars (.env.local) so no secrets are
 * committed. See .env.example for the full list.
 */

/**
 * Vite inlines a blank `.env` entry as an empty string, not as undefined, so
 * `??` never falls through to the default — and .env.example ships every
 * optional key blank, which is exactly the shape that used to bite. A blank
 * VITE_BACKEND silently selected the direct path and then complained about a
 * missing API key. Treat whitespace-only as unset everywhere in this file.
 */
function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

/**
 * Fixed-choice options. An unrecognised value is nearly always a typo, and
 * quietly falling back to the default hides it until it costs you a take.
 */
function choice<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = str(raw)
  if (value === undefined) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  console.warn(
    `[jarvis] ${name}="${value}" is not one of ${allowed.join(' | ')} — using "${fallback}".`,
  )
  return fallback
}

/** Same, for the on/off options. Accepts true/false and 1/0. */
function flag(name: string, raw: unknown, fallback: boolean): boolean {
  const value = str(raw)?.toLowerCase()
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  console.warn(`[jarvis] ${name}="${value}" is not true or false — using ${fallback}.`)
  return fallback
}

/**
 * Keys behind the bridge (plan 25 phase 4, Q22). Every VITE_* value is copied
 * into the JavaScript Vite builds, so a key read here is a key anyone with
 * devtools can copy. The built front end therefore holds none: `vite build`
 * refuses to run while one is set (vite.config.ts, scripts/bundle-secrets.mjs)
 * and the build scans dist/ for keys afterwards. The bridge keeps keys in the
 * OS keychain and makes the provider calls itself.
 *
 * `npm run dev` still reads them, for the browser-direct demo only. Use
 * `devSecret` for every credential below, so a production build never even
 * tries to use one.
 */
const DEV = import.meta.env.DEV
function devSecret(raw: unknown): string | undefined {
  return DEV ? str(raw) : undefined
}

/**
 * Which brain to use.
 *
 *   'bridge' — run `npm run bridge` alongside the app. Authenticates off your
 *              existing Claude Code login (no API key), and every MCP server in
 *              your Claude Code config is available to JARVIS, including local
 *              ones like higgsfield, elevenlabs, android and playwright.
 *
 *   'direct' — the browser calls the Claude API itself, with
 *              VITE_ANTHROPIC_API_KEY, and only reaches remote HTTP MCP
 *              servers. Development only (`npm run dev`): a built front end
 *              carries no keys, so a build always uses the bridge.
 */
const REQUESTED_BACKEND: 'bridge' | 'direct' = choice(
  'VITE_BACKEND',
  import.meta.env.VITE_BACKEND,
  ['bridge', 'direct'] as const,
  'bridge',
)
if (REQUESTED_BACKEND === 'direct' && !DEV) {
  console.warn(
    '[jarvis] VITE_BACKEND=direct works only in `npm run dev`: a built JARVIS keeps its keys behind the bridge. Using the bridge.',
  )
}
export const BACKEND: 'bridge' | 'direct' = DEV ? REQUESTED_BACKEND : 'bridge'

/**
 * Where the bridge lives. Derived once here rather than in each of the three
 * places that talk to it, so moving off the default port is a single edit.
 * `wss://` maps to `https://` on its own, which is why this is a prefix swap
 * rather than a hardcoded scheme.
 */
export const BRIDGE_WS_URL = str(import.meta.env.VITE_BRIDGE_URL) ?? 'ws://localhost:8787'
export const BRIDGE_HTTP_URL = BRIDGE_WS_URL.replace(/^ws/, 'http')

/**
 * Speech output engine.
 *
 * false (default) — the browser's own speechSynthesis. Runs on-device, so
 *   speech starts on the next frame with no request and no download. This is
 *   the fastest option that exists and it's why it's the default.
 *
 * true — ElevenLabs. Noticeably better voice, but every sentence costs a
 *   round trip plus generation, which is the difference between a conversation
 *   and a walkie-talkie. Turn it on when you want the voice more than the pace.
 */
export const USE_ELEVENLABS = flag(
  'VITE_USE_ELEVENLABS',
  import.meta.env.VITE_USE_ELEVENLABS,
  false,
)

/**
 * Speech engine.
 *
 *   'system' — the browser's own speechSynthesis. Starts on the next frame,
 *     costs nothing, but is capped by whatever voices the OS ships; on macOS
 *     the British male option is compact Daniel.
 *
 *   'kokoro' — an 82M-parameter neural TTS running entirely in the browser via
 *     ONNX. Four proper British male voices and far better sound, nothing
 *     leaving the machine. MEASURED ON THIS MACHINE at q8/WebGPU it generates
 *     about 2.2x slower than realtime — "Yes, sir?" took 3.3 seconds and a
 *     thirteen-word sentence took nine. That is not a conversation, so it is
 *     not the default. Try `fp32` (see kokoro.ts) before enabling it; int8
 *     quantisation often silently falls back to CPU on WebGPU, which is the
 *     likely cause.
 */
export const TTS_ENGINE: 'kokoro' | 'system' = choice(
  'VITE_TTS_ENGINE',
  import.meta.env.VITE_TTS_ENGINE,
  ['kokoro', 'system'] as const,
  'system',
)

/**
 * Which Kokoro voice. All four are British male:
 *   bm_george — measured RP baritone, closest to the character
 *   bm_fable  — warmer
 *   bm_lewis  — lower
 *   bm_daniel — brighter
 */
export const KOKORO_VOICE = choice(
  'VITE_KOKORO_VOICE',
  import.meta.env.VITE_KOKORO_VOICE,
  ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const,
  'bm_george',
)

export const env = {
  // Direct mode in `npm run dev` only; always empty in a build (see devSecret).
  anthropicKey: devSecret(import.meta.env.VITE_ANTHROPIC_API_KEY) ?? '',
  elevenKey: devSecret(import.meta.env.VITE_ELEVENLABS_API_KEY) ?? '',
  elevenVoiceId:
    str(import.meta.env.VITE_ELEVENLABS_VOICE_ID) ?? 'JBFqnCBsd6RMkjVDRZzb',
}

/** `claude-opus-5` is the strongest model; `claude-sonnet-5` trades a little
 *  quality for lower latency if you find responses feel slow on camera. */
export const MODEL = 'claude-opus-5'

/**
 * Fast mode runs the same Opus 5 at up to 2.5x output speed. It is a research
 * preview on the Claude API and costs $10/$50 per Mtok instead of $5/$25.
 * For a recorded demo the snappiness is worth it; flip to false to save money.
 */
export const FAST_MODE = true

/**
 * The wake word is not configured here. It is a user setting
 * (JARVIS_WAKE_WORD / JARVIS_WAKE_SENSITIVITY in bridge/settings-registry.mjs)
 * and runs offline in the page: see src/lib/wake/ and ADR 002. The Porcupine
 * option and VITE_PICOVOICE_ACCESS_KEY were removed (Q09): Picovoice keys can
 * no longer be obtained for free.
 */

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpServer = {
  /** Stable id used as the tool namespace. Lowercase, no spaces. */
  name: string
  /** Human label for the HUD. */
  label: string
  /** Remote MCP endpoint. Must be reachable from Anthropic's servers, not yours. */
  url: string
  /** Bearer token, if the server wants one. Many put the secret in the URL instead. */
  token?: string
  enabled: boolean
}

/**
 * These are passed to the Messages API `mcp_servers` parameter. Anthropic dials
 * the servers itself, so there is no CORS to fight and no local bridge to run —
 * which is what makes a backend-free JARVIS possible.
 *
 * Only *remote HTTP* MCP servers work here. Local stdio servers (filesystem,
 * Blender, Playwright) need a machine to run on and are out of scope for a
 * browser-only build.
 *
 * Development only. Every token below, and the Zapier and Pipedream URLs (the
 * URL *is* the credential), would be readable by anyone who opens devtools, so
 * they are read in `npm run dev` only and `vite build` refuses to run while any
 * is set (Q22). The bridge backend (the default) reads none of this — it uses
 * your Claude Code MCP config, where the secrets stay on your machine — so for
 * these integrations in a real install, add them there instead.
 */
export const MCP_SERVERS: McpServer[] = [
  // The single highest-leverage integration: one URL, ~8,000 apps, managed
  // OAuth. Wire up Gmail, Google Calendar, Spotify, Slack, Notion and Sheets in
  // the Zapier dashboard and they all arrive through this one endpoint.
  // Get yours at https://mcp.zapier.com -> New MCP Server.
  {
    name: 'zapier',
    label: 'Zapier',
    url: devSecret(import.meta.env.VITE_ZAPIER_MCP_URL) ?? '',
    enabled: Boolean(devSecret(import.meta.env.VITE_ZAPIER_MCP_URL)),
  },

  // Alternative/complementary gateway: ~3,000 apps, free for personal use.
  {
    name: 'pipedream',
    label: 'Pipedream',
    url: devSecret(import.meta.env.VITE_PIPEDREAM_MCP_URL) ?? '',
    enabled: Boolean(devSecret(import.meta.env.VITE_PIPEDREAM_MCP_URL)),
  },

  // Official first-party servers. Each needs its own OAuth token pasted in.
  {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    token: devSecret(import.meta.env.VITE_NOTION_TOKEN),
    enabled: Boolean(devSecret(import.meta.env.VITE_NOTION_TOKEN)),
  },
  {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    token: devSecret(import.meta.env.VITE_LINEAR_TOKEN),
    enabled: Boolean(devSecret(import.meta.env.VITE_LINEAR_TOKEN)),
  },
  {
    name: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    token: devSecret(import.meta.env.VITE_GITHUB_TOKEN),
    enabled: Boolean(devSecret(import.meta.env.VITE_GITHUB_TOKEN)),
  },
  {
    name: 'stripe',
    label: 'Stripe',
    url: 'https://mcp.stripe.com',
    token: devSecret(import.meta.env.VITE_STRIPE_TOKEN),
    enabled: Boolean(devSecret(import.meta.env.VITE_STRIPE_TOKEN)),
  },
  {
    name: 'sentry',
    label: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    token: devSecret(import.meta.env.VITE_SENTRY_TOKEN),
    enabled: Boolean(devSecret(import.meta.env.VITE_SENTRY_TOKEN)),
  },
  // Home Assistant is self-hosted, so this needs a publicly reachable URL
  // (Nabu Casa Cloud, or a Cloudflare tunnel). Worth the setup — "Jarvis, dim
  // the lights" with the room actually dimming is the best shot in the video.
  // Both halves are required: an instance reachable from Anthropic's servers
  // with no bearer token attached is one that answers 401 to every tool call,
  // which reads on the HUD as connected and behaves as broken.
  {
    name: 'home',
    label: 'Home',
    url: devSecret(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) ?? '',
    token: devSecret(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    enabled: Boolean(
      devSecret(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) &&
        devSecret(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    ),
  },
]

export const activeServers = () => MCP_SERVERS.filter((s) => s.enabled && s.url)

/**
 * The persona for the browser-direct path only. The bridge carries its own,
 * fuller version in bridge/server.mjs — that's the one that gets used by
 * default, and the one worth editing.
 */
export const SYSTEM_PROMPT = `You are JARVIS, Tony Stark's assistant. You are speaking out loud.

THE HARD RULE: your entire reply must be under 60 words. This is not a style
preference — every word is read aloud by a speech synthesiser and the user is
waiting in silence while it plays. A four-paragraph answer is a failure, however
good the content. If a question genuinely needs more, give the headline in two
sentences and offer the detail: "There's more if you want it."

Voice:
- Dry, precise, quietly amused. Understated competence, never fawning.
- Say "sir" at most once per exchange, and not in every exchange.
- Plain spoken prose only. No markdown, no bullet points, no headings, no code,
  no emoji, no asterisks, no numbered lists.
- Write numbers, dates and times the way you'd say them: "eight fifteen",
  "the first of August", not "8:15" or "2026-08-01".

Using tools:
- You have live tools. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a URL, ID or raw JSON aloud unless asked. Summarise.
- If a tool fails or isn't connected, one plain sentence saying so.
- For anything outward-facing or destructive (sending mail, posting, paying,
  deleting) say exactly what you're about to do and wait for confirmation.
- If you don't know, say you don't know.`
