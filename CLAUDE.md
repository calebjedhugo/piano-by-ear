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
- `src/audio.js`  two voices on one AudioContext: the player's keys strike
  the Salamander sample set (`src/sampler.js`, in `~/.piano-by-ear/samples`
  via `npm run fetch-samples`; NOT in the repo) or, until fetched,
  resound-sound's Piano (`audioContextManager.context` is set to ours before
  construction). `startVoice`/`stopVoice` = key down/up, damped on release;
  the call (`note()`) is a sustained exact-harmonic tone. NEVER give the call
  detuned partials (a 3.01x partial beat against the triangle's 3x harmonic
  and read as a stutter). Call notes are articulated in `beginQuestion`.
- `src/drill.js`  state machine + teacher. Read its header comment first.
  Question = `{kind, call, graded, durs, meter, gradeFrom}`. THE RESPONSE IS
  A CANON: the click grid is a constant pulse (nextBarAt only advances by
  whole bars, never moves to the player). The next question starts on the
  first click >= one beat after the last key press/release with no key down
  (tick(), QUIET_BEATS_BEFORE_NEXT); calls must never contain a beat of
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
  GRADING IS BY ONSET GROUP (`buildGroups`): notes with the same offset form
  a group; a key press matches any pending note of the current group by
  pitch, a wrong note consumes the nearest pending graded note, and a press
  matching the NEXT group (inside its window) abandons the rest of this one
  (one miss per abandoned note). Each expected note carries `melodicFrom`
  (previous note in its voice -> melodic engine) and `harmonicFrom` (the
  group's bass -> harmonic engine). Question notes are
  `{midi, b, dur, voice, free}`; `free` = the note on the anchor.
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
