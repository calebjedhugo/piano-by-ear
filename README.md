# piano-by-ear

A headless "learn piano by ear" drill for a MIDI controller. No screen, no
settings: the process is the piano, the metronome, and the teacher, and you
only ever touch the keys.

1. Plug in a MIDI keyboard and run `npm start`. A two-note rising cue says it
   is listening.
2. Play any note. That note is the **anchor** and the session begins at a
   tempo chosen from your history (72 bpm the first time).
3. The metronome starts. In the call bar you hear the anchor on beat 1 and a
   **target** on beat 3. On the next downbeat, which is a double tick, you
   play the target back on beat 3.
4. Right pitch, in time: a soft chime. Right pitch but early or late: a short
   glide, falling if you were early, rising if you were late. Wrong pitch: a
   low buzz, the beat keeps going, keep trying. After two misses the app
   plays the note for you; after six it moves on.
5. Three clean answers in a row earn a **real passage**: a Bach chorale
   phrase or a bit of a Mozart sonata, announced by a two-note cue, played
   in its own meter starting on your anchor. Play the whole thing back in
   time, one phrase-length later. A rising arpeggio means you played it
   clean; a single tone means it counted but had errors, and it will come
   back a couple of questions later.
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
  and 132. Timing tolerance is an eighth of a beat.

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
