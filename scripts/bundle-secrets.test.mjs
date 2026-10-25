// Q22 · Plan 25 phase 4: no provider key may reach the built front end.
// Key-shaped strings are assembled at run time so this file itself never
// contains one for a secret scanner to flag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SECRET_ENV_VARS,
  buildRefusal,
  parseDotenv,
  scanText,
  secretValues,
  secretsInEnv,
} from './bundle-secrets.mjs'
import { checkDist } from './check-bundle-secrets.mjs'

const fake = {
  anthropic: ['sk', 'ant', 'api03', 'A'.repeat(90)].join('-'),
  openai: ['sk', 'proj', 'b'.repeat(60)].join('-'),
  eleven: 'sk' + '_' + 'ab12'.repeat(12),
  github: 'ghp' + '_' + 'Z'.repeat(36),
  linear: 'lin' + '_api_' + 'q'.repeat(40),
  stripe: 'sk' + '_live_' + 'x'.repeat(30),
  notion: 'ntn' + '_' + 'n'.repeat(46),
  sentry: 'sntrys' + '_' + 'e'.repeat(60),
  zapier: 'https://mcp.zapier.com/api/mcp/s/' + 'Zt0k'.repeat(10) + '/mcp',
}

test('every VITE_ variable the front end reads as a credential is listed', () => {
  // src/config.ts is the one place the front end reads env vars. Any VITE_
  // name there ending in KEY, TOKEN or MCP_URL must be on the secret list.
  const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
  const read = new Set([...config.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)].map((m) => m[1]))
  const credentialLike = [...read].filter((n) => /(KEY|TOKEN|MCP_URL|SECRET)$/.test(n))
  assert.ok(credentialLike.length >= 5)
  for (const name of credentialLike) assert.ok(SECRET_ENV_VARS.includes(name), `${name} is not in SECRET_ENV_VARS`)
})

test('the front end reads credentials only through devSecret, and only in config.ts', async () => {
  const { readdirSync } = await import('node:fs')
  const srcDir = new URL('../src/', import.meta.url)
  const files = readdirSync(srcDir, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f))
  for (const file of files) {
    const text = readFileSync(new URL(String(file), srcDir), 'utf8')
    for (const name of SECRET_ENV_VARS) {
      const reads = text.split(`import.meta.env.${name}`).length - 1
      if (String(file).replace(/\\/g, '/') !== 'config.ts') {
        assert.equal(reads, 0, `${file} reads ${name}; credentials are read in src/config.ts only`)
        continue
      }
      const gated = text.split(`devSecret(import.meta.env.${name})`).length - 1
      assert.equal(gated, reads, `src/config.ts reads ${name} without devSecret`)
    }
  }
})

test('the build is refused while any secret is set, and the message never contains it', () => {
  assert.equal(buildRefusal({}), null)
  assert.equal(buildRefusal({ VITE_BACKEND: 'direct', VITE_TTS_ENGINE: 'kokoro' }), null)
  assert.equal(buildRefusal({ VITE_ANTHROPIC_API_KEY: '   ' }), null, 'blank counts as unset')
  const msg = buildRefusal({ VITE_ANTHROPIC_API_KEY: fake.anthropic, VITE_NOTION_TOKEN: fake.notion })
  assert.match(msg, /Refusing to build: VITE_ANTHROPIC_API_KEY, VITE_NOTION_TOKEN are set/)
  assert.ok(!msg.includes(fake.anthropic) && !msg.includes(fake.notion))
  assert.deepEqual(secretsInEnv({ VITE_HOMEASSISTANT_TOKEN: 't', VITE_BRIDGE_URL: 'ws://x' }), ['VITE_HOMEASSISTANT_TOKEN'])
})

test('known key shapes are found', () => {
  for (const [kind, key] of Object.entries(fake)) {
    const findings = scanText(`var a="${key}";`)
    assert.equal(findings.length, 1, `${kind} not detected exactly once`)
    assert.equal(findings[0].kind, 'pattern')
    assert.ok(!JSON.stringify(findings).includes(key), 'findings never carry the key')
  }
})

test('ordinary bundle text is not flagged', () => {
  const benign = [
    'const ask = "sk-ant-api03-…"; // documented placeholder',
    'apiKey: env.anthropicKey, dangerouslyAllowBrowser: true',
    'https://mcp.notion.com/mcp https://api.githubcopilot.com/mcp/',
    'className="task-list secret_sauce" data-disk="sk_cache"',
    'https://mcp.zapier.com -> New MCP Server',
    'xi-api-key',
  ].join('\n')
  assert.deepEqual(scanText(benign), [])
})

test('literal values from env files are found even with no known shape', () => {
  const values = secretValues({ VITE_HOMEASSISTANT_TOKEN: 'fake-home-assistant-test-value' }, { ELEVENLABS_API_KEY: 'not-a-known-shape-123' })
  assert.deepEqual(Object.keys(values).sort(), ['ELEVENLABS_API_KEY', 'VITE_HOMEASSISTANT_TOKEN'])
  const findings = scanText('x="fake-home-assistant-test-value";y="not-a-known-shape-123"', values)
  assert.deepEqual(findings.map((f) => f.name).sort(), ['ELEVENLABS_API_KEY', 'VITE_HOMEASSISTANT_TOKEN'])
  // Short values are skipped: they would match all over minified code.
  assert.deepEqual(scanText('abc', { VITE_LINEAR_TOKEN: 'abc' }), [])
})

test('dotenv parsing handles comments, quotes and export', () => {
  const env = parseDotenv([
    '# comment',
    'VITE_A=plain # trailing',
    'export VITE_B="quoted value"',
    "VITE_C='single'",
    'VITE_D=',
    'not a line',
  ].join('\n'))
  assert.deepEqual(env, { VITE_A: 'plain', VITE_B: 'quoted value', VITE_C: 'single', VITE_D: '' })
})

test('checkDist scans a built tree and reports file and kind only', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-q22-'))
  try {
    const dist = join(root, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<script src="/assets/index.js"></script>')
    writeFileSync(join(dist, 'assets', 'index.js'), 'console.log("clean")')
    writeFileSync(join(dist, 'assets', 'logo.png'), fake.eleven) // binary types are skipped
    assert.deepEqual(checkDist(dist, { root, env: {} }), [])

    writeFileSync(join(root, '.env.local'), 'VITE_SENTRY_TOKEN=custom-sentry-token-value\n')
    writeFileSync(join(dist, 'assets', 'chunk.js'), `a="custom-sentry-token-value";b="${fake.anthropic}"`)
    const findings = checkDist(dist, { root, env: {} })
    assert.deepEqual(
      findings.map((f) => [f.file.replace(/\\/g, '/'), f.kind, f.name]),
      [
        ['dist/assets/chunk.js', 'value', 'VITE_SENTRY_TOKEN'],
        ['dist/assets/chunk.js', 'pattern', 'Anthropic API key'],
      ],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
