# piano-by-ear

A headless "learn piano by ear" drill for a MIDI controller. No screen, no
settings: the process is the piano, the metronome, and the teacher, and you
only ever touch the keys.

1. Plug in a MIDI keyboard and run `npm start`. A two-note rising cue says it
   is listening.
2. Play any note. That note is the **anchor** and the session begins at a
   tempo chosen from your history (80 bpm the first time).
3. The metronome starts as a **constant pulse** and never moves. You hear the
   call: the anchor, then the target (for a passage, the whole phrase in its
   own meter). Then you play it back as a **canon** — start on any click at
   least one beat after the call, following one beat behind or waiting as
   many clicks as you like. Your first note begins the response; the rest is
   expected at the phrase's own rhythm relative to it. The first note is the
   anchor you already know, so you may echo it or skip straight to the
   second note.
4. Every note is graded on pitch, on its onset against the pulse (the
   first note included: if the phrase starts an eighth off the beat, you
   play it an eighth off the beat), and on how long you hold it. There is
   no feedback while you play. It is a conversation: the reply is the next
   question. An interval you missed comes back as a remediation drill; a
   passage with errors comes back two questions later.
5. Three clean answers in a row earn a **real passage**: a Bach chorale
   phrase or a bit of a Mozart sonata, played in its own meter starting on
   your anchor. Play the whole thing back in time, following the call. The
   next call always starts on a bar line at least two beats after your last
   key press, so it never lands on top of you.
6. Ten seconds of silence, once an answer was possible, ends the session.
   Play a note to start another.

Everything adapts:

- **Which interval** is asked comes from an adaptive engine (ported from
  [ear-training](https://github.com/calebjedhugo/ear-training)) that keeps
  first-try success near 80%, unlocks intervals in aural-difficulty order,
  runs discrimination drills on pairs you confuse, and counts an interval
  mastered only when you hit it accurately **and** on the beat. A four-note
  fanfare marks a newly unlocked tier.
- **When you get a passage** is the chime streak above. An interval you miss
  inside a passage is drilled on its own right after. Notes inside passages
  train a separate in-melody model, so a step you can sing inside a chorale
  never masquerades as a step you can name cold.
- **How long a passage** is grows with the engine's unlocked tiers, and its
  fastest note is limited by the tempo.
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
| `--db` | `~/.piano-by-ear/piano-by-ear.db` | SQLite history |
| `--debug-midi` | off | print raw MIDI bytes |

Requires Node 22.5+ (uses `node:sqlite`). Audio is produced in-process by
[node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api);
MIDI input via [@julusian/midi](https://github.com/Julusian/node-midi).

Two voices, so you always know who is playing. Your keys play the additive
concert-grand piano from [resound-sound](https://www.npmjs.com/package/resound-sound):
a key rings while it is down and is damped when it comes up. The system's
call is a steady reed-like tone built only from exact harmonics, so nothing
in it beats or wobbles; each call note sounds for its written length with a
small articulation gap before the next, and the rhythm you copy is carried
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
