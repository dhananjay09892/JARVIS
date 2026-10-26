/**
 * Fast/deep routing (plan 06, phase 2).
 *
 * Every turn that reaches a model is sent down one of two paths:
 *
 *   fast  small talk, thanks, a quick clarification: answered by a quicker
 *         model (Settings → Brain → Fast model), because waiting on the
 *         deep model's thinking for "thanks, that's all" is dead air.
 *   deep  anything that may need tools, reasoning, or care: the normal model.
 *
 * The decision is made on the bridge, from the owner's own words only (never
 * the memory context riding along), with plain rules and no model call, so it
 * costs nothing and is the same every time for the same words.
 *
 * When unsure it picks deep: misrouting a hard question to the fast model is
 * the risk in the plan, sending a simple one to the deep model only costs a
 * second. A short reply straight after a turn that used tools ("yes", "the
 * second one") also goes deep, because it is almost always the same task
 * carrying on.
 *
 * Both paths have the same tools behind the same policy engine: routing picks
 * a model, it never changes what JARVIS is allowed to do.
 *
 * Like traces.mjs this uses only Node built-ins, so it can be tested on its own.
 */

export const PATHS = ['fast', 'deep']

/**
 * Why a path was chosen; a trace may carry one of these, never the words.
 *   off        routing is turned off: every turn is deep
 *   chat       short small talk with nothing that needs tools or thought
 *   tools      asks for something JARVIS would need a tool for
 *   reasoning  asks why/how/explain, or for working something out
 *   long       too long to be small talk
 *   follow-up  a short reply right after a turn that used tools
 *   default    nothing clear either way, so the safe choice
 */
export const PATH_REASONS = ['off', 'chat', 'tools', 'reasoning', 'long', 'follow-up', 'default']

/** More words than this is never small talk. */
const LONG_WORDS = 24
/** At most this many words for the fast path without a small-talk match. */
const SHORT_WORDS = 8

// Words that point at a tool: the world outside the conversation, the screen,
// files, messages, memory, the camera, time-sensitive facts. Matched as whole
// words, case-insensitive.
const TOOL_WORDS = [
  // doing things
  'open', 'close', 'launch', 'start', 'run', 'play', 'pause', 'stop', 'show', 'display', 'put',
  'send', 'reply', 'forward', 'email', 'emails', 'mail', 'inbox', 'message', 'messages', 'text', 'call',
  'remind', 'reminder', 'reminders', 'schedule', 'calendar', 'meeting', 'meetings', 'event', 'events', 'book',
  'add', 'create', 'make', 'write', 'draft', 'save', 'delete', 'remove', 'move', 'rename', 'edit', 'update', 'change', 'set', 'turn',
  'file', 'files', 'folder', 'folders', 'document', 'documents', 'doc', 'docs', 'sheet', 'spreadsheet', 'pdf', 'drive',
  'code', 'repo', 'commit', 'build', 'install', 'download', 'upload',
  'task', 'tasks', 'todo', 'list', 'note', 'notes', 'workflow',
  // finding things out
  'search', 'find', 'look', 'lookup', 'google', 'browse', 'website', 'site', 'page', 'tab', 'link', 'url', 'chrome', 'browser',
  'weather', 'forecast', 'news', 'headlines', 'price', 'prices', 'stock', 'stocks', 'score', 'scores', 'traffic',
  'latest', 'current', 'currently', 'today', 'tonight', 'tomorrow', 'yesterday', 'week', 'recent',
  'remember', 'remembered', 'forget', 'memory', 'memories', 'earlier', 'last',
  'screen', 'camera', 'see', 'picture', 'photo', 'image', 'panel', 'window',
  'summarise', 'summarize', 'summary', 'read', 'check', 'research', 'translate', 'convert',
]

// Words that ask for thought rather than a quick line.
const REASONING_WORDS = [
  'why', 'explain', 'compare', 'difference', 'analyse', 'analyze', 'plan', 'design', 'debug',
  'calculate', 'compute', 'solve', 'prove', 'estimate', 'recommend', 'should', 'pros', 'cons', 'versus', 'vs',
  'step', 'steps', 'detail', 'detailed', 'thoroughly',
]

// Phrases that need thought though every word is ordinary.
const REASONING_PHRASES = [/\bhow (?:does|do|did|would|could|can|should|much|many|long|far)\b/, /\bwhat if\b/, /\bwhat(?:'s| is) the best\b/]

// Small talk: greetings, thanks, acknowledgements, the assistant itself, a joke.
const CHAT = [
  /^(?:hi|hello|hey|hiya|yo|morning|good (?:morning|afternoon|evening|night))\b/,
  /^(?:thanks|thank you|cheers|ta|nice|great|cool|perfect|awesome|brilliant|lovely|wonderful|excellent|good job|well done)\b/,
  /^(?:ok|okay|alright|all right|right|sure|fine|got it|understood|noted|fair enough|makes sense|i see)\b/,
  /^(?:yes|yeah|yep|no|nope|nah|maybe|exactly|indeed|of course)\b/,
  /^(?:sorry|my bad|never ?mind|forget it|no worries|no problem)\b/,
  /^(?:how are you|how's it going|how are things|what's up|you there|are you there|are you awake)\b/,
  /^(?:who are you|what's your name|what is your name|what can you do|are you (?:ok|okay|real|alive))\b/,
  /\b(?:tell me a joke|say something funny|make me laugh|joke)\b/,
  /^(?:i'm|i am) (?:back|home|here|tired|bored|hungry|off|leaving|going)\b/,
  /^(?:good ?bye|bye|see you|see ya|later|night night|talk later)\b/,
]

// The assistant itself, a joke, a greeting: chat even if a tool word appears
// ("how are you today" has "today" in it).
const CHAT_ONLY = [
  /^(?:how are you|how's it going|how are things)(?: (?:today|tonight|this morning|doing))?$/,
  /^(?:good (?:morning|afternoon|evening|night))(?: \w+)?$/,
  /^(?:thanks|thank you)(?: (?:so|very) much)?(?: for (?:that|this|everything|the help))?(?: \w+)?$/,
  /^(?:tell me a joke|tell me another(?: one)?|another joke|say something funny|make me laugh)$/,
]

const toolSet = new Set(TOOL_WORDS)
const reasoningSet = new Set(REASONING_WORDS)

/** Lower case, curly quotes straightened, punctuation that is not part of a word dropped. */
function tidy(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pick a path for one turn.
 *
 * @param {string} text  the owner's own words for this turn
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]          routing on (Settings → Brain → Fast/deep routing)
 * @param {boolean} [o.afterTools=false]      the previous turn used a tool
 * @returns {{ path: 'fast'|'deep', reason: string }}
 */
export function routeTurn(text, { enabled = true, afterTools = false } = {}) {
  if (!enabled) return { path: 'deep', reason: 'off' }
  const said = tidy(text)
  // A link, a file path or a number with units is never small talk.
  if (/https?:|www\.|\w\.(?:com|org|net|io|dev)\b|[/\\]\w/.test(String(text ?? ''))) return { path: 'deep', reason: 'tools' }
  if (!said) return { path: 'deep', reason: 'default' }
  const words = said.split(' ')
  if (words.length > LONG_WORDS) return { path: 'deep', reason: 'long' }

  if (CHAT_ONLY.some((re) => re.test(said)) && !afterTools) return { path: 'fast', reason: 'chat' }
  if (words.some((w) => toolSet.has(w.replace(/'s$/, '')))) return { path: 'deep', reason: 'tools' }
  if (words.some((w) => reasoningSet.has(w)) || REASONING_PHRASES.some((re) => re.test(said)) || /\d\s*[-+*/x×^%=]\s*\d/.test(String(text))) {
    return { path: 'deep', reason: 'reasoning' }
  }
  // "yes", "the second one", "do it" straight after a tool turn carry that task on.
  if (afterTools && words.length <= SHORT_WORDS) return { path: 'deep', reason: 'follow-up' }
  if (CHAT.some((re) => re.test(said))) return { path: 'fast', reason: 'chat' }
  // Anything else short and plain ("what's the capital of France") is chat;
  // the rest is the safe choice.
  if (words.length <= SHORT_WORDS) return { path: 'fast', reason: 'chat' }
  return { path: 'deep', reason: 'default' }
}

/**
 * The per-conversation router: remembers whether the last turn used a tool,
 * so a short follow-up stays on the deep path.
 */
export function createRouter() {
  let afterTools = false
  return {
    /** Decide the path for the next turn. */
    decide(text, { enabled = true } = {}) {
      return routeTurn(text, { enabled, afterTools })
    },
    /** A turn finished; note whether it used a tool. */
    turnEnded({ usedTools = false } = {}) {
      afterTools = Boolean(usedTools)
    },
  }
}

/**
 * Routing for one live conversation: decide the path, switch the session's
 * model if the path needs another one, and say which model will answer.
 *
 * Calls must not overlap (server.mjs runs them one at a time, in order); each
 * is made between turns, before the turn's words are handed to the brain.
 *
 * @param {object} o
 * @param {string}   o.deepModel   the conversation's main model (what the session started on)
 * @param {Function} o.fastModel   () => the fast model, read per turn
 * @param {Function} o.enabled     () => routing on, read per turn
 * @param {Function} o.setModel    async (model) => true if the session switched
 * @param {Function} [o.log]       where a failed switch is reported
 */
export function createTurnRouter({ deepModel, fastModel, enabled, setModel, log = () => {} }) {
  const router = createRouter()
  let current = deepModel

  const use = async (model) => {
    if (!model || model === current) return current
    try {
      if (await setModel(model)) current = model
    } catch (err) {
      log(`could not switch to ${model}: ${err?.message ?? err}`)
    }
    return current
  }

  return {
    /**
     * Route one turn. Resolves to { path, reason, model }: the model that will
     * answer. A fast turn whose switch failed is answered by the main model
     * and reported as deep, so a trace never claims a path it did not take.
     */
    async route(said) {
      const r = router.decide(said, { enabled: Boolean(enabled()) })
      const wanted = r.path === 'fast' ? fastModel() || deepModel : deepModel
      const model = await use(wanted)
      if (model !== wanted) return { path: model === deepModel ? 'deep' : 'fast', reason: 'default', model }
      return { ...r, model }
    },
    /** A turn finished; note whether it used a tool. */
    turnEnded: router.turnEnded,
    /** The model the session is on now. */
    get model() {
      return current
    },
  }
}
