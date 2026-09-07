# piano-by-ear

Headless learn-piano-by-ear drill for a MIDI controller (Node, no browser).
Prototype lineage: `../ear-training/` (the on-screen version whose adaptive
engine this ports). GitHub: calebjedhugo/piano-by-ear (public).

**IMPORTANT: the user interacts ONLY from the piano keyboard.** No musical
setting may become a flag; derive it from history or make it a keyboard
gesture. Every state change must be audible (see `src/audio.js`).

## Run

Normal use is the macOS launcher, `launcher/` -> `/Applications/Piano by
Ear.app` (`launcher/build.sh` rebuilds it; rerun after editing the
AppleScript, `pbe.sh` or `icon.py`). Click when stopped: admin dialog to
disable lid sleep (Cancel leaves it), then start; click when running: Free
play / Drill (switch mode), Switch user, Restart, End drill (End re-enables
sleep), and, only with no MIDI port present, the "Use keyboard keys" toggle
(`pbe.sh keys on|off`; then `start` opens `run-in-terminal.command` so
`src/keys.js` can read the computer keyboard, in drill or free play; the
drill then uses `<user>-keys.db`, a SEPARATE history, hidden from the user
list, and grades no holds from that port; `scripts/compare-surfaces.mjs`
compares piano vs keys per interval). It always boots into the drill. `launcher/pbe.sh
status|users|current|mode|midi|keys [on|off]|start [user] [free]|stop` is the process control both the app
and the `/piano-by-ear` skill use; it never touches sleep. Profiles are one
DB each in `~/.piano-by-ear/profiles/<user>.db` ("Guest" is always listed
and wiped on every start as Guest), current user in
`~/.piano-by-ear/current-user`; log always `~/.piano-by-ear/run.log`.
Restart after every code change with `launcher/pbe.sh start`; the log is
where a session is reviewed afterwards.

```bash
npm start                      # flags: --port <substr> --db <path> --debug-midi
node src/main.js --bpm 160     # developer override only
```

No MIDI device present at start is fine; `src/midi.js` polls every 2s and
opens every input port.

## Layout

- `src/main.js`   wiring, SIGINT shutdown (silent stop, close audio then DB).
- `src/free.js`   free play: MIDI straight to the pianos (+ sustain pedal, CC 64), no drill, no DB.
- `src/keys.js`   the computer keyboard as a controller (`--keys`, needs a TTY). free.js: musical-typing note layout (note-off synthesized 350 ms after the last autorepeat). main.js: INTERVAL mode, number row = semitones down (Shift = up) from `refNote()` (= drill.lastNoteOn ?? anchor); the named note is emitted as a 150 ms press and graded normally.
- `src/audio.js`  two pianos on one AudioContext (`src/sampler.js`,
  samples in `~/.piano-by-ear/samples` via `npm run fetch-samples`; NOT in
  the repo): the player's keys strike the Salamander grand (pan +0.15,
  `startVoice`/`stopVoice` = key down/up, damped on release); the call
  (`note()`) plays the Upright Piano KW (pan -0.5, trim 0.6) via
  `SampledPiano.play(key, vel, at, dur)`, scheduled on the clock and
  independent of the key-down voices. Fallbacks until fetched: resound-sound's
  Piano (`audioContextManager.context` set to ours first) and an
  exact-harmonic reed tone -- NEVER give a synth call detuned partials (a
  3.01x partial beat against the triangle's 3x harmonic and read as a
  stutter). `parseSfz` handles both sfz layouts (opcodes across lines,
  group/global inheritance, loops). Call notes are articulated in `beginQuestion`.
- `src/drill.js`  state machine + teacher. Read its header comment first.
  Question = `{kind, call, graded, durs, meter, gradeFrom}`. THE RESPONSE IS
  A CANON: the click grid is a constant pulse (nextBarAt only advances by
  whole bars, never moves to the player). The next question starts on the
  first click >= one beat after the last key press/release with no key down
  (tick(), QUIET_BEATS_BEFORE_NEXT); an UNFINISHED response ends the same
  way once the pending group's time has passed (`abandonResponse`: the rest
  is missed, never a stall); calls must never contain a beat of
  silence (interval anchor rings until the target; phrases with a rest >= 1
  beat are dropped in PhraseBank). `startResponse()` fires on the
  player's first note, snaps it to a whole number of beats behind the call
  (>=1), and sets `expected[k].at = callNotes[k].time + N*beat`, preserving
  the phrase's exact sub-beat rhythm. The first note's onset is graded too,
  so an off-beat phrase played on the beat is a timing defect.
  Kinds: interval | discrimination | remediation | passage | retry.
  Selection order in `makeQuestion()`: discrimination queue, remediation
  queue (intervals missed inside passages), retry queue (failed passages,
  2 questions later), chime streak >= 3 and < 3 passages in a row ->
  passage, else interval. Tempo: `chooseTempo()` once per session from
  `attempts.in_time` (+/-4 bpm, 50..132). Tolerance = beat/8 clamped
  45..110 ms and never more than 40% of the note's gap.
  Scheduling is on the AudioContext clock via a 25 ms ticker 150 ms ahead;
  the perf->audio offset is low-passed every tick (clocks drift ~1 ms/min).
  Silence timeout counts from call end and never runs while `answered` (the
  wait between questions is not silence).
  `nextQ` is decided at answer time, never inside the tick.
  PASSAGE LENGTH is a controller (kv `passageLen`, per kind: +1 after 2
  clean first-askings in a row, -1 after 3 failures, bounded by LEN.min and
  the tier ceiling), NOT the tier ladder; retries don't count. Hold grading:
  short vs the sounded length (capped CALL_MAX_S), long vs the written one.
  GRADING IS BY ONSET GROUP (`buildGroups`): notes with the same offset form
  a group; a key press matches any pending note of the current group by
  pitch, a wrong note consumes the nearest pending graded note, and a press
  matching the NEXT group (inside its window) abandons the rest of this one
  (one miss per abandoned note). Each expected note carries `melodicFrom`
  (previous note in its voice -> melodic engine) and `harmonicFrom` (the
  group's bass -> harmonic engine). Question notes are
  `{midi, b, dur, voice, free, silent}`; `free` = the note on the anchor,
  `silent` = in the question (grading context, may be echoed) but never
  sounded in the call. Interval questions: silent anchor at b -1, target
  on the downbeat, so the call is the target alone.
  POLYPHONY LEVEL (`polyLevel()`, kv `poly` {level, history}) is earned
  from the last 12 passages of the level's kind (promote >= 70%, demote
  < 30%) plus tier gates; NEVER a flag. Level >= 1 adds dyad questions
  (`dyadQuestion`, both notes together, every 3rd plain question) from the
  harmonic engine and duo passages; 2 adds chorales; 3 adds two-hand poly.
- `src/engine.js` AdaptiveEngine (ear-training port), instantiated twice:
  melodic (kv `engine`) and harmonic (kv `engine:harmonic`, intervals above
  a chord's bass). Two evidence scopes:
  interval questions update parent stats/cells/confusions/tier controller;
  passage notes (`ask(..., {scope:'passage'})`) update only a
  `+7|src:passage` cell. Confusions decay each session, only drill widths in
  unlocked tiers, never cascade (one run at a time), and clear on a clean
  success. `inwardVariant()` keeps discrimination/remediation from walking
  the anchor to an edge. `adopt()` carries the in-flight framing across a
  mid-session range rebuild. rt is NORMALIZED onset error (ms at 60 bpm),
  `fluentMs` 120. `scoreInterval()` is the read-only scorer for phrases.
- `src/phrases.js` PhraseBank, one instance per corpus file (phrases.json
  melodic, poly.json polyphonic: kinds duo/chorale/poly, notes carry a
  voice, `pivot` = the note placed on the anchor). Precomputes melodic
  intervals per voice and harmonic intervals above each chord's bass;
  `pick({kind, engine, harmonic})` filters by kind, max notes, fastest note
  at tempo, no rest >= 1 beat, 3-day rest after a clean pass, exact-anchor
  placement (octave only if nothing fits), weights by both engines'
  scoreInterval + failed boost + centerPull.
- `scripts/build-corpus.mjs` **kern -> phrases.json. Integer ticks
  (TPQ 1680). Melody = rightmost kern spine and all its sub-spines, highest
  attacked pitch unless a higher note is still held. Meter per barline;
  x/8 meters use the eighth (or dotted quarter) as the FELT beat: offsets
  are in felt beats, `beatLen` = felt beat in quarters. Soft cut at the last
  bar line before 12 notes; `suitable()` drops accompaniment textures.
  Ids are content hashes (stable across rebuilds). Also writes poly.json:
  `extractPoly` keeps every voice; `polyPhrases` cuts bar-aligned windows
  (2..8 beats) inside each melodic phrase: duo (voices 0 and top) and
  chorale for 4-voice files, poly for 2-staff files; limits in `POLY`.
- `src/range.js`  per-port range: guessed from a standalone key count in the
  name, else 48..72; widening snaps to a standard layout while guessed.
  `FIXED` ports (the computer keyboard: 36..84) never widen.
- `src/db.js`     node:sqlite, WAL, busy_timeout. Guarded migrations add
  columns. `kv(key)` returns a guarded {load, save}.

## Testing without the keyboard

See `/private/tmp/.../scratchpad/sim4.mjs` pattern: build Drill with
`bpmOverride`, `audio.master.gain.value = 0`, call
`drill.onNoteOn({note, velocity, at: (audioTime + drill.clockOffset) * 1000,
port: 'Keystation Pro 88'})`, wait for `drill.questions` to increment and
`!drill.answered` before reading `drill.expected[i].at/.midi/.acceptFrom`.

## Gotchas

- `@julusian/midi` has an install script; `npm install` may warn about
  allow-scripts. The prebuilt binary loads fine on macOS arm64.
- Rebuilding the corpus renumbers nothing (hash ids) but changes which
  phrases exist; `phraseStats` entries for vanished ids are harmless.
