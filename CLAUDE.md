# piano-by-ear

Headless learn-piano-by-ear drill for a MIDI controller (Node, no browser).
Prototype lineage: `../ear-training/` (the on-screen version whose adaptive
engine this ports). GitHub: calebjedhugo/piano-by-ear (public).

## Run

```bash
npm start -- --bpm 80 --tolerance 80 [--port keystation] [--debug-midi]
```

No MIDI device present at start is fine; `src/midi.js` polls every 2s.

## Layout

- `src/main.js`   CLI wiring (parseArgs), SIGINT shutdown.
- `src/drill.js`  State machine. IDLE -> first note = anchor -> QUESTION loop.
  Two bars per question: call (anchor beat 1, target beat 3), response
  (target expected bar 2 beat 3). Answer window opens half a beat before the
  expected onset; notes before it are free (playing along). 10s silence ends
  the session. All scheduling is on the AudioContext clock via a 25ms ticker
  that schedules 150ms ahead; MIDI `performance.now()` stamps are mapped to
  the audio clock with a fixed offset captured at startup.
- `src/engine.js` AdaptiveEngine, ported from ear-training with injected
  `store` instead of localStorage. "Response time" = |onset error| ms, so
  the fluency gate on mastery means "in time". `pitchClassOffset` keeps the
  key-color cells correct when index 0 isn't a C.
- `src/audio.js`  node-web-audio-api: additive piano voice, click, cues.
  Every incoming note-on is echoed here (the controller has no sounds).
- `src/range.js`  Per-port-name key range: guessed from a number in the port
  name, widened by observed notes, persisted in kv `ranges`. Applied at
  session start (engine is rebuilt per session with that range).
- `src/db.js`     node:sqlite. Tables `kv`, `sessions`, `attempts`.

## Testing without the keyboard

Drive `Drill.onNoteOn({note, velocity, at})` directly with
`at = (audioTime + drill.clockOffset) * 1000`, set `audio.master.gain.value = 0`,
and poll `drill.questions` / `drill.expectedAt` / `drill.target`. Wait for
`drill.questions` to increment before reading the next question's timing.

## Gotchas

- `@julusian/midi` has an install script; `npm install` may warn about
  allow-scripts. The prebuilt binary loads fine on macOS arm64.
- Timing tolerance is also the mastery threshold, so a tight `--tolerance`
  slows tier unlocking.
