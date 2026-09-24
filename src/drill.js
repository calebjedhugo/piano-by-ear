// The drill state machine. Everything is decided from the keyboard and from
// history; there are no settings.
//
//   IDLE      no metronome. The first note played (velocity >= 20) becomes
//             the anchor and starts a session. TEMPO IS PER QUESTION and
//             belongs to the excerpt, never to how well you played (see
//             src/tempo.js); history only sets a floor under the fastest note.
//   QUESTION  metronome throughout. A question is a CALL (notes the app
//             plays) and your RESPONSE: the same notes, same rhythm. THE
//             RESPONSE STARTS WHEN YOU START PLAYING. You may follow the
//             call one beat behind, like a canon, or wait as many clicks as
//             you like; your first note snaps to the nearest click (keeping
//             the phrase's own beat fraction) and the rest of the phrase is
//             expected relative to it. The note placed on your anchor is
//             free (you already know it); in a melody you may skip it and
//             begin with the second note.
//
// THE ONE RULE ABOVE ALL OTHERS: NO NOTE IS PLAYED THAT YOU ARE NOT BEING
// ASKED TO PLAY BACK. There are no listen-only passages, no cues, no chimes
// and no error sounds anywhere in this program. Everything the player needs
// to know arrives in the content itself: the key arrives as an arpeggio he
// plays, a miss arrives as the same phrase asked again, the round arrives as
// a caller that stops waiting. The only sounds are the metronome (a
// woodblock, never a pitch), the call, and the piano under your own keys. A
// note marked `free` is still a note you are asked to play -- free means it
// is not held against you, not that it is decoration.
//
// THE KEY IS A BLOCK (src/keyblock.js). Every BLOCK_QUESTIONS questions the
// drill takes the note you are on as a new tonic and asks for a tonal set
// from that note IN A RANDOM ORDER -- triad, seventh, pentatonic, first five
// degrees, ninth, whichever the open tiers allow. The pitches name the key;
// the scrambling is what makes it a question rather than a preamble. Holding
// the key is the rest of it: passages
// are transposed INTO it, gestures step diatonically in it, plain targets
// lean diatonic. The old emergent centre named a new key nearly every
// question; a half-established frame is worse than none for a scale-step
// encoder, and the phrase errors were exactly that (a whole step played as a
// half step at the second note, with no key yet to place it in).
//
// KINDS OF QUESTION
//   prime:     the key, arriving ONE NOTE AT A TIME in the drill's own form.
//              A block opens on the note under your hand -- that note is the
//              tonic -- and then walks a tonal set through two to four
//              ordinary call-and-response questions until the key is simply
//              there. Every step is at your level: the target is picked so
//              the interval from where your hand actually IS is one the
//              ladder has opened, plus steps and half steps, which are always
//              allowed. The sets are ordered by how hard they are to WALK,
//              which is not how hard they are to name: stepwise degrees come
//              first and the triad comes later, so a beginner gets do-re-mi
//              and nothing else.
//   interval:  call = the target on the downbeat (the anchor is the note you
//              just played; it stays in the question, silent, a beat before).
//              THE ANCHOR IS NEVER SOUNDED FIRST, at any stage or tier. A
//              beginner who wants to hear it plays it himself -- it is under
//              his hand and free in the question -- so the scaffold is
//              self-served and fades on its own (2026-09-21).
//              A secure simple interval is sometimes asked an OCTAVE WIDER:
//              the skill is still the simple interval, the octave is judged
//              apart (a compound interval is not a skill of its own).
//   gesture:   the same target, then a diatonic step in the block key, so the
//              interval is heard in a line (no anchor echo first: the target
//              comes when you are ready, as it does on a bare question).
//   discrimination: one of a confused pair (fourth/fifth, minor/major sixth)
//              interleaved among plain questions in a constant register --
//              two-label categorisation, not an A-B-A-B run.
//   exposure:  both intervals of the pair in one call, from one anchor, every
//              sixth pair trial: the labelled exposure that flanks the
//              categorisation, asked back rather than merely played.
//   dyad/chord: (polyphony level >= 1) the anchor as a fixed bass with one or
//              more notes above it, all together; each voice scored on its own.
//              The top voice is heard for free (Fujioka 2005); the inner ones
//              are the target.
//   passage:   a real phrase in the block key, in its own meter with its
//              pickup ('mono' one voice; 'duo', 'chorale', 'poly' more).
//   window:    after EVERY passage the pulse DROPS for two seconds (or two
//              beats, whichever is longer). Whatever you play in that silence
//              is your answer to "which note did you miss?"; playing nothing
//              says "that was clean". It follows the passages you nailed too,
//              so its arrival is never the verdict. The metronome stopping is
//              the only signal in this program that costs no note.
//   correction: the notes you never reached, served as a call at the
//              passage's own tempo, for you to play back -- minus any you
//              named in the window and any you caught in flight. Cascade
//              notes included: a note played in the right interval from a
//              pitch you had already lost is still a place you never got to.
//   retry:     a failed passage comes straight back, SAME key and register
//              (constant practice until correct: Lai et al. 2000), up to
//              RETRY_MAX_TRIES while the rungs beneath exact pitch improve;
//              nailing it is the reward, stalling rests it (retryVerdict).
//              The retry is the whole of the feedback: the call you just
//              missed, sounded again, with the chance to use it.
//   variant:   a passage you nailed comes back a few questions later in the
//              block's new key, or the other mode, or a step away (variable
//              practice after constant; practice, not the retention test).
//   round:     when plain intervals are coming back clean and in time, the
//              caller stops waiting: the next call comes on a fixed lead
//              while you are still answering, a canon. A 2-down/1-up
//              staircase on ONE dimension per run (interval width, tempo, or
//              lead) oscillates around threshold instead of climbing to a
//              break; the run ends on a passable call, and its evidence is
//              its own (never the tier ladder).
//   echo:      (lowest stage) the drill goes quiet; you make up two or three
//              notes; it asks for them straight back. The game is taught by
//              imitating you first, and your own figure is the call. It is
//              the ONE question where the drill has played nothing, so
//              silence means "still thinking", not "gone away": the silence
//              timeout moves on to the next question instead of ending the
//              session.
//
// GRADING: ONE pass, by ONSET GROUP. Notes that sound together form a group;
// each note you play is matched by pitch to a pending note of the current
// group (any order within a chord), judged on timing against the constant
// grid and on how long you hold it. A wrong note consumes the nearest
// pending note of the group. Starting the next group abandons what was left
// of this one.
// ONE RE-ATTACK PER NOTE: if you miss a note and go back for it before the
// next one is due, that catch is recorded (`self_corrected`) and counts
// toward rungScore -- it is not a second chance at the note, which stays a
// miss, and a passage still passes or fails on exact pitch, first try. Until
// 2026-09-11 that press was thrown away unread, so the drill could not tell
// a player who hears his own mistakes from one who never notices. You get
// exactly one: the next press closes the window whatever it is, because
// hunting through four pitches is searching, not catching.
// Each note carries up to two skills: the melodic interval from
// the previous note in its voice (melodic engine) and the interval above its
// chord's bass (harmonic engine). PITCH AND TIME ARE SEPARATE VERDICTS: a
// passage passes on exact pitch alone (retry, length, streak, promotion all
// read pitch); timing and holds are recorded and reported beside it, never
// gating it (separable systems: Pfordresher 2003; Brown & Penhune 2018).
// THE STAGE (src/stage.js) says what a note is credited on -- direction,
// within two semitones, or the note itself -- derived from history; the
// attempts table keeps both the exact verdict and the credit.
// A BEAT OF SILENCE MEANS YOU ARE DONE: after the last note the next
// question comes on the following click; before the last note, whatever is
// left is missed and the next question comes anyway. Silence for
// TIMEOUT (ten seconds at the top stage, longer below) ends the session; a
// session started within CARRY_MS of the last one resumes it (same warm-up,
// same loops: bursts are one sitting; the key is not carried -- a resumed
// sitting opens a fresh block on the note you have just sat down on,
// because the prime is a call and a call starts under your hand).
//
// The ONLY sounds are the metronome, the call (the system's turn) and the
// piano under your keys (the controller has no sound of its own). See the
// rule at the top: nothing else sounds, ever.

import { DIATONIC_TIERS, TIER_WIDTHS, WARMUP_QUESTIONS, simpleOf } from './engine.js';
import { floorFromHistory, passageTempo, remeterNotes, remeterPlan, toleranceMsFor } from './tempo.js';
import { summarizeRungs, describeRungs, rungScore } from './rungs.js';
import { BLOCK_QUESTIONS, NAMES, chooseKey, chordFor, keyName, nearestPc, primeSet, diatonicIn, diatonicStep, modeSwap } from './keyblock.js';
import { Stage } from './stage.js';

const MIN_VELOCITY = 20; // key brushes are echoed but never graded
const SCHEDULE_AHEAD_S = 0.15;
const TICK_MS = 25;
// Articulation between consecutive call onsets: at least this long, or this
// fraction of the gap between them.
const CALL_GAP_MIN_S = 0.03;
const CALL_GAP_FRAC = 0.12;
const STREAK_FOR_PASSAGE = 3;
const CLEAN_NOTES_FOR_PASSAGE = 6; // clean graded notes (any kind) also earn a passage
// The corrective loop (see retryVerdict): a failed passage comes straight back,
// this many attempts in all, and rests this long once it proves too hard.
const RETRY_MAX_TRIES = 3;
const TOO_HARD_REST_MS = 2 * 24 * 60 * 60 * 1000;
const REMEDIATE_MAX_PER_PASSAGE = 2;
const MAX_PASSAGES_IN_A_ROW = 3; // interval questions are what move the tier ladder
const DEBOUNCE_S = 0.06;
const QUIET_BEATS_BEFORE_NEXT = 1; // the next call starts on the first click after this much silence
// Note duration: a held note should last about its written value. Cutting
// it below half, or holding it past 1.5x plus a pad, is a defect. A note
// still held when the question finalizes is never penalized (holding the
// last note is natural).
const DUR_SHORT_FRAC = 0.5;
const DUR_LONG_FRAC = 1.5;
const DUR_LONG_PAD_S = 0.15;
const FLUENT_NORM_MS = 120; // mastery: onset error <= 12% of a beat (ms at 60 bpm)
const CALL_MAX_S = 2; // the longest a call note sounds; a hold is never graded against more
// Passage length follows passage results, not the tier ladder: grow a note
// after LEN.grow clean passages in a row, shrink after LEN.shrink failures in
// a row, inside [min, ceiling] where the ceiling comes from the engines.
// THE LENGTH CONTROLLER SETS A LENGTH, NOT A CEILING. It used to pass its
// value as `maxNotes` alone, so the bank returned ANY phrase at or under it
// and the diet was everything from two notes to the ceiling. Two things
// followed, and both were defects:
//
// (1) GROWTH WAS EARNED CHEAP AND SPENT DEAR. `grow` counts clean passages
//     without caring how long they were, so a run that included a clean
//     TWO-note passage raised the ceiling that admits NINE-note ones.
//     2026-09-18, 20:40-20:41: clean at 2, 7, 6, 7, 7 -> ceiling 7->8->9 ->
//     failed 8, 9, 9. Mono clean rate by length over 09-11..19: 2 notes 67%,
//     3 61%, 4 65%, 5 44%, 6 45%, 7 31%, 8 18%, 9 0% (n=9, and 0 for 9 is the
//     whole lifetime record at that length). Per-note accuracy is FLAT at
//     72-81% across all of it, so a long passage is not harder material, it
//     is only arithmetic: .75^9 is 7%.
//
// (2) IT COST HIM A POLYPHONY LEVEL. duo started at EIGHT notes and could not
//     fall below SIX, and his duo record at six-plus is 0 for 23 (at three
//     notes it is 63%, the same as his mono rate there). The twelve-passage
//     window that demoted him duo->mono on 2026-09-18 had all three of its
//     clean passages at 3, 4 and 5 notes and eight of its nine failures at
//     6, 7, 8 and 9. He was judged on material he has never once completed
//     and lost a level he was competent at.
//
// So: `band` is how far under the target the bank may go, and only a passage
// served INSIDE the band votes on growth or shrink -- a clean three-note
// passage says nothing about nine and no longer gets to say it. Starts and
// minimums are set where the data puts him rather than where the ladder
// wished he was (Wilson et al. 2019: aim near the rate at which he succeeds).
// UNITS: these are CORPUS notes -- `phrase.notes.length`, what `maxNotes`
// filters on. `passages.notes` in the DB is the GRADED count, which leaves out
// the free pivot, so it reads one LOWER (415 of 435 mono first askings, 78 of
// 87 duo). Read a length off the database and you must add one before putting
// it here. Getting this wrong once set duo to 3 when the poly corpus has
// nothing shorter than 4, and duo passages silently stopped being served at
// all. His clean rates in CORPUS notes: mono 4 61%, 5 65%, 6 44%, 7 45%,
// 8 31%, 9 18%, 10 0%; duo 4 63%, 5 36%, 6 19%, 7+ 0 for 23.
const LEN = {
  start: { mono: 5, duo: 4, chorale: 4, poly: 4 },
  min: { mono: 4, duo: 4, chorale: 4, poly: 4 },
  band: 1, // a pick may be this many notes under the target, and still votes
  grow: 2,
  shrink: 3,
};
// How many recent graded passage notes the tempo ceiling looks at (src/tempo.js).
const FLOOR_WINDOW = 400;
// The pulse the anchor rings on before the first question sets its own tempo,
// and the calm pulse of every interval question (hearing, not speed).
const LEAD_IN_BPM = 72;
const INTERVAL_BPM = 72;
// A gesture -- the target and then a diatonic step in the block key -- this
// often among plain interval questions. Caleb: "play two or three notes in a
// row once in a while... make the whole thing a musical experience."
const GESTURE_RATE = 0.34;
// Plain targets land diatonic in the block key: the ladder still picks the
// width, the SIGN is chosen so the target is in the key whenever either
// direction would be (a 1.3 weight on a 24-entry pool moved nothing).
const DIATONIC_LEAN = 1.3; // a diatonic target whose mirror is chromatic (or off the keyboard)
const CHROMATIC_SIDE = 0.15; // a chromatic target whose mirror is diatonic and feasible; otherwise 1
// THE JUDGMENT WINDOW. After EVERY passage -- clean or not, so its arrival
// says nothing about the verdict -- THE PULSE DROPS. The metronome is the one
// thing in this drill that never moves, so its stopping is the loudest signal
// available and the only one that costs no note. Whatever you play in that
// silence is your answer to "which note did you miss?"; playing nothing says
// "that was clean". Then the click returns and the notes you never reached
// are served as an ordinary call for you to play back -- minus any you named
// in the silence, and any you caught in flight, because nothing is served
// that you have already shown you have. Error estimation before the answer is
// what turns feedback into hypothesis testing (Guadagnoli & Kohl 2001); the
// first version of this asked with a chime and was heard as an error buzzer,
// which is how the drill came by its one rule.
const WINDOW_SEC = 2; // ...or two dropped beats, whichever is LONGER
const WINDOW_BEATS = 2;
// A beat of silence ends an answer, except where the player is recalling
// rather than echoing: a retry or a variant waits two.
const QUIET_BEATS = { retry: 2, variant: 2 };
// A re-metered excerpt's beat is the length of a sixteenth, and "a beat of
// silence means you are done" then cuts an answer off in four tenths of a
// second. Every wait measured in beats gets this floor in real time.
const MIN_QUIET_S = 0.8;
// The round: this many clean, in-time plain answers started within two beats
// open one; a run is this many calls or this many misses; then a cool-down
// call. At the ~70% a 2-down/1-up staircase converges on, 16 calls expect
// about 5 misses, so a run usually ends on its length, not on a failure.
const ROUND = { trigger: 5, calls: 16, misses: 5, cooldown: 15, maxLevel: 4, leads: [4, 3, 2], tempoStep: 6 };
// THE CHAIN. Past a certain number of missed notes the corrective loop stops
// working, and the data says exactly where. Correction accuracy by how many
// notes the passage missed (2026-09-11..18, first askings, the correction
// served two questions later):
//
//     missed   n    graded notes   note acc   whole correction right
//        2     21       1.0           81%            81%
//        3     34       1.5           59%            62%
//        4     32       2.1           53%            47%
//        5     20       3.1           41%            20%
//        6      5       4.4           27%            20%
//
// At two it works, because the correction hands you the first note and asks
// for one: a reference, then a step. At three and past it, the correction
// turns into a list of pitches with no run-up and the answer is a guess. And
// what the loop leaves behind falls off the same cliff -- the next COLD
// asking of the same phrase, on a later day, is clean 60-63% of the time
// after a clean or one-miss first try and 12% of the time after a deep one.
//
// So past three, the correction and the retry are both replaced by a chain
// (Ash & Holding 1990: on a keyboard task both part methods beat whole
// training during training, on the whole task, and at one-week retention;
// forward chaining won). It is cut from the passage AS PLACED AND HEARD --
// the same pitches, rhythm and tempo -- and it runs over the SPAN: from the
// note before the first miss through the last one, INCLUDING the notes in
// between that were played correctly. Not the set of missed notes: half of
// all multi-miss failures are scattered rather than contiguous, and serving
// only the misses teaches a sequence that never occurs in the music.
//
// Each step is the span's opening note (handed, ungraded -- the reference)
// plus `len` notes after it. Clean and it grows by one; missed and it
// SHRINKS by one, so the drill stays near the rate at which he is playing
// rather than guessing (Wilson et al. 2019). At the shortest step it stops.
//
// NO RETRY FOLLOWS. A retry already records nothing (see the corrective loop
// below: `const first = q.kind === 'passage'` gates every store), so dropping
// it costs no measurement -- and re-serving a passage he just missed badly
// keeps him far under the error band the rest of the drill aims at. The
// phrase's retention test was, and remains, its next cold asking.
//
// WHAT THIS IS FOR, stated in advance so it is not re-scored later: the
// target is SEGMENT ACCURACY >= 80% -- playing instead of guessing. The 12%
// next-cold-clean is watched, not targeted.
const CHAIN = {
  minMissed: 3, // at two the correction already works; this starts past the cliff
  maxSteps: 8,  // a span is 3-5 notes; this caps the walk even if it oscillates
};
// Kinds that use the block key: what a block counts.
const KEYED_KINDS = new Set(['interval', 'gesture', 'discrimination', 'remediation', 'passage', 'variant']);
// Once a level is dropped, the interval-confidence gate cannot lift it again for this long.
const POLY_DEMOTE_HOLD_MS = 24 * 60 * 60 * 1000;
// Bursts closer than this are one sitting: the key, the warm-up and the loops carry over.
const CARRY_MS = 30 * 60 * 1000;
// Polyphony levels and how they are earned (see polyLevel()).
export const POLY_KINDS = ['mono', 'duo', 'chorale', 'poly'];
const POLY = {
  window: 12, // passages of a level's kind judged for promotion/demotion
  // PER NOTE, not per passage (2026-09-22): the level is judged on the notes
  // of the window's first askings pooled -- sum exact / sum graded -- in the
  // dyad rungs' band. A passage verdict cannot judge texture: the length
  // controller (grow on 2 clean in a row, shrink on 3 misses) holds the
  // clean rate near 43% BY DESIGN at every level, so a 30% floor was noise
  // around its setpoint and a 70% bar was unreachable. The window that
  // demoted Caleb on 2026-09-21 was 3/12 clean and 80% of its notes right.
  promoteNote: 0.85,
  demoteNote: 0.65,
  melodicTiersForDyads: 6, // melodic tiers unlocked before dyads begin (through the M6)
  masteredForDyads: 6, // ...and this many intervals mastered: dyads wait for interval confidence, not passages
  harmonicTiersForChorale: 4, // harmonic tiers unlocked before four-part chords
  // Harmonic tiers before three-note chords join the dyads. TWO, not three:
  // the tier ladder was tuned on the melodic engine, which has 30x the data,
  // and a rung of it means very little at n=81. More to the point, TWO NOTES
  // ARE AMBIGUOUS AND THREE ARE NOT -- E-C is a m6 that could be C major, Am7
  // or F6; E-G-C is C major in first inversion and nothing else. Function
  // appears at three notes, so gating the sonorities behind a ladder earned
  // on two-note asks holds back the very thing that gives the interval its
  // meaning (McLachlan 2013: hearing out chord tones tracks familiarity with
  // the TYPE). Caleb, 2026-09-12, on why decades of naming bare sixths never
  // took: "I need to hear and play them in a chord to learn them."
  harmonicTiersForChords: 2,
  dyadEvery: 3, // at level >= 1, every third plain question is a dyad (or a chord)
  historyMax: 200,
};
// A small, repeated set of chord shapes above a fixed bass (McLachlan 2013:
// hearing out chord tones tracks familiarity with the TYPE).
const CHORD_SHAPES = [[4, 7], [3, 7], [3, 8], [4, 9], [4, 7, 10]];
// Passage TEXTURE only: the dyads left this ladder on 2026-09-12 (dyadsOpen).
const LEVEL_NAMES = ['melody only', 'two voices', 'four-part chorales', 'both hands'];
// THE DYAD RUNGS (Caleb, 2026-09-20; see dyadSlot). A dyad is a DEPARTURE from
// the anchor: both notes are measured from the note being left, and the
// bottom note is no longer named for the player. Three rungs, in order:
//   1  contains the anchor -- one retrieval; the common tone is REQUIRED and
//      graded as a unison (a row, never an engine skill)
//   2  does not contain it -- two retrievals from the anchor being left
//   3  two hands to two hands -- each hand from its own anchor, the dyad
//      before it; only ever served right after a dyad, chained
// A per-RETRIEVAL band (the unison is logged but never in the denominator):
// promote above `high`, demote below `low`, after `cooldown` retrievals on
// the current rung. Per retrieval, not per question: two retrievals at 0.84
// come out clean 71% by question, which is the passage-length arithmetic
// again -- the skill is the note, the length is multiplication.
// It is a DIET, not a gate: which dyad the slot serves next, never whether
// duo passages are served (the placing puts a departure in front of every
// one of those anyway).
const DYAD_RUNG = { high: 0.85, low: 0.65, cooldown: 8, alpha: 0.15, lowerShare: 0.4 };

export class Drill {
  /**
   * @param {object} deps
   * @param {import('./audio.js').Audio} deps.audio
   * @param {import('./db.js').Db} deps.db
   * @param {import('./range.js').RangeTracker} deps.range
   * @param {(lo: number, hi: number, fluentMs: number, name: string) => import('./engine.js').AdaptiveEngine} deps.makeEngine
   * @param {import('./phrases.js').PhraseBank|null} deps.phrases   melodic bank
   * @param {import('./phrases.js').PhraseBank|null} [deps.poly]    polyphonic bank
   * @param {(msg: string) => void} deps.log
   * @param {number} [deps.bpmOverride]  debugging only
   * @param {() => void} [deps.onSessionEnd]  the sitting is over: src/lobby.js sends it to the pi
   */
  constructor({ audio, db, range, makeEngine, phrases, poly = null, log, bpmOverride = null, onSessionEnd = null }) {
    this.keysDown = new Set(); // every key currently down, graded or not
    this.lastReleasedAt = null; // audio time of the last key-up
    this.audio = audio;
    this.db = db;
    this.range = range;
    this.makeEngine = makeEngine;
    this.phrases = phrases;
    this.poly = poly;
    this.log = log;
    this.bpmOverride = bpmOverride;
    this.onSessionEnd = onSessionEnd;
    this.polyStore = db.kv('poly');
    this.lenStore = db.kv('passageLen');
    this.carryStore = db.kv('carry');
    this.stageStore = db.kv('stage');
    this.roundsStore = db.kv('rounds'); // one record per run: the round's evidence is scoped away from the ladder
    this.rungStore = db.kv('dyadRung'); // the dyad rung controller (DYAD_RUNG)
    this.len = this.lenStore.load() || {};
    this.state = 'IDLE';
    this.clockOffset = performance.now() / 1000 - audio.now;
    this.stage = new Stage(db.recentIsolated(20), this.stageStore.load()?.name ?? null);
  }

  // --- clocks --------------------------------------------------------------

  perfToAudio(perfMs) {
    return perfMs / 1000 - this.clockOffset;
  }

  audioToPerf(audioS) {
    return (audioS + this.clockOffset) * 1000;
  }

  syncClock(alpha = 1) {
    const o = performance.now() / 1000 - this.audio.now;
    this.clockOffset += alpha * (o - this.clockOffset);
  }

  // --- input ---------------------------------------------------------------

  onNoteOn({ note, velocity, at, port }) {
    this.audio.startVoice(note, velocity);
    this.keysDown.add(note);
    // A DIFFERENT CONTROLLER IS A DIFFERENT KEYBOARD. A session captures
    // lo/hi once in startSession, and observe() only fires on a note OUTSIDE
    // the current port's stored range -- so switching from the 25-key to the
    // 88 mid-sitting left the session running on the 25-key's bounds, with
    // everything above them outside the stage window and the anchor being
    // dragged back. Nothing ever signalled the change, because on the 88 at
    // 32..100 there is no note he can play that is out of range. The switch
    // itself is the signal.
    const switched = Boolean(port) && port !== this.range.portName;
    if (switched) this.range.setPort(port);
    if (this.range.observe(note) || switched) {
      this.rangeDirty = true;
      const { lo, hi } = this.range.current;
      this.log(switched ? `  keyboard now ${port} (range ${lo}..${hi})` : `range widened to ${lo}..${hi}`);
    }
    if (velocity < MIN_VELOCITY) return;
    if (this.state === 'IDLE') {
      this.startSession(note);
      return;
    }
    this.lastInputAt = performance.now();
    this.lastPlayedAt = this.perfToAudio(at); // any key, fumbles included
    this.handleAnswer(note, velocity, this.perfToAudio(at));
  }

  // --- tempo ---------------------------------------------------------------

  /**
   * The shortest note worth asking for, in seconds: one number per session,
   * from whether recent fast notes were actually played cleanly. It can only
   * ever slow a question down (see src/tempo.js); tempo itself belongs to the
   * excerpt and is set in beginQuestion().
   */
  sessionFloor() {
    const rows = [];
    for (const r of this.db.recentPassageNotes(FLOOR_WINDOW)) {
      const phrase = this.phrases?.byId.get(r.phrase_id) ?? this.poly?.byId.get(r.phrase_id);
      if (!phrase) continue; // a phrase the corpus no longer has
      // In a re-metered excerpt the shortest note IS the beat, so beat_ms is
      // already how long it lasted; scaling by minDur again would report a
      // sixteenth that ran at 0.4s as having flown by at 0.1s.
      const remetered = Boolean(remeterPlan(phrase));
      rows.push({ fastestSec: (remetered ? r.beat_ms : phrase.minDur * r.beat_ms) / 1000, clean: Boolean(r.correct && r.in_time) });
    }
    return floorFromHistory(rows);
  }

  /** The tempo for a question: what its music wants, never what you earned. */
  questionTempo(q) {
    if (this.bpmOverride) return this.bpmOverride;
    if (q.tempo) return q.tempo; // a window or its correction keeps the passage's pulse
    if (q.phrase) return passageTempo(q.phrase, this.floorSec);
    // A round on the tempo dimension is the one place a question is quicker
    // than its music wants, and it is a game, not a controller: the tempo
    // returns to INTERVAL_BPM the moment the round is over.
    if (q.kind === 'round' && this.round?.dim === 'tempo') return INTERVAL_BPM + ROUND.tempoStep * this.round.level;
    return INTERVAL_BPM;
  }

  // --- polyphony level -----------------------------------------------------

  /**
   * The level is earned, never set. Promotion needs the NOTES of the last
   * POLY.window first-asked passages of the current level's kind at least
   * 85% right, pooled (plus, for the first steps, enough tiers unlocked on
   * the relevant engine); demotion follows a window under 65%. Per note,
   * because length is the length controller's to set: see POLY. Lower kinds
   * keep being asked at every level.
   * The FIRST step (dyads) is the exception: it waits on interval confidence
   * (tiers open and intervals mastered), not on melodic passages -- a dyad
   * is an interval played together, not a phrase.
   */
  polyLevel() {
    const st = this.polyStore.load() || { level: 0, history: [] };
    if (!this.poly) return { ...st, level: 0 };
    // Rows from before 2026-09-22 carry only a passage verdict; they cannot
    // vote on a per-note rule, so they are not in the window at all.
    const recent = (kind) => st.history.filter((h) => h.kind === kind && h.notes > 0).slice(-POLY.window);
    const rate = (rows) => {
      const notes = rows.reduce((t, h) => t + h.notes, 0);
      return notes ? rows.reduce((t, h) => t + h.exact, 0) / notes : 0;
    };
    let level = st.level || 0;
    const cur = recent(POLY_KINDS[level]);
    if (level === 0) {
      const held = st.demotedAt && Date.now() - st.demotedAt < POLY_DEMOTE_HOLD_MS;
      if (!held && this.engine.state.tiersUnlocked >= POLY.melodicTiersForDyads && this.engine.masteredCount() >= POLY.masteredForDyads) level = 1;
    } else if (cur.length >= POLY.window && rate(cur) >= POLY.promoteNote && level < POLY_KINDS.length - 1) {
      const gate = level === 1 ? this.harmonic.state.tiersUnlocked >= POLY.harmonicTiersForChorale : true;
      if (gate) level += 1;
    } else if (level > 0 && cur.length >= POLY.window && rate(cur) < POLY.demoteNote) {
      level -= 1;
      st.demotedAt = Date.now();
    }
    if (level !== (st.level || 0)) {
      // the passages that earned the change don't count again at the new level
      st.history = st.history.filter((h) => h.kind !== POLY_KINDS[st.level || 0]);
    }
    st.level = level;
    return st;
  }

  /**
   * DYADS AND CHORDS RUN ON INTERVAL CONFIDENCE, NEVER ON THE POLYPHONY
   * LADDER. A dyad is an interval played together and a chord is a sonority;
   * neither has anything to do with whether two melodic VOICES can be held
   * apart in a Bach excerpt. Tying them together meant a bad night on duo
   * passages switched off the only harmonic practice in the drill -- and the
   * harmonic engine has had 81 trials in the lifetime of the profile against
   * the melodic engine's 2,395, with the harmonic m6 asked exactly ONCE.
   * (2026-09-10 already moved PROMOTION onto interval confidence; demotion
   * was still dragging the dyads down with the passages.) The entry bar is
   * unchanged -- the same tiers and mastered counts as before -- it simply
   * cannot be taken away by a passage result any more. The poly ladder keeps
   * governing passage TEXTURE (`passageKinds`), which is what it is for.
   * Independent of `this.poly`: a dyad is built from the anchor, so it needs
   * no polyphonic corpus.
   */
  dyadsOpen() {
    return this.engine.state.tiersUnlocked >= POLY.melodicTiersForDyads
      && this.engine.masteredCount() >= POLY.masteredForDyads;
  }

  recordPolyOutcome(kind, clean, exact, notes) {
    const st = this.polyState;
    st.history.push({ kind, clean, exact, notes, ts: Date.now() });
    if (st.history.length > POLY.historyMax) st.history.splice(0, st.history.length - POLY.historyMax);
    this.polyStore.save(st);
    // THE LEVEL IS RE-READ HERE, not only at startSession. A sitting can run
    // half an hour, and the passage that fills the judging window usually
    // lands mid-session: 2026-09-12's 33-minute session (267 questions) ran
    // to the end on duo passages at 0% clean because the 12th duo row -- the
    // one that would have demoted it -- arrived after the level was last
    // read. A level the player is failing must not hold for the rest of the
    // sitting. Announced by nothing but the change in what is asked.
    const before = st.level;
    this.polyState = this.polyLevel();
    this.polyStore.save(this.polyState);
    // The level changes NOW -- everything downstream of this question sees it
    // -- but the LINE waits for the passage verdict. Printed before it, a
    // demotion reads as though the passage that just went clean had caused
    // it; the twelfth duo row is what caused it, whatever that row said.
    if (this.polyState.level !== before) this.polyMove = before;
  }

  /**
   * Say that the polyphony level moved, once the verdict it followed is out.
   * Log only: no cue, no sound. The change in what is asked IS the signal.
   */
  flushPolyMove() {
    if (this.polyMove === null || this.polyMove === undefined) return;
    const from = this.polyMove;
    const to = this.polyState.level;
    this.polyMove = null;
    this.log(`  polyphony level ${to > from ? 'up' : 'down'} to ${to} (${LEVEL_NAMES[to]})`);
  }

  // --- session -------------------------------------------------------------

  startSession(anchor) {
    const { lo, hi } = this.range.current;
    this.lo = Math.min(lo, anchor);
    this.hi = Math.max(hi, anchor);
    this.rangeDirty = false;
    const carry = this.carryStore.load();
    const resumed = carry && Date.now() - carry.endedAt < CARRY_MS ? carry : null;
    this.engine = this.makeEngine(this.lo, this.hi, FLUENT_NORM_MS, 'engine');
    this.engine.startSession({ questionInSession: resumed?.questionInSession ?? 0 });
    this.harmonic = this.makeEngine(this.lo, this.hi, FLUENT_NORM_MS, 'harmonic');
    this.harmonic.startSession({ questionInSession: resumed?.questionInSession ?? 0 });
    this.polyState = this.polyLevel();
    this.polyStore.save(this.polyState);
    this.polyMove = null; // a pending level-change line, flushed after the verdict
    this.floorSec = this.sessionFloor();
    // The lead-in only carries the anchor to the first downbeat; every
    // question sets its own tempo in beginQuestion().
    this.bpm = this.bpmOverride ?? LEAD_IN_BPM;
    this.beat = 60 / this.bpm;
    this.toleranceMs = toleranceMsFor(this.bpm);
    this.sessionId = this.db.newSession({ bpm: this.bpm, anchor });
    this.questions = 0;
    this.plainQuestions = 0;
    this.echoEmpty = 0; // windows in a row the player left silent
    this.passagesDone = 0;
    this.streak = 0;
    this.cleanNotes = 0;
    this.roundStreak = 0; // reset per burst: a round wants a run within one sitting
    this.roundCooldown = 0;
    this.round = null;
    this.remediationQueue = resumed?.remediationQueue ?? [];
    this.recovery = null; // { a, t, chord, step } -- the walk out of a harmonic miss
    // The corrective loop and the variants carry as ids + placement, re-placed
    // from the bank (a phrase object through JSON would be a detached copy).
    // A window belongs to the passage that just happened; neither it nor its
    // correction survives the end of a session.
    this.window = null; // { missed, clean, question, phraseId, sec, bpm, pressed }
    this.correction = null; // { notes, bpm }
    this.chain = null; // { notes, onsets, len, steps, bpm, meter, phraseId } -- the walk out of a deep miss
    this.reanchor = null; // { target, forRetry, served } -- transient, like the window
    this.placing = null; // { kind, picked, suffix, target, dyad } -- the passage waiting behind its placing question
    this.retry = resumed?.retry ? this.replace(resumed.retry) : null; // { id, kind, tries, score, placed }
    this.variantQueue = (resumed?.variantQueue ?? []).map((v) => this.replace(v)).filter(Boolean);
    // A resumed sitting re-opens its block rather than carrying one: the
    // prime is a call, and a call starts on the note under the hand, so the
    // key has to be chosen from wherever the player has just sat down.
    this.block = null; // { key, asked, n }
    this.priming = null; // { key, tonic, set, left, step, total, lastIv } while the key is being walked
    this.blockN = resumed?.block?.n ?? 0;
    this.askedThisSession = new Set(resumed?.asked ?? []);
    this.passagesInARow = 0;
    this.anchor = anchor;
    this.prevAnchor = null;
    // TWO ANCHORS, after a dyad in which both notes were struck: [lower,
    // upper], what he PLAYED (the hand is where the hand is). Null after any
    // single-line answer -- the anchor is a monophonic idea and collapses to
    // the top note as it always did. Read by the two-hand rung and by a duo
    // passage's first group (each voice from its own hand).
    this.hands = null;
    this.chainDyad = false; // serve a two-hand dyad next, off the hands just set
    this.prevSonority = null; // { question, spanExpected, spanPlayed } -- so a resolution reads as one
    this.lastInputAt = performance.now();
    this.lastPlayedAt = this.audio.now;
    this.syncClock(1);
    this.state = 'QUESTION';
    const level = this.polyState.level;
    const dyads = this.dyadsOpen();
    this.log(`session started${resumed ? ' (resuming the sitting)' : ''}: anchor ${name(anchor)}, range ${this.lo}..${this.hi}, tempo per excerpt (shortest note ${Math.round(this.floorSec * 1000)}ms), tiers ${this.engine.state.tiersUnlocked}${dyads ? `/${this.harmonic.state.tiersUnlocked} harmonic` : ''}, ${dyads ? 'dyads and chords, ' : ''}passages ${LEVEL_NAMES[level]}, stage ${this.stage.current}${this.block ? `, key ${keyName(this.block.key)}` : ''}`);

    // The anchor rings for a beat, then the grid starts on an accented downbeat.
    this.nextBarAt = this.audio.now + this.beat;
    this.scheduledUntil = this.nextBarAt;
    this.meter = 4;
    this.answered = false;
    this.nextQ = this.makeQuestion();
    this.beginQuestion();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  endSession(reason, { silent = false } = {}) {
    clearInterval(this.ticker);
    this.ticker = null;
    this.db.endSession(this.sessionId, { questions: this.questions, passages: this.passagesDone });
    // What a burst a few minutes from now picks up again.
    const slim = (x) => x && { ...x, placed: x.placed && { id: x.placed.phrase.id, kind: x.placed.phrase.kind, shift: x.placed.shift, key: x.placed.key ?? null, octave: x.placed.octave } };
    this.carryStore.save({
      endedAt: Date.now(),
      questionInSession: this.engine.questionInSession,
      block: this.block ? { key: this.block.key, asked: this.block.asked, n: this.blockN } : null,
      retry: slim(this.retry),
      variantQueue: this.variantQueue.map(slim),
      remediationQueue: this.remediationQueue,
      asked: [...this.askedThisSession],
    });
    if (!silent) this.audio.sessionOver();
    this.state = 'IDLE';
    this.log(`session over (${reason}): ${this.questions} questions, ${this.passagesDone} passages. Play a note to start again.`);
    this.onSessionEnd?.();
  }

  stop({ silent = false } = {}) {
    if (this.state !== 'IDLE') this.endSession('stopped', { silent });
  }

  // --- question selection --------------------------------------------------

  idx(midi) {
    return midi - this.lo;
  }

  /** The keyboard window questions live in (a stage below exact stays near the middle). */
  get win() {
    return this.stage.window(this.lo, this.hi);
  }

  /** Rebuild a carried retry/variant's placement from the bank; null if the phrase is gone or no longer fits. */
  replace(x) {
    if (!x?.placed) return null;
    const bank = x.placed.kind === 'mono' ? this.phrases : this.poly;
    const phrase = bank?.byId.get(x.placed.id);
    if (!phrase) return null;
    const placed = bank.place(phrase, x.placed.shift, this.anchor, x.placed.key ?? null);
    if (!this.fits(placed)) return null;
    // Placed on the anchor (nothing fit the key), its free pivot must still be
    // the note under the hand; on another note it would be ungraded yet fatal.
    if (!placed.key && placed.notes[phrase.pivot][0] !== this.anchor) return null;
    return { ...x, placed };
  }

  fits(placed) {
    if (!placed.notes.every((n) => n[0] >= this.lo && n[0] <= this.hi)) return false;
    // AT THE ENTRY LEVEL, ON THE WHITE KEYS. A passage or variant is placed
    // in the block key when one fits and ON THE ANCHOR when none does, and
    // that fallback -- plus the variant's own anchor/mode-swap fallbacks --
    // is how a beginner's C major block ends up serving him an F# major
    // transposition. There is no shortage of C major excerpts; drop the ones
    // that leave it rather than bending the level to fit a phrase.
    return !this.entryLevel() || !this.block
      || placed.notes.every((n) => diatonicIn(n[0], this.block.key));
  }

  /**
   * Where in the stage's keyboard window this note would sit. A pure
   * calculation now: the caller asks the player to MOVE here (reanchorQuestion)
   * rather than moving the anchor out from under him, so nothing is logged --
   * the re-anchor question is its own record.
   */
  clampAnchor(midi) {
    const w = this.win;
    if (midi >= w.lo && midi <= w.hi) return midi;
    let back = Math.max(w.lo + 3, Math.min(w.hi - 3, midi));
    // The window's edge is an arbitrary pitch, so at the entry level walking
    // him back to it can land on a black key -- the one note the level is
    // supposed not to contain. Take the nearest note of the key instead.
    if (this.entryLevel() && this.block) {
      for (let d = 0; d <= 6; d += 1) {
        const up = back + d;
        const down = back - d;
        if (up <= w.hi && diatonicIn(up, this.block.key)) { back = up; break; }
        if (down >= w.lo && diatonicIn(down, this.block.key)) { back = down; break; }
      }
    }
    return back;
  }

  /**
   * PUT THE HAND WHERE THE NEXT CALL STARTS. Two notes: the note he is
   * already on, SOUNDED and free, then the note the next call needs, a beat
   * later, graded. Nothing is played that he is not asked to play back.
   *
   * This is the ONLY call in the program whose first note sounds before a
   * graded one (a dyad's two notes are simultaneous; an interval's and a
   * gesture's anchor is silent at every stage; a passage is four notes at
   * minimum). That makes it legible as "corrections are done, we are about
   * to try again" without a cue, which is Caleb's design and the reason for
   * the unison -- and since 2026-09-21 the signal is distinctive for every
   * player, not just the ones at the top of the ladder.
   *
   * NAVIGATION, NOT EVIDENCE (`navigation`): he is handed the target by ear
   * and asked to match it, and it fires most often on the phrases he is
   * failing, so scoring it would bias the ladder in exactly the wrong
   * direction. gradeNote skips the engines for it, and it is not an
   * `isolatedKind`, so the stage never sees it either.
   */
  reanchorQuestion(target) {
    return {
      kind: 'reanchor',
      navigation: true,
      optionalAnchor: true,
      notes: [
        { midi: this.anchor, b: 0, dur: 1, voice: 0, free: true },
        { midi: target, b: 1, dur: 1, voice: 0 },
      ],
      meter: 4,
      label: `re-anchor: ${name(this.anchor)} -> ? (${signed(target - this.anchor)})`,
    };
  }

  /** Notes are { midi, b, dur, voice, free, silent }. */
  intervalQuestion(kind, target, { wide = false } = {}) {
    const iv = target - this.anchor;
    const label = wide ? `${signed(simpleOf(iv))} +8ve` : signed(iv);
    return {
      kind,
      wide,
      optionalAnchor: true, // a wrong first note is a wrong target, never a wrong anchor
      // The anchor is the note you just played, so the call sounds only the
      // target, on the downbeat. The anchor stays in the question, a beat
      // before it: the target's melodic context for grading and the free note
      // you may echo or skip when you answer. IT IS NEVER SOUNDED, at any
      // stage or tier (2026-09-21) -- see the header note.
      notes: [{ midi: this.anchor, b: -1, dur: 1, voice: 0, free: true, silent: true }, { midi: target, b: 0, dur: 1, voice: 0 }],
      meter: 4,
      label: `${kind === 'interval' ? '' : `${kind}: `}${name(this.anchor)} -> ? (${label})`,
    };
  }

  /**
   * A GESTURE: the drilled target, then a diatonic step in the block key, so
   * the interval is heard inside a line. The anchor is silent as on a bare
   * question (the target comes when you are ready, not one beat after an
   * echo). Evidence goes to the engines at passage scope, so gestures never
   * move the interval tier ladder; the clean isolated probes still own that.
   */
  gestureQuestion(target) {
    const k = this.block.key;
    const mid = (this.lo + this.hi) / 2;
    const step = diatonicStep(target, k, mid, this.lo, this.hi);
    const notes = [{ midi: this.anchor, b: -1, dur: 1, voice: 0, free: true, silent: true }, { midi: target, b: 0, dur: 1, voice: 0 }];
    if (step !== null) notes.push({ midi: step, b: 1, dur: 2, voice: 0 });
    const tail = step === null ? '' : ` ${signed(step - target)}`;
    return {
      kind: 'gesture',
      gesture: true,
      optionalAnchor: true,
      notes,
      meter: 4,
      label: `gesture: ${name(this.anchor)} -> ? (${signed(target - this.anchor)})${tail} in ${keyName(k)}${diatonicIn(target, k) ? '' : ', borrowed'}`,
    };
  }

  /**
   * THE OTHER HAND'S FIRST NOTE, asked as a dyad against the anchor before a
   * polyphonic passage is served. The pivot is placed on the anchor, so one
   * hand knows where it is; every other voice's first note was a cold
   * interval to be found while the passage was already moving -- the same
   * "a call assuming the hand is where it isn't" that the re-anchor cured for
   * mono. Caleb, on unlocking polyphony again: "There's nothing placing my
   * left hand before the example starts."
   *
   * A dyad rather than a melodic ask, because what has to be placed is two
   * hands DOWN AT ONCE; the anchor does not move (keepAnchor), since moving
   * it is exactly what would unplace the pivot.
   */
  placingQuestion(target) {
    // BOTH HANDS DOWN AT ONCE, and both count: the pivot is the common tone,
    // required and graded as a unison; the other hand's note is a departure
    // from it. It used to be free, and free is what taught him the bottom
    // note of a dyad is optional (190 of 366 dyads answered with one note).
    const a = this.anchor;
    const [lo, hi] = target < a ? [target, a] : [a, target];
    return {
      kind: 'placing',
      dyad: true,
      pair: true,
      regime: 'placing',
      placing: true,
      keepAnchor: true,
      optionalAnchor: true,
      notes: [
        { midi: lo, b: 0, dur: 2, voice: 0, from: a, unison: lo === a },
        { midi: hi, b: 0, dur: 2, voice: 1, from: a, unison: hi === a },
      ],
      meter: 4,
      label: `placing: ${name(a)} + ? (${signed(target - a)} together, keep ${name(a)}) -- the other hand's first note`,
    };
  }

  /**
   * PUT THE HAND THERE, after a missed placing. Every note sounded and asked
   * back, nothing graded for any ladder (navigation): for a dyad placing the
   * other hand's note ALONE, then both hands together, so the pair is under
   * the hands when the passage starts (and `hands` is set from what he
   * struck); for a melodic one, the re-anchor shape to the note the passage
   * starts on. `placing` marks it so its landing is read like the first try.
   */
  placeHandQuestion(p) {
    if (!p.dyad) {
      const q = this.reanchorQuestion(p.target);
      q.kind = 'place hand';
      q.placing = true;
      q.label = `place hand: ${name(this.anchor)} -> ${name(p.target)} -- the note the passage starts on`;
      return q;
    }
    const a = this.anchor;
    const [lo, hi] = p.target < a ? [p.target, a] : [a, p.target];
    return {
      kind: 'place hand',
      navigation: true,
      dyad: true,
      placing: true,
      keepAnchor: true,
      notes: [
        { midi: p.target, b: 0, dur: 1, voice: p.target === lo ? 0 : 1, from: a },
        { midi: lo, b: 1, dur: 2, voice: 0, from: a, unison: lo === a },
        { midi: hi, b: 1, dur: 2, voice: 1, from: a, unison: hi === a },
      ],
      meter: 4,
      label: `place hand: ${name(p.target)}, then ${name(lo)} + ${name(hi)} together -- the other hand's first note`,
    };
  }

  /** The note a placing dyad should put the other hand on: the lowest entry
   *  among the voices the pivot does not cover (the hand with travelling to
   *  do). Null when there is nothing to place. */
  placingTarget(picked) {
    const { phrase, notes } = picked;
    if (phrase.kind === 'mono') return null;
    const pivotVoice = notes[phrase.pivot][3] ?? 0;
    const firsts = new Map(); // voice -> [offset, midi]
    for (const [midi, off, , voice = 0] of notes) {
      const seen = firsts.get(voice);
      if (!seen || off < seen[0]) firsts.set(voice, [off, midi]);
    }
    let target = null;
    for (const [voice, [, midi]] of firsts) {
      if (voice === pivotVoice || midi === this.anchor) continue;
      if (target === null || midi < target) target = midi;
    }
    return target;
  }

  /**
   * What must be under a hand before this passage can start, and how to ask
   * for it. Two cases, and the second was missed until 2026-09-15:
   *
   *   dyad      the PIVOT hand is already home and the OTHER hand has
   *             travelling to do -- ask for them together.
   *   interval  the passage does not begin under the hand AT ALL. A variant
   *             may be shifted an octave (`picked.octave`), and then the
   *             pivot -- the one note that is supposed to be free, the note
   *             you already have -- is somewhere else entirely. Ask for it
   *             as a plain melodic interval, and the hand ends up on it,
   *             which is the whole point. (Caleb, guest mode: "The last
   *             question made me start a passage cold. My hand was not on
   *             the starting note." Mozart K332 variant, starts C#4, anchor
   *             C#3: he fumbled A#3 on the free note and was 1.6s late into
   *             a re-metered 150 bpm line.)
   *
   * Null when the passage already begins where the hand is.
   */
  placingPlan(picked) {
    // THE PIVOT FIRST, because placing it MOVES the anchor, and the other
    // hand's dyad is measured from the anchor. A duo that is both in a
    // foreign octave and two-handed therefore places in two steps: the hand
    // you have, then the hand you do not. The order also makes the chain
    // terminate -- a landed melodic placing leaves the pivot ON the anchor,
    // so it can never be asked for twice, and a dyad placing is always last.
    const pivotMidi = picked.notes[picked.phrase.pivot][0];
    if (pivotMidi !== this.anchor) return { target: pivotMidi, dyad: false };
    const other = this.placingTarget(picked);
    return other === null ? null : { target: other, dyad: true };
  }

  /** Serve a passage, putting the hand where it has to be first. */
  serveWithPlacement(kind, picked, suffix = '') {
    const plan = this.placingPlan(picked);
    if (plan === null) {
      const q = this.passageQuestion(kind, picked);
      if (suffix) q.label += suffix;
      return q;
    }
    this.placing = { kind, picked, suffix, ...plan };
    if (plan.dyad) return this.placingQuestion(plan.target);
    // A plain interval question: nothing marks it as a placement, because
    // from the player's side it is not one. The anchor moves to it the way
    // it moves after any interval, and the passage then starts under the
    // hand -- so the octave displacement in the label is no longer true.
    const q = this.intervalQuestion('placing', plan.target);
    q.placing = true;
    q.label += ' -- the note the passage starts on';
    return q;
  }

  /**
   * THE WALK OUT OF A HARMONIC MISS. A missed dyad used to queue another
   * dyad -- an "easier" inward variant off a 119-trial model -- which landed
   * at 36-41% clean whether it came first or second in a row, i.e. it was
   * never easier at all, and being handed it straight after a miss is what
   * made the drill feel like a cascade (Caleb, 2026-09-14: "I feel stressed",
   * and the data agreed).
   *
   * Instead the interval is given a chord to live in and the ear is walked
   * there one note at a time, every step a plain melodic ask -- the thing he
   * does at 62-90% while the same intervals harmonically sit at 17-38%
   * (m3 82/38, M3 79/21, m6 62/25, M6 69/17; P5 72/79 and the octave 90/71
   * need no help, which is the fusion story: perfect consonances resolve into
   * one nameable object, imperfect ones into a blur).
   *
   *   1. the note that was MISSED, alone, from wherever the hand is
   *   2. a chord tone, the biggest leap he has tiers for
   *   3. the other note of the dyad
   *   4. the dyad again -- the same two notes
   *
   * By step 4 the chord has been laid out in time rather than sounded at
   * once: "the user will be hearing a sparsely orchestrated chord by now."
   * ONE MISS ANYWHERE AND THE WHOLE THING IS DROPPED, back to the ordinary
   * drill -- no stacking failures, and the retry that never arrives is never
   * announced, so he may not know it was coming.
   */
  queueRecovery(from, missed) {
    // Only out of a dyad, chord or placing. A harmonic miss inside a PASSAGE
    // already has a corrective loop of its own (window -> correction ->
    // re-anchor -> retry) and inserting a walk into the middle of it would
    // push the retry four questions away from the miss it answers.
    if (!this.q?.dyad || this.q.recovery || this.recovery || !this.block || !this.dyadsOpen()) return;
    const chord = chordFor(this.block.key, [from % 12, missed % 12]);
    if (!chord) return; // a chromatic pair: the key has nothing to build on
    this.recovery = { a: from, t: missed, chord, step: 0 };
  }

  /** Every question in the walk carries the flag: it keeps the ladder out of
   *  it, and it stops a missed retry from spawning a second walk. */
  mark(q) {
    q.recovery = true;
    return q;
  }

  /** The chord tone to pass through: the biggest leap the ladder has opened
   *  that still leaves the other note of the dyad reachable -- and a THIRD
   *  tone of the chord, never either of the dyad's own notes in another
   *  octave. The octave of the missed note always won "biggest leap" (G4 ->
   *  G3 -> E4 for E4-G4), so the walk laid out no chord at all, only the
   *  missed note in the wrong register -- and both wrong-octave retries on
   *  record played exactly that note (E4+G3, then C4+E3; 2026-09-22/23). */
  recoveryTone() {
    const r = this.recovery;
    const widths = this.primeWidths();
    const pc = (m) => ((m % 12) + 12) % 12;
    let best = null;
    for (let midi = this.lo; midi <= this.hi; midi += 1) {
      if (midi === this.anchor || pc(midi) === pc(r.a) || pc(midi) === pc(r.t)) continue;
      if (!r.chord.includes(((midi % 12) + 12) % 12)) continue;
      const out = Math.abs(midi - this.anchor);
      const back = Math.abs(r.a - midi);
      if (!widths.has(out) || !widths.has(back)) continue;
      if (!best || out + back > best.span) best = { midi, span: out + back };
    }
    return best ? best.midi : null;
  }

  /**
   * THE SAME INTERVAL SOMEWHERE ELSE IN THE SAME KEY. The retry proves he can
   * play the two keys he has just played; it does not prove he heard
   * anything, because by then his hand has been on both. This is the trial
   * that cannot be passed from hand memory -- and keeping both notes diatonic
   * keeps it inside the harmonic field the walk just built, so the same
   * interval arrives with a different function. Prefer no approach at all
   * (his hand already works as the bass), then a bass inside the same chord,
   * then any diatonic one he can reach.
   */
  transferBass(r) {
    const iv = r.t - r.a;
    const key = this.block.key;
    const widths = this.primeWidths();
    const ok = (b) => b !== r.a && b >= this.lo && b <= this.hi
      && b + iv >= this.lo && b + iv <= this.hi
      && diatonicIn(b, key) && diatonicIn(b + iv, key);
    // A DIFFERENT DEGREE, not the same pair an octave away: the interval has
    // to arrive with a different function or the trial is the same trial.
    // Relaxed only when the key holds no other placement -- a tritone sits on
    // exactly one degree pair, and F+B after B+F is the only "elsewhere"
    // there is.
    const pc = (m) => ((m % 12) + 12) % 12;
    const fresh = (b) => pc(b) !== pc(r.a);
    const pick = (test) => {
      if (ok(this.anchor) && test(this.anchor)) return this.anchor;
      let best = null;
      for (let b = this.lo; b <= this.hi; b += 1) {
        if (!ok(b) || !test(b) || !widths.has(Math.abs(b - this.anchor))) continue;
        const d = Math.abs(b - this.anchor);
        if (!best || d < best.d) best = { b, d };
      }
      return best ? best.b : null;
    };
    return pick(fresh) ?? pick(() => true);
  }

  recoveryQuestion() {
    const r = this.recovery;
    for (;;) {
      if (r.step === 0) {
        r.step = 1;
        if (this.anchor === r.t) continue; // already there: nothing to ask
        return this.mark(this.intervalQuestion('recovery', r.t));
      }
      if (r.step === 1) {
        r.step = 2;
        const tone = this.recoveryTone();
        if (tone !== null) return this.mark(this.intervalQuestion('recovery', tone));
        continue; // no room for a pass: go straight back
      }
      if (r.step === 2) {
        r.step = 3;
        if (this.anchor === r.a) continue;
        return this.mark(this.intervalQuestion('recovery', r.a));
      }
      if (r.step === 3) {
        r.step = 4;
        // The same two notes, and the anchor is the note under his hand: the
        // walk ended on it, which is the only reason this can be the dyad
        // that was missed.
        if (this.anchor === r.a) return this.mark(this.dyadQuestion('dyad retry', r.t));
        break;
      }
      if (r.step === 4) {
        r.step = 5;
        const bass = this.transferBass(r);
        if (bass === null) break;
        r.bass = bass;
        if (this.anchor === bass) continue; // already there: no approach needed
        return this.mark(this.intervalQuestion('recovery', bass));
      }
      this.recovery = null;
      return this.anchor === r.bass ? this.mark(this.dyadQuestion('dyad transfer', r.bass + (r.t - r.a))) : null;
    }
    this.recovery = null;
    return null;
  }

  /**
   * A DYAD IS A DEPARTURE FROM THE ANCHOR (Caleb, 2026-09-20). The anchor is
   * the last note he played and it is a monophonic idea; a dyad is the moment
   * of leaving it, and BOTH notes are measured from the note being left. The
   * bottom note is no longer named for him: it used to be, and free, and the
   * named note was right 282 times in 282 -- a row, not a test -- while in
   * 190 of 366 dyads he never played it at all and was scored anyway. So the
   * "dyad" number was a melodic interval wearing a label (84% against 80%
   * for a plain interval), and the rung it claimed to be did not exist.
   *
   * Rung 1 (`containingDyad`): the dyad contains the anchor. One retrieval;
   * the common tone is REQUIRED, graded as a unison -- the first voice-leading
   * skill, a voice staying put, which is also the percept behind his worst
   * harmonic event (two voices arriving on one pitch). It is recorded as a
   * row and reported to no engine: a unison is not a width.
   * Rung 2 (`departingDyad`): neither note is the anchor. Two retrievals.
   * Rung 3 (`twohandDyad`): each hand from its own anchor, the dyad before.
   *
   * The harmonic SPAN (the dyad's own width, unfolded -- a tenth is not a
   * third; wide cold dyads were 9/9 while a melodic tenth is his weakest
   * band) is chosen by the harmonic engine's ladder, which opens at seconds
   * and thirds. The DEPARTURE distances are melodic intervals and are not
   * capped: the melodic engine already rates them, and capping a floor is the
   * 09-12 mistake. Below DIATONIC_TIERS both notes sit in the block key.
   *
   * This one (`dyadQuestion`) is the rung-1 shape on the anchor, kept for the
   * recovery walk's retry and transfer -- easy exemplars first, then the hard
   * case, which is the walk's stated rationale.
   */
  dyadQuestion(kind, target) {
    return this.pairNotes(kind, this.anchor, this.anchor, this.anchor, target, 'departure');
  }

  /** Build a two-note question, each note framed from the anchor named for it. */
  pairNotes(kind, fromLo, fromHi, lo, hi, regime) {
    if (lo > hi) { [lo, hi] = [hi, lo]; [fromLo, fromHi] = [fromHi, fromLo]; }
    const notes = [
      { midi: lo, b: 0, dur: 2, voice: 0, from: fromLo, unison: lo === fromLo },
      { midi: hi, b: 0, dur: 2, voice: 1, from: fromHi, unison: hi === fromHi },
    ];
    const contains = notes.some((n) => n.unison);
    let label;
    if (regime === 'twohand') label = `${kind}: each hand: ${name(fromLo)} -> ? ${name(fromHi)} -> ? (${signed(lo - fromLo)}, ${signed(hi - fromHi)} together)`;
    else if (contains) label = `${kind}: ${name(fromLo)} + ? (${signed((lo === fromLo ? hi : lo) - fromLo)} together, keep ${name(fromLo)})`;
    else label = `${kind}: from ${name(fromLo)}: ? + ? (${signed(lo - fromLo)}, ${signed(hi - fromLo)} together)`;
    return { kind, dyad: true, pair: true, regime, contains, optionalAnchor: true, notes, meter: 4, label };
  }

  /** The dyad rung controller's state (DYAD_RUNG). */
  rungState() {
    const st = this.rungStore.load();
    return st || { rung: 1, ewma: { 1: 0.75, 2: 0.75, 3: 0.75 }, n: { 1: 0, 2: 0, 3: 0 }, since: 0 };
  }

  /** One retrieval on a rung (never the unison), and the move it may cause. */
  noteRungRetrieval(rung, ok) {
    const st = this.rungState();
    st.ewma[rung] = st.ewma[rung] * (1 - DYAD_RUNG.alpha) + (ok ? DYAD_RUNG.alpha : 0);
    st.n[rung] = (st.n[rung] || 0) + 1;
    st.since += 1;
    if (rung === st.rung && st.since >= DYAD_RUNG.cooldown) {
      const names = { 1: 'a dyad on the note you are on', 2: 'a dyad away from the note you are on', 3: 'each hand moving from its own note' };
      if (st.ewma[rung] > DYAD_RUNG.high && st.rung < 3) {
        st.rung += 1; st.since = 0; st.ewma[st.rung] = 0.78;
        this.log(`  dyads: up to rung ${st.rung} -- ${names[st.rung]}`);
      } else if (st.ewma[rung] < DYAD_RUNG.low && st.rung > 1) {
        st.rung -= 1; st.since = 0; st.ewma[st.rung] = 0.75;
        this.log(`  dyads: back to rung ${st.rung} -- ${names[st.rung]}`);
      }
    }
    this.rungStore.save(st);
  }

  /** Signed departure distances the melodic ladder allows, plus the two steps (always). */
  departureWidths() {
    const w = new Set([1, 2]);
    for (const x of TIER_WIDTHS.slice(0, this.engine.state.tiersUnlocked)) w.add(x);
    return w;
  }

  /** May this note be a dyad note right now: on the keyboard, in the stage's window, and in the key while the level demands it. */
  dyadNoteOk(midi) {
    const w = this.win;
    if (midi < this.lo || midi > this.hi || midi < w.lo || midi > w.hi) return false;
    if (this.entryLevel() && this.block && !diatonicIn(midi, this.block.key)) return false;
    return true;
  }

  /** Diatonic notes are preferred where the level does not require them. */
  dyadLean(midi) {
    return this.block && diatonicIn(midi, this.block.key) ? DIATONIC_LEAN : 1;
  }

  pickWeighted(cands) {
    if (cands.length === 0) return null;
    const total = cands.reduce((t, c) => t + c.w, 0);
    let roll = Math.random() * total;
    for (const c of cands) { roll -= c.w; if (roll <= 0) return c; }
    return cands[cands.length - 1];
  }

  /**
   * The dyad slot: which rung, then the span from the harmonic ladder, then
   * the shape. Rung 3 is never served here -- it needs two hands down, so it
   * is chained after a rung-1/2 dyad (finalizeQuestion, `chainDyad`). The
   * current rung mostly; a lower one sometimes, so it is a diet and not a
   * cliff.
   */
  dyadSlot(a) {
    const st = this.rungState();
    let rung = Math.min(st.rung, 2);
    if (rung === 2 && Math.random() < DYAD_RUNG.lowerShare) rung = 1;
    const spanHi = Math.min(this.idx(this.hi), a + 12);
    if (a + 1 > spanHi) return null;
    const span = this.harmonic.nextTargetIndex(a, null, { bounds: { lo: a + 1, hi: spanHi } }) - a;
    if (span <= 0) return null;
    const kind = this.harmonic.servedQueue ? 'dyad discrimination' : 'dyad';
    return (rung === 2 ? this.departingDyad(kind, span) : null) ?? this.containingDyad(kind, span);
  }

  /** Rung 1: the anchor and one note a span away, above or below it. */
  containingDyad(kind, span) {
    const a = this.anchor;
    const cands = [a + span, a - span].filter((m) => this.dyadNoteOk(m)).map((m) => ({ m, w: this.dyadLean(m) }));
    const pick = this.pickWeighted(cands);
    if (!pick) return null;
    return this.pairNotes(kind, a, a, a, pick.m, 'departure');
  }

  /** Rung 2: two notes a span apart, neither the anchor, both departures the melodic ladder allows. */
  departingDyad(kind, span) {
    const a = this.anchor;
    const ai = this.idx(a);
    const widths = this.departureWidths();
    const now = Date.now();
    const cands = [];
    for (const d1 of [...widths].flatMap((w) => [w, -w])) {
      const d2 = d1 + span;
      if (d2 === 0 || !widths.has(Math.abs(d2))) continue;
      const lo = a + d1;
      const hi = a + d2;
      if (!this.dyadNoteOk(lo) || !this.dyadNoteOk(hi)) continue;
      const w = this.engine.weight(d1, ai, now, null) * this.engine.weight(d2, ai, now, null) * this.dyadLean(lo) * this.dyadLean(hi);
      cands.push({ lo, hi, w });
    }
    const pick = this.pickWeighted(cands);
    if (!pick) return null;
    return this.pairNotes(kind, a, a, pick.lo, pick.hi, 'departure');
  }

  /** Rung 3: from two hands, each moves (or holds) to a new dyad a span apart. */
  twohandDyad() {
    const [L, U] = this.hands;
    const li = this.idx(L);
    const spanHi = Math.min(this.idx(this.hi), li + 12);
    if (li + 1 > spanHi) return null;
    const span = this.harmonic.nextTargetIndex(li, null, { bounds: { lo: li + 1, hi: spanHi } }) - li;
    if (span <= 0) return null;
    const widths = this.departureWidths();
    const now = Date.now();
    const cands = [];
    for (const dL of [0, ...[...widths].flatMap((w) => [w, -w])]) {
      const lo = L + dL;
      const hi = lo + span;
      const dU = hi - U;
      if (dL === 0 && dU === 0) continue; // nothing moved: not a question
      if (dU !== 0 && !widths.has(Math.abs(dU))) continue;
      if (!this.dyadNoteOk(lo) || !this.dyadNoteOk(hi)) continue;
      const wl = dL === 0 ? 1 : this.engine.weight(dL, li, now, null);
      const wu = dU === 0 ? 1 : this.engine.weight(dU, this.idx(U), now, null);
      cands.push({ lo, hi, w: wl * wu * this.dyadLean(lo) * this.dyadLean(hi) });
    }
    const pick = this.pickWeighted(cands);
    if (!pick) return null;
    return this.pairNotes('dyad', L, U, pick.lo, pick.hi, 'twohand');
  }

  /** A chord shape above the anchor as a fixed bass; every note above it graded. */
  chordQuestion() {
    const open = this.harmonic.state.tiersUnlocked >= 5 ? CHORD_SHAPES : CHORD_SHAPES.filter((s) => s.length === 2);
    const fits = open.filter((s) => this.anchor + s[s.length - 1] <= this.hi);
    if (fits.length === 0) return null;
    const shape = fits[Math.floor(Math.random() * fits.length)];
    const notes = [{ midi: this.anchor, b: 0, dur: 2, voice: 0, free: true }];
    shape.forEach((iv, i) => notes.push({ midi: this.anchor + iv, b: 0, dur: 2, voice: i + 1 }));
    // Each voice is framed for the harmonic engine as it is graded (gradeNote),
    // at passage scope: a chord tone is heard in a chord, not probed alone.
    return { kind: 'chord', dyad: true, chord: true, optionalAnchor: true, notes, meter: 4, label: `chord: ${name(this.anchor)} + ${shape.map((iv) => `+${iv}`).join(' ')} together` };
  }

  /**
   * THE PRIME'S ONE-NOTE STEP, and the only thing that establishes the key.
   *
   * The key arrives the way everything else in this drill does: one note at a
   * time, call and response, the note under your hand and then a target. A
   * block opens on the tonic (chooseKey takes the anchor's pitch class) and
   * then walks a tonal set through two to four ordinary questions -- do, then
   * re, then mi -- until the set is covered and the key is simply there. It
   * used to arrive as the whole set at once, three to five notes in a single
   * call, which is not a thing anyone can play back and is not how any of the
   * rest of the drill works.
   *
   * EVERY STEP IS AT THE PLAYER'S LEVEL. The target is chosen from what is
   * left of the set so that the interval from where the hand actually IS is
   * one the ladder (or the stage's pool) has opened, plus steps and half
   * steps, which are always allowed: walking a scale is how a key is
   * established and it is the easiest motion there is. A beginner therefore
   * gets do-re-mi and nothing else, because the two stepwise sets are the
   * only ones open to him.
   *
   * Evidence goes in at passage scope: the set is context, not a probe.
   */
  primeQuestion() {
    const p = this.priming;
    const target = this.nextPrimeTarget();
    if (target === null) { // nothing reachable: the key is as established as it will get
      this.priming = null;
      return this.makeQuestion();
    }
    p.left = p.left.filter((d) => d !== target.degree);
    p.step += 1;
    p.lastIv = target.iv;
    if (p.left.length === 0) this.priming = null;
    const q = this.intervalQuestion('prime', target.midi);
    q.prime = true;
    q.label = `key: ${keyName(p.key)}, ${p.set} ${p.step}/${p.total}: ${name(this.anchor)} -> ? (${signed(target.iv)})`;
    return q;
  }

  /**
   * The widths a prime step may use. BELOW THE EXACT STAGE: the step and the
   * half step, and nothing else -- a beginner gets the intervals he starts
   * out with, which means the key arrives as a scale he walks up. (The rest
   * of the block still uses the stage's own pool; this is the warm-up.) At
   * the top: everything the ladder has opened, plus the two steps, which are
   * always allowed because walking a scale is how a key is established and is
   * the easiest motion there is.
   */
  primeWidths() {
    const w = new Set([1, 2]);
    if (this.stage.current !== 'exact') return w;
    for (const x of TIER_WIDTHS.slice(0, this.engine.state.tiersUnlocked)) w.add(x);
    return w;
  }

  /**
   * The next note of the walk, chosen from where the hand actually is (which
   * is where the last answer LANDED, right or wrong -- so a wrong turn never
   * leaves the next question out of reach). Each remaining degree is tried in
   * the octave above and below as well, which keeps the line inside the
   * stage's window and gives the walk somewhere to turn.
   *
   * Aesthetics, such as they are: a turn is worth more than a run, and a
   * singable distance more than a leap. A prime should sound like a small
   * tune, not like a list.
   */
  nextPrimeTarget() {
    const p = this.priming;
    const widths = this.primeWidths();
    const w = this.win;
    const lo = Math.max(this.lo, w.lo);
    const hi = Math.min(this.hi, w.hi);
    const cands = [];
    for (const degree of p.left) {
      for (const octave of [0, -12, 12]) {
        const midi = p.tonic + degree + octave;
        const iv = midi - this.anchor;
        if (midi < lo || midi > hi || iv === 0) continue;
        if (!widths.has(Math.abs(iv))) continue;
        // Shape, in three terms. A singable distance over a leap -- but the
        // leap stays possible, because catching a seventh cold is the point
        // of a seventh. A turn over a run, so the walk is a little tune and
        // not an arpeggio with the notes shuffled. And the key's own octave
        // over the far end of the keyboard, which is what stops a five-note
        // set from climbing two octaves and never coming back.
        const span = Math.abs(iv);
        let weight = span <= 2 ? 2 : span <= 5 ? 1.4 : span <= 7 ? 1 : span <= 9 ? 0.5 : 0.3;
        if (p.lastIv && Math.sign(iv) !== Math.sign(p.lastIv)) weight *= 2.2;
        weight /= 1 + Math.abs(midi - p.tonic) / 12;
        cands.push({ degree, midi, iv, weight });
      }
    }
    if (cands.length === 0) {
      // Stranded: the hand landed somewhere no remaining degree can be
      // reached from at this level. Rather than abandon the warm-up -- which
      // is what a beginner, who lands anywhere, would get every single time --
      // take a diatonic step from where he actually is. Stepwise motion
      // inside the key is the strongest key cue there is, so the walk still
      // does its job, and it can never strand again.
      const step = diatonicStep(this.anchor, p.key, (lo + hi) / 2, lo, hi);
      if (step === null) return null;
      return { degree: p.left[0], midi: step, iv: step - this.anchor };
    }
    let roll = Math.random() * cands.reduce((a, c) => a + c.weight, 0);
    for (const c of cands) {
      roll -= c.weight;
      if (roll <= 0) return c;
    }
    return cands[cands.length - 1];
  }

  /**
   * Both intervals of a confused pair from one anchor, in one call: the
   * labelled exposure that flanks the categorisation trials. It is ASKED,
   * not merely played -- there is no listening-only question in this drill.
   * (Melodic: in turn, returning to the anchor between them. Harmonic: as
   * two dyads.) Scored at passage scope: exposure, not a probe.
   */
  pairQuestion(pair, { harmonic = false } = {}) {
    const a = this.anchor;
    const ok = (iv) => a + iv >= this.lo && a + iv <= this.hi;
    const ivs = [pair.a, pair.b].map((iv) => (ok(iv) ? iv : -iv)).filter(ok);
    if (ivs.length < 2) return null;
    const notes = [];
    // Harmonic: the first dyad is a departure from the anchor (both notes
    // from it, the anchor itself a required unison); the second is a two-hand
    // step -- the bass holds (a unison from its own hand), the top moves from
    // the note it was just on. buildGroups frames voice 1 from its previous
    // note on its own; the common tones are marked so they are graded.
    if (harmonic) ivs.forEach((iv, i) => notes.push(
      { midi: a, b: i * 2, dur: 2, voice: 0, unison: true, from: a, regime: i === 0 ? 'departure' : 'twohand' },
      { midi: a + iv, b: i * 2, dur: 2, voice: 1, from: i === 0 ? a : undefined, regime: i === 0 ? 'departure' : 'twohand' },
    ));
    else ivs.forEach((iv, i) => notes.push({ midi: a, b: i * 2, dur: 1, voice: 0, free: i === 0 }, { midi: a + iv, b: i * 2 + 1, dur: 1, voice: 0 }));
    return {
      kind: 'exposure',
      exposure: true,
      pair: harmonic,
      optionalAnchor: true,
      notes,
      meter: 4,
      label: `both: ${name(a)} ${harmonic ? '+' : '->'} ${signed(ivs[0])}, then ${signed(ivs[1])}`,
    };
  }

  /**
   * THE JUDGMENT WINDOW: no notes, no click, just the pulse stopping. What
   * the player does in the silence is collected (handleAnswer) and read when
   * it closes (closeWindow).
   */
  windowQuestion(w) {
    return {
      kind: 'window',
      window: w,
      tempo: w.bpm,
      notes: [],
      meter: 4,
      label: `judgment window: ${w.sec.toFixed(1)}s, no pulse (play the note you think you missed, or nothing)`,
    };
  }

  /**
   * THE CORRECTION: the notes you never reached, served as an ordinary call
   * at the passage's own tempo, for you to play back. Cascade notes included
   * -- a note you played in the right interval from a pitch you had already
   * lost is still a place you never got to, and "this is where you should
   * have been" is the lesson. Scored at passage scope: you were just handed
   * the pitch, so it is context, not a probe, and it queues no remediation
   * (the passage that spawned it already did).
   */
  correctionQuestion(c) {
    const notes = c.notes.map((midi, i) => ({ midi, b: i, dur: i === c.notes.length - 1 ? 2 : 1, voice: 0 }));
    return {
      kind: 'correction',
      correction: true,
      tempo: c.bpm,
      notes,
      meter: 4,
      label: `correction: ${c.notes.map(name).join(' ')} -- ${c.notes.length === 1 ? 'the note' : 'the notes'} you never reached`,
    };
  }

  passageQuestion(kind, picked) {
    const { phrase, octave, key } = picked;
    // RE-METERED when the written rhythm is too fast to hear at its own
    // tempo: the shortest note becomes the beat and the long notes are capped
    // so they do not drag behind it (src/tempo.js). The pivot index still
    // points at the same note -- only offsets and lengths change.
    const plan = remeterPlan(phrase, this.floorSec);
    const notes = plan ? remeterNotes(picked.notes, plan) : picked.notes;
    const pickup = plan ? Math.round((phrase.pickup * plan.beatSec) / plan.unitSec) : phrase.pickup;
    // Placed in a key, the pivot is no longer the note under the hand: it is
    // a heard note like any other and is graded (buildGroups frames it from
    // the anchor). Placed on the anchor, it stays free. On a RETRY every
    // voice's first note was just heard: free, so a fumbled start costs
    // nothing and the correction is about the notes that were missed.
    const seen = new Set();
    const placed = notes.map(([midi, off, dur, voice], i) => {
      const firstInVoice = !seen.has(voice);
      seen.add(voice);
      // The pivot is the note under your hand, in a key or not (PhraseBank
      // places it there): free, as it always was.
      return { midi, b: pickup + off, dur, voice, free: i === phrase.pivot || (kind === 'retry' && firstInVoice) };
    });
    const pivotMidi = notes[phrase.pivot][0];
    const remetered = plan ? `, re-metered (${plan.meter} per beat)` : '';
    const start = key ? `, in ${keyName(key)}` : octave === 0 ? '' : `, starts ${name(pivotMidi)} (octave ${octave > 0 ? 'above' : 'below'} anchor)`;
    const poly = phrase.kind !== 'mono';
    return {
      kind,
      notes: placed,
      meter: plan ? plan.meter : phrase.meter,
      tempo: plan ? plan.bpm : undefined,
      phrase,
      octave,
      placed: picked,
      label: `${kind === 'passage' ? '' : `${kind}: `}${poly ? `${phrase.kind}: ` : ''}${phrase.composer} ${phrase.catalog} "${phrase.title}" bar ${phrase.bar}, ${phrase.meter}-beat bars, ${poly ? `${phrase.voices} voices, ` : ''}${notes.length} notes in ${phrase.key || '?'}${start}${remetered}`,
    };
  }

  /** Which passage kinds this level may ask, weighted toward the level's own. */
  passageKinds() {
    const level = this.polyState.level;
    const kinds = [];
    for (let l = 0; l <= level; l += 1) kinds.push({ kind: POLY_KINDS[l], w: l === level ? 0.6 : 0.4 / Math.max(1, level) });
    // weighted order without replacement
    const order = [];
    const pool = kinds.slice();
    while (pool.length) {
      const total = pool.reduce((a, k) => a + k.w, 0);
      let roll = Math.random() * total;
      let i = 0;
      for (; i < pool.length - 1; i += 1) {
        roll -= pool[i].w;
        if (roll <= 0) break;
      }
      order.push(pool.splice(i, 1)[0].kind);
    }
    return order;
  }

  /** The tier ladder's ceiling on passage length for a kind. */
  lengthCeiling(kind) {
    return kind === 'mono' ? 3 + this.engine.state.tiersUnlocked : 6 + 2 * this.harmonic.state.tiersUnlocked;
  }

  /** Current passage length for a kind: the controller's value, inside its bounds. */
  passageLength(kind) {
    const st = this.len[kind] || { notes: LEN.start[kind], cleanRun: 0, failRun: 0 };
    this.len[kind] = st;
    return Math.max(LEN.min[kind], Math.min(this.lengthCeiling(kind), st.notes));
  }

  /**
   * A passage of this kind (first asking, not a retry) ended clean or not, on
   * pitch. ONLY A PASSAGE SERVED AT THE TARGET LENGTH VOTES: a clean short one
   * is not evidence about a long one, and letting it vote is what walked the
   * mono ceiling to nine and the duo ceiling to eight (see LEN).
   */
  updatePassageLength(kind, clean, served = null) {
    const before = this.passageLength(kind); // also creates the kind's state
    if (served !== null && served < before - LEN.band) return;
    const st = this.len[kind];
    if (clean) { st.cleanRun += 1; st.failRun = 0; } else { st.failRun += 1; st.cleanRun = 0; }
    if (st.cleanRun >= LEN.grow) { st.notes = before + 1; st.cleanRun = 0; }
    else if (st.failRun >= LEN.shrink) { st.notes = before - 1; st.failRun = 0; }
    this.lenStore.save(this.len);
    const after = this.passageLength(kind);
    if (after !== before) this.log(`  ${kind} passages now up to ${after} notes`);
  }

  pickPassage() {
    for (const kind of this.passageKinds()) {
      const bank = kind === 'mono' ? this.phrases : this.poly;
      if (!bank) continue;
      const opts = {
        engine: this.engine,
        harmonic: kind === 'mono' ? null : this.harmonic,
        kind,
        maxNotes: this.passageLength(kind),
        minNotes: this.passageLength(kind) - LEN.band,
        exclude: this.askedThisSession,
      };
      // In the block key first; on the anchor only if nothing fits the key.
      // THE BAND IS A PREFERENCE, NOT A FAMINE: when nothing in it fits the
      // key, the hand and the range, the bottom drops away rather than the
      // question. Widening down is safe -- a short passage is the easy end.
      const wide = { ...opts, minNotes: 0 };
      const picked = (this.block && bank.pick(this.anchor, this.lo, this.hi, { ...opts, key: this.block.key })) ||
        bank.pick(this.anchor, this.lo, this.hi, opts) ||
        (this.block && bank.pick(this.anchor, this.lo, this.hi, { ...wide, key: this.block.key })) ||
        bank.pick(this.anchor, this.lo, this.hi, wide);
      if (picked && this.fits(picked)) return picked;
    }
    return null;
  }

  /** The variant of a nailed passage: the block's new key, else the other mode, else a step away. */
  variantQuestion(v) {
    const bank = v.kind === 'mono' ? this.phrases : this.poly;
    const phrase = bank?.byId.get(v.id);
    if (!phrase) return null;
    let picked = null;
    let how = '';
    // A parameter of the same pattern first (Lai et al. 2000): the new key,
    // else a small transposition with the same hand shape; the other mode --
    // which changes the melody itself -- only when neither fits.
    if (this.block && phrase.tonalKey && (!v.key || v.key.tonic !== this.block.key.tonic || v.key.mode !== this.block.key.mode)) {
      picked = bank.pickInKey(v.id, this.block.key, this.anchor, this.lo, this.hi);
      // A major phrase in the relative minor block (or the reverse) is the
      // same pitch set: no transposition at all. Fall through to a real step.
      if (picked && v.placed && (((picked.shift - v.placed.shift) % 12) + 12) % 12 === 0) picked = null;
      if (picked) how = `now in ${keyName({ tonic: (((phrase.tonalKey.tonic + picked.shift) % 12) + 12) % 12, mode: phrase.tonalKey.mode })}`;
    }
    // EVERY FALLBACK IS ANCHORED TOO. These used to transpose v.placed -- the
    // placement from when he NAILED it -- by +-2/3 semitones or into the other
    // mode, which starts the call wherever his hand was THEN, not where it is
    // now. The anchor has moved since (it is wherever the last note landed),
    // so placing the phrase on the anchor IS the transposition; there is no
    // need to step off his hand to find one. Rejected when it reproduces the
    // original's pitch set, i.e. he happens to be sitting where he sat before.
    const onAnchor = () => bank.pickById(v.id, this.anchor, this.lo, this.hi);
    const isNewKey = (p) => !v.placed || (((p.shift - v.placed.shift) % 12) + 12) % 12 !== 0;
    if (!picked) {
      const cand = onAnchor();
      if (cand && isNewKey(cand)) {
        picked = cand;
        how = phrase.tonalKey
          ? `now in ${keyName({ tonic: (((phrase.tonalKey.tonic + cand.shift) % 12) + 12) % 12, mode: phrase.tonalKey.mode })}`
          : `now from ${name(this.anchor)}`;
      }
    }
    if (!picked && phrase.tonalKey) {
      // Last, because it changes the melody itself. Mode-swapping can move the
      // pivot (degrees 3, 6 and 7 shift), so re-check that the call still
      // opens on the anchor rather than assuming it.
      const cand = onAnchor();
      if (cand) {
        const sounding = { tonic: (((phrase.tonalKey.tonic + cand.shift) % 12) + 12) % 12, mode: phrase.tonalKey.mode };
        const notes = modeSwap(cand.notes, sounding);
        if (notes[phrase.pivot][0] === this.anchor && notes.every((n) => n[0] >= this.lo && n[0] <= this.hi)) {
          picked = { ...cand, notes };
          how = `in the ${phrase.tonalKey.mode === 'major' ? 'minor' : 'major'} mode`;
        }
      }
    }
    if (!picked || !this.fits(picked)) return null;
    return this.serveWithPlacement('variant', picked, ` (${how})`);
  }

  /** The drill is still on the white keys: C major, wherever the hand is. */
  entryLevel() {
    return this.engine.state.tiersUnlocked < DIATONIC_TIERS;
  }

  /**
   * A new key block opens on the note you are on: that note is the tonic, and
   * the walk through the key's set starts from it. The tonic itself is never
   * asked -- it is already under the hand.
   *
   * AT THE ENTRY LEVEL THE KEY IS C MAJOR INSTEAD, so the tonic is NOT
   * necessarily the note under the hand -- and then it is one of the notes to
   * find, which is the right lesson anyway: the beginner walks to the tonic
   * by step rather than being told he is already standing on it.
   */
  openBlock() {
    const key = chooseKey(this.anchor, this.block?.key ?? null, this.entryLevel());
    this.blockN += 1;
    this.block = { key, asked: 0, n: this.blockN };
    // Below the exact stage only the stepwise sets are open (tiers 0).
    const tiers = this.stage.current === 'exact' ? this.engine.state.tiersUnlocked : 0;
    const set = primeSet(key, { tiers });
    const tonic = nearestPc(this.anchor, key.tonic, this.lo, this.hi) ?? this.anchor;
    const onIt = tonic === this.anchor;
    const left = onIt ? set.degrees.slice(1) : set.degrees.slice(); // degree 0 is the note under the hand
    this.priming = { key, tonic, set: set.name, left, step: 0, total: left.length, lastIv: 0 };
    this.log(`key block: ${keyName(key)} -- ${set.name}, ${left.length} note${left.length === 1 ? '' : 's'} to find`);
    return this.primeQuestion();
  }

  makeQuestion() {
    const engine = this.engine;
    const dyads = this.dyadsOpen(); // masteredCount() walks every interval: ask once
    const a = this.idx(this.anchor);
    const prev = this.prevAnchor === null ? null : this.idx(this.prevAnchor);
    const top = this.stage.current === 'exact';

    // The round has the floor while it runs (see roundStep).
    if (this.round) return this.roundQuestion(a, prev);

    // The window, then its correction, then the retry: estimate, hear, redo.
    if (this.window) {
      const w = this.window;
      this.window = null;
      return this.windowQuestion(w);
    }
    if (this.correction) {
      const c = this.correction;
      this.correction = null;
      return this.correctionQuestion(c);
    }
    // The chain stands in the correction's place and holds the floor until
    // the span is walked (stepChain clears it), so nothing comes between the
    // steps of one walk.
    if (this.chain) return this.chainQuestion();
    // The passage its placing dyad was served for, immediately: nothing may
    // come between the hand being placed and the call that needs it there.
    // Caleb, on the passage that followed the one he missed: "I didn't stand
    // a chance because my left hand wasn't in position." A passage he cannot
    // reach is not practice, it is a failure being recorded.
    //
    // A MISSED PLACING NO LONGER DROPS IT (2026-09-24): it PLACES THE HAND.
    // The cold attempt stays exactly as it was -- asked, graded, charged to
    // the harmonic ear -- and then the note he missed is sounded alone for
    // him to match (navigation, like the re-anchor), and the passage is
    // served. Dropping cost 11 of 23 duo passages on 09-24, nearly half the
    // session's passage slots, to a gate harder than anything his ladder had
    // opened (compound sixths; tier 4 = M3), and a miss with no answer after
    // it teaches almost nothing (Kornell, Hays & Bjork 2009; Metcalfe 2017).
    // A passage is practised whole once the hand is there (Naylor & Briggs
    // 1963). Only a missed MATCH still drops it: that one he could not reach.
    if (this.placing) {
      const p = this.placing;
      this.placing = null;
      if (!p.landed && !p.matched) {
        p.matched = true;
        this.placing = p;
        // The match IS the correction: a walk queued by the miss would land
        // after the passage, measured from a hand that has moved on.
        this.recovery = null;
        this.log(`  (placing missed: match the ${p.dyad ? 'other hand\'s note' : 'note it starts on'}, then the ${p.kind === 'retry' ? 'retry' : 'passage'})`);
        return this.placeHandQuestion(p);
      }
      if (!p.landed) {
        this.log(`  (placing missed twice: the ${p.kind === 'retry' ? 'retry' : 'passage'} is dropped -- ${p.dyad ? 'the other hand was never there' : 'the hand never got to the note it starts on'})`);
        if (p.kind === 'retry') this.retry = null; // no verdict, no try spent: as a missed re-anchor
      } else if (this.fits(p.picked)) {
        // A melodic placing MOVED the anchor onto the pivot, so the passage
        // now begins under the hand and the octave in the label is stale.
        // It may also have left a second hand still to place: ask again.
        if (!p.dyad) return this.serveWithPlacement(p.kind, { ...p.picked, octave: 0 }, p.suffix);
        const q = this.passageQuestion(p.kind, p.picked);
        if (p.suffix) q.label += p.suffix;
        return q;
      }
    }
    // THE TWO-HAND RUNG can only be asked while two hands are down: right
    // after a dyad he struck with both, before anything moves either anchor.
    if (this.chainDyad) {
      this.chainDyad = false;
      const q = this.hands ? this.twohandDyad() : null;
      if (q) return q;
    }
    // THE WALK OUT OF A HARMONIC MISS, before anything else can intervene.
    if (this.recovery) {
      const q = this.recoveryQuestion();
      if (q) return q;
    }
    // A re-anchor that was served last question: did it land? The anchor is
    // whatever he played, so landing means it equals the note we asked for.
    if (this.reanchor?.served) {
      const { target, forRetry } = this.reanchor;
      this.reanchor = null;
      if (this.anchor !== target) {
        if (forRetry) {
          // He could not find the note the retry starts on, so there is no
          // point serving it. Drop it WITHOUT a verdict: no try is spent, the
          // phrase is not rested, and its failed first asking has already set
          // it due tomorrow. That is the whole penalty.
          this.log('  (re-anchor missed: the retry is dropped, the phrase is due tomorrow)');
          this.retry = null;
        } else {
          // He did not land it. Never ask twice -- fall back to the old
          // behaviour and move the anchor, so the walk cannot run off the end.
          this.anchor = this.clampAnchor(this.anchor);
          this.log(`  (re-anchor missed: anchor brought back to ${name(this.anchor)})`);
        }
      }
    }
    if (this.reanchor) { this.reanchor.served = true; return this.reanchorQuestion(this.reanchor.target); }
    if (this.retry) {
      // Straight back, before anything else, in the SAME key and register:
      // the correction has to be adjacent to the miss to be one, and constant
      // practice until correct is what the evidence backs.
      if (this.fits(this.retry.placed)) {
        // ...but a retry's first note is FREE, so if his hand has wandered off
        // it during the attempt he just failed, it is a note to find cold at
        // the worst moment. Put him on it first. Caleb: "I'm getting lost
        // during the passage and losing track of the anchor. Then my retry is
        // corrupted by not remembering what note the passage started on."
        const pivot = this.retry.placed.notes[this.retry.placed.phrase.pivot][0];
        if (pivot !== this.anchor) {
          this.reanchor = { target: pivot, forRetry: true, served: true };
          return this.reanchorQuestion(pivot);
        }
        // ...and a duo retry gets its OTHER hand placed too, the same way a
        // first asking does: the hand keeps the anchor, and the drill asks him
        // to move rather than assuming a hand is where it is not (09-13).
        return this.serveWithPlacement('retry', this.retry.placed);
      }
      this.log('  (retry dropped: the phrase no longer fits the keyboard)');
      this.retry = null;
    }
    // A key block opens (and re-opens after a burst) with its prime, and the
    // prime keeps the floor until its walk is done.
    if (this.priming) return this.primeQuestion();
    if (!this.block || this.block.asked >= BLOCK_QUESTIONS) return this.openBlock();
    const pair = top ? engine.takeExposure() : null;
    if (pair) {
      const q = this.pairQuestion(pair);
      if (q) return q;
    }
    // The harmonic exposure is a departure and then a two-hand step in one
    // call -- the two-hand rung's shape -- so it waits for that rung.
    const dyadPair = top && dyads && this.rungState().rung >= 3 ? this.harmonic.takeExposure() : null;
    if (dyadPair) {
      const q = this.pairQuestion(dyadPair, { harmonic: true });
      if (q) return q;
    }
    while (this.remediationQueue.length > 0) {
      const raw = this.remediationQueue.shift();
      let iv = engine.inwardVariant(raw, a);
      // The plain slot's key gate does not reach here -- remediation picks its
      // own interval off the queue -- so at the entry level take whichever
      // direction lands in the key. It is usually free (both do), and when
      // neither does, the anchor itself is off the white keys because he just
      // played a wrong note; the walk gets him back either way.
      if (iv !== null && this.entryLevel() && this.block && !diatonicIn(a + iv + this.lo, this.block.key)
        && engine.feasible(a, -iv) && diatonicIn(a - iv + this.lo, this.block.key)) iv = -iv;
      if (iv !== null) {
        const target = engine.ask(iv, a, prev) + this.lo;
        return this.intervalQuestion('remediation', target);
      }
    }
    if (this.variantQueue.length > 0 && this.variantQueue[0].block < this.blockN) {
      const v = this.variantQueue.shift();
      const q = this.variantQuestion(v);
      if (q) return q;
    }
    if (this.phrases && top) {
      if ((this.streak >= STREAK_FOR_PASSAGE || this.cleanNotes >= CLEAN_NOTES_FOR_PASSAGE) && this.passagesInARow < MAX_PASSAGES_IN_A_ROW) {
        const picked = this.pickPassage();
        if (picked) return this.serveWithPlacement('passage', picked);
      }
    }
    // The echo game: every third plain question at the two lowest stages.
    //
    // IT USED TO BE EVERY QUESTION AT 'echo', AND THAT IS A DEAD END. At that
    // stage the echo game was the ONLY thing the plain slot could produce, so
    // a player who does not make something up got a silent 30-second window,
    // the "nothing played yet" skip, and then another silent window, forever:
    // from the outside the drill has simply stopped asking. (William,
    // 2026-09-15: four primes, all four exactly right, and then nothing the
    // drill would ask him.) Worse, the ordinary questions are what the STAGE
    // is read from, so a player pinned at 'echo' could never generate the
    // evidence that would lift him off it. Echo is a warm-up device, not a
    // drill. Two unfilled windows and it stops being offered this sitting:
    // a player who has nothing to make up is telling you so.
    // At the bottom rung the game is half the plain slot (a four-year-old may
    // have more to say by inventing than by answering -- Evelyn); at contour
    // it is a third. Never all of it at either: the ordinary questions are
    // what the stage is read from, so a player with no ordinary questions can
    // never climb. Which of the two kinds of player is at the bottom rung --
    // the one who fills the window and the one who has nothing to make up --
    // is settled by `echoEmpty`, not by the stage.
    const echoEvery = this.stage.current === 'echo' ? 2 : 3;
    if (this.echoEmpty < 2 && this.stage.current !== 'exact' && this.stage.current !== 'sizing'
      && this.plainQuestions % echoEvery === echoEvery - 1) {
      this.plainQuestions += 1;
      return { kind: 'echo', collect: true, notes: [], meter: 4, label: 'echo: the drill is quiet -- play two or three notes and it will ask for them back' };
    }
    this.plainQuestions += 1;
    if (dyads && top && this.plainQuestions % POLY.dyadEvery === 0) {
      if (this.harmonic.state.tiersUnlocked >= POLY.harmonicTiersForChords && this.plainQuestions % (POLY.dyadEvery * 3) === 0) {
        const q = this.chordQuestion();
        if (q) return q;
      }
      const q = this.dyadSlot(a);
      if (q) return q;
    }
    const w = this.win;
    const key = this.block.key;
    const inKey = (t) => diatonicIn(t + this.lo, key);
    const feasible = (t) => t >= this.idx(w.lo) && t <= this.idx(w.hi);
    const target = engine.nextTargetIndex(a, prev, {
      allowWide: top,
      pool: this.stage.pool ? this.stage.pool.flatMap((x) => [x, -x]) : null,
      bounds: { lo: this.idx(w.lo), hi: this.idx(w.hi) },
      // The sign lands in the key: the mirror target (same width, other way)
      // being diatonic and feasible makes this one nearly unwanted.
      lean: (t) => {
        const mirror = 2 * a - t;
        if (inKey(t)) return inKey(mirror) && feasible(mirror) ? 1 : DIATONIC_LEAN;
        return inKey(mirror) && feasible(mirror) ? CHROMATIC_SIDE : 1;
      },
      // Early on the lean is not enough: it only chooses which SIDE of the
      // anchor to land on, and from a white key in C a fifth is diatonic
      // either way, so a beginner got fifths in key and learned nothing about
      // the key. Below DIATONIC_TIERS the target must actually be in it.
      only: engine.state.tiersUnlocked < DIATONIC_TIERS ? inKey : null,
    }) + this.lo;
    if (engine.servedQueue) return this.intervalQuestion('discrimination', target);
    if (engine.lastWide) return this.intervalQuestion('interval', target, { wide: true });
    // A plain interval question is sometimes a gesture instead: the same
    // drilled interval, continued in the key. Never at the lower stages.
    if (top && Math.random() < GESTURE_RATE) return this.gestureQuestion(target);
    return this.intervalQuestion('interval', target);
  }

  // --- the round -----------------------------------------------------------

  /** Clean plain answers in a row, started promptly, open a round. */
  noteRoundStreak(q, clean, behind) {
    if (this.round || this.stage.current !== 'exact') return;
    if (this.roundCooldown > 0) this.roundCooldown -= 1;
    const plain = q.kind === 'interval' || q.kind === 'gesture' || q.kind === 'discrimination';
    if (plain && clean && behind <= 2) this.roundStreak += 1;
    else if (plain) this.roundStreak = 0;
    if (this.roundStreak >= ROUND.trigger && this.roundCooldown === 0 && !this.retry) {
      const dims = ['interval', 'tempo', 'lead'];
      this.round = { dim: dims[Math.floor(Math.random() * dims.length)], level: 0, correctRun: 0, misses: 0, calls: 0, cool: false };
      this.roundStreak = 0;
      // Nothing announces it. The next call simply does not wait for you,
      // which is the only description of a round anyone needs.
      this.log(`round on: ${this.round.dim} staircase`);
    }
  }

  roundQuestion(a, prev) {
    const r = this.round;
    const extra = r.dim === 'interval' ? r.level : 0;
    // The round pushes PAST the current level on one dimension -- that is what
    // it is for -- but the entry level's promise is the white keys, and a
    // round widening by extraTiers off a white key lands on black ones (C + 3).
    // It can widen inside the key instead; tempo and lead are untouched.
    const key = this.block?.key ?? null;
    const target = this.engine.nextTargetIndex(a, prev, {
      extraTiers: extra,
      scope: 'round',
      bounds: { lo: this.idx(this.win.lo), hi: this.idx(this.win.hi) },
      only: this.entryLevel() && key ? (t) => diatonicIn(t + this.lo, key) : null,
    }) + this.lo;
    r.calls += 1;
    const q = this.intervalQuestion('round', target);
    q.round = true;
    q.level = r.level;
    // The lead never cuts a player who answers as promptly as the trigger
    // admits: at least one beat more than the previous answer's lag.
    q.lead = Math.max(r.dim === 'lead' ? ROUND.leads[Math.min(r.level, ROUND.leads.length - 1)] : ROUND.leads[0], (this.behind ?? 1) + 1);
    q.label = `round ${r.calls}${r.cool ? ' (cool-down)' : ''}, ${r.dim} level ${r.level}: ${name(this.anchor)} -> ? (${signed(target - this.anchor)})`;
    return q;
  }

  /** 2-down/1-up: two clean in a row climb one level, a miss drops one. */
  roundStep(clean) {
    const r = this.round;
    if (r.cool) {
      this.round = null;
      this.roundCooldown = ROUND.cooldown;
      this.log(`round over: ${r.calls} calls, ${r.misses} misses, top level ${r.top ?? r.level}`);
      const runs = this.roundsStore.load() || [];
      runs.push({ ts: Date.now(), session: this.sessionId, dim: r.dim, calls: r.calls, misses: r.misses, top: r.top ?? r.level });
      this.roundsStore.save(runs.slice(-500));
      return;
    }
    r.top = Math.max(r.top ?? 0, r.level);
    if (clean) {
      r.correctRun += 1;
      if (r.correctRun >= 2) { r.level = Math.min(ROUND.maxLevel, r.level + 1); r.correctRun = 0; }
    } else {
      r.misses += 1;
      r.correctRun = 0;
      r.level = Math.max(0, r.level - 1);
    }
    if (r.calls >= ROUND.calls || r.misses >= ROUND.misses) {
      // One more call at an easy level, so the run ends on a correct model.
      r.cool = true;
      r.level = 0;
    }
  }

  beginQuestion() {
    if (this.rangeDirty) this.rebuildEngine();
    const q = this.nextQ || this.makeQuestion();
    this.nextQ = null;
    this.q = q;
    this.questions += 1;
    if (this.block && KEYED_KINDS.has(q.kind)) this.block.asked += 1; // the prime, retries, rounds, echoes and exposures are not the key's
    this.engine.beginQuestion();
    this.harmonic.beginQuestion();
    this.meter = q.meter;
    // TEMPO IS PER QUESTION, like the meter beside it: this excerpt's own,
    // decided before anything is scheduled against it. The grid restarts here
    // anyway (nextBarAt is beat 0 of this question), so the new beat governs
    // from the downbeat on; scheduledUntil follows it, and nothing further
    // ahead than this has been scheduled -- the click at nextBarAt is still
    // one tick away when the handover happens.
    this.bpm = this.questionTempo(q);
    this.beat = 60 / this.bpm;
    this.toleranceMs = toleranceMsFor(this.bpm);
    this.scheduledUntil = this.nextBarAt;
    const t0 = this.nextBarAt;
    // Voices in unison at the same onset are one key: keep one note (the
    // free anchor if it is among them).
    const sorted = q.notes.slice().sort((x, y) => x.b - y.b || x.midi - y.midi || (y.free ? 1 : 0) - (x.free ? 1 : 0));
    const notes = sorted.filter((n, i) => i === 0 || Math.abs(n.b - sorted[i - 1].b) > 1e-9 || n.midi !== sorted[i - 1].midi);
    // Each call note sounds for its written length, but never into the next
    // onset: a short articulation gap before every onset keeps a fast note
    // short and a repeated pitch a clear re-attack, so the rhythm is unambiguous.
    this.callT0 = t0; // where beat 0 of the question falls on the audio clock
    const sounded = notes.filter((n) => !n.silent);
    this.callNotes = sounded.map((n) => {
      const at = t0 + n.b * this.beat;
      let dur = Math.min(CALL_MAX_S, n.dur * this.beat);
      const next = sounded.find((m) => m.b > n.b + 1e-9);
      if (next) {
        const gap = (next.b - n.b) * this.beat;
        dur = Math.min(dur, gap - Math.max(CALL_GAP_MIN_S, CALL_GAP_FRAC * gap));
      }
      return [n.midi, at, Math.max(0.05, dur)];
    });
    this.callScheduled = 0;
    const lastCall = this.callNotes[this.callNotes.length - 1];
    this.callEndAt = lastCall ? lastCall[1] + Math.max(lastCall[2], this.beat) : t0 + (q.window ? q.window.sec : this.beat);
    this.buildGroups(notes);
    this.earliestStart = (lastCall ? this.callNotes[0][1] : t0) + this.beat; // one beat behind the call
    if (q.collect) this.earliestStart = t0; // your turn to make something up: any time
    this.responseStarted = false;
    this.gi = 0;
    this.pitchClean = true;
    this.timeClean = true;
    this.timing = { notes: 0, inTime: 0, holds: 0 };
    this.remediated = 0;
    this.answered = false;
    this.lastNoteOn = null;
    this.reattack = null; // { exp, at, until }: the missed note still open for its one catch
    this.collected = [];
    this.held = new Map(); // midi -> { rowId, onAt, durSec } for notes awaiting release
    this.awaitingFinalize = false;
    this.behind = null;
    if (q.phrase && q.kind === 'passage') this.askedThisSession.add(q.phrase.id);
    // Nothing sounds here but the call. A collect question is silence you
    // fill; a variant is the phrase you nailed in a new key, and it is the
    // new key that says so.
    if (q.round) this.nextQuestionAt = t0 + q.lead * this.beat; // the caller does not wait
    this.log(`Q${this.questions}: ${q.label} @ ${this.bpm} bpm (±${this.toleranceMs.toFixed(0)}ms)${this.block && q.kind === 'interval' ? `  [${keyName(this.block.key)}]` : ''}`);
  }

  /**
   * Onset groups, each with its expected notes and their skills: the melodic
   * interval from the previous note in the same voice (and the one before,
   * for context) and the interval above the group's bass.
   */
  buildGroups(notes) {
    const groups = [];
    for (const n of notes) {
      let g = groups[groups.length - 1];
      if (!g || Math.abs(g.b - n.b) > 1e-9) {
        g = { b: n.b, notes: [], at: null, acceptFrom: null, gapMs: null };
        groups.push(g);
      }
      g.notes.push({ midi: n.midi, dur: n.dur, voice: n.voice, free: Boolean(n.free), silent: Boolean(n.silent), harmonicRef: n.harmonicRef ?? null, from: n.from ?? null, unison: Boolean(n.unison), regime: n.regime ?? null, done: false, played: null, melodicFrom: null, melodicPrev: null, harmonicFrom: null, graded: false });
    }
    const lastInVoice = new Map(); // voice -> [prev, prevPrev] midis
    // A keyed passage is heard from the note under the hand: EVERY voice's
    // first note is framed from the anchor and graded (a duo's first bass
    // note was ungraded yet fatal). Not on a retry: there the first notes
    // are free (passageQuestion), just heard, not a new leap.
    if (this.q?.placed?.key && this.q.kind !== 'retry') {
      for (const n of notes) {
        if (!lastInVoice.has(n.voice) && !n.free) lastInVoice.set(n.voice, [this.anchor, this.prevAnchor]);
      }
    }
    // EACH HAND FROM ITS OWN ANCHOR: a voice whose first note is the note a
    // hand is already on (the placing just put it there) is a unison from that
    // hand, not a leap from the pivot hand's note -- which is what it was
    // graded as until 2026-09-20, doubly: once by the placing, once here.
    const hands = this.hands && this.q?.kind !== 'retry' ? this.hands : null;
    const seenVoice = new Set();
    // The echo ask-back's first note is found again from the playback's last
    // note (the anchor): graded, on the stage's rung, like every other.
    if (this.q?.echoOf) lastInVoice.set(0, [this.anchor, this.prevAnchor]);
    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi];
      const bass = Math.min(...g.notes.map((e) => e.midi));
      for (const e of g.notes) {
        const hist = lastInVoice.get(e.voice) || [];
        const firstOfVoice = !seenVoice.has(e.voice);
        seenVoice.add(e.voice);
        if (e.from !== null) {
          e.melodicFrom = e.from; // a dyad note: from the anchor named for it
        } else if (firstOfVoice && !e.free && hands && hands.includes(e.midi)) {
          e.melodicFrom = e.midi; // the note this hand is on: a unison from its own anchor
          e.unison = true;
        } else if (hist.length > 0) {
          e.melodicFrom = hist[0];
          e.melodicPrev = hist.length > 1 ? hist[1] : (e.free || gi > 0 ? null : this.prevAnchor);
        }
        // Normally the group's bass frames every note above it; a placing
        // dyad names its reference instead, because the note being asked
        // for is usually BELOW the anchor (the left hand).
        if (e.harmonicRef !== null) e.harmonicFrom = e.harmonicRef;
        else if (g.notes.length > 1 && e.midi !== bass) e.harmonicFrom = bass;
        // A unison is graded only where a note says so (the common tone of a
        // dyad, a hand's first note in a passage): a row, never an engine
        // width. A repeated note inside a line stays as it was -- deferred,
        // not forgotten (2026-09-18: do not move the ruler mid-measurement).
        e.graded = !e.free && ((e.melodicFrom !== null && (e.melodicFrom !== e.midi || e.unison)) || e.harmonicFrom !== null);
        lastInVoice.set(e.voice, [e.midi, hist[0] ?? null]);
      }
      g.index = gi;
    }
    // the pivot voice's first melodic context is the previous anchor
    const first = groups[0]?.notes.find((e) => e.free);
    if (first) {
      for (const g of groups.slice(1)) {
        const e = g.notes.find((x) => x.voice === first.voice && x.melodicFrom === first.midi);
        if (e && e.melodicPrev === null) e.melodicPrev = this.prevAnchor;
        if (e) break;
      }
    }
    this.groups = groups;
  }

  rebuildEngine() {
    const { lo, hi } = this.range.current;
    const newLo = Math.min(lo, this.anchor);
    const newHi = Math.max(hi, this.anchor);
    if (newLo === this.lo && newHi === this.hi) {
      this.rangeDirty = false;
      return;
    }
    for (const which of ['engine', 'harmonic']) {
      const old = this[which];
      this[which] = this.makeEngine(newLo, newHi, FLUENT_NORM_MS, which);
      this[which].adopt(old, this.lo - newLo);
    }
    this.lo = newLo;
    this.hi = newHi;
    this.rangeDirty = false;
    this.log(`engine range now ${newLo}..${newHi}`);
  }

  // --- scheduling ----------------------------------------------------------

  tick() {
    this.syncClock(0.05);
    const now = this.audio.now;
    // Silence only counts once an answer is actually possible: never during
    // the wait between questions, and never before the call has finished.
    if (!this.answered) {
      const idleSince = Math.max(this.lastInputAt, this.audioToPerf(this.callEndAt));
      if (performance.now() - idleSince > this.stage.timeoutMs) {
        // THE ECHO WINDOW IS THE ONE QUESTION WHERE THE DRILL HAS PLAYED
        // NOTHING, so silence there means "I have not thought of anything
        // yet", not "I have gone away" -- and a player thinking about what to
        // make up is doing the task, not failing to. It moves on instead of
        // ending the session; the ordinary question that follows ends it in
        // the usual way if the player really has left. (William, 2026-09-11:
        // four windows, two figures -- and both of the other two ended his
        // session, which is the whole of what was wrong here.)
        if (this.q.collect && this.collected.length === 0) {
          this.echoEmpty += 1;
          this.log(`  nothing played yet: moving on${this.echoEmpty >= 2 ? ' (and the echo game is done for this sitting)' : ''}`);
          this.lastPlayedAt = now;
          this.completeQuestion();
        } else {
          this.endSession(`${Math.round(this.stage.timeoutMs / 1000)}s of silence`);
          return;
        }
      }
    }
    const horizon = now + SCHEDULE_AHEAD_S;
    while (this.scheduledUntil < horizon) {
      const beatIndex = Math.round((this.scheduledUntil - this.nextBarAt) / this.beat);
      const beatTime = this.nextBarAt + beatIndex * this.beat;
      // THE PULSE DROPS FOR THE WINDOW. The grid keeps counting underneath
      // (scheduledUntil still advances) so nothing has to be restarted; the
      // clicks simply are not played, and the next question sets its own
      // downbeat anyway.
      if (beatTime >= now && beatTime < horizon && !this.q.window) {
        const inBar = ((beatIndex % this.meter) + this.meter) % this.meter;
        this.audio.click(beatTime, { accent: inBar === 0 });
      }
      this.scheduledUntil = beatTime + this.beat;
    }
    while (this.callScheduled < this.callNotes.length && this.callNotes[this.callScheduled][1] < horizon) {
      const [midi, at, duration] = this.callNotes[this.callScheduled];
      // A note whose time has already passed (the event loop stalled past the
      // lookahead) plays now, bunched against its neighbour; say so in the log.
      if (at < now - 0.005) this.log(`  call note ${this.callScheduled + 1} late by ${Math.round((now - at) * 1000)}ms`);
      this.audio.note(midi, { at: Math.max(at, now), velocity: 90, duration });
      this.callScheduled += 1;
    }
    if (!this.answered) {
      const q = this.q;
      if (q.window && now >= this.callT0 + q.window.sec) {
        this.closeWindow(q.window);
        this.completeQuestion();
      } else if (q.window) {
        // still open: the silence is the question
      } else if (q.collect) {
        this.collectTick(now);
      } else if (q.round && now >= this.nextQuestionAt + this.toleranceMs / 1000) {
        // The caller does not wait: whatever is left of this answer is missed
        // (a note inside tolerance of the next downbeat is still this answer).
        this.abandonResponse({ quiet: true });
      } else if (this.responseStarted && this.keysDown.size === 0) {
        // A beat of silence once the pending group's time has come means you
        // are done, whatever is left: the rest is missed and the reply comes.
        const g = this.groups[this.gi];
        const quietSince = Math.max(this.lastPlayedAt ?? -Infinity, this.lastReleasedAt ?? -Infinity, g.at);
        const quiet = QUIET_BEATS[q.kind] ?? QUIET_BEATS_BEFORE_NEXT;
        const wait = Math.max(quiet * this.beat, MIN_QUIET_S);
        if (now >= quietSince + wait - this.toleranceMs / 1000) this.abandonResponse({ waited: quiet });
      }
    }
    if (this.answered) {
      // The reply comes as soon as you have been silent for a beat: no key
      // down, nothing pressed or released for QUIET_BEATS_BEFORE_NEXT beats.
      // The next call starts on the first click after that. The pulse itself
      // never moves; only the bar's accent pattern restarts there.
      if (this.q.round) {
        // fixed lead, set in beginQuestion: never renegotiated by silence
      } else if (this.keysDown.size === 0) {
        const quietSince = Math.max(this.lastPlayedAt ?? -Infinity, this.lastReleasedAt ?? -Infinity);
        // A release within the timing tolerance after a click counts as on it.
        const earliest = Math.max(quietSince - this.toleranceMs / 1000 + Math.max(QUIET_BEATS_BEFORE_NEXT * this.beat, MIN_QUIET_S), now);
        const n = Math.ceil((earliest - this.nextBarAt) / this.beat - 1e-6);
        this.nextQuestionAt = this.nextBarAt + n * this.beat;
      } else {
        this.nextQuestionAt = Infinity;
      }
      if (now >= this.nextQuestionAt - SCHEDULE_AHEAD_S) {
        if (this.awaitingFinalize) this.finalizeQuestion();
        // A round abandons an unfinished answer just past its lead: the next
        // call then goes on the next grid beat, never at a time already gone
        // (the pulse is constant, so one beat later is still clean).
        while (this.nextQuestionAt < now) this.nextQuestionAt += this.beat;
        this.nextBarAt = this.nextQuestionAt;
        this.beginQuestion();
      }
    }
  }

  // --- the echo game -------------------------------------------------------

  /** Your two or three notes are in once a beat of silence follows them (or four notes). */
  collectTick(now) {
    const c = this.collected;
    if (c.length === 0) return;
    const quiet = this.keysDown.size === 0 && now >= Math.max(this.lastPlayedAt, this.lastReleasedAt ?? 0) + this.beat;
    if (c.length < 4 && !quiet) return;
    if (c.length < 2) { this.collected = []; return; } // one note is not a figure: keep waiting
    const first = c[0].at;
    const notes = c.map((n, i) => {
      const b = Math.max(i, Math.round((n.at - first) / this.beat));
      return { midi: n.midi, b, dur: 1, voice: 0 };
    });
    for (let i = 1; i < notes.length; i += 1) if (notes[i].b <= notes[i - 1].b) notes[i].b = notes[i - 1].b + 1;
    // Their own figure comes straight back AS THE CALL: hearing it and being
    // asked for it are one question, because the drill never plays anything
    // it is not asking for. Every note is graded, the first included (it is
    // their note, not the anchor under the hand).
    this.echoEmpty = 0;
    this.log(`  your figure: ${notes.map((n) => name(n.midi)).join(' ')}`);
    this.nextQ = { kind: 'echo', echoOf: true, notes: notes.map((n) => ({ ...n })), meter: 4, label: `echo: now you: ${notes.map((n) => name(n.midi)).join(' ')}` };
    this.lastPlayedAt = now;
    this.completeQuestion();
  }

  // --- grading -------------------------------------------------------------

  /** Does this key press match an expected note? The free pivot also accepts
   *  the anchor itself when the phrase sits an octave away. */
  matches(e, note) {
    return note === e.midi || (e.free && Boolean(this.q.octave) && note === this.anchor);
  }

  /**
   * Your first note starts the response. It belongs to the first group or,
   * when the first group is only the free anchor, to the second (you may
   * skip the note you already know). It snaps to a whole number of beats
   * (>= 1) behind the call; every group is then expected relative to it.
   */
  startResponse(note, atAudio) {
    const g = this.groups;
    let j = 0;
    // A first note that is not the free anchor belongs to the second group
    // when it matches it, when the anchor was never sounded, or when the
    // question says its anchor is optional (interval kinds: the anchor is the
    // note you just played, so a wrong first note is a wrong target).
    if (g.length > 1 && g[0].notes.every((e) => e.free) && !g[0].notes.some((e) => this.matches(e, note)) &&
        (g[1].notes.some((e) => !e.free && this.matches(e, note)) || g[0].notes.every((e) => e.silent) || this.q.optionalAnchor)) {
      j = 1;
      for (const e of g[0].notes) e.done = true;
    }
    const callAt = this.callT0 + g[j].b * this.beat; // when the call sounded (or would have) this group
    const behind = Math.max(1, Math.round((atAudio - callAt) / this.beat));
    const T = callAt + behind * this.beat;
    for (const grp of g) grp.at = T + (grp.b - g[j].b) * this.beat;
    let prevAt = T - this.beat; // the first group's own window is +/- half a beat
    for (let k = j; k < g.length; k += 1) {
      const gap = g[k].at - prevAt;
      g[k].gapMs = gap * 1000;
      g[k].acceptFrom = g[k].at - Math.min(this.beat / 2, gap / 2);
      prevAt = g[k].at;
    }
    this.gi = j;
    this.behind = behind;
    this.responseStarted = true;
    this.log(`  response started ${behind} beat${behind === 1 ? '' : 's'} behind${j === 1 ? ' (skipping the anchor)' : ''}`);
  }

  /** A key was released: grade how long the matching note was held. */
  onNoteOff({ note, at }) {
    this.audio.stopVoice(note); // always release the sound, even when not grading
    this.keysDown.delete(note);
    this.lastReleasedAt = this.perfToAudio(at);
    if (this.state !== 'QUESTION') return;
    const h = this.held.get(note);
    if (!h) return;
    this.held.delete(note);
    this.gradeHold(h, this.perfToAudio(at));
    if (this.awaitingFinalize && this.held.size === 0) this.finalizeQuestion();
  }

  gradeHold(h, offAtAudio, stillHeld = false) {
    const heldSec = Math.max(0, offAtAudio - h.onAt);
    // Too short is judged against what the call actually sounded (capped);
    // too long against the written value, so a long final note is never
    // penalized for being held as written.
    const shortMin = DUR_SHORT_FRAC * h.heardSec;
    const longMax = DUR_LONG_FRAC * h.durSec + DUR_LONG_PAD_S;
    const ok = heldSec >= shortMin && (stillHeld || heldSec <= longMax);
    this.db.updateHeld(h.rowId, heldSec * 1000, ok);
    if (!ok) {
      this.timeClean = false;
      this.timing.holds += 1;
      this.log(`  hold ${heldSec < shortMin ? 'short' : 'long'} ${(heldSec * 1000).toFixed(0)}ms (want ~${(h.heardSec * 1000).toFixed(0)}ms)`);
    }
  }

  handleAnswer(note, velocity, atAudio) {
    if (this.answered) return; // between questions: free play
    const q = this.q;
    if (q.window) {
      if (atAudio >= this.callT0) q.window.pressed.push(note); // before it opened: a stray key
      return;
    }
    if (q.collect) { this.collected.push({ midi: note, at: atAudio }); return; }
    if (!this.responseStarted) {
      if (atAudio < this.earliestStart - this.beat / 2) return; // still the call: free
      this.startResponse(note, atAudio);
    }
    // ONE RE-ATTACK. You missed a note and went back for it before the next
    // one was due. That is the amateur recovery -- the professional one is to
    // say nothing and get back onto the line further down (`recovered` in
    // src/rungs.js) -- and it is the one that proves you HEARD the mistake.
    // Before this, the press was thrown away unread: it arrives ahead of the
    // next group's window, and the line below dropped it.
    //
    // It is graded as a catch, not as a note: the miss stands (a passage
    // still fails on exact pitch, first try) and the grid does not move. You
    // get exactly ONE -- the next press closes the window whatever it is, so
    // hunting through four pitches is searching, not catching.
    const re = this.reattack;
    if (re) {
      this.reattack = null;
      if (note === re.exp.midi && atAudio < re.until && !this.dueNow(note, atAudio)) {
        re.exp.selfCorrected = true;
        if (re.exp.rowId) this.db.selfCorrected(re.exp.rowId);
        this.log(`  caught it: ${name(note)}, ${Math.round((atAudio - re.at) * 1000)}ms later`);
        return;
      }
    }
    let g = this.groups[this.gi];
    if (atAudio < g.acceptFrom) return; // ahead of this group's slot: free
    // Ignore an exact double-trigger of the same key (hardware bounce, or a
    // controller that sends on two ports at once).
    if (this.lastNoteOn && note === this.lastNoteOn.midi && atAudio - this.lastNoteOn.at < DEBOUNCE_S) {
      this.lastNoteOn = { midi: note, at: atAudio };
      return;
    }
    this.lastNoteOn = { midi: note, at: atAudio };

    const pending = (grp) => grp.notes.filter((e) => !e.done);
    let exp = pending(g).find((e) => this.matches(e, note));
    if (!exp) {
      // Moving on to the next group abandons what is left of this one.
      const next = this.groups[this.gi + 1];
      if (next && atAudio >= next.acceptFrom && pending(next).some((e) => !e.free && this.matches(e, note))) {
        for (const e of pending(g)) if (!e.free) this.gradeNote(g, e, note, velocity, null, false, { abandoned: true });
        for (const e of g.notes) e.done = true;
        this.closeGroup(g);
        this.gi += 1;
        g = next;
        exp = pending(g).find((e) => this.matches(e, note));
      }
    }
    let correct = true;
    if (!exp) {
      // Wrong note: it consumes the nearest pending GRADED note of the group.
      // When only free notes are pending (the pivot, a retry's first notes),
      // it consumes nothing: free means free, never fatal. The right note may
      // still follow, or the next group may simply begin.
      let cands = pending(g).filter((e) => !e.free);
      if (cands.length === 0) {
        // One fumble is free; a second wrong press on the same free notes
        // means the player has moved on: the free notes are skipped and this
        // press is graded against the next group (a transposed shape must
        // not be swallowed press after press).
        g.fumbles = (g.fumbles || 0) + 1;
        if (g.fumbles === 1 || !this.groups[this.gi + 1]) {
          this.log(`  (${name(note)} on a free note: ignored)`);
          return;
        }
        for (const e of g.notes) e.done = true;
        this.closeGroup(g);
        this.gi += 1;
        g = this.groups[this.gi];
        exp = pending(g).find((e) => this.matches(e, note));
        if (exp) { correct = true; } else {
          cands = pending(g).filter((e) => !e.free);
          if (cands.length === 0) { this.log(`  (${name(note)} on a free note: ignored)`); return; }
        }
      }
      if (!exp) {
        exp = cands.reduce((best, e) => (Math.abs(e.midi - note) < Math.abs(best.midi - note) ? e : best), cands[0]);
        correct = false;
      }
    }
    this.gradeNote(g, exp, note, velocity, atAudio, correct);
    exp.done = true;
    exp.played = note;
    if (pending(g).every((e) => e.free)) {
      for (const e of g.notes) e.done = true;
      this.closeGroup(g);
      this.gi += 1;
      if (this.gi >= this.groups.length) this.completeQuestion(atAudio);
    }
    // A missed note stays open for one re-attack, until the next note is
    // actually due (its onset, not its accept window: a player who stops to
    // fix something is behind by then, and that is the whole point).
    if (!correct && exp.graded && !this.answered) {
      const next = this.groups[this.gi];
      this.reattack = { exp, at: atAudio, until: next && next.at !== null ? next.at : atAudio + this.beat };
    } else {
      this.reattack = null;
    }
  }

  /** Is this pitch a pending note of the group that is accepting right now?
   *  Then it is that note, played on time, not a catch of the last one. */
  dueNow(note, atAudio) {
    const g = this.groups[this.gi];
    return Boolean(g && g.acceptFrom !== null && atAudio >= g.acceptFrom
      && g.notes.some((e) => !e.done && !e.free && e.midi === note));
  }

  /** Is this an isolated interval answer (the stage's business)? */
  isolatedKind(q = this.q) {
    return ['interval', 'discrimination', 'remediation', 'round'].includes(q.kind) || q.echoOf;
  }

  /**
   * ONE attempt per note, on pitch AND timing (against its group's onset).
   * Each of the note's skills is reported to its engine. `atAudio` null =
   * the note was never played (its group was abandoned).
   */
  gradeNote(g, exp, note, velocity, atAudio, correct, { abandoned = false } = {}) {
    const q = this.q;
    const onsetMs = atAudio === null ? null : (atAudio - g.at) * 1000;
    const tol = Math.min(this.toleranceMs, 0.4 * g.gapMs);
    const inTime = correct && onsetMs !== null && Math.abs(onsetMs) <= tol;
    // A gesture, a variant, the block's prime and a pair exposure are scored
    // like a passage for engine evidence: heard in context, they inform the
    // engine at passage scope but never
    // moves the interval tier ladder, which only clean isolated probes own.
    const passage = Boolean(q.phrase) || Boolean(q.gesture) || Boolean(q.prime) || Boolean(q.exposure) || Boolean(q.correction) || Boolean(q.recovery);
    const round = Boolean(q.round);
    const rtNorm = inTime ? Math.min(Math.abs(onsetMs), this.beat * 1000) / this.beat : null;
    const from = exp.melodicFrom ?? exp.harmonicFrom ?? this.anchor;
    // The stage's credit: what this note counts as for the engine and the
    // streak. At the top it is the note itself; below, direction or size.
    const isolated = this.isolatedKind(q);
    const played = atAudio === null ? null : note;
    let credit = correct;
    let heightErr = false;
    // The prime is credited on the stage's rung even though it is not an
    // isolated probe: below the exact stage it is the only thing the drill
    // asks for that a passage would otherwise cover, and a beginner who
    // arpeggiates in the right direction has done what he was asked. It
    // still never moves the ladder or the stage (see `isolated` below).
    if ((isolated || q.prime || q.recovery) && exp.melodicFrom !== null) {
      credit = this.stage.credit(exp.melodicFrom, exp.midi, played);
      // A compound ask: the interval skill is judged on pitch class, the
      // octave on its own.
      if (q.wide && !correct && played !== null && Math.abs(played - exp.midi) === 12) { heightErr = true; credit = true; }
    }
    // A PAIR QUESTION (a dyad, a placing, the harmonic exposure) is judged
    // when its group closes (judgeSonority): two notes carry two degrees of
    // freedom and a wrong one is charged to ONE ear, never both. Here only
    // the row is written.
    if (exp.graded && !q.navigation && !q.pair) {
      if (exp.melodicFrom !== null && exp.melodicFrom !== exp.midi) {
        const raw = exp.midi - exp.melodicFrom;
        const iv = q.wide || Math.abs(raw) > 12 ? simpleOf(raw) : raw; // the ladder knows simple intervals only
        const prev = exp.melodicPrev;
        if (passage) this.engine.ask(iv, this.idx(exp.melodicFrom), prev === null ? null : this.idx(prev), { scope: 'passage' });
        if (!credit) {
          this.engine.reportMiss(this.idx(exp.melodicFrom), played === null ? this.idx(exp.melodicFrom) : this.idx(note), { confuse: !round });
          if (passage && !q.correction && Math.abs(iv) >= 3 && this.remediated < REMEDIATE_MAX_PER_PASSAGE &&
              this.engine.predictedAcc(iv, this.idx(exp.melodicFrom)) < 0.8) {
            this.remediationQueue.push(simpleOf(iv));
            this.remediated += 1;
          }
        }
        this.engine.reportResolved(rtNorm);
        if (q.wide && (correct || heightErr)) this.engine.reportHeight(!heightErr);
      }
      if (exp.harmonicFrom !== null) {
        // By SIZE: a placing dyad's note sits below its reference, and a
        // sixth is a sixth whichever of the two you were already holding.
        const iv = simpleOf(Math.abs(exp.midi - exp.harmonicFrom)); // the ladder knows simple intervals only
        const dyad = Boolean(q.dyad) && !q.chord && !q.placing && !q.recovery; // a dyad was framed by nextTargetIndex; chord, placing and recovery tones are framed here
        if (!dyad) this.harmonic.ask(iv, this.idx(exp.harmonicFrom), null, { scope: 'passage' });
        if (!correct) {
          this.harmonic.reportMiss(this.idx(exp.harmonicFrom), played === null ? this.idx(exp.harmonicFrom) : this.idx(note), { confuse: dyad });
          this.queueRecovery(exp.harmonicFrom, exp.midi);
        }
        this.harmonic.reportResolved(rtNorm);
      }
    }
    // The stage sees plain answers only: never a round (its pressure must not
    // decide the grading rung), whatever isolatedKind says for the credit path.
    if (isolated && !round && exp.graded && exp.melodicFrom !== null) {
      if (this.stage.observe(exp.melodicFrom, exp.midi, played)) this.stageMoved();
    }
    const rowId = this.db.attempt({
      sessionId: this.sessionId, anchor: from, target: exp.midi, played: note, velocity, correct,
      firstAttempt: true, onsetMs, question: this.questions, kind: q.kind,
      phraseId: q.phrase?.id ?? null, position: g.index, graded: exp.graded, inTime, beatMs: this.beat * 1000,
      credit: isolated || q.prime ? credit : null, stage: isolated || q.prime ? this.stage.current : null, heightErr: q.wide ? heightErr : null,
      voice: exp.voice ?? null, behind: this.behind,
      key: this.block ? keyName(this.block.key) : null,
      regime: exp.regime ?? q.regime ?? null, containsAnchor: q.pair ? exp.unison : null,
    });
    exp.rowId = rowId; // so a re-attack can mark this note caught
    // Remember this key press so its release can be graded for duration.
    if (exp.graded && correct) {
      const durSec = exp.dur * this.beat;
      this.held.set(note, { rowId, onAt: atAudio, durSec, heardSec: Math.min(durSec, CALL_MAX_S) });
    }
    if (exp.graded && atAudio !== null) {
      this.timing.notes += 1;
      if (inTime) this.timing.inTime += 1;
    }
    if (q.correction) { /* handed to you: neither earns nor spends the passage credit */ }
    else if (credit && exp.graded) this.cleanNotes += 1;
    else if (!credit) this.cleanNotes = 0;
    if (!credit) this.pitchClean = false;
    if (!inTime) this.timeClean = false;
    const chord = g.notes.length > 1 ? ` [chord ${g.index + 1}]` : '';
    if (abandoned) {
      this.log(`  missed ${name(exp.midi)}${chord}`);
      return;
    }
    const why = correct ? '' : ` (${exp.unison ? 'the note you were on' : exp.melodicFrom !== null ? signed(exp.midi - exp.melodicFrom) : exp.harmonicFrom !== null ? `+${exp.midi - exp.harmonicFrom} above bass` : 'anchor'})`;
    const mark = correct ? 'correct' : credit ? `~ ${name(note)} wanted` : `x ${name(note)} wanted`;
    const creditNote = !correct && credit ? (heightErr ? ' -- right note, wrong octave' : this.stage.current === 'contour' || this.stage.current === 'echo' ? ' -- right direction' : ' -- close') : '';
    this.log(
      `  ${mark} ${name(exp.midi)}${why}${chord}, onset ${onsetMs >= 0 ? '+' : ''}${onsetMs.toFixed(0)}ms${correct && !inTime ? (onsetMs < 0 ? ' EARLY' : ' LATE') : ''}${creditNote}`,
    );
  }

  /** A group is done, however it ended: judge a pair, or record one. */
  closeGroup(g) {
    if (g.closed) return;
    g.closed = true;
    const notes = g.notes.filter((e) => !e.silent);
    if (notes.length !== 2) return;
    if (this.q.pair) this.judgeSonority(g, notes);
    else if (this.q.phrase) this.recordSonority(g, notes);
  }

  /**
   * TWO NOTES, TWO DEGREES OF FREEDOM, ONE CHARGE PER WRONG NOTE. The pair he
   * PLAYED is the sonority (span_played: the interval between his two notes,
   * whatever was asked of either); the harmonic verdict is on that, folded
   * to the simple interval. A wrong note is debited to whichever ear
   * predicted it worse -- the melodic engine's estimate for the departure
   * that note was asked to make, or the harmonic engine's for the span --
   * and the other ear gets no trial for it. When both predicted it fine
   * (>= DYAD_RUNG.high) it is a PROGRESSION miss: recorded, charged to
   * nothing, the voice-leading object that harmonic-motion scoring will be
   * designed from. A common tone that was not struck is the question's miss
   * and no ear's: a row.
   *
   * The convergence data is what rules out "harmonic reported, never
   * charged": arriving on an octave is made of steps he plays at 80% in
   * isolation and fails 60-86% of the time. Under that rule the harmonic
   * ladder would never learn his worst event.
   *
   * The recovery walk follows the charge: a harmonic miss walks; a melodic
   * one does not (the melodic remediation queue stays closed to dyads).
   */
  judgeSonority(g, notes) {
    const q = this.q;
    const [lo, hi] = notes[0].midi < notes[1].midi ? notes : [notes[1], notes[0]];
    const regime = lo.regime ?? q.regime ?? 'departure';
    const melodicScope = regime === 'twohand' ? 'twohand' : 'departure';
    const plain = q.kind === 'dyad' || q.kind === 'dyad discrimination';
    const harmonicScope = plain ? 'interval' : 'passage'; // only the slot's own dyads move the span ladder
    const spanExpected = hi.midi - lo.midi;
    const both = lo.played !== null && hi.played !== null;
    const spanPlayed = both ? Math.abs(hi.played - lo.played) : null;
    const harmonicOk = both && simpleOf(spanPlayed) === simpleOf(spanExpected);
    const ok = (e) => e.played === e.midi;
    const hAcc = this.harmonic.predictedAcc(simpleOf(spanExpected), this.idx(lo.midi), null);
    const mAcc = (e) => (e.unison || e.melodicFrom === null ? null : this.engine.predictedAcc(simpleOf(e.midi - e.melodicFrom), this.idx(e.melodicFrom), null));
    const trial = (e) => {
      // one melodic trial for this note at the rung's scope: asked, missed or not, resolved
      const iv = simpleOf(e.midi - e.melodicFrom);
      this.engine.ask(iv, this.idx(e.melodicFrom), null, { scope: melodicScope });
      if (!ok(e)) this.engine.reportMiss(this.idx(e.melodicFrom), e.played === null ? this.idx(e.melodicFrom) : this.idx(e.played), { confuse: true });
      this.engine.reportResolved(null);
    };
    let charged = null;
    let harmonicMiss = null; // { from, missed }
    for (const e of [lo, hi]) {
      if (ok(e)) { if (!e.unison) trial(e); continue; }
      if (e.unison) { charged = charged ?? 'unison'; continue; } // the note he was on, not struck: no ear
      const m = mAcc(e);
      const other = e === lo ? hi : lo;
      if (m !== null && m >= DYAD_RUNG.high && hAcc >= DYAD_RUNG.high) { charged = 'progression'; continue; }
      // The pair he played IS the pair that was asked (a semitone below asked,
      // a semitone above played: same sonority, wrong side of the anchor):
      // the harmonic ear cannot be the culprit, whatever it predicted. That is
      // a departure error and it is the melodic ear's. (2026-09-20, session
      // 269 Q11: charged harmonic because the restarted harmonic engine still
      // predicted 0.5 for everything.)
      if (m !== null && (harmonicOk || m < hAcc)) { trial(e); charged = charged === 'harmonic' ? 'harmonic' : 'melodic'; continue; }
      charged = 'harmonic';
      harmonicMiss = harmonicMiss ?? { from: other.midi, missed: e.midi };
    }
    if (harmonicMiss) {
      this.harmonic.ask(simpleOf(spanExpected), this.idx(lo.midi), null, { scope: harmonicScope });
      this.harmonic.reportMiss(this.idx(lo.midi), this.idx(lo.midi) + (spanPlayed ?? 0), { confuse: spanPlayed !== null });
      this.harmonic.reportResolved(null);
      this.queueRecovery(harmonicMiss.from, harmonicMiss.missed);
    } else if (ok(lo) && ok(hi)) {
      this.harmonic.ask(simpleOf(spanExpected), this.idx(lo.midi), null, { scope: harmonicScope });
      this.harmonic.reportResolved(null);
    }
    // The rung controller reads the slot's own dyads, per retrieval, never the unison.
    if (plain) for (const e of [lo, hi]) if (!e.unison) this.noteRungRetrieval(regime === 'twohand' ? 3 : q.contains ? 1 : 2, ok(e));
    const prev = this.prevSonority && (this.prevSonority.question === this.questions || (this.prevSonority.question === this.questions - 1 && q.dyad)) ? this.prevSonority : null;
    this.db.sonority({
      sessionId: this.sessionId, question: this.questions, kind: q.kind, regime, position: g.index,
      loExpected: lo.midi, hiExpected: hi.midi, loPlayed: lo.played, hiPlayed: hi.played, loFrom: lo.melodicFrom, hiFrom: hi.melodicFrom,
      loOk: ok(lo), hiOk: ok(hi), spanExpected, spanPlayed, harmonicOk, containsAnchor: lo.unison || hi.unison, charged,
      melodicAccLo: mAcc(lo), melodicAccHi: mAcc(hi), harmonicAcc: hAcc,
      prevSpanExpected: prev?.spanExpected ?? null, prevSpanPlayed: prev?.spanPlayed ?? null,
      key: this.block ? keyName(this.block.key) : null,
    });
    this.prevSonority = { question: this.questions, spanExpected, spanPlayed };
    const heard = harmonicOk ? 'heard' : spanPlayed === null ? 'one note only' : `played as a ${intervalName(spanPlayed)}`;
    const ear = charged === null ? '' : charged === 'progression' ? ' -- neither ear predicts it: a progression miss, recorded' : charged === 'unison' ? ' -- the common tone was not played' : ` -- charged to the ${charged} ear`;
    this.log(`  sonority: ${intervalName(spanExpected)} ${heard}${ear}`);
  }

  /** A two-note group inside a passage: recorded as a pair, charged to nothing here (the notes were). */
  recordSonority(g, notes) {
    const q = this.q;
    const [lo, hi] = notes[0].midi < notes[1].midi ? notes : [notes[1], notes[0]];
    const spanExpected = hi.midi - lo.midi;
    const both = lo.played !== null && hi.played !== null;
    const spanPlayed = both ? Math.abs(hi.played - lo.played) : null;
    const prev = this.prevSonority?.question === this.questions ? this.prevSonority : null;
    this.db.sonority({
      sessionId: this.sessionId, question: this.questions, kind: q.kind, regime: 'passage', position: g.index,
      loExpected: lo.midi, hiExpected: hi.midi, loPlayed: lo.played, hiPlayed: hi.played, loFrom: lo.melodicFrom, hiFrom: hi.melodicFrom,
      loOk: lo.free ? null : lo.played === lo.midi, hiOk: hi.free ? null : hi.played === hi.midi,
      spanExpected, spanPlayed, harmonicOk: both ? simpleOf(spanPlayed) === simpleOf(spanExpected) : null,
      containsAnchor: lo.unison || hi.unison, charged: null,
      prevSpanExpected: prev?.spanExpected ?? null, prevSpanPlayed: prev?.spanPlayed ?? null,
      key: this.block ? keyName(this.block.key) : null,
    });
    this.prevSonority = { question: this.questions, spanExpected, spanPlayed };
  }

  stageMoved() {
    const s = this.stage.current;
    this.stageStore.save({ name: s, at: Date.now() });
    // Unannounced: what changes is what you are asked for, and that is heard.
    this.log(`stage: now graded on ${s === 'exact' ? 'the exact note' : s === 'sizing' ? 'size (within two semitones)' : s === 'contour' ? 'direction' : 'the echo game'}`);
  }

  /** You stopped before the end: every note still pending is a miss. */
  abandonResponse({ quiet = false, waited = QUIET_BEATS_BEFORE_NEXT } = {}) {
    let missed = 0;
    const last = this.lastNoteOn?.midi ?? this.anchor;
    for (let gi = this.gi; gi < this.groups.length; gi += 1) {
      const g = this.groups[gi];
      if (g.at === null) g.at = this.callT0 + (g.b + 1) * this.beat; // never started: as if one beat behind
      for (const e of g.notes) {
        if (e.done) continue;
        if (!e.free) {
          this.gradeNote(g, e, last, 0, null, false, { abandoned: true });
          missed += 1;
        }
        e.done = true;
      }
      this.closeGroup(g);
    }
    this.gi = this.groups.length;
    if (missed > 0) this.pitchClean = false;
    if (!quiet || missed > 0) this.log(`  response ended${quiet ? '' : ` after ${waited === 1 ? 'a beat' : `${waited} beats`} of silence`}: ${missed} note${missed === 1 ? '' : 's'} missed`);
    this.completeQuestion();
  }

  /** All groups played. Mark the response done; grade releases and choose the
   *  next question at finalize (so a note still held now is still graded). */
  completeQuestion() {
    this.answered = true;
    this.awaitingFinalize = true;
    // The conversation continues from where your hands actually are: the
    // highest note you PLAYED in the last group, right or wrong (the written
    // note only if you played nothing there).
    const n = this.groups.length;
    // ONLY NOTES HE PLAYED. The top of a group used to fall back to the
    // WRITTEN notes when he played none of them, so an unanswered question
    // moved the anchor onto the note he had been asked for and never touched,
    // and the next call was measured from it while his hand was still where it
    // had been. 42 questions in his history (15 after the 09-13 ruling below),
    // 52% right against 77% -- it is what wrecked the round of 2026-09-24
    // (two calls in a row from notes he never played, 5 of 6 missed). Caleb:
    // "I've been chasing that for weeks but was always too disoriented to
    // reason about it in the moment."
    const top = (grp) => Math.max(...grp.notes.filter((e) => e.played !== null).map((e) => e.played));
    const reached = this.groups.filter((g) => g.notes.some((e) => e.played !== null));
    // TWO HANDS DOWN: a dyad he struck with both notes leaves two anchors,
    // what he played, lower and upper. Anything else leaves one.
    if (n > 0) {
      const struck = this.groups[n - 1].notes.filter((e) => !e.silent && e.played !== null).map((e) => e.played);
      this.hands = this.q.dyad && !this.q.chord && struck.length === 2 ? [Math.min(...struck), Math.max(...struck)] : null;
    }
    // Nothing played at all: the hand has not moved, and neither does the anchor.
    if (reached.length > 0 && !this.q.keepAnchor) {
      const k = reached.length;
      this.prevAnchor = k >= 2 ? top(reached[k - 2]) : this.anchor;
      // THE ANCHOR IS THE NOTE UNDER THE HAND. It used to be clamped into the
      // stage's window here, which kept target selection in range and quietly
      // broke that: the call would then be built from a note he was not on,
      // his attempt to start where his hand actually was got eaten by the
      // free-note rule, and he was graded from a note he never found
      // (2026-09-13, anchor pulled to B5 with his hand on F#6, and the next
      // passage opened on B5 -- correctly placed, still lost). Now the hand
      // keeps the anchor and the drill ASKS him to move, which is the only
      // thing that actually puts him there.
      const hand = top(reached[k - 1]);
      const inWindow = this.clampAnchor(hand);
      this.anchor = hand;
      if (inWindow !== hand) this.reanchor = { target: inWindow, forRetry: false, served: false };
    }
    // When the next question starts is decided in tick(): a beat of silence
    // (a round's is fixed and already set).
    if (!this.q.round) this.nextQuestionAt = Infinity;
    if (this.held.size === 0) this.finalizeQuestion();
  }

  /** Record the outcome (now that releases are in) and choose the next
   *  question. Runs when the last note is released, else just before the
   *  next question begins. Kept off the click path so the phrase pick can't
   *  delay a click. */
  finalizeQuestion() {
    if (!this.awaitingFinalize) return;
    this.awaitingFinalize = false;
    const now = this.audio.now;
    for (const [, h] of this.held) this.gradeHold(h, now, true); // still held: never "too long"
    this.held.clear();
    const q = this.q;
    if (q.collect || q.window) {
      if (!this.nextQ) this.nextQ = this.makeQuestion();
      return;
    }
    const clean = this.pitchClean && this.timeClean;
    // A correction is notes you were just handed: playing them back is not a
    // clean answer, and it must not count toward earning the next passage.
    // A window has no notes at all, and neither of them breaks a run of
    // passages -- they are part of the passage that spawned them.
    // ONE MISS ANYWHERE IN THE WALK AND IT IS DROPPED: no stacking failures,
    // and the retry he never knew was coming simply does not come.
    if (q.recovery && !this.pitchClean && this.recovery) {
      this.recovery = null;
      this.log('  (recovery dropped: back to the drill)');
    }
    if (q.chain && this.chain) this.stepChain();
    // Did the hand get there? Read for EVERY placing question. It used to be
    // read only in the dyad branch below, so a melodic placing (the passage
    // starting away from the hand) never counted as landed and always
    // dropped its passage, even when he played the note.
    if (q.placing && this.placing) this.placing.landed = this.pitchClean;
    if (!q.correction) this.streak = this.pitchClean ? this.streak + 1 : 0;
    if (q.phrase) this.passagesInARow += 1;
    else if (!q.correction && !q.window) this.passagesInARow = 0;
    if (q.round) this.roundStep(this.round?.dim === 'tempo' ? clean : this.pitchClean); // time only counts when time is the game
    else this.noteRoundStreak(q, clean, this.behind ?? 99);
    if (q.phrase) {
      this.cleanNotes = 0;
      this.passagesDone += 1;
      const bank = q.phrase.kind === 'mono' ? this.phrases : this.poly;
      const rungs = summarizeRungs(
        this.groups.flatMap((g) => g.notes.map((e) => ({
          expected: e.midi, played: e.played ?? null, free: e.free || e.silent, b: g.b, voice: e.voice, selfCorrected: Boolean(e.selfCorrected),
        }))),
      );
      this.db.passage({
        sessionId: this.sessionId, question: this.questions, phraseId: q.phrase.id, kind: q.phrase.kind, qkind: q.kind,
        bpm: this.bpm, clean, pitchClean: this.pitchClean, ...rungs,
      });
      const timing = this.timing.notes ? `; timing ${this.timing.inTime}/${this.timing.notes} in time${this.timing.holds ? `, ${this.timing.holds} hold${this.timing.holds === 1 ? '' : 's'} off` : ''}` : '';
      if (q.kind === 'variant') {
        // Practice, not a test: nothing moves but the engines' passage cells.
        this.log(`  variant ${this.pitchClean ? 'clean' : 'with errors'}${this.pitchClean ? '' : ` -- ${describeRungs(rungs)}`}${timing}`);
      } else {
        // A RETRY DRIVES THE CORRECTIVE LOOP AND NOTHING ELSE. It is the
        // phrase you just heard, handed back to you seconds later, so getting
        // it right is not evidence that you learned anything -- and it used
        // to be counted as exactly that: a clean retry overwrote the failure's
        // "due tomorrow" with "due in three days" and filled a slot in the
        // promotion window (158 clean retries in the week to 2026-09-11).
        // The retention test is, and always was, tomorrow's first attempt.
        // So: only a first asking moves the spaced-repetition schedule, the
        // promotion window, the length controller and the variant queue.
        // Drill a phrase as often as you like; none of it counts as learning.
        const first = q.kind === 'passage';
        if (first) {
          bank.record(q.phrase.id, this.pitchClean);
          this.recordPolyOutcome(q.phrase.kind, this.pitchClean, rungs.exact, rungs.notes);
          this.updatePassageLength(q.phrase.kind, this.pitchClean, q.phrase.notes.length);
        }
        const verdict = this.retryVerdict(q, rungs, bank);
        const tail = this.pitchClean ? (verdict ? ` -- ${verdict}` : '') : ` -- ${describeRungs(rungs)}; ${verdict}`;
        this.log(`  passage ${this.pitchClean ? 'clean' : 'done with errors'} (streak ${this.streak})${tail}${timing}`);
        this.flushPolyMove();
        if (first && this.pitchClean) {
          // Nailed COLD: it comes back in the next block, varied (key, a step,
          // or the mode). Nailed on a retry is not nailed; that phrase is due
          // again tomorrow, which its failed first asking already arranged.
          this.variantQueue.push({ id: q.phrase.id, kind: q.phrase.kind, placed: q.placed, key: q.placed.key ?? null, block: this.blockN });
        }
      }
      // THE PULSE DROPS. After every passage, clean or not, so its arrival
      // never gives the verdict away -- that is the whole reason it follows
      // the ones you nailed.
      this.openWindow(q);
    } else if (q.kind === 'gesture' || q.dyad) {
      const timing = this.timing.notes && !this.timeClean ? ` (timing ${this.timing.inTime}/${this.timing.notes})` : '';
      if (timing) this.log(`  ${this.pitchClean ? 'right' : 'wrong'} notes${timing}`);
      // Rung 3 follows a clean departure with both hands still down.
      if (q.kind === 'dyad' && q.regime === 'departure' && this.pitchClean && this.hands && this.rungState().rung >= 3) this.chainDyad = true;
    }
    this.nextQ = this.makeQuestion();
  }

  /**
   * Open the judgment window on the passage that just finished. Every note
   * the player never reached goes on the list, cascade notes included; the
   * ones he CAUGHT in flight are listed but flagged, because they are already
   * measured (attempts.self_corrected) and naming a note you have just played
   * proves nothing.
   */
  openWindow(q) {
    const missed = [];
    for (const g of this.groups) {
      for (const e of g.notes) {
        if (e.free || e.silent || !e.graded || e.played === e.midi) continue;
        missed.push({ midi: e.midi, played: e.played, from: e.melodicFrom, b: g.b, caught: Boolean(e.selfCorrected) });
      }
    }
    missed.sort((x, y) => x.b - y.b);
    this.window = {
      missed,
      clean: this.pitchClean,
      question: this.questions,
      phraseId: q.phrase.id,
      // The passage exactly as it was PLACED and heard -- the chain is cut
      // from this, not rebuilt from the phrase, so it keeps the pitches, the
      // rhythm and the re-metering of the call that was actually missed. Kept
      // here because the window question that follows rebuilds this.groups.
      notes: this.groups.flatMap((g) => g.notes.map((e) => ({ midi: e.midi, b: g.b, dur: e.dur, voice: e.voice }))),
      meter: this.meter,
      first: q.kind === 'passage',
      sec: Math.max(WINDOW_SEC, WINDOW_BEATS * this.beat),
      bpm: this.bpm,
      pressed: [],
    };
  }

  /**
   * Read the silence. Each note offered is one of four things:
   *   a HIT     -- it really did get past him
   *   an ECHO   -- it is the wrong note he actually PLAYED: given time and
   *                silence he still believes it was right, which is a
   *                representation problem and not a fumble, and it goes to
   *                the confusion tracker at full weight (a passage miss gets
   *                half) because he has now asserted it twice
   *   a CATCH   -- a note he had already gone back for: already measured
   *   a STRAY   -- nothing was wrong there; after a clean passage, a false alarm
   * Offering nothing says "that was clean", which is right or is a miss that
   * went unnoticed. Then the notes he did not name are queued to be served.
   */
  closeWindow(w) {
    const live = w.missed.filter((m) => !m.caught);
    // He is NAMING notes, not playing music: the same pitch offered twice is
    // one offer, and must not score twice in any cell.
    const offered = [...new Set(w.pressed)];
    const named = new Set();
    let hits = 0; let echoes = 0; let strays = 0;
    for (const note of offered) {
      if (w.missed.some((m) => m.caught && m.midi === note)) {
        this.log(`  judged ${name(note)}: you caught that one yourself`);
        continue;
      }
      const hit = live.find((m) => m.midi === note);
      if (hit) {
        hits += 1;
        named.add(note);
        this.log(`  judged ${name(note)}: yes, that one got past you`);
        continue;
      }
      // An echo names the wrong note without excusing it: he still has to
      // hear the right one, so it stays on the list to be served.
      const echo = live.find((m) => m.played === note);
      if (echo) {
        echoes += 1;
        this.log(`  judged ${name(note)}: no -- that is what you played; you still hear it as right (wanted ${name(echo.midi)})`);
        if (echo.from !== null && echo.from !== undefined) this.engine.recordConfusion(echo.midi - echo.from, note - echo.from, 1);
        continue;
      }
      strays += 1;
      this.log(`  judged ${name(note)}: no, nothing was wrong there${w.clean ? ' -- it was clean (false alarm)' : ''}`);
    }
    if (offered.length === 0) {
      this.log(w.clean
        ? '  nothing offered: it was clean (correct)'
        : `  nothing offered: ${live.length} note${live.length === 1 ? '' : 's'} got past you unnoticed`);
    }
    this.db.window({
      sessionId: this.sessionId, question: w.question, phraseId: w.phraseId, passageClean: w.clean,
      missed: live.length, caught: w.missed.length - live.length, pressed: offered.length, hits, echoes, strays,
    });
    // Served next: what he never reached, minus what he just named and what
    // he caught in flight. Nothing is played that he has already shown.
    const serve = [];
    for (const m of live) if (!named.has(m.midi) && !serve.includes(m.midi)) serve.push(m.midi);
    // Past the cliff the list of pitches is replaced by the chain (see CHAIN).
    // Only a FIRST asking spawns one: a retry is already a second look, and a
    // chain of a chain is a hole to fall down.
    if (w.first && serve.length >= CHAIN.minMissed && this.startChain(w, live.filter((m) => !named.has(m.midi)))) {
      this.correction = null;
      return;
    }
    this.correction = serve.length ? { notes: serve, bpm: w.bpm } : null;
  }

  /**
   * Cut the chain out of the passage: the span from the note BEFORE the first
   * miss (the handed reference -- a note he actually played right, so the run
   * up to the error is real) through the last one. Returns false when there is
   * nothing to walk, and the ordinary correction stands.
   */
  startChain(w, missed) {
    if (!w.notes?.length || !missed.length) return false;
    const all = [...new Set(w.notes.map((n) => n.b))].sort((a, b) => a - b);
    const lo = Math.min(...missed.map((m) => m.b));
    const hi = Math.max(...missed.map((m) => m.b));
    const at = all.indexOf(lo);
    const from = all[Math.max(0, at - 1)] ?? lo; // one note of run-up when there is one
    const notes = w.notes.filter((n) => n.b >= from && n.b <= hi);
    const onsets = [...new Set(notes.map((n) => n.b))].sort((a, b) => a - b);
    if (onsets.length < 2) return false;
    // The retry that retryVerdict just queued does not happen (see CHAIN).
    this.retry = null;
    this.chain = { notes, onsets, len: 1, steps: 0, bpm: w.bpm, meter: w.meter, phraseId: w.phraseId };
    this.log(`  chaining the span: ${onsets.length} notes from where it went wrong (no retry)`);
    return true;
  }

  /**
   * One step of the walk: the span's opening note, handed back ungraded as the
   * reference, plus `len` notes after it at the passage's own tempo and meter.
   * Scored as a correction -- notes you were just given earn no credit, spend
   * none, break no run and queue no remediation -- but logged as its own kind
   * so the walk can be read apart from the loop it replaced.
   */
  chainQuestion() {
    const c = this.chain;
    const upto = c.onsets[Math.min(c.len, c.onsets.length - 1)];
    const within = c.notes.filter((n) => n.b <= upto);
    const base = c.onsets[0];
    const last = Math.max(...within.map((n) => n.b));
    const notes = within.map((n) => ({
      midi: n.midi, b: n.b - base, dur: n.b === last ? Math.max(n.dur, 2) : n.dur, voice: n.voice,
    }));
    const heard = [...within].sort((a, b) => a.b - b.b || a.midi - b.midi).map((n) => name(n.midi)).join(' ');
    return {
      kind: 'chain',
      correction: true, // scored exactly like one: handed, not earned
      chain: true,
      tempo: c.bpm,
      meter: c.meter,
      notes,
      label: `chain ${c.len}/${c.onsets.length - 1}: ${heard} -- from the note before it went wrong`,
    };
  }

  /**
   * Grow on clean, SHRINK on a miss -- never repeat the step that just failed,
   * which is what makes the walk terminate and what keeps him near the rate at
   * which he is playing rather than guessing. The span is the whole of it:
   * the walk stops there and the phrase is not asked again this sitting.
   */
  stepChain() {
    const c = this.chain;
    c.steps += 1;
    if (this.pitchClean) c.len += 1;
    else if (c.len > 1) c.len -= 1;
    else {
      this.chain = null;
      this.log('  (chain done: the first step is still going wrong -- leaving it for tomorrow)');
      return;
    }
    if (c.len > c.onsets.length - 1) {
      this.chain = null;
      this.log(`  (chain done: the whole span, in ${c.steps} step${c.steps === 1 ? '' : 's'})`);
    } else if (c.steps >= CHAIN.maxSteps) {
      this.chain = null;
      this.log(`  (chain done: ${CHAIN.maxSteps} steps, leaving it for tomorrow)`);
    }
  }

  /**
   * THE CORRECTIVE LOOP. A failed passage comes straight back, in the same
   * key: hearing the call again right after missing it says both that you
   * missed and what it actually sounds like, and the retry is the chance to
   * use that. THAT IS THE WHOLE OF THE FEEDBACK -- no sound says "wrong",
   * because the phrase coming back already did. It keeps coming back
   * while the rungs say you are getting closer (rungScore), up to
   * RETRY_MAX_TRIES attempts in all; nailing it is the reward -- you move on.
   * No closer, or out of tries, means it is too hard just yet: the phrase
   * rests (PhraseBank.rest) instead of being hammered. Returns the log verdict.
   */
  retryVerdict(q, rungs, bank) {
    const score = rungScore(rungs);
    const loop = q.kind === 'retry' ? this.retry ?? { tries: 1, score: -1 } : null;
    if (this.pitchClean) {
      this.retry = null;
      return loop ? `nailed on try ${loop.tries + 1}` : '';
    }
    if (!loop) {
      this.retry = { id: q.phrase.id, kind: q.phrase.kind, tries: 1, score, placed: q.placed };
      return 'again';
    }
    const tries = loop.tries + 1;
    if (tries < RETRY_MAX_TRIES && score > loop.score + 1e-9) {
      this.retry = { ...loop, tries, score };
      return `try ${tries}, closer, again`;
    }
    this.retry = null;
    bank.rest(q.phrase.id, TOO_HARD_REST_MS);
    return tries >= RETRY_MAX_TRIES ? `try ${tries} of ${RETRY_MAX_TRIES}, resting it` : `try ${tries}, no closer, resting it`;
  }
}

export function name(midi) {
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}
const INTERVAL_NAMES = ['unison', 'm2', 'M2', 'm3', 'M3', 'P4', 'tritone', 'P5', 'm6', 'M6', 'm7', 'M7', 'octave'];
function intervalName(semitones) {
  const w = Math.abs(semitones);
  if (w <= 12) return INTERVAL_NAMES[w];
  const simple = simpleOf(w);
  return `${INTERVAL_NAMES[simple]} + 8ve${w - simple > 12 ? 's' : ''}`;
}
export { TIER_WIDTHS, WARMUP_QUESTIONS };
