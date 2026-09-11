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
play / Drill (switch mode), the sound toggle, Switch user, Restart, End drill
(End re-enables sleep). It always boots into the drill. `launcher/pbe.sh
status|users|current|mode|sound [app|hardware]|start [user] [free]|stop` is the
process control both the app
and the `/piano-by-ear` skill use; it never touches sleep. Profiles are one
DB each in `~/.piano-by-ear/profiles/<user>.db` ("Guest" is always listed
and wiped on every start as Guest), current user in
`~/.piano-by-ear/current-user`, sound in `~/.piano-by-ear/sound`; log always
`~/.piano-by-ear/run.log`.
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
  TEMPO IS PER QUESTION and belongs to the excerpt (`src/tempo.js`), set in
  `beginQuestion()` beside the meter; the grid restarts there anyway, so the
  new beat governs from the downbeat and `scheduledUntil` is reset to it.
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
  the tier ceiling), NOT the tier ladder; retries don't count. TEMPO IS NOT A
  CONTROLLER and must never become one: nothing you play may make the next
  question faster. Hold grading:
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
- `src/tempo.js`  TEMPO IS A PROPERTY OF THE MUSIC, NEVER A REWARD. Replaced
  a ratchet that added 4 bpm whenever 80% of recent notes were in time, which
  optimised hand speed rather than hearing AND silently hid 38% of the corpus
  (the picker dropped any phrase whose fastest note fell under the old
  `MIN_NOTE_SEC` at the session tempo -- past 110 bpm that is every
  sixteenth-note phrase). Per question: a style band per collection
  (`BANDS`, chorales 68/84, Mozart 88/108), times a texture discount that only
  ever slows (`TEXTURE`: mono 1 -> poly 0.82), capped so the excerpt's fastest
  note still lasts `AUDIATION_FLOOR_S` (190ms). Interval questions are not
  excerpts and get a flat `INTERVAL_BPM` 72. `floorFromHistory()` is the ONLY
  history input and can only slow things down: it bins recent graded passage
  notes by their excerpt's fastest note and raises the floor only where a bin
  is actually being failed, so a player who was never GIVEN fast notes is
  never locked into slow ones. Over the corpus this lands 53..88 bpm, with
  40 bpm on 0.2% (the 32nd-note phrases).
- `src/tonalfield.js` THE EMERGENT TONAL CENTRE. Holds NO key of its own
  (Caleb: no contrived I-IV-V-I); watches every sounded call note in a
  recency-weighted pitch-class histogram and, on `key()`, names the best-fit
  key by Krumhansl-Schmuckler correlation with `strength` in [0,1] folding
  correlation with evidence. A chromatic or thin stretch reads weak -- the
  atonal spell arriving on its own, not on a schedule. `degree()`/`diatonic()`
  classify a note in the current key (null = borrowed). Good on clear input
  (C-major melody -> C major 0.9; chromatic 0.36); a weak CLASSIFIER of
  isolated corpus fragments against their source key (~33%) because it reports
  the LOCAL centre of the notes it saw, which is the honest emergent signal,
  not musicological analysis. Fed in `beginQuestion` from `this.callNotes`.
  Used by: `questionTempo` (interval/gesture tempo leans +/-6 bpm with
  strength), the gesture selection, and the `[Key mode]` tag on interval logs.
- `src/rungs.js`  THE RUNGS BENEATH EXACT PITCH: direction (contour), near
  (within a semitone: sizing), recovered (a later exact note after the first
  wrong one), exact. A passage still passes or fails on exact pitch ONLY --
  not recovering to the right note IS the error, Caleb's call -- but the
  binary hid the rest (dense material: exact 48%, direction 98%), so
  `finalizeQuestion()` writes one `passages` row per passage question and
  logs `passage done with errors (streak N) -- shape a/b, sizing c/b[, N not
  played][, recovered|no recovery]; <verdict>`. THE CORRECTIVE LOOP
  (`retryVerdict`): a failed passage comes STRAIGHT BACK as the next question
  (the call is the correction), re-placed on the note you ended on; verdicts
  are `again` -> `try 2, closer, again` (rungScore rose) -> `try 3 of 3,
  resting it`, or `try N, no closer, resting it`; a clean retry logs `passage
  clean (streak N) -- nailed on try N` and moving on is the reward. Resting =
  `PhraseBank.rest` keeps the phrase out of pick() for `TOO_HARD_REST_MS`
  (2 days; a merely failed phrase otherwise comes back SOONER). Retries never
  move the length controller. Contour is between adjacent notes of ONE
  voice that were both struck (a miss never fakes an interval); the free
  pivot is context. READ A CASCADE of one-semitone errors after a mis-sized
  leap as ONE sizing error plus no recovery, not N errors. These rows are what
  the corrective-replay retry loop and the difficulty decisions will read
  (`db.passageHistory(phraseId)`); nothing acts on them yet.
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
- `src/midiout.js` ON THE INSTRUMENT'S OWN SOUND (launcher sound toggle ->
  `~/.piano-by-ear/sound`, read at startup, so a change needs a restart).
  For a keyboard with a sound engine rather than a mute controller: the call
  goes out on ch 2, the metronome on the instrument's woodblock (ch 10, notes
  76 accent / 77), and the player's keys are never echoed -- the instrument
  sounded them locally, sooner than a round trip could. Everything falls back
  to `src/audio.js` if the output port is missing, so a pulled cable never
  leaves the drill mute. `claim()` re-centres pan and volume on connect
  because a CC sticks in the instrument until something changes it back.
  MEASURED ON THE WILLIAMS ALLEGRO (via a generic 1a86 DIN-to-USB cable):
  ch 1 = the panel voice and the player's keys, ch 2/3 sound and are WIRED TO
  THE GRAND (no program change works, not even the instrument's own captured
  CC 80/81 + PC voice-select bytes, and they do NOT follow the panel), ch 4+
  are silent, ch 10 sounds only 76/77. So the player picks a voice at the
  panel and the call stays the grand: two voices for free, none selectable.
  CC does work (pan, volume, reverb 91, chorus 93). `OUT_LATENCY_MS` exists to
  send early if the interface ever needs it; measured 2026-09-07 as
  unnecessary (median onset -45 ms against a -31 ms all-time baseline).
- `src/range.js`  per-port range: guessed from a standalone key count in the
  name, else 48..72; widening snaps to a standard layout while guessed.
- `src/db.js`     node:sqlite, WAL, busy_timeout. Guarded migrations add
  columns. `kv(key)` returns a guarded {load, save}. Tables `sessions`,
  `attempts` (one row per graded key press or miss), `passages` (one row per
  passage question, see rungs.js). `backfillPassages()` builds `passages`
  from `attempts` once when the table is empty (main.js calls it at startup)
  so history exists from day one; attempts carry no voice, so backfilled
  polyphonic rows have contour zeroed.

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
