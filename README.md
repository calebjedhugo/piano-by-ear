# piano-by-ear

A headless "learn piano by ear" drill for a MIDI controller. No screen, no
settings: the process is the piano, the metronome, and the teacher, and you
only ever touch the keys.

1. Plug in a MIDI keyboard and run `npm start`. Two clicks say it is
   listening.
2. Play any note. That note is the **anchor** and the session begins. The
   drill answers with the **key** — a triad, a seventh, the pentatonic, the
   first five degrees, in a scrambled order from your note. The pitches tell
   you the key; the order tells you nothing, so every interval after the
   first has to be caught cold. It is a call like any other, so you play it
   back. Every eight questions the note you happen to be on becomes the next
   tonic and the key changes.
3. The metronome starts as a **constant pulse** and never moves. You hear the
   call: for an interval, just the target note (the anchor is the note you
   just played, so it is not repeated); for a passage, the whole phrase in
   its own meter, transposed into the block's key. Then you play it back as
   a **canon** — start on any click at least one beat after the call,
   following one beat behind or waiting as many clicks as you like. Your
   first note begins the response; the rest is expected at the phrase's own
   rhythm relative to it. The anchor you already know is always yours to
   echo or skip: for an interval, answer with the target alone.
4. Every note is graded on pitch, on its onset against the pulse, and on how
   long you hold it, but **pitch and time are separate verdicts**: a phrase
   passes on its notes; the timing is reported beside it and never decides
   what comes next. Miss a note and go back for it before the next one is
   due and the drill records that you **caught** it — the note still counts
   as missed, but hearing your own mistake is its own skill and it is
   measured. You get one re-attack; after that you are searching, not
   catching. There is no feedback while you play, and there are no
   cues, chimes or error sounds anywhere in this program: **nothing is ever
   played that you are not being asked to play back.** It is a conversation,
   and the reply is the next question. A phrase you missed comes back; a
   phrase you nailed comes back somewhere new; when you are on top of it the
   caller stops waiting. You hear where you stand in what you are given.
5. Three clean answers in a row earn a **real passage**: a Bach chorale
   phrase, a bit of a Mozart sonata, or a hymn tune, in its own meter in the
   current key. Miss it and the phrase comes straight back, same key, same
   register, up to three tries while you are getting closer. Nail it and it
   comes back a few questions later in the next key, or the other mode, or a
   step away.
6. Play the intervals back clean and on the pulse for a while and the caller
   stops waiting: **the round**. The next call comes while you are still
   answering the last, and the intervals, the tempo, or the lead get harder
   two right answers at a time and easier one miss at a time, until the run
   is over and a last easy call closes it. Then business as usual.
7. Silence, once an answer was possible, ends the session (ten seconds; longer
   for beginners). Play a note to start another; within half an hour it picks
   up the same sitting.

Everything adapts:

- **Which interval** is asked comes from an adaptive engine (ported from
  [ear-training](https://github.com/calebjedhugo/ear-training)) that keeps
  first-try success near 80%, unlocks the twelve simple intervals in
  aural-difficulty order, sometimes asks a secure one an octave wider (the
  octave is judged on its own), and counts an interval mastered only when
  you hit it accurately **and** on the beat. A pair you keep confusing
  (fourth and fifth, the two sixths) is asked once as a single call carrying
  both, and then slipped in among the ordinary questions until it
  separates. A second
  engine of the same kind tracks the intervals inside chords (see
  Polyphony below).
- **What a note is graded on** depends on where you are. A beginner who
  moves the right way but lands seven keys off is credited for the
  direction, then for landing within two keys, then for the note itself,
  each stage earned from the last twenty answers; below the top stage the
  anchor is sounded before the target, the questions stay near the middle
  of the keyboard, and every third question is an echo game: the drill goes
  quiet, you make up two or three notes, and it asks for them straight
  back — your own figure becomes the call.
- **When you get a passage** is the clean streak above. An interval you miss
  inside a passage is drilled on its own right after. Notes inside passages
  train a separate in-melody model, so a step you can sing inside a chorale
  never masquerades as a step you can name cold. A phrase you failed is due
  again the next day; one you played clean after three days, then a week,
  then three.
- **Which kind of passage** follows your polyphony level, from single lines
  to four-part chords and two-hand passages.
- **How long a passage** is follows your passages, not your intervals: it
  starts at five notes, grows by one after two clean passages in a row,
  shrinks by one after three failures in a row, and never exceeds a ceiling
  set by the unlocked tiers.
- **Tempo** belongs to the music, never to you: each excerpt sets its own
  from its style and its fastest note, interval questions sit at a calm 72,
  and nothing you play makes the next question faster (the round excepted,
  and it resets).

Progress is judged on **next-day first attempts**, not on how a session
felt: `node scripts/progress.mjs` prints them per day.

## Install

```bash
npm install
npm start
```

| flag | default | meaning |
|---|---|---|
| `--port` | all inputs | only open MIDI inputs whose name contains this |
| `--db` | `~/.piano-by-ear/piano-by-ear.db` | SQLite history (the launcher passes `~/.piano-by-ear/profiles/<user>.db`) |
| `--debug-midi` | off | print raw MIDI bytes |

Requires Node 22.5+ (uses `node:sqlite`). Audio is produced in-process by
[node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api);
MIDI input via [@julusian/midi](https://github.com/Julusian/node-midi).

It sounds like a teacher's studio with two pianos. You play a grand, the
[Salamander Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html)
sample set (a Yamaha C5 by Alexander Holm, CC BY 3.0), a little to your
right. The teacher plays the call on an upright, the Upright Piano KW set
(a Kawai in a living room, FreePats, CC0), off to your left: the same kind
of instrument, a different piano in a different place, so the call is as
real as your answer and never mistaken for it. Fetch both once with

```bash
npm run fetch-samples
```

which downloads about 450 MB into `~/.piano-by-ear/samples`; the drill then
decodes four of the grand's sixteen velocity layers and the whole upright
at startup (about a second, and roughly half a GB of memory). Until the
sets are fetched you get synths instead: the additive piano from
[resound-sound](https://www.npmjs.com/package/resound-sound) for your keys
and an exact-harmonic reed tone for the call. Either way a key rings while
it is down and is damped when it comes up (with the real hammer-release
noise on the grand), and each call note sounds for its written length with
a small articulation gap before the next, so the rhythm you copy is carried
by the onsets alone.

## Key range

MIDI doesn't tell you how many keys a controller has, so the range is
guessed from a key count in the port name (`Keystation Pro 88` -> A0..C8,
`Launchkey 25` -> C3..C5) and otherwise starts as two octaves around middle
C. Playing outside it widens it, snapping to the nearest standard layout, and
it is remembered per controller name. Targets and passages only ever fall
inside the current range.

## Passages

5,200 phrases extracted from Craig Sapp's **kern editions of the 370 Bach
chorales (soprano) and the Mozart piano sonatas (right hand, including the
spurious K. 498a by Müller); see `corpus/README.md` for attribution
(CC BY-NC-SA 4.0). Phrases are cut at fermatas, rests and bar lines, keep
their meter and pickup, and accompaniment figures are filtered out. Another
580 phrases are hymn tunes (`scripts/build-hymns.mjs`, from the
singHarmony2 song files): familiar music is where playing by ear starts.

## Data

`sessions` and `attempts` record every note you play during a question:
pitch, velocity, onset error against the beat, the question kind and
phrase, whether it was graded and in time, and what the stage credited it
as. `passages` keeps one row per passage with the rungs beneath exact pitch
(direction, size, recovery) and separate pitch and timing verdicts;
`judgments` records what you said you missed. The engine state,
per-controller ranges and passage schedule live in the `kv` table.

## Polyphony

The goal is to hear any combination of notes and play it back, so the
drill has four **levels**, earned from history and never set by hand:

| level | what is asked | earned by |
|---|---|---|
| 0 | melody only | (start) |
| 1 | **dyads** (anchor as a fixed bass and one note above, together), small **chords** above it, and **duos** (soprano and bass of a chorale bar) | melodic tiers unlocked through the sixth and six intervals mastered |
| 2 | **chorales**: all four voices of a Bach chorale bar as chords | 12 duos at least 70% clean, harmonic tiers through the fourth |
| 3 | **both hands** of a Mozart sonata bar | 12 chorales at least 70% clean |

Every level keeps asking the kinds below it. A bad run (12 passages under
30% clean) drops a level. Session start logs the level in force.

Vertical hearing gets its own adaptive engine: every note above a chord's
bass is an interval the **harmonic engine** tracks exactly as the melodic
engine tracks steps and leaps, with its own tiers, confusion runs and
remediation. At level 1 and above every third plain question is a dyad
chosen by that engine, and a chord note you miss in a passage comes back as
a dyad. Chords are graded by onset group: play the notes of a chord in any
order, each judged on pitch, timing and hold. Moving on to the next chord
abandons what was left of this one, which counts as one miss per note
rather than a cascade.

The corpus for this is the same set of files: 7,399 duo windows and 3,225
four-part windows from the 371 chorales, and 3,349 two-hand windows from the
sonatas, all bar-aligned, two to eight beats, at most four notes sounding at
once, with the phrase's melodic window as the frame.

## macOS launcher

`launcher/build.sh` builds `Piano by Ear.app` into `/Applications` (piano-key
icon). Click it when the drill is stopped: it offers to disable lid sleep for
the run (standard admin password dialog; Cancel leaves sleep alone), then
starts the drill as the current user. Click it while running for
**Free play** (the same pianos plus the sustain pedal, nothing graded or recorded; `src/free.js`)
or **Drill** to switch back, **Switch user** (pick a profile or type a new
name for a clean slate; **Guest** is always offered and starts empty every
time, its history is discarded on each start), **Restart** (same user and
mode, sleep untouched)
or **End drill** (stops, and re-enables sleep if the launcher disabled it).
It always boots into the drill. Each user is one SQLite file
under `~/.piano-by-ear/profiles/`. `launcher/pbe.sh` is the command-line
equivalent without the sleep handling.
