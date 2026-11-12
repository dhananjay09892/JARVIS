# Changelog

What changed in each version of JARVIS, written for the people who use it. Numbers in
brackets are the pull requests on GitHub where each change was made.

## 0.3.0

Everything since 0.2.3.

### Read this first

- **Most of what is new has only been checked against stand-ins.** The agents, the connectors,
  Telegram and speaker recognition were built and tested with recorded data and a stand-in for
  the AI model, not with real accounts or a live model. They may behave differently for you.
  If one does, please [open an issue](https://github.com/dhananjay09892/JARVIS/issues).
- **Nothing new acts on its own until you turn it on.** Anything that runs without being asked,
  reads an account, or sends a message is off until you switch it on in Settings. The two
  exceptions, both under Settings → Alerts, are listed below.
- The Windows installer is still not code-signed, so Windows shows "Windows protected your PC".
  Choose **More info**, then **Run anyway**.

### New

**Agents** (Settings → Agents) [102–107, 110–112, 115–117, 120–122, 125–127, 130–132, 134, 135, 137–139, 142, 143]

- JARVIS now has named agents that do a job in the background and report back. Twelve come
  with the app: Coordinator, Researcher, Writer, Reviewer, Coder, Inbox Triager, Morning
  Briefing, Memory Curator, Watcher, Meeting Notes, Browser Operator and Translator.
- Ask for one by name, or just say what you need and JARVIS picks one that is switched on.
- You can make your own from a template or by describing it. An agent JARVIS drafts is saved
  only if you approve it.
- Agents that run without being asked (on a schedule, when something happens, or continuously)
  are **off until you switch them on**, and switching one on asks you to confirm. That covers
  the Inbox Triager, Morning Briefing, Memory Curator, Watcher and Meeting Notes agents.
- The screen has a switch for each agent, its recent runs and cost, and **Pause all agents**.
  You can set how many run at once, how far one agent may hand work to another, and a default
  budget.
- **Suggest new agents** is on by default: JARVIS may propose an agent, at most once a day, and
  it waits under "Waiting for your approval". Turn it off in Settings → Agents.
- Background work has limits on tool calls, minutes, tokens and cost, with fixed upper bounds
  you cannot raise [144]. It can be paused and resumed without losing its plan, its log or
  what it has spent [140].

**Alerts and the morning briefing** (Settings → Alerts) [85, 86, 90]

- **Let JARVIS bring things up on his own** is **on by default**, with **Quiet hours** from
  22:00 to 07:00.
- **Morning briefing** is **on by default**. With nothing connected it tells you to add the
  weather or a calendar under Settings → Connectors. **Say who mail is from** is off.
- The briefing can be offered at a set time (off by default) and is available in Hindi and
  Gujarati.

**Recognising who is speaking** (Settings → People) [108, 113, 118, 128]

- Off by default. To enrol someone you give a name, tick a consent box and record eight
  seconds of speech. Voiceprints stay on your computer.
- A speaker model picker shows each model's size and licence. Changing the model means
  everyone enrols again.
- Each person can have a main language and a language JARVIS replies in [123].

**Connectors** (Settings → Connectors) [84, 87, 89, 91, 93, 96, 98, 103, 109, 114, 119, 124, 129, 133, 136, 141, 145]

All of these only read. None can send, change or delete anything.

- No account needed: Weather, News / RSS feeds, Hacker News.
- Your account: Google Contacts, Google Tasks, Email (IMAP), Outlook / Microsoft 365 mail,
  GitHub notifications, Dropbox, Oura Ring, Spotify (recently played), Strava, Granola.
- A file you choose: Apple Health (an export file).
- Mac only: Apple Calendar, Apple Contacts and Apple Notes read the Mac's own databases and
  need Full Disk Access. They report themselves unavailable on Windows.
- Some need something from you first: Strava needs an API application you create, Granola
  needs a Business or Enterprise plan to make a key, and GitHub's only permission for
  notifications is wider than reading (JARVIS only reads).

**Telegram** (Settings → Channels) [92, 94]

- Off by default. After you pair your own account you can message JARVIS; anyone else gets no
  reply.
- Sending `freeze` from chat, or pressing the freeze button in the HUD, stops JARVIS: every
  tool call is refused and the channels go silent.

**Smaller things**

- Settings → Context: an optional, off-by-default way to give JARVIS the time and basic
  system state with each request [97].
- First-run setup has more microphone and camera checks, and an opt-in count of where setup
  stops (**Count where setup stops**, off by default) [83].

### Safer and more reliable

- **The bridge now answers on this computer only.** It listens on the loopback addresses and
  no other [151].
- **Saving no longer fails when Windows briefly refuses it.** Settings, saved keys, voiceprints,
  schedules and agent files are saved by writing a new file and swapping it in; when another
  program has the file open for a moment, JARVIS now tries again [148, 152].
- **The installer now carries what speaker recognition needs.** Earlier builds would not have
  found it [153, 154].
- **The installer is checked before it is built.** A new step starts the packaged app with the
  packaged Node and makes sure everything it needs is inside the package [155].
- The installer ships the licence notices it must carry; see [LICENCES.md](LICENCES.md) [101].

### For people working on JARVIS

- `npm run verify` runs what the pull-request checks run: tests, lint and build [147].
- Every pull request is now tested on Windows and Linux, linted and built [146].
- A test starts the real bridge [150]; a test compares what the bridge imports with what the
  installer packages [153].
- The planning documents moved out of this repository [100].

### Known limits

- See "Read this first": the new features have not been tried with real accounts or a live
  model.
- Updating: starting this version on data written by 0.2.3 kept settings, a saved key,
  memories and a conversation in a check with the bridge alone. Running the new installer over
  an installed 0.2.3 has not been checked yet.
- The built page has no automated test of its own, and no test covers a spoken conversation.
- The three Apple connectors cannot work in the Windows app.
