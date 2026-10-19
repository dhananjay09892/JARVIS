# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

**Just want to use it?** Skip to [Install on Windows](#install-on-windows-no-setup-no-commands):
download one installer and run it.

---

## Install on Windows (no setup, no commands)

**1. Download the installer:**
[**JARVIS-Setup.exe**](https://github.com/dhananjay09892/JARVIS/releases/latest/download/JARVIS-Setup.exe)
(about 140 MB, Windows 10 or 11). Step-by-step pictures and help:
[jarvis.pateldhananjay.com](https://www.jarvis.pateldhananjay.com/).

**2. Double-click it and click Next, Install, Finish.** It installs just for you,
so there is no administrator prompt. Windows may show *"Windows protected your PC"*
because the installer is not code-signed yet: click **More info**, then
**Run anyway**.

**3. First start.** JARVIS opens in its own window and shows a short welcome:
**Sign in** with your Claude account (Claude Code is already included in the
installer — there is nothing else to install), optionally paste an ElevenLabs key
for a better voice (you can skip it), then click **INITIALISE**, allow the
microphone, and say **"Hey Jarvis"**.

That is all you need. You do **not** need Node.js, `npm`, git or a terminal.

**What you need besides the installer:** a Claude subscription, a microphone, and
Google Chrome or Microsoft Edge.

**Changing things later.** Click **SETTINGS** at the top right to add or remove the
ElevenLabs key, change the model and effort, or allow JARVIS to take real actions
(off by default). Model, effort and actions apply after you restart JARVIS.

**Updating.** When a newer version exists, an **UPDATE** button appears at the top
right. Download the new installer and run it; your settings and memories are kept.

**Uninstalling.** Windows **Settings → Apps → Installed apps → JARVIS → Uninstall**.
Your settings are kept in `%APPDATA%\JARVIS` and memories in
`%LOCALAPPDATA%\JARVIS`; delete those folders too to erase everything.

---

## Run from source (developers)

Everyone else can skip this section. Running from source needs Node.js, npm and
a terminal, and is for working on JARVIS itself.

### Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

### Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

On Windows, run `.\restart-jarvis.ps1` from PowerShell to stop the current
JARVIS bridge/dev-server listeners and start a fresh session. It only stops
listeners whose process ancestry identifies the JARVIS launcher; unrelated
processes on the same ports are left alone. Add `-Writes` only when you want
browser actions and other effectful tools enabled.
The restart script invokes Node directly, so npm does not need to be on the
new window's PATH. It checks for Node.js 20+ and installed dependencies before
stopping the current session.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.
- **Input language** can be selected in the HUD and is remembered in this
  browser. Auto-detect is the default and lets ElevenLabs Scribe identify
  English, Gujarati, or Hindi; you can also force one of those languages.
  JARVIS understands those inputs and replies and speaks in English. Without
  ElevenLabs, the browser's speech recognition uses the selected language; in
  auto-detect mode its fallback uses English.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### Launching Windows applications

Browser control through Claude in Chrome uses the extension's Windows named
pipe on Windows and its local Unix socket on macOS/Linux. Install and sign in
to the official Claude extension, then complete `claude --chrome` setup.
Restart JARVIS once the extension connection is active. This connector uses a
private native-host protocol that may change with extension updates.

Say "Open VS Code", "Open Chrome", "Open Notepad", or "Open Calculator".
The local `jarvis_apps` tool launches only these four approved applications
from their standard Windows installation locations, without shell commands,
URLs, file paths, or additional arguments. It is available in bridge mode
even with writes disabled; it does not grant filesystem or general command
execution permissions. A successful result confirms an OS launch request,
not that a window is ready. Missing installations and launch failures are
reported explicitly. Launching an app does not let JARVIS control it afterward.

Restart JARVIS after installing this update to load the tool.

### Dedicated development workspace

In bridge mode, `jarvis_workspace` can list, read, create, and edit text files
in `Documents\GitHub` under the current user's home directory.
This is available with general writes disabled. Paths must be relative and
include the repository name, for example `Created-By-Jarvis\src\main.js`;
traversal, symlinks/junctions, hard-linked files, `.git`, and `.env*` are blocked.
Text files are limited to 256 KiB. Editing requires the SHA-256 returned by a
fresh read, and creation will not overwrite an existing file.

The browser displays **Approve once / Reject** before every
`jarvis_development.run_command` call (PowerShell), including builds,
installations, commits, and pushes, and before single-file workspace deletion.
The dedicated `push_branch` tool displays an explicit repository working
directory, configured remote name, and destination branch; it does not offer
force pushing.
Deletion requires a fresh SHA-256; recursive deletion is not supported by the
file tool. Requests expire after 90 seconds and are rejected on interruption
or disconnection. Review the complete command and working directory; no
remembered approvals or model-generated approval messages are accepted.
Closing a card after approval does not stop an already-running command.

Keep general writes disabled to preserve this approval workflow; enabling
`-Writes` grants separate, broader capabilities. Built-in shell/edit/delegation
tools are disabled in restricted mode and the SDK pre-tool hook additionally
enforces the tool policy. Commands have a two-minute timeout and bounded output;
child processes they launch may outlive them. Code generated here is not
verified until an approved build/test actually succeeds.
Do not store secrets in files you ask JARVIS to read.
The combined launcher explicitly keeps general writes off unless started with
`--writes` (or `-Writes` in the restart script), even if the environment sets
`JARVIS_ALLOW_WRITES=1`. A general permission denial does not disable the
dedicated workspace tools.
Neither path checks nor command approvals are an OS sandbox. Approved commands
run under your account and can access other folders and stored credentials
(including `gh` authentication), delete files, or modify JARVIS itself. The
bridge does not pass its API-key environment to the command, but this cannot
prevent access to credentials on disk. Review build scripts as well as the
command before approval. File checks are not race-proof against concurrent
local filesystem manipulation. Editing the running agent's own code changes
the policy after restart; do not ask it to weaken its controls.

Hermes is a separate application, not yet connected to these approval cards.
For this local setup its file tools (patches can delete files),
command/execution/delegation, scheduled task, remote
connector, desktop-control and browser toolsets are disabled through
`agent.disabled_toolsets` in its local configuration. Restart any existing
Hermes sessions to apply that setting. Its default working directory and
`HERMES_WRITE_SAFE_ROOT` are set to the GitHub folder for future approved
integration; native file tools are currently disabled entirely.
That environment setting is not an OS sandbox for every possible plugin.
Do not re-enable disabled toolsets or use additional
MCP/plugins as an execution workaround until an approval bridge is implemented.

### Persistent memory

In bridge mode JARVIS keeps a local SQLite database (Node's built-in
`node:sqlite`; no extra package, service or API key) at
`%LOCALAPPDATA%\JARVIS\memory\jarvis-memory.sqlite`. It is outside the
repository, the frontend and any build output, and is never committed or sent
to an external service by JARVIS. Set `JARVIS_MEMORY_DIR` to move it, or
`JARVIS_MEMORY=off` to disable it.

- **Conversations.** Each conversation has a stable id kept in the browser's
  `localStorage`; the socket and the agent session are still disposable. After
  a refresh, reconnect or bridge restart the page reattaches to that
  conversation, redraws the recent transcript, and the bridge puts a bounded
  tail of it (about 2.6 KB, newest kept) into the first turn of the new agent
  session. The agent is **not** given the whole history, and its internal
  state from before the disconnect is gone. Replies are stored as `complete`
  only when the SDK reports success for a turn nobody interrupted; barge-ins
  are stored as `interrupted` with the text produced so far, errors as
  `failed`, and anything left over after a crash is marked `interrupted` on the
  next start. A retried turn id is ignored. **MEMORY → Conversations → New
  conversation**, or saying "start a new conversation", opens a fresh session
  and conversation; older ones stay.
- **Your memories.** Only what you ask for: "remember that…", "what do you
  remember about me", "show my saved memories", "forget…" (or use the MEMORY
  panel to add, edit and forget). Each has an id, source and date; repeats are
  de-duplicated; text that looks like a credential is refused.
- **Project journal.** The bridge records `write_file`, `delete_file`,
  `run_command` and `push_branch` calls per repository folder, from the real
  tool results rather than from what the model says. Statuses: `requested`
  (seen, no result yet; also used for the owner's request text),
  `completed` (the tool reported success), `verified` (a single, simple
  test/build/lint command such as `npm test` exited 0 — the exit code is all
  that is known, output is not parsed), `failed` (error, or not approved —
  nothing ran), and `interrupted` (the turn or connection ended first: the
  outcome is **unknown**, an approved command may still have run). File
  contents are never stored. Project facts you ask JARVIS to remember are
  scoped to one repository folder and are only retrieved when that project is
  the one being discussed.
- **Retrieval.** No embeddings and no summarising model. SQLite FTS5 keyword
  search picks a few matching memories, journal entries and snippets of past
  conversations, capped at roughly 2.5 KB per turn (6 KB when a session
  restores), skipping anything already shown to the current agent session. It
  can miss relevant items and can surface unrelated ones; it is not perfect
  recall. Retrieved text is placed in a `<jarvis_memory>` block labelled as
  data with provenance, and JARVIS is told to treat it as possibly stale and to
  read the actual files before stating facts about code.
- **Memory never grants permission.** The approval queue, command runner,
  workspace tools and tool policy do not read memory (a test enforces this),
  and no approval is stored. A remembered "approved npm test" authorizes
  nothing: each command, deletion and push needs a fresh browser approval.
  The memory tools can only read and edit the memory database.
- **Privacy and limits.** Anything retrieved is sent to the model provider as
  part of the prompt, like anything else you say. Credential filtering
  (`sk-…`, GitHub/Slack/AWS tokens, JWTs, `key=value` secrets, private-key
  blocks) is pattern-based: it will miss unusual secrets, so do not dictate
  them. Management uses the same origin-checked WebSocket as the rest of the
  UI; there is no HTTP endpoint for memory. Nothing is deleted automatically
  unless `JARVIS_MEMORY_RETENTION_DAYS` is set (conversations and journal only;
  your memories are kept). Forgetting uses SQLite `secure_delete`, so the text
  is overwritten in the file. Backups you make of the file are your own to
  manage. Without a browser, `localStorage` cleared means a new conversation
  starts, though the old one stays in the database. The Hermes agent has its
  own separate memory; nothing is shared or ingested from it, from email, or
  from repositories.

### Workflows

JARVIS can propose, edit and delete workflows by voice or chat, and run them on
demand or daily at a local time. A workflow is a stored recipe of up to 20
structured steps — `read_file` and `list_files` (read only, inside the
workspace rules) and `run_command` and `push_branch` (the same tools as above).
There are no free-form or self-modifying steps.

- **You approve every change to a recipe.** Creating, editing or deleting a
  workflow shows a card with the whole recipe (before and after for edits),
  with action steps marked. If you reject it, nothing is saved. Saving a recipe
  only stores it; it permits nothing.
- **Action steps ask on every run.** Each `run_command` / `push_branch` step of
  every run, scheduled or not, shows the exact command and working directory
  and needs a fresh Approve. Nothing is remembered or pre-approved. Read-only
  steps run without a card.
- **Away from the screen, a run waits.** A scheduled action step stays pending
  with no browser open and is shown to the first browser that connects; it
  expires after 24 hours and is then rejected, never skipped past. A rejected,
  failed or expired step stops the run (remaining steps are `skipped`).
- **Scheduling limits.** The scheduler lives in the bridge: workflows run only
  while it is running, checked every 30 seconds. A daily workflow starts once
  per local day, after its time (a late start the same day still runs it; a
  rejected run is not retried that day). A bridge restart marks any waiting or
  running run `interrupted`; it is not resumed.
- **Records.** Runs and per-step outcomes (`completed`, `failed`, `rejected`,
  `skipped`) are stored in `jarvis-workflows.sqlite` beside the memory
  database, with at most 300 characters of redacted command output per step.
  The MEMORY panel's Workflows tab lists them and can run, disable or delete a
  workflow yourself. `JARVIS_WORKFLOWS=off` disables the feature.
- Approved commands carry the same caveats as before: they run under your
  account, not in a sandbox. Review a recipe's commands as carefully as a
  one-off command, since later runs show the card again but you will have seen
  the same text before.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Copy `.env.example` to `.env.local` for
frontend settings. `npm start` also reads `ELEVENLABS_API_KEY` from that file
and passes it only to the local bridge process; it is not exposed to Vite or
the browser. `JARVIS_MODEL` and `JARVIS_EFFORT` can also be set there when using
`npm start`; shell environment values take precedence.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run; set in shell or `.env.local` for `npm start` |
| `JARVIS_EFFORT` | `high` | Reasoning effort; set in shell or `.env.local` for `npm start` |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_MEMORY` | on | `off` disables persistent memory |
| `JARVIS_MEMORY_DIR` | `%LOCALAPPDATA%\JARVIS\memory` | Where the memory database lives |
| `JARVIS_MEMORY_RETENTION_DAYS` | `0` (keep) | Delete conversations and journal older than N days at startup |
| `JARVIS_WORKFLOWS` | on | `off` disables workflows and the scheduler |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `JARVIS_HINDI_VOICE_ID` | `JARVIS_VOICE_ID` | Optional Hindi-capable ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag when using `npm start`. Add the key to
`.env.local` (or set `ELEVENLABS_API_KEY` in the environment), then restart
JARVIS. The combined launcher passes the key only to the bridge; it is not
compiled into the browser bundle. If running the bridge by itself with
`npm run bridge`, set the environment variable first, or:

- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json`; the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Disclaimer

JARVIS is an independent, free, non-commercial fan project. It is **not** made,
approved, endorsed or sponsored by Marvel, Disney, Anthropic or ElevenLabs.
The name J.A.R.V.I.S. is a tribute to Marvel's Iron Man stories; "Iron Man",
"J.A.R.V.I.S." and "Marvel" belong to their owners (including Marvel
Characters, Inc. and The Walt Disney Company), and no footage, images or voice
recordings from any film are included. "Claude" and "Claude Code" are Anthropic's,
"ElevenLabs" is ElevenLabs, Inc.'s; you use your own accounts under their terms.
Provided "as is" with no warranty. Rights holders with a concern: please open an
[issue](https://github.com/dhananjay09892/JARVIS/issues). Full text:
[DISCLAIMER.txt](DISCLAIMER.txt).

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
