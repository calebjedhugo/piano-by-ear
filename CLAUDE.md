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
  THE RESPONSE IS A CANON: the click grid is a constant pulse (nextBarAt
  only advances by whole bars, never moves to the player). The next question
  starts on the first click >= one beat after the last key press/release
  with no key down (tick(), QUIET_BEATS_BEFORE_NEXT); an UNFINISHED response
  ends the same way once the pending group's time has passed
  (`abandonResponse`); calls never contain a beat of silence. `startResponse()`
  fires on the player's first note, snaps it to a whole number of beats
  behind the call (>=1); on interval questions a wrong first note is a wrong
  TARGET (anchor skipped), on passages the old pivot rule holds.
  TEMPO IS PER QUESTION (`src/tempo.js`), set in `beginQuestion()`; interval
  questions are a flat INTERVAL_BPM 72 (the round's tempo dimension is the
  one exception and resets after). Tolerance = beat/8 clamped 45..110 ms
  and never more than 40% of the note's gap.
  KEY BLOCKS (`src/keyblock.js`): every BLOCK_QUESTIONS (8) the note the
  player is on becomes a new tonic (mode rotates), a `prime` listen question
  plays do-mi-sol-do', and the block holds: passages are transposed INTO
  the key (`PhraseBank.pick({key})`, pivot no longer on the anchor),
  gestures step diatonically in it, plain targets lean diatonic
  (DIATONIC_LEAN). No cadence, no drone, no emergent key (tonalfield.js is
  gone: it renamed the key almost every question).
  KINDS: prime | listen | interval | gesture | discrimination | remediation |
  dyad | chord | passage | retry | judge | variant | round | echo. Selection
  order in `makeQuestion()`: round, judge window, retry (SAME placement as
  the miss: `retry.placed`), block prime, pair listen, remediation queues
  (folded to simple intervals), due variant, passage (streak >= 3 or 6
  clean notes, < 3 in a row; top stage only), echo game (echo stage always,
  contour every 3rd), dyad/chord slot, then a plain target (discrimination
  from the pair focus, wide ask, gesture GESTURE_RATE, or interval). The
  harmonic engine's pair focus gets its listen pass too (as dyads).
  PITCH AND TIME ARE SEPARATE: `pitchClean` drives streak, retry, length,
  poly promotion, variants; `timeClean`/`timing` are logged beside it
  ("timing 3/4 in time, 1 hold off") and stored (`passages.clean` = both,
  `passages.pitch_clean` = pitch). JUDGE WINDOW: EVERY failed passage and
  JUDGE_CLEAN_RATE (half) of the clean ones at the exact stage are followed
  by a `judge` cue (a soft LOW rising fourth: the high version was heard as
  an error buzzer) and JUDGE_BEATS of silence in which one key press = "the
  note I missed" (`judgments` table with passage_clean: hits, misses, false
  alarms, correct rejections; then the retry if there is one). Its arrival
  must never reveal the verdict -- and must never sound like one: the cue is
  a soft LOW rising fourth (the first high version was heard as an error
  buzzer after a passage he had nailed, and he hunted for a wrong note).
  A `variant` gets its own rising-triad cue so the phrase you NAILED coming
  back is never mistaken for a correction. THE CUE TEACHES ITSELF: kv `judge` {seen,
  pressed}; until the first press or JUDGE_LEARNING_WINDOWS windows, the cue
  plays twice, the window is JUDGE_LEARNING_BEATS, and the row is
  `learning` = 1 (not evidence). QUIET_BEATS: a retry or variant answer ends
  after TWO beats of silence (recall, not echo), everything else one. VARIANTS: a nailed passage returns in the
  NEXT block (variantQueue[].block < blockN), in the block's new key, else
  +-2/3 semitones (same hand shape), else the other mode (`modeSwap`, last:
  it changes the melody); passage-scope evidence only, never the length
  controller or the retry loop.
  THE ROUND: ROUND.trigger clean, in-time plain answers started <= 2 beats
  behind (passages neither count nor reset) open a run: kind `round`, the
  next call at a fixed lead (`nextQuestionAt` set in beginQuestion and
  never renegotiated by the silence rule; an unfinished answer is abandoned
  once the lead has passed by more than the tolerance), a 2-down/1-up
  staircase on one dimension per run (interval = extra tiers, tempo = +6
  bpm/level, lead = 4/3/2 beats), ends after ROUND.calls (16) or
  ROUND.misses (5) with one cool-down call at level 0, cues
  `round`/`roundOver`, evidence scope 'round' (cells only: never the tier
  ladder, never the stage, never a focus trial), a record per run in kv
  `rounds`, cooldown before the next. A staircase miss is pitch only,
  except on the tempo dimension where time is the game.
  STAGE (`src/stage.js`): `this.stage.credit()` decides what an isolated
  note counts as (direction / within 2 / exact); the engine and streak see
  the credit, `attempts.correct` stays exact, `attempts.credit`/`stage`
  record the judgment. Below exact: the anchor is SOUNDED (on the downbeat,
  target a beat later -- never at b -1, that note would already be in the
  past), the stage's pool replaces the ladder, questions stay inside
  `stage.window()` (the anchor is clamped where it is set, completeQuestion),
  timeout is longer, no passages, gestures, wide asks, dyads/chords or
  rounds. Question flag `optionalAnchor` (interval kinds) is what lets a
  wrong first note count as a wrong target; the echo ask-back has no free
  note at all (its first note is framed from the playback's last note and
  graded on the stage's rung).
  Block count: KEYED_KINDS only. ECHO GAME: `collect` question (cue, then
  the player's 2-4 notes until a beat of silence) -> listen playback -> the
  same figure asked back, graded on the stage's rung.
  COMPOUND ASKS: `engine.lastWide` marks a target an octave wider than the
  asked simple interval (label "+8ve"); pitch class right but octave wrong
  = `height_err`, credited to the interval, debited to `engine.state.height`.
  BURSTS ARE ONE SITTING: kv `carry` (endedAt, block key + number, warm-up
  count, retry and variants as id/shift/key re-placed from the bank and
  dropped if they no longer fit, the pending judge, remediation, asked ids)
  is restored by a session started within CARRY_MS (30 min) and the key
  re-primed; roundStreak/cooldown and the streak reset per burst.
  PASSAGE LENGTH is a controller (kv `passageLen`, +1 after 2 clean
  first-askings, -1 after 3 failures, bounded by LEN.min and the tier
  ceiling). TEMPO IS NOT A CONTROLLER and must never become one.
  GRADING IS BY ONSET GROUP (`buildGroups`): notes with the same offset form
  a group; a key press matches any pending note of the current group by
  pitch, a wrong note consumes the nearest pending graded note, and a press
  matching the NEXT group (inside its window) abandons the rest of this one.
  Each expected note carries `melodicFrom` and `harmonicFrom`. Question
  notes are `{midi, b, dur, voice, free, silent}`.
  POLYPHONY LEVEL (`polyLevel()`, kv `poly`): level 0 -> 1 is earned from
  interval confidence (POLY.melodicTiersForDyads tiers AND
  POLY.masteredForDyads mastered), not passages; higher levels from the
  last 12 passages of the level's kind (>= 70% / < 30%) plus tier gates.
  Demotion 1 -> 0 on duo passages < 30% holds the gate closed for
  POLY_DEMOTE_HOLD_MS. Dyads keep the anchor as a FIXED BASS; every 9th
  plain slot is a `chord` from CHORD_SHAPES once harmonic tiers >= 3 (dom7
  at >= 5); each chord tone is framed for the harmonic engine as it is
  graded (`q.chord`), never pre-asked. KEYED PASSAGES grade the pivot too
  (it is not the note under the hand): buildGroups frames it from the
  anchor: the duo's BASS first note (its pivot voice starts on the anchor
  and is free). A KEYED PASSAGE STILL STARTS ON THE NOTE UNDER YOUR HAND --
  `PhraseBank.pick` with a key REQUIRES the pivot to land on the anchor and
  pickPassage falls back to anchor placement (no key) when nothing does. The
  pivot is free, as it always was. Placing a phrase merely "in the key" made
  its first note something to find cold, and the player starts where he is
  sitting because that is what the drill taught: 13 of 22 failed passages in
  the 2026-09-11 10:35 session failed on the FIRST note. Do not re-introduce
  it. On a RETRY every voice's first note is FREE (just heard, not a new
  leap). FREE MEANS FREE, ONCE: the first wrong press when only free notes
  are pending is ignored (logged "on a free note: ignored"); a second one
  skips them and is graded against the next group, so a transposed shape is
  graded, not swallowed press after press. The octave is the one whose
  pivot is nearest the anchor, wider than an octave folds to the simple
  interval, and the label says `first note +N from X` (not on retries).
  VARIANT in the relative key of the original placement is no transposition
  (same pitch set): it falls through to the +-2/3 step; the label names the
  sounding key. ANCHOR WALK: `Stage.window()` is EXACT_WINDOW_SEMITONES (40)
  around the middle even at the top, and `engine.centerPull` is steep past
  18 semitones out (x3 / x0.15): the walk reached C7 and C2 on 88 keys.
  `attempts.behind` stores the response-start lag (beats) on every row of a
  question: the effort signature, reported by kind in progress.mjs. A round's lead is never shorter than the previous
  answer's lag + 1, and a call is never scheduled at a time already past.
- `src/engine.js` AdaptiveEngine (ear-training port), instantiated twice:
  melodic (kv `engine`) and harmonic (kv `engine:harmonic`). TIER_WIDTHS is
  SIMPLE INTERVALS ONLY (12 tiers; `simpleOf()` folds compounds; a loaded
  state with more tiers is clamped). Evidence scopes: interval questions
  update parent stats/cells/confusions/tier controller; passage notes and
  gestures (`scope:'passage'`) update a `+7|src:passage` cell AND record
  near-miss confusions; the round (`scope:'round'`) updates `src:round`
  cells only. CONFUSIONS decay by the DAY (`confusionsDecayedAt`), not per
  session; a pair (same direction, widths within 2) at CONFUSION_THRESHOLD
  becomes `state.focus` {a, b, left, listen, served, recent}: `takeListen()`
  hands the drill a listen-only pass at open and every FOCUS_LISTEN_EVERY
  pair trials (practice + exposure), about FOCUS_SHARE of the next
  FOCUS_TRIALS (30, spanning sittings) plain asks are one of the pair in its
  own direction (`servedQueue` = true -> kind 'discrimination'), and the
  focus closes early once the last FOCUS_DONE_WINDOW pair trials reach
  FOCUS_DONE_ACC. Never served inside a round. No queue, no A-B-A-B run.
  PAIR RULE: same sign, widths ADJACENT (diff <= 1) or 4th/5th; passage
  near-misses count half and only for |asked| >= 3 (a wrong step in a phrase
  is the key's degree, not the interval's category: the first real session's
  focus was -1 vs -2, harvested from gesture tails, while P4/P5 got none).
  `nextTargetIndex(a, prev, {allowWide, pool, bounds, extraTiers, lean,
  scope})`: pool = a stage's signed list instead of the ladder; bounds = an
  index window; extraTiers = the round's escalation; lean = per-target
  weight (diatonic); allowWide = may return the simple interval an octave
  wider (`lastWide`, `reportHeight()` -> `state.height`), only for secure
  intervals <= WIDE_MAX_SIMPLE. `masteredCount()` gates dyads.
  `inwardVariant()` keeps remediation from walking the anchor to an edge.
  rt is NORMALIZED onset error (ms at 60 bpm), `fluentMs` 120.
  `scoreInterval()` is the read-only scorer for phrases.
- `src/tempo.js`  TEMPO IS A PROPERTY OF THE MUSIC, NEVER A REWARD. Replaced
  a ratchet that added 4 bpm whenever 80% of recent notes were in time, which
  optimised hand speed rather than hearing AND silently hid 38% of the corpus
  (the picker dropped any phrase whose fastest note fell under the old
  `MIN_NOTE_SEC` at the session tempo -- past 110 bpm that is every
  sixteenth-note phrase). Per question: a style band per collection
  (`BANDS`, chorales 68/84, Mozart 88/108), times a texture discount that only
  ever slows (`TEXTURE`: mono 1 -> poly 0.82), capped so the excerpt's fastest
  note still lasts `AUDIATION_FLOOR_S` (190ms). Interval questions are not
  excerpts and get a flat INTERVAL_BPM 72 (drill.js). Collections: chorales
  68/84, Mozart 88/108, hymns 76/96. `floorFromHistory()` is the ONLY
  history input and can only slow things down: it bins recent graded passage
  notes by their excerpt's fastest note and raises the floor only where a bin
  is actually being failed, so a player who was never GIVEN fast notes is
  never locked into slow ones. Over the corpus this lands 53..88 bpm, with
  40 bpm on 0.2% (the 32nd-note phrases).
- `src/keyblock.js` KEY BLOCKS. `parseKey`, `phraseKey(phrase)` (the piece
  key if every note fits or at most one pitch class of >= 4 notes is
  foreign; else the nearest key on the circle of fifths that holds every
  note; null = chromatic, gets no prime), `shiftToKey` (mode reconciled via
  the relative key, octave nearest a point drawn halfway from the anchor to
  the keyboard middle), `primeNotes` (do-mi-sol-do' over two beats),
  `modeSwap` (3/6/7 moved), `chooseKey` (tonic = the anchor's pitch class,
  mode rotates), `diatonicStep`. Evidence: Cuddy & Badertscher 1987 (three
  notes set a key), Dowling 1986 / Bartlett & Dowling 1980 (a drifting or
  near key is worse than none), Springer 2021 (drones do nothing).
- `src/stage.js`  THE STAGE a player is graded on, from the last 20 isolated
  answers: echo < contour (direction) < sizing (within 2) < exact. A fresh
  profile starts at exact and drops one rung per reassessment once 8
  answers are in (hysteresis HYSTERESIS below each bar). Per stage: POOLS
  (steps first, fifth/octave as the first leaps), TIMEOUT_MS, a
  keyboard `window()` of an octave and a half, `soundsAnchor()` (below
  exact, or while tiers <= 3). `stageMoved()` in drill.js cues stageUp/Down
  and persists kv `stage`.
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
- `src/phrases.js` PhraseBank, one instance per bank: melodic = phrases.json
  + hymns.json (`path` accepts a list), polyphonic = poly.json. `analyse()`
  precomputes melodic/harmonic intervals and `tonalKey` (keyblock.js).
  `pick({kind, engine, harmonic, maxNotes, exclude, key})`: with `key`,
  phrases are placed IN the key (`shiftToKey`; keyless phrases skipped),
  else on the anchor as before; `pickInKey(id, key)` for variants.
  SCHEDULE: `record(id, clean)` sets `dueAt` -- failed: 1 day; clean: 3 days,
  then 7, then 21 by clean run -- and pick() skips undue phrases and boosts
  due ones (DUE_BOOST) and failed ones (FAILED_BOOST). `rest()` = the
  corrective loop gave up (TOO_HARD_REST_MS).
- `scripts/build-hymns.mjs` singHarmony2's hymn soprano lines
  (`../singHarmony2/public/songs/*.json`) -> corpus/hymns.json, same schema,
  collection 'hymns' (familiar tunes for the family: Berkowska & Dalla
  Bella 2013, known songs before abstract intervals).
- `scripts/progress.mjs [--db] [--days]` the report that matters: NEXT-DAY
  FIRST ATTEMPTS per day (isolated accuracy and the known pairs, passage
  pitch-clean and rung score, savings on re-encounter, retry loop and
  judgments, timing apart from pitch, stage, session shape). In-session
  gains are performance; judge progress here.
- `scripts/sim.mjs <db> <player> <n> [bpm] [nophrases]` headless scripted
  player (perfect | sloppy | kid | liz | random) against a scratch DB; the
  way every path above was verified. Never a live profile.
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
  `attempts` (one row per graded key press or miss; `credit`/`stage` = the
  stage's judgment, `height_err` = right pitch class wrong octave),
  `passages` (one row per passage question, see rungs.js; `clean` = pitch
  AND time, `pitch_clean` = pitch, backfilled from exact = notes),
  `judgments` (the judge window: guessed, hit, passage_clean); `attempts.voice`
  for per-voice dyad/chord accuracy. kv: `engine`, `engine:harmonic`, `poly`,
  `passageLen`, `phraseStats`, `polyStats`, `ranges`, `carry`, `stage`,
  `rounds`. `backfillPassages()` builds `passages`
  from `attempts` once when the table is empty (main.js calls it at startup)
  so history exists from day one; attempts carry no voice, so backfilled
  polyphonic rows have contour zeroed.

## Testing without the keyboard

`node scripts/sim.mjs <copy-of-a-profile.db> perfect 40 200` (or sloppy /
kid / liz / random; `nophrases` as a fifth arg to reach the round). It
drives `Drill` directly with `audio.master.gain.value = 0` and answers each
onset group one beat behind the call. Copy a profile first; never the live
one. The end-of-run "statement has been finalized" is the harness closing
the DB under late timers, not the drill.

## Gotchas

- `@julusian/midi` has an install script; `npm install` may warn about
  allow-scripts. The prebuilt binary loads fine on macOS arm64.
- Rebuilding the corpus renumbers nothing (hash ids) but changes which
  phrases exist; `phraseStats` entries for vanished ids are harmless.
- A sounded anchor must never sit at b -1: the question begins at most
  150 ms before its downbeat, so a note before it is already late.
- The research behind the design (2026-09-10 review with a literature-primed
  session) is summarised in the memory note
  `project_piano_by_ear_research_review`; the module headers cite the
  specific findings each mechanism rests on.
