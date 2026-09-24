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
play / Drill (switch mode), the sound toggle, Restart, End drill
(End re-enables sleep). It always boots into the drill. `launcher/pbe.sh
status|users|current|mode|sound [app|hardware]|start [free]|stop` is the
process control both the app
and the `/piano-by-ear` skill use; it never touches sleep. Profiles are one
DB each in `~/.piano-by-ear/profiles/<user>.db`, chords in
`roster.json`, who is loaded right now in `current-user` (written by the
running drill, empty for nobody), sound in `~/.piano-by-ear/sound`; log always
`~/.piano-by-ear/run.log`.
Restart after every code change with `launcher/pbe.sh start`; the log is
where a session is reviewed afterwards.

```bash
npm start                      # flags: --port <substr> --profiles <dir> --debug-midi
node src/main.js --user Caleb  # skip the chord: development only
node src/main.js --keys 36..96 # decode only these keys (small machines)
node src/main.js --bpm 160     # developer override only
```

## WHO IS PLAYING IS A CHORD (2026-09-19)

There is no user menu any more, because a menu is not a keyboard. The drill
boots into a LOBBY with nothing open and nothing graded, and the first thing
played says who it is (`src/lobby.js`):

- a chord on the roster -> that profile opens
- a chord nobody owns -> a NEW profile, named from the chord, there and then
- a single note -> Guest, wiped on every guest login, **and that note is the
  anchor**: the session starts on it, with no click. Everyone else is opening
  a history and is told so by the low-high click, then plays an anchor; a
  guest has no history to open, so asking him to play a second time to begin
  was a step that bought nothing.

A chord is a SET of MIDI notes, so it may be rolled or spread; it is complete
once every key has been up for 300ms. **The decision always waits for the
release, the single note included** -- there is no other way to tell a guest's
note from the first note of a rolled chord. **The match is on exact notes, octave
included** -- `C4-E4-G4` is William and `C5-E5-G5` is Evelyn, and the octave
is the only thing between them. The low-high click (`audio.ready()`) means the
profile is open and the next thing to play is the anchor; a single click means
only that a controller appeared.

**THE PROFILE CLOSES OUT WITH THE SESSION.** Ten seconds of silence ends the
sitting, and the same silence answers "is anyone still there" -- waiting a
second ten only meant twenty seconds of nothing meaning the same thing twice.
It closes a beat later (1.2s), never at once: the session-over clicks go out
on `setTimeout` (`src/midiout.js`) and a sync blocks the event loop for
seconds, which would swallow them. A chord that never becomes an anchor --
somebody logged in and walked away -- closes on the ordinary silence timeout
instead, and pushes nothing, because nothing was played.

A profile nobody has played for 30 days is SOFT DELETED: the db moves to
`profiles/retired/` and the chord stops matching, so playing it starts a
fresh profile. Restoring one is deliberate -- move the file back and clear
`retiredAt` in `roster.json`.

## THE PI IS THE SOURCE OF TRUTH, AND SYNC IS A MERGE (2026-09-19)

Two computers (upstairs, downstairs) and a laptop that travels with the
25-key all write to the same profiles, so a profile CANNOT be a file one
machine overwrites with another: the event tables carry `(device, origin_id)`
and a sync inserts what is missing in both directions, under a per-profile
lock on the pi (`src/sync.js`, `src/delta.js`, `Db.mergeFrom`). It runs when a profile opens
and when it closes, which is now the same thing as a session ending. No network means you play on the local copy
and the rows go home at the next sync -- that is the whole point.

**A LOGIN IS INSTANT AND MUST STAY THAT WAY** (Caleb, 2026-09-19). It was 3 s
here and 9 s on pianobox, all of it between the chord and the click, which is
the one place in the program where a wait is felt. Now 31 ms. Three things
hold it there, and breaking any one of them puts the seconds back:
- **The corpus is parsed once per process** (`src/phrases.js` CORPUS), warmed
  at boot by `main.js` while nobody is waiting. It is the same 20k phrases for
  every player; only `stats` belongs to a profile. Was 0.5 s a login here,
  3 s there.
- **ssh is multiplexed** (`MUX` in `src/sync.js`). A sync makes several remote
  calls and each used to pay its own 200-360 ms handshake.
- **A sync that has nothing to do costs one round trip.** Each push writes a
  random token to `<name>.rev` beside the database and records it locally; if
  the pi still holds that token and `db.localSignature()` has not moved, both
  sides are in step and nothing transfers. **The token cannot be `stat`:**
  mtime is second-granular and a database that grew by one small session lands
  in the same second at the same rounded size, so a stat fingerprint declared
  "already in step" and silently skipped a real merge -- one machine lost the
  other's sitting in testing. If only the pi moved, we pull and skip the push.

**A SYNC SENDS ROWS, NOT FILES (2026-09-23; `src/delta.js`).** It used to
copy the whole database both ways on every sync: 3.7 MB at 19 days, ~75 MB a
year, against a 20 s transfer limit -- pianobox's wifi would have crossed it
within months and its sessions would SILENTLY have stopped reaching the pi.
Now each side reports its WATERMARKS (per table and device, the highest
`origin_id` it holds) and only the rows past them travel: a day of sessions is
~240 KB (~106 KB of it the kv, which goes whole), whatever the history's size.
- **The pi runs the sqlite3 CLI (3.40), not this program** (its Node 18 has no
  `node:sqlite`). So the pi's half is plain SQL built in `delta.js`: it builds
  the pull delta and folds in the push delta (insert where `(device,
  origin_id)` is missing, session ids remapped through a temp `smap`, kv
  replaced by the sender's -- exactly what the whole-file push did). This side
  builds its push with THE SAME SQL (`Db.writeDelta`) and merges the pull with
  `Db.mergeFrom`, which reads `meta.last_played` to decide the kv.
- **Why watermarks are enough:** origin ids are the recording machine's own
  row ids, which only grow; synced rows are NEVER deleted or updated after a
  sync (sync runs only once a session has ended); every transfer sends
  everything past the receiver's watermark. So every copy holds an unbroken
  run of each device's rows. **Adding a DELETE, or an UPDATE of a row after it
  can have synced, breaks this** -- the other copies would never see it.
- **The pi's schema catches up on push** (`schemaDdl`): a missing table is
  created with its merge index, a missing column added. Never dropped.
- **The version token is written BEFORE the rows commit**, so a connection
  lost mid-push errs toward a needless pull, never a missed one.
- The first copy of a profile on the pi is the only whole-file transfer.
- Tested 2026-09-23 against the real pi (isolated dir) with the Mac's copy, a
  brand-new machine and simulated sessions both ways: all three copies
  identical row for row, a forced failure retried with no duplicates, a
  dropped table and column rebuilt. Harmless leftover: older files carry an
  all-NULL `sessions.out_latency_ms` (the reverted 09-19 latency column) that
  fresh profiles do not.

**The kv store cannot be merged** (engine tiers, stage, the passage-length
controller, the phrase schedule are running state, not events): it is taken
whole from whichever side played last and the other side's is kept in
`kv_archive`. That only bites when the SAME player plays two machines while
the pi is unreachable. Rows are never at risk.

The roster travels too, for a sharper reason than convenience: retirement is
decided from `lastPlayedAt`, and without a shared roster a computer that has
not seen Liz for a month retires her while she plays daily on the other one.
It syncs at startup, **before creating a profile from an unknown chord**, and
when a profile closes. The middle one is the important one: a drill running
under systemd has been up since the last reboot, so a profile made on the
other machine this afternoon is simply not in its copy -- creating one there
would fork the player into two db files under one chord, and the roster can
only keep one of the names.

Config: `~/.piano-by-ear/sync.json` (`{enabled, host, dir}`), machine identity
`~/.piano-by-ear/device-id`.

## A DYAD IS A DEPARTURE FROM THE ANCHOR (2026-09-20)

Caleb's definition: **the anchor is the last note I played, and it only
applies to monophonic music. A dyad has no anchor: it is scored as two
intervals from the anchor we are leaving. After it, each hand has its own
anchor.** When each hand plays several notes the anchor concept dissolves
and scoring becomes harmonic motion -- NOT designed, reserved for his ear;
`sonorities` records what it will be designed from.

WHY. The bottom note of a dyad used to be NAMED for him and free, and the
named note was right **282 times in 282** across dyad, placing and chord -- a
row, not a test. In **190 of 366 dyads he never played it** and the question
was scored anyway (123 marked correct). The reported 90% counted those rows;
the interval actually asked for was 75%, and the plain dyad at 84% was
statistically a plain melodic interval (80%). The rung did not exist, and the
app had trained the habit he then noticed: "the app has trained me to have
the bottom note under my hand already. I was using muscle memory."

THE RUNGS (`DYAD_RUNG`, `dyadSlot`, kv `dyadRung`):
1. **contains the anchor** -- one retrieval; **the common tone is REQUIRED
   and graded as a unison**: a row (`attempts.contains_anchor`), never an
   engine width. A one-note answer is a miss ("the common tone was not
   played"). This flips the 190 half-played dyads from passes to fails,
   measured FORWARD only -- never re-score the legacy rows.
2. **does not contain it** -- two retrievals from the anchor being left.
3. **two hands to two hands** -- each hand from its own anchor. Only ever
   served CHAINED right after a dyad he struck with both notes (`this.hands`,
   `chainDyad`): two anchors exist only while two hands are down, and any
   single-line answer collapses them to the top note as it always did.

A per-RETRIEVAL band (85/65, cooldown 8; the unison is never in the
denominator), a DIET not a gate: it decides which dyad the slot serves next,
never whether duo passages are served. The harmonic engine picks the SPAN
(the dyad's own width, unfolded -- a tenth is not a third; wide cold dyads
were 9/9 while a melodic tenth is his weakest band); it is UNSIGNED now and
opens at seconds AND thirds (`minTiers: 3` -- "start narrow like they have"
was seconds only, and its ladder had never moved: 278 trials, zero tier
changes, because plain dyads were built upward only and promotion waited for
a `-w` that could never arrive). The departure distances are melodic
intervals the melodic engine already rates and are NOT capped (09-12: a
floor is never a target). Below DIATONIC_TIERS both notes sit in the key.
"Hand" is VOICE BY REGISTER: MIDI carries no hand.

TWO NOTES, TWO DEGREES OF FREEDOM, ONE CHARGE PER WRONG NOTE
(`judgeSonority`). A pair question (dyad, placing, harmonic exposure) is
judged when its group closes, on the pair he PLAYED. A wrong note is debited
to whichever ear predicted it worse -- the melodic engine's estimate for
that note's departure or the harmonic engine's for the span -- and the
other ear gets no trial for it. Both predicting it fine (>= 0.85) is a
PROGRESSION miss: recorded, charged to nothing. **The recovery walk follows
the charge**: a harmonic miss walks, a melodic one does not, and the melodic
remediation queue stays closed to dyads. "Reported, never charged" was
proposed and is WRONG: arriving on an octave is made of steps he plays at
80% and fails 60-86% of the time; under that rule the harmonic ladder would
never learn his worst event. Evidence goes to the melodic engine at scopes
`departure` / `twohand` (cells only, never the tier ladder, so the dyad gate
cannot feed itself); to the harmonic engine at ISOLATED scope from the
slot's own dyads only (retry, transfer, placing and exposure: passage scope).
The harmonic engine's old state is ARCHIVED to `kv_archive` once per profile
(`Db.runOnce`, kv `migrations`): it measured the wrong thing. It restarts at
three tiers, so the chord gate (>= 2) stays open.

THE PLACING is rung 1 by shape and stays what it was: passage-scope
evidence, off the rung controller (the corpus picks its widths, 23% sixths).
Both hands are REQUIRED now; a duo passage's first group is then two unisons
from two hands (`buildGroups`, `this.hands`) -- it used to grade the placed
bass note AGAIN as a leap from the pivot, a note that hand never travels (65
rows). A duo RETRY gets its other hand placed too (09-13 already required
it). A missed placing before a retry drops the retry, as a missed re-anchor
does. The harmonic pair exposure is a departure then a two-hand step in one
call, so it waits for rung 3. Chords are untouched (the anchor is still free
there): they are not dyads, and the spec did not reach them.

WHAT THE DATA CANNOT SAY: how hard the rung will be. Every historical dyad
named the bottom note, so no retrieval of it was ever recorded; the one
proxy (cold-anchor dyads, 57%) was withdrawn as confounded by remediation.
Measure forward. 7-4 -> 1-3 has occurred ZERO times in the duo data (outer-
voice chorale extractions rarely hold the tritone): a corpus question, later.

## THE ANCHOR IS NEVER SOUNDED BEFORE THE GRADED NOTE (2026-09-21)

An interval call plays the TARGET only. The anchor sits in the question a
beat earlier, silent and free, as melodic context for grading and as a note
you may echo or skip. There is no longer a stage or tier at which the call
sounds it first (`soundsAnchor()` and ANCHOR_SOUNDED_TIERS are gone).

Caleb: "I just want to get rid of it when it's sounding before every
question." The scaffold existed below the exact stage and until three tiers
were open.

THE NUMBERS SAID KEEP IT. William's beginner data is the cleanest natural
experiment the app has produced -- same session, same exact grading, widths
of 1 and 2 semitones only, and the branch flipping question to question as
tiers crossed 3: sounded 78% (23), silent 47% (15); by width 78/38 at a
semitone and 79/57 at a tone. Liz leans the same way on 9. Caleb's own 534
sounded vs 1857 silent are a wash width for width, and he had not heard one
in 40 sessions. The one confound runs AGAINST the scaffold (tiers drop after
misses, so sounded questions follow bad runs).

WE REMOVED IT ANYWAY, and the reason the number was higher is the reason:
with both notes sounding the task is comparing two audible pitches; with
only the target you must retrieve the one you are holding and measure from
it. That is the skill. The gap between the two numbers is the size of the
crutch, not the size of the help -- the same shape as the echo stage (looked
fine, was a dead end) and as passage length being a ceiling, not a target.
EXPECT WILLIAM'S SECONDS TO FALL ABOUT 25 POINTS. That is the real level.

The scaffold did not disappear with the branch: the anchor is the note under
the player's hand and it is free in the question, so a beginner who needs to
hear it plays it himself, when he wants it, without the call spending a beat
every time. Self-served, and it fades on its own.

STILL SOUNDED: the re-anchor (`reanchorQuestion`), which is navigation, not
evidence -- and it is now the ONLY call in the program whose first note
sounds before a graded one. That is what makes "corrections are done, we are
about to try again" legible, for every player rather than just the advanced
ones. Caleb: "the way it's used for the advanced rungs is fine."

## THE LEVEL IS JUDGED PER NOTE, NOT PER PASSAGE (2026-09-22)

The polyphony level (mono -> duo -> chorale -> poly) is promoted and demoted
on the NOTES of the last 12 first-asked passages of its kind, pooled (sum
exact / sum graded): promote >= 85%, demote < 65% -- the dyad rungs' band.
It used to read the PASSAGE VERDICT (>= 70% clean / < 30%).

WHY: TWO CONTROLLERS WERE READING ONE GAUGE. The length controller grows a
kind on 2 clean in a row and shrinks it on 3 misses in a row, which settles
where p^2 = (1-p)^3, about 43% of passages clean -- by design, at any level
he can play at all (mono since 09-19 at his working lengths: 39/48/35%). So
the level's clean rate was the length controller's setpoint plus noise: a 30%
floor over 12 passages is crossed by chance about one window in six, and 70%
is unreachable. The same flaw as 09-19 (a controller steering by a number
another controller sets).

THE CASE: demoted to mono 2026-09-21 20:47 on 3/12 clean -- and those 12
were 80% right note for note (49/61), above his duo average since 09-19
(77%) and inside the band. Duo per note at 4-7 notes: 83/85/70/75%; mono at
the same lengths 83/91/81/76%. "The skill is the note, the length is
multiplication" (the dyad rung's rule) now governs the level too.

NOT CHANGED, on Caleb's call ("let's see what happens first"): a returning
level resumes its kind's length where it was left (duo came back at 7 notes,
where he is 0 for 4 since 09-19). Watch it before resetting it.

## MEMORY, FOR SMALL MACHINES (2026-09-19)

The sampled pianos decode every kept layer into memory at startup. Measured
RSS on the mac, profile open, samples present:

| decoded keys | RSS | grand PCM | upright PCM |
|---|---|---|---|
| 21..108 (88, the default) | 615 MB | 243 MB | 107 MB |
| 36..96 (61) | 477 MB | 176 MB | 69 MB |
| 48..72 (25) | 375 MB | 77 MB | 32 MB |

The corpus is ~130 MB of that and loads PER PROFILE OPEN (both banks), so it
is not paid until somebody plays. Salamander is already trimmed to 4 of 16
velocity layers (`SALAMANDER_LAYERS`); velocity still varies continuously by
gain, so the layers are timbre only.

MEASURED ON `pianobox` (2026-09-19), the downstairs machine: Acer CB3-111,
Celeron N2830, **1887 MB total RAM**, Debian 13, 88-key Keystation, Node
22.23.2. Full 88-key load, lobby (no profile open): **peak RSS 568 MB**,
599 MB steady after a reboot, 606-1074 MB available. **Sample decode takes
~15 s there against ~1 s on the mac** -- so give it no systemd watchdog (the
app does not sd_notify and anything short kills it mid-decode), and expect
the synth to voice anything played in the first quarter minute after boot.

DEPLOYING ON SIMILAR HARDWARE (Bay Trail / `chtmax98090`), from that install:
- **`firmware-intel-sound` is not installed by default and nothing tells you
  so.** Without the SST DSP blob every PCM open returns EBUSY, and each layer
  renders that as a different wrong answer -- ALSA "invalid hwparams", cpal
  "stream configuration is not supported", PipeWire "Device or resource
  busy". The truth is only in dmesg: `intel_sst_acpi ... FW download fail -2`.
- **PipeWire is mandatory on that codec, not a convenience.** The card takes
  only S16_LE / 2ch / 48000 and has no UCM profile; cpal cannot negotiate it
  even through the ALSA plug layer `aplay` uses happily.
- **`rtkit`** too, or PipeWire never gets realtime priority -- worth having
  where onset is graded to +-45-110 ms.
- **PipeWire driving that card with mmap and small periods wedges the DSP**
  (`sst: Busy wait failed, can't send this msg` flooding dmesg): `aplay` is
  fine because it goes rw through the plug layer, and node-web-audio-api is
  silent while every layer reports success. A wireplumber rule fixes it --
  `api.alsa.disable-mmap = true`, `period-size 1024`, `periods 4`,
  `headroom 8192`, `disable-batch = true`. A wedged DSP STAYS wedged: reboot
  before concluding a fix did not work.

THE COST OF THAT FIX WAS 178 ms, AND IT WAS NEVER THE DSP'S FAULT. 1024
frames at 48 kHz is ~21 ms a period; the wireplumber headroom that made the
card audible at all is what set `outputLatency` (0 -> 7.7 ms but silent,
2048 -> 50 ms silent, 8192 -> 178 ms and the only setting that reliably
sounded). **Superseded on pianobox 2026-09-19 23:50: PipeWire is masked
there and output latency is 10.0 ms.** Audio goes node-web-audio-api -> cpal
-> ALSA `hw:chtmax98090` directly; raw hardware does 6 ms. Sessions on device
`63fcc72e` before that timestamp were played at 178 ms, after it at 10 ms.
The PipeWire notes above still apply to a fresh Bay Trail install that has
not had that shim built.

**LATENCY IS NOT COMPENSATED FOR, AND THAT IS DELIBERATE** (Caleb, 2026-09-19:
"Latency occurs on acoustic instruments for various reasons. The performer
adapts. Don't factor it in."). `onsetMs` measures the player's press against
the time the call was SCHEDULED, not the time it became audible, and it stays
that way. A player adapts to an instrument's delay the way an organist does;
building a correction would be modelling the room instead of the playing, and
it would move the grading ruler. 178 ms is a HARDWARE fault to fix in
hardware -- a USB audio adapter bypasses that DSP -- not a number to subtract.

**AND NOTHING IN THE APP CHANGED WHEN THE 178 BECAME 10.** The fix is
entirely machine-side. One repo-relevant reason it has to be: cpal 0.18
(bundled in node-web-audio-api 2.2.0) negotiates ALSA buffer-first in powers
of two, and `chtmax98090` returns EINVAL for anything that is not a multiple
of 48 rather than rounding, so **`latencyHint` is silently ignored on that
hardware** and cpal falls back to 864 frames. pianobox fixes the negotiation
in an LD_PRELOAD interposer (`~/.local/lib/sst-buffer.so`, loaded by the
systemd unit) that forces period 240 / buffer 480 and puts the audio thread
on SCHED_FIFO. So **do not add `sinkId` or `latencyHint` logic to the app**
for that box -- it would do nothing, and the shim already handles it.
`src/audio.js` uses a plain `new AudioContext()`; `~/.asoundrc` there makes
the codec the default device.

**ZERO ERRORS IS NOT AUDIBILITY ON THAT CODEC.** Twice a clean ALSA/DSP log
there has meant silence. Confirm by ear before calling an audio change good.

`--keys lo..hi` trims what is decoded. **Only for a machine with one
permanently attached controller**: a key outside the decoded range falls back
to the synth mid-sitting, silently, which is exactly what a second keyboard
switched on later would cause. It is infrastructure, not a musical setting --
it changes nothing the drill asks for, only what is in memory to sound it.

No MIDI device present at start is fine; `src/midi.js` polls every 2s and
opens every input port.

**THE VOLUME IS CC 7** (`src/volume.js`, 2026-09-20): the Keystation's
fader reports as MIDI's own volume controller and Caleb wants it FIXED, not
learned. It drives the app's master gain (square law), never the codec
mixer, so it is the same on every machine; the last position is kept in
`~/.piano-by-ear/volume.json` across restarts.

## DEPLOYING TO pianobox: A PUSH IS HALF A DEPLOY (2026-09-20)

**YOU MUST pull on pianobox every time you push to the repo.** Nothing does
it for you, deliberately -- **there is no auto-pull, by Caleb's ruling
(2026-09-20): a machine that fetches code from the internet by itself is not
wanted, his own repo included.** From the mac:

```bash
ssh pianobox 'cd ~/piano-by-ear && git pull --ff-only && systemctl --user restart piano-by-ear'
```

- **Check nobody is playing first** (`tail ~/.piano-by-ear/run.log`): the
  restart kills a sitting, and the sitting's rows reach the pi only on close.
- **If `package-lock.json` moved, stop and do it by hand.** Two of the three
  deps are native (`@julusian/midi`, `node-web-audio-api`) and an unattended
  install on a 2 GB Celeron with no working display is how that box becomes
  an ssh rescue job.
- The machine-side audio setup (`~/sst-shim/`, `~/.local/lib/sst-buffer.so`,
  the systemd unit, `~/.asoundrc`) is NOT in this repo and a pull cannot
  touch it. That is on purpose: the app is hardware-agnostic.

WHO CAN REACH WHOM (measured 2026-09-20, this is not symmetric):

| from -> to | mac | pianobox | hugopi |
| --- | --- | --- | --- |
| mac | -- | ssh yes | ssh yes |
| pianobox | no | -- | ssh yes (profile sync) |
| hugopi | no | **no -- cannot even resolve the name** | -- |

**The pi holds the histories; it cannot drive either machine.** It is a place
files are put and fetched, never a thing that reaches out. So a deploy to
pianobox can only be driven from the mac, and any "have the pi push it" plan
is a non-starter until pianobox has a name the pi can resolve.

VERSION SKEW HAS ONE REAL TOOTH, and it is the sync fast path. The `.rev`
token arrived in `797af88`; a machine older than that pushes a profile
without writing one, so the other machine reads its own stale token, says
"already in step with the pi", and skips the merge. **The sitting that
follows is played against a stale floor.** Nothing is lost -- the next
session's signature no longer matches, the full merge runs, and both sides
land -- but keep the two machines on the same commit and the question never
comes up.

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
  RE-METERING (2026-09-14): an excerpt whose fastest note would still go by
  under REMETER_BELOW_S (0.32s) is RE-QUANTISED ONTO A 0.4s CLICK -- the
  shortest note becomes the beat, and everything else keeps very nearly the
  real duration it had, because gaps and lengths are measured in SECONDS at
  the tempo the music wanted and then rounded to whole clicks (min 1, max a
  half note). So a quarter comes out 0.80s, not 1.60s: only what was too fast
  to hear is stretched. Caleb: "slowed down to half-time and then any longer
  notes put back at the regular tempo so things don't get too slow." 42% of
  the mono corpus qualifies. THE COST, ACCEPTED: sixteenths and eighths both
  become one click, so a 2:1 written ratio flattens -- pitch exact, rhythm
  approximate. Never more than ONE CLICK of silence between onsets (the note
  is lengthened, never the gap), which keeps the MAX_REST_BEATS guarantee
  that rounding would otherwise have broken. Because a re-metered beat is
  0.4s, every wait written in beats has an absolute floor MIN_QUIET_S (0.8s)
  or an answer gets cut off mid-phrase.
  **THE ONE RULE: NO NOTE IS PLAYED THAT THE PLAYER IS NOT BEING ASKED TO
  PLAY BACK.** No listen-only questions, no cues, no chimes, no error
  sounds, anywhere. Feedback is intrinsic to the content served: a miss is
  the same phrase asked again, the key is an arpeggio he plays, the round is
  a caller that stops waiting, a stage move is a change in what is asked.
  The only sounds are the metronome (a woodblock, never a pitch), the call,
  and the piano under the player's own keys. `ready()` and `sessionOver()`
  are clicks for the same reason. A note flagged `free` is still a note he
  is asked to play -- free means not held against him, NOT decoration.
  YOU MUST NOT add a cue, a chime, a listen pass or a sounded hint to this
  program. If a feature needs one to work, the feature does not belong here
  (that is what removed the judge window on 2026-09-11).
  KEY BLOCKS (`src/keyblock.js`): every BLOCK_QUESTIONS (8) the note the
  player is on becomes a new tonic (mode rotates) and the block opens with a
  `prime`: a TONAL SET WALKED ONE NOTE AT A TIME, two to four ordinary
  interval questions (`this.priming`, `primeQuestion`, `nextPrimeTarget`),
  not one call carrying the whole set -- a five-note call is not something
  anyone can play back, and nothing else in the drill works that way. The
  tonic is the note already under the hand and is never asked. Sets
  (`PRIME_SETS`, keyblock.js) are ordered by how hard they are to WALK, which
  inverts how hard they are to name: first three / first five (tiers 0, so
  always open) / pentatonic (4) / triad (5) / seventh (7) / ninth (9),
  weighted toward the widest earned; below the exact stage only the stepwise
  pair. EVERY STEP IS AT THE PLAYER'S LEVEL: `nextPrimeTarget` picks from what
  is left of the set so the interval FROM WHERE THE HAND ACTUALLY IS is in
  `primeWidths()` = the stage's pool or the unlocked TIER_WIDTHS, plus 1 and 2
  which are always allowed (walking a scale is how a key is established and is
  the easiest motion there is). So a beginner only ever gets steps and half
  steps. Degrees are tried an octave up and down too, to stay inside the
  stage window and give the line somewhere to turn; the weighting prefers a
  turn over a run (x1.8) and a singable distance over a leap (x1.3). A wrong
  answer never strands the walk -- the next target is chosen from where the
  hand landed. That walk IS how the tonal centre is established -- nothing
  announces it. The block then
  holds: passages are transposed INTO the key (`PhraseBank.pick({key})`,
  pivot still on the anchor), gestures step diatonically in it, plain
  targets lean diatonic (DIATONIC_LEAN). No cadence, no drone, no emergent
  key (tonalfield.js is gone: it renamed the key almost every question).
  HARMONIC RECOVERY WALK (`queueRecovery`/`recoveryQuestion`, Caleb's design
  2026-09-14). A missed dyad/chord/placing used to queue another dyad -- an
  "easier" inward variant off a 119-trial harmonic model -- which sat at
  36-41% clean whether it came first or second in a row (i.e. it was never
  easier), and arriving straight after a miss is what made the drill feel like
  a cascade: "I feel stressed, and the data agrees with how I'm feeling."
  THE OLD HARMONIC REMEDIATION QUEUE IS GONE. Now the interval is given a
  chord to live in (`chordFor`: the diatonic chord of the block key holding
  both pitch classes -- consonant triad, else seventh, else diminished; a
  tritone comes back as V7, a sixth as the triad it inverts) and the ear is
  WALKED there, every step a plain melodic ask: (1) the note that was missed,
  alone; (2) a chord tone, the biggest leap the ladder has opened that still
  leaves the other note reachable; (3) the other note of the dyad; (4) the
  same two notes together; (5) THE SAME INTERVAL ELSEWHERE IN THE SAME KEY
  (`transferBass`), on a different degree, both notes diatonic. By (4) the
  chord has been laid out in time rather than sounded at once -- "a sparsely
  orchestrated chord". (5) exists because (4) can be passed from HAND MEMORY:
  by then his hand has been on both notes, so a clean retry does not prove he
  heard anything, and perceptual learning consolidates at the hard end
  (Ahissar & Hochstein's reverse hierarchy: easy exemplars first, then the
  hard case, repeatedly). A different degree is required, not merely a
  different octave, or the interval arrives with the same function and it is
  the same trial; relaxed only where the key holds no second placement (a
  tritone sits on one degree pair, so F+B after B+F is the only elsewhere
  there is). Steps are GRADED
  but scored like the prime: evidence at passage scope, stage credit on the
  rung, NEVER the tier ladder (a prompted step inside a scaffold must not
  promote). ONE MISS ANYWHERE DROPS THE WHOLE WALK, back to the ordinary
  drill -- no stacking failures, and the retry is never announced, so a
  dropped one is simply never noticed. Only out of a dyad/chord/placing: a
  harmonic miss inside a PASSAGE keeps its own loop (window -> correction ->
  re-anchor -> retry) rather than having a walk pushed into the middle of it.
  A chromatic pair gets no walk (the key has nothing to build on).
  WHY MELODIC STEPS WORK WHEN THE DYAD DOES NOT (his profile, 2026-09-14):
  m3 82% melodic / 38% harmonic, M3 79/21, m6 62/25, M6 69/17 -- but P5 72/79
  and the octave 90/71. Perfect consonances fuse into one nameable object;
  imperfect ones fuse into a blur. Sequential presentation separates the
  streams (Bregman). P4/P5 are still walked when missed: a freebie after a
  miss is what an 85% training rate is made of (Wilson et al. 2019).
  WHAT THIS IS NOT: recall. THE ONE RULE means the call SOUNDS every note the
  player must produce, so the answer is in the stimulus on every question in
  the drill -- there is no question anywhere that withholds it. Retrieval-
  practice findings (Kornell/Hays/Bjork: errorful generation needs the answer
  to follow) DO NOT APPLY here and were cited against this design in error.
  The task is auditory discrimination plus an ear-to-hand mapping, its
  feedback is intrinsic and immediate (call heard, own note heard, mismatch
  audible), and the governing literature is perceptual learning, where
  repeated exposure at the hard end is the mechanism and immediate repetition
  is correct -- which is what the retry has always said: "constant practice
  until correct is what the evidence backs".
  KINDS: prime | interval | gesture | discrimination | exposure | remediation |
  dyad | dyad discrimination | chord | passage | retry | variant | round |
  echo | reanchor | placing | recovery | dyad retry | dyad transfer. Question
  flags: `pair` (judged as a pair at group close), `regime` (departure |
  twohand | placing), `contains`; note flags `from` (the anchor a note is
  measured from), `unison` (a required common tone), `regime`.
  PLACING (`placingPlan`/`serveWithPlacement`). TWO CASES, and the second was
  missed until 2026-09-15. (a) A MELODIC PLACING when the passage does not
  begin under the hand AT ALL: `PhraseBank` offers each phrase at octave 0 and
  at +/-12 (`placement`), so a variant can start an octave away, and then the
  PIVOT -- the one note that is supposed to be free, the note you already have
  -- is somewhere else entirely. The pivot is asked as an ordinary melodic
  interval (kind 'placing'), the anchor moves onto it as after any interval,
  and `picked.octave` is zeroed because the displacement is no longer true.
  Caleb, guest mode 2026-09-15: "The last question made me start a passage
  cold. My hand was not on the starting note" -- Mozart K332 variant, starts
  C#4, anchor C#3; he fumbled A#3 on the free note (swallowed, as in the
  09-13 keyed case) and was 1.6s late into a re-metered 150 bpm line. THE
  PIVOT IS PLACED FIRST because placing it MOVES the anchor and (b) is
  measured from the anchor, so a two-handed passage in a foreign octave
  places in two steps: the hand you have, then the hand you do not. The chain
  terminates -- a landed melodic placing leaves the pivot ON the anchor, so it
  can never be asked twice, and the dyad is always last.
  (b) THE PLACING DYAD (`placingQuestion`, Caleb 2026-09-14, on unlocking
  polyphony again: "There's nothing placing my left hand before the example
  starts"): before EVERY polyphonic passage (first asking and variant, not retry --
  there every voice's first note is already free), the other hand's first
  note is asked as a dyad against the anchor. The pivot is placed on the
  anchor, so one hand knows where it is; every other voice's entry was a cold
  interval to be found while the passage was already moving. SAME BUG CLASS AS
  THE RE-ANCHOR: a call assuming the hand is where it isn't. (buildGroups had
  already made a duo's first bass note GRADED -- 09-11, "ungraded yet fatal" --
  but nothing ever ASKED for it.) A dyad, not a melodic ask, because what has
  to be placed is two hands DOWN AT ONCE -- and since 09-20 BOTH ARE
  REQUIRED, the pivot as a graded unison (it was free, and free is what
  taught him the bottom note is optional); `keepAnchor` stops
  completeQuestion moving the anchor to the note just played (which is exactly
  what would unplace the pivot), and the landed pair becomes `this.hands`. The target is the LOWEST entry among the
  voices the pivot does not cover, and it is usually BELOW the anchor, so
  buildGroups honours an explicit `harmonicRef` instead of the group's bass
  and gradeNote takes the harmonic interval BY SIZE, folded (a sixth is a
  sixth whichever of the two you were already holding). EVIDENCE, at passage
  scope, unlike the re-anchor: it is a real sonority he found, not navigation.
  Across the poly corpus these placings are 23% sixths (+8 1794, +9 1460 of
  13971), so this is also the harmonic sixth dose that opening chords failed
  to deliver (+8 was n=2 lifetime on 09-13). Served EVERY time for now --
  Caleb: "err on the program being easier for now". A MISSED PLACING DROPS THE
  PASSAGE, with no verdict and no try spent, exactly as a missed re-anchor
  drops a retry -- Caleb, 09-14, on the passage that followed one he missed:
  "I didn't stand a chance because my left hand wasn't in position." A passage
  he cannot reach is not practice, it is a failure being recorded. It cannot
  ping-pong: a missed dyad resets `streak` to 0, so another passage has to be
  earned again. Not in KEYED_KINDS (no block question spent) and not an
  isolatedKind (the tier ladder never sees it). It is drained at the TOP of
  `makeQuestion` so nothing can come between the hand being placed and the
  call that needs it there. TUNE LATER if it gets tedious when he is more
  advanced (first asking only, or only when the entry is far from the anchor).
  RE-ANCHOR (`reanchorQuestion`, Caleb's design 2026-09-13): two notes -- the
  note he is ALREADY ON, sounded and free, then the note the next call needs,
  a beat later, graded. It is `intervalQuestion`'s sounded-anchor branch,
  which only players below the exact stage ever hear, so at the top of the
  ladder it is the ONLY sequential two-note call whose first note sounds (a
  dyad's are simultaneous; a gesture's and an interval's anchor is silent; a
  passage is 4 notes minimum). That makes it legible as "corrections are done,
  we are about to try again" WITHOUT A CUE. Below exact the signal is not
  distinctive and that is accepted -- beginners are not running long
  corrective loops. It is NAVIGATION, NOT EVIDENCE (`q.navigation`): gradeNote
  skips both engines for it and it is not an `isolatedKind`, so the stage
  never sees it -- he is handed the target by ear, and it fires most often on
  the phrases he is failing, so scoring it would bias the ladder the wrong
  way. Fires (1) before a RETRY whose free first note is not under his hand --
  Caleb: "I'm getting lost during the passage and losing track of the anchor.
  Then my retry is corrupted by not remembering what note the passage started
  on"; a missed re-anchor DROPS the retry with no verdict, no try spent and no
  rest (its failed first asking already set the phrase due tomorrow); (2) when
  the anchor leaves the stage window. THE ANCHOR IS THE NOTE UNDER THE HAND
  AND IS NO LONGER CLAMPED BEHIND HIS BACK: clampAnchor is now a pure
  calculation and the drill ASKS him to move, because that is the only thing
  that actually puts him there. A missed re-anchor of kind (2) falls back to
  moving the anchor, so the walk cannot run off the end and it never asks
  twice. Selection
  order in `makeQuestion()`: round, window, correction, placed passage,
  recovery walk, re-anchor, retry (SAME
  placement as the miss: `retry.placed`), block prime, pair exposure, the melodic remediation queue
  (folded to simple intervals), due variant, passage (streak >= 3 or 6
  clean notes, < 3 in a row; top stage only), echo game (every 2nd plain
  question at the echo stage, every 3rd at contour, and never after two
  unfilled windows in a sitting -- `this.echoEmpty`; it used to be EVERY question at the echo
  stage, which is a dead end: the plain slot could produce nothing else, so a
  player who makes nothing up gets silent 30s windows forever and the drill
  has visibly stopped asking, AND the ordinary questions the stage is read
  from never happen, so he can never climb off 'echo'. William, 2026-09-15.
  THE GAME STAYS -- it is for Evelyn, who is four, and inventing may be more
  than she can do by answering; which of the two kinds of player is on the
  bottom rung is settled by `echoEmpty`, not by the stage),
  dyad/chord slot, then a plain target (discrimination
  from the pair focus, wide ask, gesture GESTURE_RATE, or interval). The
  harmonic engine's pair focus gets its exposure call too (as dyads).
  PITCH AND TIME ARE SEPARATE: `pitchClean` drives streak, retry, length,
  poly promotion, variants; `timeClean`/`timing` are logged beside it
  ("timing 3/4 in time, 1 hold off") and stored (`passages.clean` = both,
  `passages.pitch_clean` = pitch).
  THE JUDGMENT WINDOW (`openWindow`/`closeWindow`, kinds `window` then
  `correction`, table `windows`). After EVERY passage-kind question -- clean
  or not, so arrival is never the verdict -- THE PULSE DROPS for
  max(WINDOW_SEC 2s, WINDOW_BEATS 2 beats). The metronome is the one thing
  that never moves, so stopping it is the loudest signal available and the
  only one that costs no note (tick() skips `audio.click` while `q.window`;
  the grid keeps counting underneath so nothing restarts). Presses in the
  silence are collected in handleAnswer and read at the close, DEDUPED (he is
  naming notes, not playing): HIT (a note that really got past him), ECHO
  (the wrong note he actually PLAYED -- on reflection he still believes it
  was right, a representation problem; goes to `recordConfusion` at weight 1
  where a passage miss gets 0.5), CATCH (already self-corrected, already
  measured, scores nothing), STRAY (nothing wrong there; after a clean
  passage, a false alarm). No press = "it was clean", right or a miss gone
  unnoticed. Then `correction`: the live misses minus the ones he named,
  served at the passage's tempo (`q.tempo`) to play back, cascade included.
  THE CHAIN REPLACES BOTH PAST THREE MISSED NOTES (`CHAIN.minMissed`, first
  askings only). Correction accuracy by how many notes the passage missed
  (09-11..18): 2 -> 81%, 3 -> 62%, 4 -> 47%, 5 -> 20%, 6 -> 20%; and the next
  COLD asking of that phrase on a later day is clean 60-63% after a clean or
  one-miss try and 12% after a deep one. At two the correction works because
  it hands you a note and asks for one; past that it is a list of pitches with
  no run-up. `startChain` cuts the SPAN out of the passage as placed and heard
  (`window.notes`) -- from the note BEFORE the first miss through the last
  one, INCLUDING the correct notes between, because half of multi-miss
  failures are scattered and serving only the misses teaches a sequence that
  is not in the music. Each step = the span's opening note (handed, ungraded,
  the reference) + `len` after it; clean GROWS it, a miss SHRINKS it (never
  repeats -- that is what terminates the walk and keeps him near the rate at
  which he is playing rather than guessing, Wilson 2019); done at the whole
  span or `CHAIN.maxSteps`. NO RETRY FOLLOWS (`startChain` clears
  `this.retry`): a retry records nothing anyway, and re-serving a passage he
  just missed badly sits far under the error band. Scored exactly like a
  correction (`correction: true`) but logged as `kind: 'chain'` so the walk
  reads apart from the loop it replaced. Ash & Holding 1990 (keyboard task:
  both part methods beat whole training in training, on the whole task and at
  one-week retention; forward chaining won). DECLARED IN ADVANCE, do not
  re-score it later: the target is SEGMENT ACCURACY >= 80% -- playing instead
  of guessing -- and the 12% next-cold-clean is watched, not targeted.
  Order in makeQuestion: round, WINDOW, CORRECTION, CHAIN, retry.
  PASSAGE LENGTH IS A TARGET, NOT A CEILING (`LEN`, `passageLength`,
  `updatePassageLength`). It used to pass its value as `maxNotes` alone, so the
  bank returned ANY phrase under it, and `grow` counted clean passages without
  caring how long they were -- a clean TWO-note passage raised the ceiling that
  admits NINE-note ones (09-18 20:40: clean at 2,7,6,7,7 -> ceiling 7->8->9 ->
  failed 8,9,9). Mono clean by length 09-11..19: 2 67%, 3 61%, 4 65%, 5 44%,
  6 45%, 7 31%, 8 18%, 9 0% (n=9, the whole lifetime record); per-note accuracy
  is FLAT at 72-81%, so length is arithmetic, not harder material. It also cost
  a polyphony level: duo started at 8 notes and floored at 6, his duo record at
  6+ is 0 for 23 (at 3 notes it is 63%), and the window that demoted him
  duo->mono on 09-18 had all 3 cleans at 3-5 notes and 8 of 9 failures at 6-9.
  NOW: `minNotes = target - LEN.band` bounds the pick from below, and ONLY a
  passage served in the band votes on grow/shrink. The band is a preference --
  `pickPassage` widens down rather than serving nothing. Starts/mins are where
  the data puts him (mono 4/3, duo 3/3). A high target also SHRINKS THE POOL,
  which is what made long phrases recur; it is a symptom of the target, not a
  separate bug. Variants and retries do not go through the band (a nailed
  phrase's length is proven for that phrase). Neither moves the
  streak, cleanNotes, passagesInARow or the ladder; a correction is scored at
  passage scope and queues no remediation. The CUED judge window it replaces
  is dead (`judgments`, historical) -- a cue is a note you are not asked to
  play, which is how this drill got its one rule. QUIET_BEATS: a retry or variant answer ends
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
  ROUND.misses (5) with one cool-down call at level 0, ANNOUNCED BY NOTHING
  (the caller simply stops waiting), evidence scope 'round' (cells only: never the tier
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
  Block count: KEYED_KINDS only (the prime, retries, rounds, echoes and
  exposures are not the key's). ECHO GAME: `collect` question (SILENT -- the
  drill just goes quiet and takes the player's 2-4 notes until a beat of
  silence) -> that same figure asked straight back as the call, graded on
  the stage's rung. One question, not two: the playback and the ask are the
  same thing, because nothing is played that is not being asked for.
  It is the ONE question where the drill has played nothing, so silence in it
  means "still thinking", not "gone away" -- and thinking about what to make
  up IS the task. It used to run the clock out and END THE SESSION (William,
  2026-09-11: four windows, two figures, and both of the other two killed the
  session; the fifteen seconds he took before one of the figures is normal,
  not a stall). The silence timeout on an empty `collect` now moves on to the
  next question instead of ending the session; the ordinary question that
  follows ends it in the usual way if the player really has left. DO NOT put
  a level gate on this -- William understood the game perfectly well; the
  only thing wrong was the session dying under him.
  COMPOUND ASKS: `engine.lastWide` marks a target an octave wider than the
  asked simple interval (label "+8ve"); pitch class right but octave wrong
  = `height_err`, credited to the interval, debited to `engine.state.height`.
  BURSTS ARE ONE SITTING: kv `carry` (endedAt, block key + number, warm-up
  count, retry and variants as id/shift/key re-placed from the bank and
  dropped if they no longer fit, remediation, asked ids)
  is restored by a session started within CARRY_MS (30 min). The block
  itself is NOT carried, only its number: a resumed sitting opens a fresh
  block on the note the player has just sat down on, because the prime is a
  call and a call starts under the hand. roundStreak/cooldown and the streak
  reset per burst.
  PASSAGE LENGTH is a controller (kv `passageLen`, +1 after 2 clean
  first-askings, -1 after 3 failures, bounded by LEN.min and the tier
  ceiling). TEMPO IS NOT A CONTROLLER and must never become one.
  GRADING IS BY ONSET GROUP (`buildGroups`): notes with the same offset form
  a group; a key press matches any pending note of the current group by
  pitch, a wrong note consumes the nearest pending graded note, and a press
  matching the NEXT group (inside its window) abandons the rest of this one.
  Each expected note carries `melodicFrom` and `harmonicFrom`. Question
  notes are `{midi, b, dur, voice, free, silent}`.
  ONE RE-ATTACK (`this.reattack`, `dueNow()`): a missed note stays open until
  the next note's ONSET (not its accept window -- a player who stops to fix
  something is behind by then). The expected pitch arriving in that gap is a
  CATCH: logged `caught it: X, Nms later`, stored as `attempts.self_corrected`
  and counted in `passages.self_corrected`, worth half an exact note in
  `rungScore`. It is NOT a second chance -- the note stays missed, pitchClean
  stays false, the grid does not move, the engines and the stage see only the
  first attempt. Exactly ONE: any other press closes the window (hunting is
  searching, not catching). Distinct from rungs' `recovered`, which is the
  professional recovery -- play on, get back onto the line later -- and says
  nothing about whether the player noticed. Before 2026-09-11 the re-attack
  press hit `atAudio < g.acceptFrom` and was discarded unread, so 2026-09-11
  and earlier data has no catches at all.
  POLYPHONY LEVEL (`polyLevel()`, kv `poly`): level 0 -> 1 is earned from
  interval confidence (POLY.melodicTiersForDyads tiers AND
  POLY.masteredForDyads mastered), not passages; higher levels from the
  NOTES of the last 12 first-asked passages of the level's kind, pooled
  (>= 85% / < 65%, the dyad rungs' band) plus tier gates -- PER NOTE SINCE
  2026-09-22, see "THE LEVEL IS JUDGED PER NOTE" above. History rows without
  `exact`/`notes` (older) never vote. Demotion 1 -> 0 holds the gate closed
  for POLY_DEMOTE_HOLD_MS. THE LEVEL IS RE-READ AFTER EVERY FIRST-ASKED PASSAGE
  (`recordPolyOutcome`), not only at `startSession`: the row that fills the
  12-passage window usually lands mid-sitting, and 2026-09-12's 33-minute
  session (267 questions) ran to the end on duo at 0% clean because the
  twelfth duo row arrived after the level was last read. The change itself is
  announced by nothing; `flushPolyMove()` prints the line AFTER the passage
  verdict, so a demotion is not read as caused by the passage that just went
  clean. The ladder now governs PASSAGE TEXTURE ONLY
  (`passageKinds`); LEVEL_NAMES[1] is "two voices", not "dyads and two
  voices".
  DYADS AND CHORDS RUN ON INTERVAL CONFIDENCE, NOT ON THIS LADDER
  (`dyadsOpen()`, 2026-09-12): the same entry bar as before (tiers and
  mastered counts) but a duo-passage slump can no longer take them away. A
  dyad is an interval played together and a chord is a sonority; neither has
  anything to do with holding two melodic voices apart in a Bach excerpt,
  and tying them together switched off the only harmonic practice in the
  drill whenever the passages had a bad night. The harmonic engine had 81
  trials in the profile's LIFETIME against the melodic engine's 2,395 --
  62 of them on P5 and P8, the harmonic m6 asked ONCE and the M6 seven
  times at 8%. Gates moved: the dyad/chord slot, the harmonic remediation
  drain, the harmonic remediation queue after a passage miss, and the
  harmonic pair-focus exposure.
  DYADS ARE DEPARTURES (2026-09-20, the section above): the anchor is no
  longer a named free bass. Every 9th
  plain slot is a `chord` from CHORD_SHAPES once harmonic tiers >= 2 (dom7
  at >= 5); each chord tone is framed for the harmonic engine as it is
  graded (`q.chord`), never pre-asked; the chord's bass is still the free
  anchor -- chords were outside the 09-20 spec. THE CHORD GATE IS 2, NOT 3, AND THE
  REASON IS THE POINT OF THE FEATURE: TWO NOTES ARE AMBIGUOUS AND THREE ARE
  NOT. E-C is a m6 that could be C major, Am7 or F6; E-G-C is C major in
  first inversion and nothing else. Function appears at three notes, so
  gating the sonorities behind a ladder earned on two-note asks holds back
  the thing that gives the interval its meaning (McLachlan 2013: hearing out
  chord tones tracks familiarity with the TYPE). `[3,8]` and `[4,9]` ARE the
  first inversions -- major and minor -- and a first inversion IS a harmonic
  sixth, which is why this is the route to the sixths and bare-interval
  drilling was not: 283 melodic m6/M6 trials over eight days moved nothing.
  Caleb, 2026-09-12: "I need to hear and play them in a chord to learn them,
  which is something I haven't done much of." Opening the chords is also the
  sixths bias, delivered structurally -- half the CHORD_SHAPES triads carry
  a sixth -- so do NOT also weight the harmonic pool toward sixths without
  re-reading the data first, or they are counted twice. KEYED PASSAGES grade the pivot too
  (it is not the note under the hand): buildGroups frames it from the
  anchor: the duo's BASS first note (its pivot voice starts on the anchor
  and is free). A KEYED PASSAGE STILL STARTS ON THE NOTE UNDER YOUR HAND --
  `PhraseBank.pick` with a key REQUIRES the pivot to land on the anchor and
  pickPassage falls back to anchor placement (no key) when nothing does. The
  pivot is free, as it always was. THE SAME GUARD NOW COVERS `pickInKey`, the
  VARIANT path (2026-09-13): it never had it, so 40 of 53 variants in Caleb's
  history opened a mean 3.6 semitones off the note under his hand -- and
  because the pivot is FREE, his attempt to start where his hand actually was
  was swallowed as an ignored free-note press and he was graded from a note he
  never found. He caught it by FEEL, not from the numbers: "I noticed I was
  frustrated and that's what told me it was a bug." The aggregate damage was
  small (variants fail on the first graded note 34% vs passages 32%) and the
  cost was real anyway, because it fired right after a miss. Variant fallbacks
  are anchored too: they used to transpose `v.placed` -- the placement from
  when he NAILED it -- by +-2/3 semitones or into the other mode, starting the
  call where his hand was THEN. The anchor has moved since, so placing on the
  anchor IS the transposition (`pickById`, rejected when it reproduces the
  original's pitch set); mode swap is last and re-checks the pivot, since
  moving degrees 3/6/7 can shift it. Placing a phrase merely "in the key" made
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
  melodic (kv `engine`) and harmonic (kv `engine:harmonic`; `unsigned: true`
  -- its skills are sizes, the frontier gate counts |w| -- `minTiers: 3`,
  seconds and thirds open from the start, and `timed: false` -- MASTERY ON
  ACCURACY ALONE, because a dyad records no response time: until 2026-09-22
  mastery required a fluent rt, so NOTHING harmonic could be mastered, the
  99% seconds kept full weight, and the failing m3 got ~24% of dyads, never
  enough to learn it or to lift the ladder past 85% to the M3; now ~60%). Any scope other than `interval`
  is cells only: `passage`, `round`, and the dyad rungs `departure` and
  `twohand`. TIER_WIDTHS is
  SIMPLE INTERVALS ONLY (12 tiers; `simpleOf()` folds compounds; a loaded
  state with more tiers is clamped). IT IS ORDERED BY HOW HARD THE INTERVAL
  IS TO PLAY, NOT TO NAME (2026-09-14): `[2, 1, 3, 4, 5, 7, 12, 9, 8, 10, 11, 6]`
  -- steps, thirds, fourth/fifth, octave, sixths, sevenths, tritone. It used
  to open octave-then-fifth (the ear-training-class order, which is an
  IDENTIFICATION order and nearly the reverse of a production one) and put a
  whole step at tier 7. The effect: three of four profiles sat at MIN_TIERS
  forever (William 209 isolated trials at ewma 0.30, Liz 119 at 0.60, Evelyn
  5 at 0.33), because the ladder only opens a tier above 0.85 and nobody
  places a cold fifth at 0.85. A beginner's whole session was descending
  fifths, and the session ended when he stopped answering. Reordering costs
  an advanced profile nothing: at Caleb's 9 tiers the old and new sets are
  IDENTICAL. AT THE ENTRY LEVEL THE BLOCK KEY IS ALWAYS C MAJOR
  (`chooseKey(..., entry)`, `Drill.entryLevel()` = tiers < DIATONIC_TIERS).
  Rooting every block on the note the player is sitting on is right for
  someone who knows where he is; for a beginner it meant the first block could
  be C MINOR and the third question of his life asked for an E-flat (Guest,
  2026-09-15: "White keys only wasn't happening. It started up black keys on
  the third question." The diatonic gate was honoured -- it just was not C).
  The tonic is then NOT necessarily the note under the hand, so it stays in
  the prime walk's `left` and is one of the notes to find (`nearestPc`), which
  is the better lesson anyway. And `fits()` refuses any passage or variant
  with a note outside the block key at this level: passages fall back to
  ANCHOR placement when none fits the key, and a variant has two more
  fallbacks (anchor, mode swap) -- that is how a C major block served an F#
  major transposition. EVERY path that chooses a target has to be gated, not
  just the plain slot, and each one that was missed showed up as black keys in
  a C major block: `remediation` (picks its own interval off the queue --
  takes whichever direction lands in the key), the confusion FOCUS branch of
  `nextTargetIndex` (returns before the pool is built, so `allowed` is applied
  there too; when neither direction fits, the pair is not served and no trial
  is spent), `clampAnchor` (walked him to the WINDOW'S EDGE, an arbitrary
  pitch -- now the nearest note of the key), and the ROUND (it pushes past the
  level by design, but the level's promise is the white keys: it widens inside
  the key instead, and tempo/lead are untouched). Verified across five
  scripted players, ~150 graded notes each: zero black TARGETS. Black-key
  ANCHORS are not a bug and are left alone -- that is the player's own wrong
  note, the anchor follows the hand as it always does, and the next question
  asks for a white key FROM there, which walks him back.
  Below `DIATONIC_TIERS` (6, i.e. until steps/thirds/4th/5th are
  all open) the plain slot passes `only: inKey` to `nextTargetIndex` -- a
  HARD filter on the target, not the DIATONIC_LEAN, which only chooses which
  SIDE of the anchor to land on and so did nothing for a beginner (a fifth
  from a white key in C is diatonic either way). So the half step arrives
  where the scale puts it (E-F, B-C) instead of as an interval of its own,
  and the black keys turn on with the octave. `only` is dropped if it would
  empty the pool: a filter must never be able to end the drill. Evidence scopes: interval questions
  update parent stats/cells/confusions/tier controller; passage notes and
  gestures (`scope:'passage'`) update a `+7|src:passage` cell AND record
  near-miss confusions; the round (`scope:'round'`) updates `src:round`
  cells only. CONFUSIONS decay by the DAY (`confusionsDecayedAt`), not per
  session; a pair (same direction, widths within 2) at CONFUSION_THRESHOLD
  becomes `state.focus` {a, b, left, expose, served, recent}: `takeExposure()`
  hands the drill a both-of-them CALL at open and every FOCUS_EXPOSE_EVERY
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
  never locked into slow ones. ITS RATE IS A NOTE RATE THAT ADDS UP TO A
  PASSAGE: OK_RATE is 0.85, not 0.5 -- a passage is clean only if EVERY note
  lands, and 0.5 per note over six notes is 3% clean, which is exactly what
  the drill was serving while the net sat quiet (2026-09-14: notes at
  0.20-0.24s were 55% correct, the passages built from them 3-16% clean).
  The floor is also the top of the SLOWEST failing bin now, not the fastest --
  it used to return early and leave a bin it was failing above its own floor.
  Over the corpus this lands 53..88 bpm, with
  40 bpm on 0.2% (the 32nd-note phrases). `remeterPlan`/`remeterNotes` are
  the re-metering pair (see TEMPO IS PER QUESTION above); `sessionFloor` must
  ask `remeterPlan` before scaling `beat_ms` by `minDur`, because in a
  re-metered excerpt the shortest note IS the beat.
- `src/keyblock.js` KEY BLOCKS. `parseKey` (the corpus's kern form, `D`/`d`,
  and the "D major" form that `keyName` writes to the log and to
  `attempts.key`), `phraseKey(phrase)` (the piece
  key if every note fits or at most one pitch class of >= 4 notes is
  foreign; else the nearest key on the circle of fifths that holds every
  note; null = chromatic, gets no prime), `shiftToKey` (mode reconciled via
  the relative key, octave nearest a point drawn halfway from the anchor to
  the keyboard middle), `primeNotes` (a scrambled tonal set from
  PRIME_SETS, one note per beat, tonic ON THE ANCHOR and always first --
  the prime is a call, every call starts under the hand, and the tonic
  leading is also the strongest key cue there is),
  `modeSwap` (3/6/7 moved), `chooseKey` (tonic = the anchor's pitch class,
  mode rotates), `diatonicStep`. Evidence: Cuddy & Badertscher 1987 (three
  notes set a key), Dowling 1986 / Bartlett & Dowling 1980 (a drifting or
  near key is worse than none), Springer 2021 (drones do nothing).
- `src/stage.js`  THE STAGE a player is graded on, from the last 20 isolated
  answers: echo < contour (direction) < sizing (within 2) < exact. A fresh
  profile starts at exact and drops one rung per reassessment once 8
  answers are in (hysteresis HYSTERESIS below each bar). Per stage: POOLS
  (steps first, fifth/octave as the first leaps), TIMEOUT_MS, a
  keyboard `window()` of an octave and a half. `stageMoved()` in drill.js
  logs the move and persists kv `stage`.
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
  **ONLY A FIRST ASKING (`qkind = 'passage'`) CALLS `record`.** A RETRY DRIVES
  THE CORRECTIVE LOOP AND NOTHING ELSE (`retryVerdict`, and `rest()` when it
  gives up): not the schedule, not `recordPolyOutcome`, not
  `updatePassageLength`, not the variant queue. It is the phrase you heard
  seconds ago handed straight back, so getting it right is not evidence you
  learned anything -- and until 2026-09-11 it was counted as exactly that
  (a clean retry overwrote "due tomorrow" with "due in three days" and filled
  a promotion slot; 158 of them in the preceding week). The retention test is
  tomorrow's first attempt, as it always was. Drill a phrase as often as you
  like -- double-drilling costs nothing now that none of it counts.
- `scripts/build-hymns.mjs` singHarmony2's hymn soprano lines
  (`../singHarmony2/public/songs/*.json`) -> corpus/hymns.json, same schema,
  collection 'hymns' (familiar tunes for the family: Berkowska & Dalla
  Bella 2013, known songs before abstract intervals).
- `scripts/progress.mjs [--db] [--days]` the report that matters: NEXT-DAY
  FIRST ATTEMPTS per day. SECTION 0 LEADS AND IS THE ONE THAT MATCHES THE
  GOAL -- notes in context: the context penalty (the same interval cold vs.
  inside a phrase), melodic step/leap accuracy by day, and whether a wrong
  note was still a degree of the key. Over 2026-09-05..12 EVERY interval
  class was 20-37 points worse inside a phrase than asked cold, including
  ones already at ceiling in isolation (whole step 92% cold, 69% in a
  phrase), 68% of graded passage notes are a half or whole step from the note
  before, and 72% of passage errors are off by one or two semitones. The
  wall is scale-degree placement, not interval sizing (Karpinski,
  function over intervals). SECTION 1 (isolated intervals) is kept as a
  DIAGNOSTIC FLOOR, NOT A TARGET: the sixths and the P4/P5 pair sat flat at
  63-77% for eight days while retention and span both moved, and they are
  1.7% of the material. Do not tune the drill to move section 1. Then
  passage pitch-clean and rung score, savings on re-encounter, retry loop and
  judgments, timing apart from pitch, stage, session shape. In-session
  gains are performance; judge progress here. Section 0 counts FIRST ASKINGS
  ONLY (`kind = 'passage'`): retries are echoes, variants are transfer.
- `scripts/sim.mjs <db> <player> <n> [bpm] [nophrases]` headless scripted
  player (perfect | sloppy | kid | liz | random) against a scratch DB; the
  way every path above was verified. Never a live profile. ALWAYS PASS A BPM:
  the harness needs `bpmOverride`, and running it with 0 (no override, real
  per-excerpt tempos) produces NaN onsets and Infinity timeouts inside the
  SCRIPT, not the drill. Timing rules written in real seconds (MIN_QUIET_S)
  therefore have to be checked by arithmetic, not by the sim.
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
  A PORT SWITCH IS A RANGE CHANGE (`onNoteOn`, 2026-09-13): a session captures
  lo/hi once in startSession and `observe()` only fires on a note OUTSIDE the
  current port's range, so picking up a different controller mid-sitting used
  to leave the session on the old one's bounds -- and nothing signalled it,
  because on the 88 at 32..100 there is no note he can play that is out of
  range. Switching now sets `rangeDirty` itself. Ending the session was always
  enough (startSession re-reads `range.current`, and `onNoteOn` calls
  `setPort` BEFORE it), so the old workaround was ten seconds of silence.
- `src/db.js`     node:sqlite, WAL, busy_timeout. Guarded migrations add
  columns. `kv(key)` returns a guarded {load, save}. Tables `sessions`,
  `attempts` (one row per graded key press or miss; `credit`/`stage` = the
  stage's judgment, `height_err` = right pitch class wrong octave, `key` =
  the block key in force, "D major", NULL outside a block -- without it a
  wrong note that is still a degree of the key cannot be told from one
  outside it, and that is the whole scale-degree question; added
  2026-09-12, so earlier rows are NULL),
  `passages` (one row per passage question, see rungs.js; `clean` = pitch
  AND time, `pitch_clean` = pitch, backfilled from exact = notes),
  `judgments` (HISTORICAL: the judge window, removed 2026-09-11; nothing
  writes it); `attempts.voice`
  for per-voice dyad/chord accuracy; `attempts.regime` / `contains_anchor`
  (09-20: which rule a dyad note was measured under; NULL = a legacy row
  whose `anchor` is the named bass, not a note departed from -- read the two
  apart, never re-score); `sonorities` (09-20: one row per two-note onset
  group in a dyad, placing or duo passage, judged as the PAIR he played:
  span_expected/played, harmonic_ok, which ear was `charged`, both engines'
  predicted accuracies, and the previous sonority so a resolution reads as
  one; synced like the other event tables). kv: `engine`, `engine:harmonic`
  (restarted 09-20, the old state in `kv_archive`), `dyadRung`, `poly`,
  `passageLen`, `phraseStats`, `polyStats`, `ranges`, `carry`, `stage`,
  `rounds`, `migrations` (what `Db.runOnce` has already done). `backfillPassages()` builds `passages`
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
