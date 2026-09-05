# piano-by-ear

Headless learn-piano-by-ear drill for a MIDI controller (Node, no browser).
Prototype lineage: `../ear-training/` (the on-screen version whose adaptive
engine this ports). GitHub: calebjedhugo/piano-by-ear (public).

**IMPORTANT: the user interacts ONLY from the piano keyboard.** No musical
setting may become a flag; derive it from history or make it a keyboard
gesture. Every state change must be audible (see `src/audio.js`).

## Run

```bash
npm start                      # flags: --port <substr> --db <path> --debug-midi
node src/main.js --bpm 160     # developer override only
```

No MIDI device present at start is fine; `src/midi.js` polls every 2s and
opens every input port.

## Layout

- `src/main.js`   wiring, SIGINT shutdown (silent stop, close audio then DB).
- `src/drill.js`  state machine + teacher. Read its header comment first.
  Question = `{kind, call, graded, durs, meter, bars, restBars, gradeFrom}`.
  Kinds: interval | discrimination | remediation | passage | retry.
  Selection order in `makeQuestion()`: discrimination queue, remediation
  queue (intervals missed inside passages), retry queue (failed passages,
  2 questions later), chime streak >= 3 and < 3 passages in a row ->
  passage, else interval. Tempo: `chooseTempo()` once per session from
  `attempts.in_time` (+/-4 bpm, 50..132). Tolerance = beat/8 clamped
  45..110 ms and never more than 40% of the note's gap.
  Scheduling is on the AudioContext clock via a 25 ms ticker 150 ms ahead;
  the perf->audio offset is low-passed every tick (clocks drift ~1 ms/min).
  Silence timeout counts from when an answer was first possible.
  `nextQ` is decided at answer time, never inside the tick.
- `src/engine.js` AdaptiveEngine (ear-training port). Two evidence scopes:
  interval questions update parent stats/cells/confusions/tier controller;
  passage notes (`ask(..., {scope:'passage'})`) update only a
  `+7|src:passage` cell. rt is NORMALIZED onset error (ms at 60 bpm),
  `fluentMs` 120. `scoreInterval()` is the read-only scorer for phrases.
- `src/phrases.js` PhraseBank: precomputed per-phrase min/max/intervals,
  `pick()` filters by max notes, fastest note at tempo, 3-day rest after a
  clean pass, exact-anchor placement (octave only if nothing fits), weights
  by engine.scoreInterval + failed boost + engine.centerPull.
- `scripts/build-corpus.mjs` **kern -> phrases.json. Integer ticks
  (TPQ 1680). Melody = rightmost kern spine and all its sub-spines, highest
  attacked pitch unless a higher note is still held. Meter per barline;
  x/8 meters use the eighth (or dotted quarter) as the FELT beat: offsets
  are in felt beats, `beatLen` = felt beat in quarters. Soft cut at the last
  bar line before 12 notes; `suitable()` drops accompaniment textures.
  Ids are content hashes (stable across rebuilds).
- `src/range.js`  per-port range: guessed from a standalone key count in the
  name, else 48..72; widening snaps to a standard layout while guessed.
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
