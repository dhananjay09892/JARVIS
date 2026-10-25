// Keys behind the bridge (plan 25 phase 4, Q22).
//
// A provider key in the front end is a key anyone with devtools can copy:
// Vite inlines every VITE_* value into the JavaScript it builds. The bridge
// holds keys in the OS keychain (Q20) and makes the provider calls itself, so
// the built front end needs none. This module is the single list of the
// VITE_* values that are secrets, and the checks that keep them out of a
// build:
//
//   - vite.config.ts refuses to run `vite build` while any of them is set
//     (`buildRefusal`), so a key in .env.local cannot reach dist/ or the
//     Windows installer;
//   - scripts/check-bundle-secrets.mjs scans dist/ after every build for the
//     values themselves and for the shapes of well-known provider keys
//     (`scanText`), in case a key arrives some other way.
//
// `npm run dev` still reads them, for the browser-direct demo path only.
// No function here ever returns or prints a secret value: findings name the
// variable or the key format, never the key.

/** VITE_* variables whose value is a credential. A URL counts when the URL
 *  itself is the credential (Zapier and Pipedream put the token in the path). */
export const SECRET_ENV_VARS = Object.freeze([
  'VITE_ANTHROPIC_API_KEY',
  'VITE_ELEVENLABS_API_KEY',
  'VITE_ZAPIER_MCP_URL',
  'VITE_PIPEDREAM_MCP_URL',
  'VITE_NOTION_TOKEN',
  'VITE_LINEAR_TOKEN',
  'VITE_GITHUB_TOKEN',
  'VITE_STRIPE_TOKEN',
  'VITE_SENTRY_TOKEN',
  'VITE_HOMEASSISTANT_MCP_URL',
  'VITE_HOMEASSISTANT_TOKEN',
])

/** Shapes of real provider keys. Lengths are kept close to the real formats
 *  so library code and documentation strings in the bundle do not match. */
export const KEY_PATTERNS = Object.freeze([
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9]{2,8}-[A-Za-z0-9_-]{40,}/ },
  { name: 'OpenAI API key', re: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/ },
  { name: 'ElevenLabs API key', re: /\bsk_[a-f0-9]{48}\b/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { name: 'Linear API key', re: /\blin_api_[A-Za-z0-9]{32,}/ },
  { name: 'Stripe secret key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: 'Notion token', re: /\b(?:secret|ntn)_[A-Za-z0-9]{40,}/ },
  { name: 'Sentry token', re: /\bsntry[su]_[A-Za-z0-9+/=_-]{40,}/ },
  { name: 'Zapier MCP URL', re: /mcp\.zapier\.com\/api\/mcp\/s\/[A-Za-z0-9_=-]{16,}/ },
])

/** Values shorter than this are not scanned for literally: a stray "1" or
 *  "abc" in an env file would otherwise match all over a minified bundle. */
const MIN_VALUE_LENGTH = 12

function present(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Names of the secret variables that hold a value in `env`. */
export function secretsInEnv(env) {
  return SECRET_ENV_VARS.filter((name) => present(env?.[name]))
}

/** The message `vite build` fails with, or null when no secret is set. */
export function buildRefusal(env) {
  const names = secretsInEnv(env)
  if (names.length === 0) return null
  return [
    `Refusing to build: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} set.`,
    'Vite would copy the value into the JavaScript it builds, where anyone who opens',
    'the page can read it. Built JARVIS keeps keys behind the bridge instead:',
    '  - ElevenLabs: paste the key in Settings → Voice, or set ELEVENLABS_API_KEY',
    '    (no VITE_ prefix) for the bridge;',
    '  - Claude: your subscription needs no key; for an API key use Settings → Brain;',
    '  - MCP servers: add them to your Claude Code MCP config, which the bridge uses.',
    'The browser-direct demo still reads these in `npm run dev` only.',
    'Remove them from .env, .env.local and .env.production(.local) and from the shell, then build again.',
    'See "Keys behind the bridge" in README.md.',
  ].join('\n')
}

/** Minimal dotenv reader: KEY=value lines, optional `export`, quotes, # comments. */
export function parseDotenv(text) {
  const out = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1))
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out[m[1]] = value
  }
  return out
}

/**
 * Finds secrets in one file's text. `values` maps variable names to the
 * values to look for literally (from the env files and the shell).
 * Returns `[{ kind: 'value' | 'pattern', name }]`, without the secret itself.
 */
export function scanText(text, values = {}) {
  const findings = []
  for (const [name, value] of Object.entries(values)) {
    if (!present(value)) continue
    const v = value.trim()
    if (v.length < MIN_VALUE_LENGTH) continue
    if (text.includes(v)) findings.push({ kind: 'value', name })
  }
  for (const { name, re } of KEY_PATTERNS) {
    if (re.test(text)) findings.push({ kind: 'pattern', name })
  }
  return findings
}

/** The values worth looking for: every secret variable set in any of `envs`
 *  (later wins), with and without the VITE_ prefix (the bridge's own
 *  ELEVENLABS_API_KEY and ANTHROPIC_API_KEY must not leak either). */
export function secretValues(...envs) {
  const names = [
    ...SECRET_ENV_VARS,
    ...SECRET_ENV_VARS.map((n) => n.replace(/^VITE_/, '')),
  ]
  const out = {}
  for (const env of envs) {
    for (const name of names) {
      if (present(env?.[name])) out[name] = env[name]
    }
  }
  return out
}
