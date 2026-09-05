# piano-by-ear

A headless "learn piano by ear" drill for a MIDI controller. No screen: the
process is the piano, the metronome, and the teacher.

1. Plug in a MIDI keyboard and run `npm start`.
2. Play any note. That note is the **anchor** and the session begins.
3. The metronome starts (4/4). In bar 1 you hear the anchor on beat 1 and a
   **target** note on beat 3. In bar 2 you play the target back on beat 3.
4. Right pitch, in time: a soft chime, and the target becomes the next
   anchor. Wrong pitch: a low buzz, keep trying, the beat keeps going.
5. Ten seconds of silence ends the session. Play a note to start another.

Which interval is asked is chosen by an adaptive engine (ported from
[ear-training](https://github.com/calebjedhugo/ear-training)) that keeps your
first-try success near 80%, unlocks intervals in aural-difficulty order,
runs discrimination drills on the pairs you confuse, and only treats an
interval as mastered when you hit it accurately **and** on the beat.

## Install

```bash
npm install
npm start -- --bpm 80 --tolerance 80
```

| flag | default | meaning |
|---|---|---|
| `--bpm` | 80 | metronome tempo |
| `--tolerance` | 80 | ms of onset error that still counts as in time |
| `--port` | first port | substring of the MIDI input name to use |
| `--db` | `~/.piano-by-ear/piano-by-ear.db` | SQLite history |
| `--debug-midi` | off | print raw MIDI bytes |

Requires Node 22.5+ (uses `node:sqlite`). Audio is produced in-process by
[node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api);
MIDI input via [@julusian/midi](https://github.com/Julusian/node-midi).

## Key range

MIDI doesn't tell you how many keys a controller has, so the range is
guessed from a key count in the port name (`Keystation Pro 88` -> A0..C8,
`... 25` -> C3..C5) and then widened whenever you play outside it. It is
remembered per controller name, so swapping between an 88 and a 25 just
works. Targets are only ever chosen inside the current range.

## Data

`sessions` and `attempts` tables record every note you play during a
question (pitch, velocity, onset error vs the beat, first attempt or retry).
The adaptive engine's state lives in the `kv` table under `engine`.
