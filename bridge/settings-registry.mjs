/**
 * The settings registry (plan 39, phase 1): every user setting JARVIS has,
 * declared once. The store (settings.mjs), the HTTP API (`GET /settings/schema`,
 * `PATCH /settings`), the Settings page and the tests all read from this list,
 * so adding a setting for a future plan means adding one entry here.
 *
 * Each entry:
 *   id         storage key, and the environment variable that overrides it
 *   section    one of SECTIONS below (the left rail of the future Settings shell)
 *   label      short name shown in the UI
 *   help       one plain-language sentence: what it does and what data it touches
 *   type       'string' | 'enum' | 'boolean' | 'secret'
 *   options    allowed values, for 'enum'
 *   pattern    allowed shape, for 'string' and 'secret'
 *   default    effective value when nothing is set ('' for secrets: no default)
 *   scope      'global' | 'person' | 'device' ('person' settings are the owner's
 *              until speaker profiles exist, plans 01/30)
 *   risk       'normal' | 'sensitive' | 'dangerous'
 *   apply      when a change takes effect (plan 39 phase 4):
 *                'live'       at once; the subsystem listens for the change
 *                'reconnect'  from the next conversation or task; nothing
 *                             already running is switched mid-answer
 *                'restart'    after JARVIS restarts (the Settings banner)
 *   visibleIn  'simple' | 'advanced'
 *
 * Values are stored as strings, exactly as before the registry existed;
 * booleans are '1' / '0'. This file holds no state and no secrets.
 */

export const SECTIONS = Object.freeze([
  { id: 'brains', label: 'Brains' },
  { id: 'voice', label: 'Voice and hearing' },
  { id: 'languages', label: 'Languages' },
  { id: 'people', label: 'People and voices' },
  { id: 'safety', label: 'Safety and permissions' },
  { id: 'connectors', label: 'Connectors and tools' },
  { id: 'memory', label: 'Memory and privacy' },
  { id: 'alerts', label: 'Alerts and routines' },
  { id: 'channels', label: 'Channels' },
  { id: 'devices', label: 'Devices and rooms' },
  { id: 'context', label: 'Context and capture' },
  { id: 'costs', label: 'Costs and limits' },
  { id: 'display', label: 'Display and accessibility' },
  { id: 'system', label: 'System' },
  { id: 'diagnostics', label: 'Diagnostics' },
])

const TYPES = ['string', 'enum', 'boolean', 'secret']
const SCOPES = ['global', 'person', 'device']
const RISKS = ['normal', 'sensitive', 'dangerous']
const APPLY = ['live', 'restart', 'reconnect']
const VISIBLE = ['simple', 'advanced']

const DEFS = [
  {
    id: 'ELEVENLABS_API_KEY',
    section: 'voice',
    label: 'ElevenLabs API key',
    help: 'Optional. Gives JARVIS a better voice and sharper hearing; speech audio is then sent to ElevenLabs. The key stays on this computer.',
    type: 'secret',
    pattern: /^[\w-]{8,200}$/,
    default: '',
    risk: 'sensitive',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_VOICE_ID',
    section: 'voice',
    label: 'ElevenLabs voice',
    help: 'The ElevenLabs voice ID JARVIS speaks with when a key is set.',
    type: 'string',
    pattern: /^[\w-]{8,64}$/,
    default: 'JBFqnCBsd6RMkjVDRZzb',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_WAKE_WORD',
    section: 'voice',
    label: 'Offline wake word',
    help: 'On (offline): JARVIS listens for "Hey Jarvis" on this computer, and audio heard while he is asleep stays here. Off (cloud): asleep audio is sent to a speech service to find his name.',
    type: 'enum',
    options: ['offline', 'cloud'],
    default: 'offline',
    risk: 'sensitive',
    apply: 'restart',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_WAKE_SENSITIVITY',
    section: 'voice',
    label: 'Wake sensitivity',
    help: 'How easily the offline wake word triggers. High wakes on a quieter or less clear "Hey Jarvis" but wakes by mistake more often (a TV, for example).',
    type: 'enum',
    options: ['low', 'medium', 'high'],
    default: 'medium',
    risk: 'normal',
    apply: 'restart',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_QUICK_START',
    section: 'voice',
    label: 'Quick start',
    help: 'Start speaking at the first phrase of an answer instead of waiting for the whole first sentence, and open the ElevenLabs connection while JARVIS thinks. Off: whole sentences only.',
    type: 'boolean',
    default: '1',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_REFLEXES',
    section: 'voice',
    label: 'Quick commands',
    help: 'Answer stop, volume, timers, the time and date, and "say that again" instantly on this computer, without asking the AI. Off: every request goes to the AI.',
    type: 'boolean',
    default: '1',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_MODEL',
    section: 'brains',
    label: 'Model',
    help: 'The Claude model that answers. Smaller models reply faster; larger ones think harder.',
    type: 'string',
    pattern: /^[\w.-]{1,80}$/,
    default: 'claude-opus-5',
    risk: 'normal',
    apply: 'reconnect',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_EFFORT',
    section: 'brains',
    label: 'Effort',
    help: 'How hard the model thinks before answering. Higher is better quality and slower to reply.',
    type: 'enum',
    options: ['low', 'medium', 'high', 'xhigh'],
    default: 'high',
    risk: 'normal',
    apply: 'reconnect',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_ROUTING',
    section: 'brains',
    label: 'Fast/deep routing',
    help: 'Answer small talk and quick questions with the fast model, and anything that may need tools or thought with the main model. Off: every turn uses the main model. Claude only.',
    type: 'boolean',
    default: '1',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_FAST_MODEL',
    section: 'brains',
    label: 'Fast model',
    help: 'The Claude model for small talk and quick questions when fast/deep routing is on. Same tools and the same safety rules as the main model.',
    type: 'string',
    pattern: /^[\w.-]{1,80}$/,
    default: 'claude-sonnet-5',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_CLAUDE_AUTH',
    section: 'brains',
    label: 'Claude sign-in',
    help: 'How Claude is paid for. Subscription (the default) uses your own Claude plan through Anthropic\'s sign-in. API key uses your own Anthropic API key instead and is billed to that key\'s account.',
    type: 'enum',
    options: ['subscription', 'apikey'],
    default: 'subscription',
    risk: 'sensitive',
    apply: 'reconnect',
    visibleIn: 'simple',
  },
  {
    id: 'ANTHROPIC_API_KEY',
    section: 'brains',
    label: 'Claude API key',
    help: 'Optional. Your own Anthropic API key, used only when Claude sign-in is set to API key; usage is billed to that key. The key stays on this computer.',
    type: 'secret',
    pattern: /^sk-ant-[\w-]{16,300}$/,
    default: '',
    risk: 'sensitive',
    apply: 'reconnect',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_BRAIN',
    section: 'brains',
    label: 'Brain',
    help: 'Which AI answers you. Claude (the default) runs on your Claude sign-in. OpenAI uses your own OpenAI API key or your ChatGPT plan instead (OpenAI sign-in): what you say, and what tools read for you, is then sent to OpenAI. Background tasks stay on Claude for now.',
    type: 'enum',
    options: ['claude', 'openai'],
    default: 'claude',
    risk: 'sensitive',
    apply: 'reconnect',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_OPENAI_AUTH',
    section: 'brains',
    label: 'OpenAI sign-in',
    help: 'How the OpenAI brain is paid for. API key (the default) uses your own OpenAI API key, billed to that key. Sign in with ChatGPT uses your own ChatGPT plan instead; JARVIS never switches between them on its own.',
    type: 'enum',
    options: ['apikey', 'chatgpt'],
    default: 'apikey',
    risk: 'sensitive',
    apply: 'reconnect',
    visibleIn: 'simple',
  },
  {
    id: 'OPENAI_API_KEY',
    section: 'brains',
    label: 'OpenAI API key',
    help: 'Optional. Your own OpenAI API key, used only when Brain is set to OpenAI; usage is billed to that key. The key stays on this computer.',
    type: 'secret',
    pattern: /^sk-[\w-]{20,300}$/,
    default: '',
    risk: 'sensitive',
    apply: 'reconnect',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_OPENAI_MODEL',
    section: 'brains',
    label: 'OpenAI model',
    help: 'The OpenAI model that answers when Brain is set to OpenAI.',
    type: 'string',
    pattern: /^[\w.:-]{1,80}$/,
    default: 'gpt-5-mini',
    risk: 'normal',
    apply: 'reconnect',
    visibleIn: 'advanced',
  },
  // The language profile (plan 28 phase 2, Q30). Scope 'person': each person
  // will have their own once speaker profiles exist (plan 01); until then they
  // are the owner's. See bridge/language-profile.mjs.
  {
    id: 'JARVIS_LANG_PRIMARY',
    section: 'languages',
    label: 'Main language',
    help: 'The language you mostly speak. JARVIS answers in it unless the reply setting says otherwise.',
    type: 'enum',
    options: ['en', 'gu', 'hi'],
    default: 'en',
    scope: 'person',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_LANG_SECONDARY',
    section: 'languages',
    label: 'Second language',
    help: 'Another language you speak, if any. JARVIS always understands English, Gujarati and Hindi; this helps him guess when a message mixes them.',
    type: 'enum',
    options: ['none', 'en', 'gu', 'hi'],
    default: 'none',
    scope: 'person',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_REPLY_LANGUAGE',
    section: 'languages',
    label: 'Reply language',
    help: 'Which language JARVIS answers in: your main language, the language you just used (mirror), or always one language. Spoken Gujarati or Hindi needs a voice that speaks it.',
    type: 'enum',
    options: ['primary', 'mirror', 'en', 'gu', 'hi'],
    default: 'primary',
    scope: 'person',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_TEXT_SCRIPT',
    section: 'languages',
    label: 'Gujarati and Hindi script',
    help: 'How Gujarati and Hindi replies are written: in their own script (native) or in Latin letters (roman).',
    type: 'enum',
    options: ['native', 'roman'],
    default: 'native',
    scope: 'person',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_ALERTS',
    section: 'alerts',
    label: 'Alerts',
    help: 'Lets JARVIS bring things up on his own (a finished task, a reminder), following quiet hours and who is in the room. Off drops every alert, even urgent ones.',
    type: 'boolean',
    default: '1',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_QUIET_HOURS',
    section: 'alerts',
    label: 'Quiet hours',
    help: 'From–to in this computer\'s local time, like 22:00-07:00, or "off". During quiet hours only urgent alerts are given; the rest wait until they end.',
    type: 'string',
    pattern: /^(off|([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)$/,
    default: '22:00-07:00',
    scope: 'person',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_BRIEFING',
    section: 'alerts',
    label: 'Morning briefing',
    help: 'Say "brief me" for the weather, today\'s calendar, new mail and what ran overnight, from the connectors you have set up. Say "skip" for the next part, "stop" to end it. Off: he says it is switched off.',
    type: 'boolean',
    default: '1',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_BRIEFING_MAIL',
    section: 'alerts',
    label: 'Say who mail is from',
    help: 'In the briefing, name up to three senders of new mail. Off: only how many new emails there are, since anyone in the room hears the briefing.',
    type: 'boolean',
    default: '0',
    scope: 'person',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_ALLOW_WRITES',
    section: 'safety',
    label: 'Let JARVIS take real actions',
    help: 'Off by default: JARVIS can look at things but changes nothing. When on, he can run commands, change files, and click and type in the browser; every action still passes the policy engine.',
    type: 'boolean',
    default: '0',
    risk: 'dangerous',
    apply: 'restart',
    visibleIn: 'simple',
  },
  {
    id: 'JARVIS_AUDIT',
    section: 'safety',
    label: 'Audit log',
    help: 'Keep a local, tamper-evident record of every policy decision and approval. Tool names and rules only, never what was said.',
    type: 'boolean',
    default: '1',
    risk: 'sensitive',
    apply: 'restart',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_TRACES',
    section: 'diagnostics',
    label: 'Turn traces',
    help: 'Record local timings for each turn so Diagnostics can show latency. Timings only, never what was said.',
    type: 'boolean',
    default: '1',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
  {
    id: 'JARVIS_SETUP_METRICS',
    section: 'diagnostics',
    label: 'Count where setup stops',
    help: 'Off unless you turn it on. Keeps, on this computer only, which setup step was reached and finished and what the microphone check found wrong (problem names like "muted", never audio or device names), so Diagnostics can show the completion rate. Turning it off deletes what was kept.',
    type: 'boolean',
    default: '0',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'simple',
  },
  {
    id: 'setupDone',
    section: 'system',
    label: 'Setup finished',
    help: 'Whether the first-run wizard has been completed. Turn off to see the wizard again.',
    type: 'boolean',
    default: '0',
    risk: 'normal',
    apply: 'live',
    visibleIn: 'advanced',
  },
]

/** Whether a stored (string) value is allowed for this setting. '' is never valid here; it means "clear". */
export function isValid(def, value) {
  if (typeof value !== 'string' || value === '') return false
  switch (def.type) {
    case 'enum':
      return Array.isArray(def.options) && def.options.includes(value)
    case 'boolean':
      return value === '0' || value === '1'
    default:
      return def.pattern instanceof RegExp && def.pattern.test(value)
  }
}

/**
 * Turn a value from a PATCH body into its stored form: a trimmed string, ''
 * (or null) to clear, and true/false for booleans. Returns undefined for a
 * value of the wrong type, which the caller rejects.
 */
export function normalise(def, raw) {
  if (raw === null) return ''
  if (def.type === 'boolean' && typeof raw === 'boolean') return raw ? '1' : '0'
  if (typeof raw !== 'string') return undefined
  return raw.trim()
}

/** Rules every entry must meet (plan 39 "Risks": section, default, help text, test). */
export function checkRegistry(defs) {
  const problems = []
  const seen = new Set()
  const sections = new Set(SECTIONS.map((s) => s.id))
  for (const d of defs) {
    const at = d?.id ?? '(no id)'
    if (typeof d?.id !== 'string' || !/^[A-Za-z][\w]{0,63}$/.test(d.id)) problems.push(`${at}: bad id`)
    if (seen.has(d.id)) problems.push(`${at}: duplicate id`)
    seen.add(d.id)
    if (!sections.has(d.section)) problems.push(`${at}: unknown section ${d.section}`)
    if (!d.label?.trim()) problems.push(`${at}: missing label`)
    if (!d.help?.trim()) problems.push(`${at}: missing help`)
    if (!TYPES.includes(d.type)) problems.push(`${at}: unknown type ${d.type}`)
    if (d.type === 'enum' && !(Array.isArray(d.options) && d.options.length)) problems.push(`${at}: enum needs options`)
    if ((d.type === 'string' || d.type === 'secret') && !(d.pattern instanceof RegExp)) problems.push(`${at}: needs a pattern`)
    if (!SCOPES.includes(d.scope)) problems.push(`${at}: unknown scope ${d.scope}`)
    if (!RISKS.includes(d.risk)) problems.push(`${at}: unknown risk ${d.risk}`)
    if (!APPLY.includes(d.apply)) problems.push(`${at}: unknown apply ${d.apply}`)
    if (!VISIBLE.includes(d.visibleIn)) problems.push(`${at}: unknown visibleIn ${d.visibleIn}`)
    if (d.type === 'secret') {
      if (d.default !== '') problems.push(`${at}: a secret has no default`)
    } else if (TYPES.includes(d.type) && !isValid(d, d.default)) {
      problems.push(`${at}: default does not validate`)
    }
  }
  return problems
}

/** The registry, frozen. A broken entry stops the bridge at boot rather than misbehaving later. */
export const REGISTRY = Object.freeze(
  DEFS.map((d) => Object.freeze({ scope: 'global', ...d, secret: d.type === 'secret' })),
)
{
  const problems = checkRegistry(REGISTRY)
  if (problems.length) throw new Error(`settings registry: ${problems.join('; ')}`)
}

const BY_ID = new Map(REGISTRY.map((d) => [d.id, d]))

export function settingDef(id) {
  return BY_ID.get(id)
}

/** The built-in default for a setting, or undefined when it has none. */
export function settingDefault(id) {
  return BY_ID.get(id)?.default || undefined
}

/**
 * What `GET /settings/schema` serves: everything the UI needs to draw a
 * control, and nothing it should not see. Patterns go out as source strings
 * so a form can hint before saving; the bridge still validates every write.
 */
export function settingsSchema() {
  return {
    v: 1,
    sections: SECTIONS.map((s) => ({ ...s })),
    settings: REGISTRY.map((d) => ({
      id: d.id,
      section: d.section,
      label: d.label,
      help: d.help,
      type: d.type,
      ...(d.options ? { options: [...d.options] } : {}),
      ...(d.pattern ? { pattern: d.pattern.source } : {}),
      default: d.default,
      scope: d.scope,
      risk: d.risk,
      apply: d.apply,
      visibleIn: d.visibleIn,
      secret: d.secret,
    })),
  }
}
