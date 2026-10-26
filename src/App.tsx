import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, diag as voiceDiag, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, diag as ttsDiag, setQuickStart, warmVoice } from './lib/tts'
import * as trace from './lib/trace'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  watchConversation,
  newConversation,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { getSettings } from './lib/settings'
import {
  answerReflex,
  familyOf,
  matchReflex,
  reflexesEnabled,
  setReflexesEnabled,
  timerDoneLine,
  type Reflex,
  type TimerView,
} from './lib/reflex'
import { browserTimers, type Timers } from './lib/timers'
import { getVolume, setVolume } from './lib/volume'
import { env } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** Starting over, by voice. Anchored so a sentence merely mentioning it is not taken as the command. */
const NEW_CONVERSATION = /^\s*(?:please\s+)?(?:start|begin|open)\s+(?:a\s+)?(?:new|fresh)\s+(?:conversation|chat)[\s.!?]*$/i
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

/** A finished timer chimes again this often, until stopped or for RING_FOR_MS at most. */
const RING_EVERY_MS = 4000
const RING_FOR_MS = 60_000

/** Reflex answers use the browser's English clock style; other languages get British English until plan 28. */
const reflexLocale = () => {
  const l = typeof navigator !== 'undefined' ? navigator.language : ''
  return /^en\b/i.test(l) ? l : 'en-GB'
}

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  /** Kitchen timers (reflex layer, plan 06). Created at boot, once sound is allowed. */
  const timers = useRef<Timers | null>(null)
  /** The repeating chime of a finished timer, and what he says about it. */
  const ringTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const alarmVoice = useRef<ReturnType<typeof createSpeaker> | null>(null)
  /** When a timer last finished, so "stop the timer" just after still means it. 0 once dealt with. */
  const lastRang = useRef(0)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Stop a finished timer's chime and announcement. It still counts as "ringing" for a minute. */
  const quietAlarm = () => {
    if (ringTimer.current) clearInterval(ringTimer.current)
    ringTimer.current = null
    alarmVoice.current?.cancel()
    alarmVoice.current = null
  }

  /** A timer finished: chime until stopped (a minute at most), and say which one when he is free. */
  const onTimerDone = (t: TimerView) => {
    quietAlarm()
    lastRang.current = Date.now()
    const line = timerDoneLine(t)
    const s = store.getState()
    s.pushTurn({ id: newId(), role: 'jarvis', text: line })
    sfx.play('alarm')
    const since = Date.now()
    ringTimer.current = setInterval(() => {
      if (Date.now() - since >= RING_FOR_MS) quietAlarm()
      else sfx.play('alarm')
    }, RING_EVERY_MS)
    // Mid-answer, the chime and the transcript line are enough; talking over
    // his own answer helps nobody.
    if (s.phase === 'dormant' || s.phase === 'listening' || s.phase === 'waking') {
      const spk = createSpeaker()
      alarmVoice.current = spk
      spk.say(line)
      void spk.end()
    }
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- reflexes (plan 06 phase 1) -------------------------------------------

  /**
   * Answer a quick command on the page: no model call, no bridge, no network.
   * Traced on route 'reflex' so Diagnostics can show they skip the model.
   */
  const runReflex = async (
    r: Reflex,
    spk: ReturnType<typeof createSpeaker>,
    stale: () => boolean,
  ): Promise<void> => {
    const s = store.getState()
    trace.beginTurn('reflex', { stt: voiceDiag.engine, tts: ttsDiag.engine, reflex: familyOf(r) })
    let failure: string | null = null
    let then: 'listen' | 'dormant' = 'listen'
    try {
      const turns = s.turns
      let lastAnswer = ''
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role === 'jarvis' && turns[i].text.trim()) {
          lastAnswer = turns[i].text
          break
        }
      }
      const a = answerReflex(r, {
        now: new Date(),
        lastAnswer,
        volume: getVolume(),
        timers: timers.current?.list() ?? [],
        ringing: lastRang.current > 0 && Date.now() - lastRang.current < RING_FOR_MS,
        locale: reflexLocale(),
      })
      then = a.then
      if (a.silence) {
        quietAlarm()
        lastRang.current = 0
      }
      if (a.cancelTimers) timers.current?.cancel(a.cancelTimers)
      if (a.startTimer && !timers.current?.start(a.startTimer.ms, a.startTimer.label)) {
        throw new Error('The timer could not be set.')
      }
      // A new volume is heard on the confirmation; "muted" is said before going quiet.
      if (a.volume && !a.volume.muted) setVolume(a.volume)
      if (a.say) {
        s.pushTurn({ id: newId(), role: 'jarvis', text: a.say })
        s.setPhase('speaking')
        spk.say(a.say)
        await spk.end()
      }
      if (a.volume?.muted) setVolume(a.volume)
    } catch (err) {
      failure = err instanceof Error ? err.message : 'error'
      if (!stale()) {
        sfx.play('error')
        store.getState().setError(failure)
      }
    } finally {
      if (!stale()) {
        trace.endTurn(failure === null ? 'ok' : 'error', failure ?? undefined)
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        if (then === 'dormant') goDormant()
        else listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    // The cloud voice's connection opens while the model thinks, not after.
    warmVoice()
    sfx.duck(true)
    music.duck(true)

    // "Start a new conversation" is the owner managing memory, not a question.
    // Handled here so it works the same whether or not the model is reachable.
    if (usingBridge && NEW_CONVERSATION.test(said)) {
      try {
        await newConversation()
        store.getState().setTurns([])
        history.current = []
        spk.say('A new conversation has begun. The previous one remains in local history.')
        await spk.end()
      } catch (err) {
        store.getState().setError(err instanceof Error ? err.message : 'Could not start a new conversation.')
      } finally {
        if (!stale()) {
          speaker.current = null
          sfx.duck(false)
          music.duck(false)
          s.setPhase('listening')
          listen(FOLLOW_UP_MS)
        }
      }
      return
    }

    // Quick commands: stop, volume, timers, the time and date, "say that again".
    // Only whole-utterance matches; everything else goes on to the model.
    const reflex = reflexesEnabled() ? matchReflex(said) : null
    if (reflex) {
      await runReflex(reflex, spk, stale)
      return
    }

    const turnId = newId()
    let started = false
    let filled = false
    let failure: string | null = null

    // One timing record per turn (lib/trace.ts). Opened here, after the
    // "new conversation" shortcut, so only real turns are measured.
    trace.beginTurn(usingBridge ? 'bridge' : 'direct', {
      stt: voiceDiag.engine,
      tts: ttsDiag.engine,
    })

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          trace.mark('firstToken')
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          trace.noteTool(name)
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      failure = err instanceof Error ? err.message : 'error'
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      // A stale turn was talked over; the next turn (or the barge-in) closes it.
      if (!stale()) trace.endTurn(failure === null ? 'ok' : 'error', failure ?? undefined)
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    // Saying his name is attention enough for a ringing timer.
    quietAlarm()
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    // Talking is how you answer a ringing timer, as with any other sound he makes.
    quietAlarm()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      trace.endTurn('interrupted')
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  /**
   * The user is mid-thought. The stand-down timer was armed when the window
   * opened, not when they started talking, so a long sentence begun late in the
   * window would otherwise run out the clock and drop him to standby halfway
   * through it. Push the deadline out for as long as there is activity.
   */
  const onActivity = () => {
    if (!idleTimer.current) return
    const phase = store.getState().phase
    if (phase !== 'listening' && phase !== 'waking') return
    clearIdle()
    idleTimer.current = setTimeout(goDormant, AWAIT_SPEECH_MS)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError(
            'Bridge reconnected on a fresh session. Recent history is reloaded from local memory when it is saved.',
          )
      }
    })
    // After a refresh the page has no transcript but the bridge may hold the
    // conversation. Redraw what was stored, with partial replies marked so an
    // interrupted answer is never shown as a finished one.
    watchConversation((frame) => {
      const st = store.getState()
      if (st.turns.length > 0) return
      st.setTurns(
        frame.messages
          .filter((m) => m.status !== 'pending' && m.text)
          .slice(-6)
          .map((m) => ({
            id: `stored-${m.id}`,
            role: m.role === 'user' ? ('user' as const) : ('jarvis' as const),
            text:
              m.status === 'interrupted'
                ? `${m.text} [interrupted]`
                : m.status === 'failed'
                  ? `${m.text} [failed]`
                  : m.text,
          })),
      )
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key for direct mode — set VITE_ANTHROPIC_API_KEY in .env.local (npm run dev only), or use the bridge.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // Offline wake word on or off, and how easily it wakes (Settings, plan 02).
    // An unreachable bridge leaves both at their defaults: offline, medium.
    const wakeSettings = await getSettings().catch(() => null)
    // Quick start (plan 05 phase 2): on unless turned off in Settings → Voice.
    setQuickStart(wakeSettings?.JARVIS_QUICK_START !== '0')
    // Quick commands (plan 06): on unless turned off in Settings → Voice.
    setReflexesEnabled(wakeSettings?.JARVIS_REFLEXES !== '0')
    // Timers from before a reload come back now that sound is allowed.
    timers.current ??= browserTimers(onTimerDone)

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      wakeEngine: wakeSettings?.JARVIS_WAKE_WORD || undefined,
      wakeSensitivity: wakeSettings?.JARVIS_WAKE_SENSITIVITY || undefined,
      language: () => store.getState().language,
      onWake,
      onSpeechStart,
      onActivity,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })
    store.getState().setWakeListening(voice.current.wakeEngine())

    store.getState().setPhase('dormant')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.language !== previous.language) {
          voice.current?.setLanguage(state.language)
        }
      }),
    [],
  )

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
