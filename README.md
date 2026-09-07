# piano-by-ear

A headless "learn piano by ear" drill for a MIDI controller. No screen, no
settings: the process is the piano, the metronome, and the teacher, and you
only ever touch the keys.

1. Plug in a MIDI keyboard and run `npm start`. A two-note rising cue says it
   is listening.
2. Play any note. That note is the **anchor** and the session begins at a
   tempo chosen from your history (80 bpm the first time).
3. The metronome starts as a **constant pulse** and never moves. You hear the
   call: for an interval, just the target note (the anchor is the note you
   just played, so it is not repeated); for a passage, the whole phrase in
   its own meter. Then you play it back as a **canon** — start on any click
   at least one beat after the call, following one beat behind or waiting as
   many clicks as you like. Your first note begins the response; the rest is
   expected at the phrase's own rhythm relative to it. The anchor you
   already know is always yours to echo or skip: for an interval, answer
   with the target alone.
4. Every note is graded on pitch, on its onset against the pulse (the
   first note included: if the phrase starts an eighth off the beat, you
   play it an eighth off the beat), and on how long you hold it. There is
   no feedback while you play. It is a conversation: the reply is the next
   question. An interval you missed comes back as a remediation drill; a
   passage with errors comes back two questions later.
5. Three clean answers in a row earn a **real passage**: a Bach chorale
   phrase or a bit of a Mozart sonata, played in its own meter starting on
   your anchor. Play the whole thing back in time, following the call. The
   reply is the next question, and it comes on the first click after one
   beat of silence: no key down, nothing pressed or released. That holds
   even if you stop before the end: the notes you left out are missed and
   the next question comes anyway. No call ever contains a beat of silence
   itself, so silence always means "I am done".
6. Ten seconds of silence, once an answer was possible, ends the session.
   Play a note to start another.

Everything adapts:

- **Which interval** is asked comes from an adaptive engine (ported from
  [ear-training](https://github.com/calebjedhugo/ear-training)) that keeps
  first-try success near 80%, unlocks intervals in aural-difficulty order,
  runs discrimination drills on pairs you confuse, and counts an interval
  mastered only when you hit it accurately **and** on the beat. A second
  engine of the same kind tracks the intervals inside chords (see
  Polyphony below).
- **When you get a passage** is the clean streak above. An interval you miss
  inside a passage is drilled on its own right after. Notes inside passages
  train a separate in-melody model, so a step you can sing inside a chorale
  never masquerades as a step you can name cold.
- **Which kind of passage** follows your polyphony level, from single lines
  to four-part chords and two-hand passages.
- **How long a passage** is follows your passages, not your intervals: it
  starts at five notes, grows by one after two clean passages in a row,
  shrinks by one after three failures in a row, and never exceeds a ceiling
  set by the unlocked tiers. Its fastest note is limited by the tempo. A
  hold is never graded against more than the teacher actually sounded (two
  seconds), so a long final note is not a trap.
- **Tempo** is one value per session: if at least 80% of your recent correct
  answers were in time it goes up 4 bpm, below 50% it goes down 4, between 50
  and 132 (80 to start). Timing tolerance is an eighth of a beat.

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
their meter and pickup, and accompaniment figures are filtered out.

## Data

`sessions` and `attempts` record every note you play during a question:
pitch, velocity, onset error against the beat, first attempt or retry, the
question kind and phrase, and whether it was graded and in time. The engine
state, per-controller ranges and passage history live in the `kv` table.

## Polyphony

The goal is to hear any combination of notes and play it back, so the
drill has four **levels**, earned from history and never set by hand:

| level | what is asked | earned by |
|---|---|---|
| 0 | melody only | (start) |
| 1 | **dyads** (anchor and one note together) and **duos** (soprano and bass of a chorale bar) | 12 melodic passages at least 70% clean, with melodic tiers unlocked through the sixth |
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
**Free play** (the same pianos plus the sustain pedal, nothing graded or recorded; `src/free.js`),
or **Drill** to switch back, **Switch user** (pick a profile or type a new
name for a clean slate; **Guest** is always offered and starts empty every
time, its history is discarded on each start), **Restart** (same user and
mode, sleep untouched)
or **End drill** (stops, and re-enables sleep if the launcher disabled it).
While no MIDI keyboard is connected the menu also offers **Use keyboard
keys: on/off**. With it on, the process runs in a Terminal window and the
computer keyboard stands in for the controller. In **free play** it is a
piano in the GarageBand/Ableton musical-typing layout (home row A S D F G H
J K L ; ' = C D E F G A B C D E F, W E T Y U O P = sharps, Z/X octave, C/V
softer/louder, Space = sustain, Q quits; a note is held while its key
autorepeats). In the **drill** you answer by naming the interval instead of
finding the note: the number row 1-9, 0 (=10), - (=11), = (=12) is that many
semitones down from the reference note (the anchor, or the last note of your
answer so far), and the same keys with Shift go up; the named note sounds
and is graded like a played one, timing included. That trains the ear
without the hands, so the drill keeps a separate history, `<user>-keys.db`,
and grades no holds there; `scripts/compare-surfaces.mjs` puts the piano and
keyboard histories side by side per interval (weak on both = ear, weak on
the piano only = ear-to-hand). It always boots into the drill. Each user is one SQLite file
under `~/.piano-by-ear/profiles/`. `launcher/pbe.sh` is the command-line
equivalent without the sleep handling.
