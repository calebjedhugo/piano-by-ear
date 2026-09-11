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
//   prime:     a tonal set from the note under your hand, scrambled, asked
//              and played back like anything else. It opens the block and IS
//              how the tonal centre is established -- the drill teaches its
//              own key, and makes you catch every interval of it cold.
//   interval:  call = the target on the downbeat (the anchor is the note you
//              just played; it stays in the question, silent, a beat before).
//              At the lower stages, and until three tiers are open, the anchor
//              is sounded too (src/stage.js): the task is then relative, which
//              is where a beginner starts; it fades as the ladder climbs.
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
//              imitating you first, and your own figure is the call.
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

import { TIER_WIDTHS, WARMUP_QUESTIONS, simpleOf } from './engine.js';
import { floorFromHistory, passageTempo, toleranceMsFor } from './tempo.js';
import { summarizeRungs, describeRungs, rungScore } from './rungs.js';
import { BLOCK_QUESTIONS, NAMES, chooseKey, keyName, primeNotes, diatonicIn, diatonicStep, modeSwap } from './keyblock.js';
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
const LEN = {
  start: { mono: 5, duo: 8, chorale: 10, poly: 10 },
  min: { mono: 4, duo: 6, chorale: 8, poly: 8 },
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
// The round: this many clean, in-time plain answers started within two beats
// open one; a run is this many calls or this many misses; then a cool-down
// call. At the ~70% a 2-down/1-up staircase converges on, 16 calls expect
// about 5 misses, so a run usually ends on its length, not on a failure.
const ROUND = { trigger: 5, calls: 16, misses: 5, cooldown: 15, maxLevel: 4, leads: [4, 3, 2], tempoStep: 6 };
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
  promoteRate: 0.7,
  demoteRate: 0.3,
  melodicTiersForDyads: 6, // melodic tiers unlocked before dyads begin (through the M6)
  masteredForDyads: 6, // ...and this many intervals mastered: dyads wait for interval confidence, not passages
  harmonicTiersForChorale: 4, // harmonic tiers unlocked before four-part chords
  harmonicTiersForChords: 3, // harmonic tiers before three-note chords join the dyads
  dyadEvery: 3, // at level >= 1, every third plain question is a dyad (or a chord)
  historyMax: 200,
};
// A small, repeated set of chord shapes above a fixed bass (McLachlan 2013:
// hearing out chord tones tracks familiarity with the TYPE).
const CHORD_SHAPES = [[4, 7], [3, 7], [3, 8], [4, 9], [4, 7, 10]];
const LEVEL_NAMES = ['melody only', 'dyads and two voices', 'four-part chorales', 'both hands'];

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
   */
  constructor({ audio, db, range, makeEngine, phrases, poly = null, log, bpmOverride = null }) {
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
    this.polyStore = db.kv('poly');
    this.lenStore = db.kv('passageLen');
    this.carryStore = db.kv('carry');
    this.stageStore = db.kv('stage');
    this.roundsStore = db.kv('rounds'); // one record per run: the round's evidence is scoped away from the ladder
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
    if (port && port !== this.range.portName) this.range.setPort(port);
    if (this.range.observe(note)) {
      this.rangeDirty = true;
      const { lo, hi } = this.range.current;
      this.log(`range widened to ${lo}..${hi}`);
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
      rows.push({ fastestSec: (phrase.minDur * r.beat_ms) / 1000, clean: Boolean(r.correct && r.in_time) });
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
   * The level is earned, never set. Promotion needs the last POLY.window
   * passages of the current level's kind at least 70% clean (plus, for the
   * first steps, enough tiers unlocked on the relevant engine); demotion
   * follows a run under 30%. Lower kinds keep being asked at every level.
   * The FIRST step (dyads) is the exception: it waits on interval confidence
   * (tiers open and intervals mastered), not on melodic passages -- a dyad
   * is an interval played together, not a phrase.
   */
  polyLevel() {
    const st = this.polyStore.load() || { level: 0, history: [] };
    if (!this.poly) return { ...st, level: 0 };
    const recent = (kind) => st.history.filter((h) => h.kind === kind).slice(-POLY.window);
    const rate = (rows) => (rows.length ? rows.filter((h) => h.clean).length / rows.length : 0);
    let level = st.level || 0;
    const cur = recent(POLY_KINDS[level]);
    if (level === 0) {
      const held = st.demotedAt && Date.now() - st.demotedAt < POLY_DEMOTE_HOLD_MS;
      if (!held && this.engine.state.tiersUnlocked >= POLY.melodicTiersForDyads && this.engine.masteredCount() >= POLY.masteredForDyads) level = 1;
    } else if (cur.length >= POLY.window && rate(cur) >= POLY.promoteRate && level < POLY_KINDS.length - 1) {
      const gate = level === 1 ? this.harmonic.state.tiersUnlocked >= POLY.harmonicTiersForChorale : true;
      if (gate) level += 1;
    } else if (level > 0 && cur.length >= POLY.window && rate(cur) < POLY.demoteRate) {
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

  recordPolyOutcome(kind, clean) {
    const st = this.polyState;
    st.history.push({ kind, clean, ts: Date.now() });
    if (st.history.length > POLY.historyMax) st.history.splice(0, st.history.length - POLY.historyMax);
    this.polyStore.save(st);
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
    this.floorSec = this.sessionFloor();
    // The lead-in only carries the anchor to the first downbeat; every
    // question sets its own tempo in beginQuestion().
    this.bpm = this.bpmOverride ?? LEAD_IN_BPM;
    this.beat = 60 / this.bpm;
    this.toleranceMs = toleranceMsFor(this.bpm);
    this.sessionId = this.db.newSession({ bpm: this.bpm, anchor });
    this.questions = 0;
    this.plainQuestions = 0;
    this.passagesDone = 0;
    this.streak = 0;
    this.cleanNotes = 0;
    this.roundStreak = 0; // reset per burst: a round wants a run within one sitting
    this.roundCooldown = 0;
    this.round = null;
    this.remediationQueue = resumed?.remediationQueue ?? [];
    this.harmonicRemediationQueue = [];
    // The corrective loop and the variants carry as ids + placement, re-placed
    // from the bank (a phrase object through JSON would be a detached copy).
    // A window belongs to the passage that just happened; neither it nor its
    // correction survives the end of a session.
    this.window = null; // { missed, clean, question, phraseId, sec, bpm, pressed }
    this.correction = null; // { notes, bpm }
    this.retry = resumed?.retry ? this.replace(resumed.retry) : null; // { id, kind, tries, score, placed }
    this.variantQueue = (resumed?.variantQueue ?? []).map((v) => this.replace(v)).filter(Boolean);
    // A resumed sitting re-opens its block rather than carrying one: the
    // prime is a call, and a call starts on the note under the hand, so the
    // key has to be chosen from wherever the player has just sat down.
    this.block = null; // { key, asked, n }
    this.blockN = resumed?.block?.n ?? 0;
    this.askedThisSession = new Set(resumed?.asked ?? []);
    this.passagesInARow = 0;
    this.anchor = anchor;
    this.prevAnchor = null;
    this.lastInputAt = performance.now();
    this.lastPlayedAt = this.audio.now;
    this.syncClock(1);
    this.state = 'QUESTION';
    const level = this.polyState.level;
    this.log(`session started${resumed ? ' (resuming the sitting)' : ''}: anchor ${name(anchor)}, range ${this.lo}..${this.hi}, tempo per excerpt (shortest note ${Math.round(this.floorSec * 1000)}ms), tiers ${this.engine.state.tiersUnlocked}${level > 0 ? `/${this.harmonic.state.tiersUnlocked} harmonic` : ''}, polyphony level ${level} (${LEVEL_NAMES[level]}), stage ${this.stage.current}${this.block ? `, key ${keyName(this.block.key)}` : ''}`);

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
    return placed.notes.every((n) => n[0] >= this.lo && n[0] <= this.hi);
  }

  /** The anchor stays inside the stage's keyboard window (applied wherever the anchor is set). */
  clampAnchor(midi) {
    const w = this.win;
    if (midi >= w.lo && midi <= w.hi) return midi;
    const a = Math.max(w.lo + 3, Math.min(w.hi - 3, midi));
    this.log(`  (anchor brought back to ${name(a)})`);
    return a;
  }

  /** Notes are { midi, b, dur, voice, free, silent }. */
  intervalQuestion(kind, target, { wide = false } = {}) {
    const sounded = this.stage.soundsAnchor(this.engine.state.tiersUnlocked);
    const iv = target - this.anchor;
    const label = wide ? `${signed(simpleOf(iv))} +8ve` : signed(iv);
    return {
      kind,
      wide,
      optionalAnchor: true, // a wrong first note is a wrong target, never a wrong anchor
      // The anchor is the note you just played, so the call sounds only the
      // target, on the downbeat. The anchor stays in the question, a beat
      // before it: the target's melodic context for grading and the free note
      // you may echo or skip when you answer. At the lower stages it sounds,
      // and then it takes the downbeat itself with the target a beat later.
      notes: sounded
        ? [{ midi: this.anchor, b: 0, dur: 1, voice: 0, free: true }, { midi: target, b: 1, dur: 1, voice: 0 }]
        : [{ midi: this.anchor, b: -1, dur: 1, voice: 0, free: true, silent: true }, { midi: target, b: 0, dur: 1, voice: 0 }],
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

  dyadQuestion(kind, target) {
    return {
      kind,
      dyad: true,
      optionalAnchor: true,
      notes: [{ midi: this.anchor, b: 0, dur: 2, voice: 0, free: true }, { midi: target, b: 0, dur: 2, voice: 1 }],
      meter: 4,
      label: `${kind}: ${name(this.anchor)} + ? (${signed(target - this.anchor)} together)`,
    };
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
   * THE BLOCK'S PRIME, and the only thing that establishes the key: a tonal
   * set -- triad, seventh, pentatonic, first five degrees, ninth, whichever
   * the open tiers allow -- SCRAMBLED, from the note under your hand, asked
   * and played back like every other call.
   *
   * The pitches name the key; the order is what makes it a question. Every
   * interval after the first has to be caught with no idea what is coming,
   * which is the skill of walking in on music already in progress. Below the
   * exact stage it is the triad: a player still credited for direction is
   * not asked to catch a scrambled ninth.
   *
   * The first note is the anchor (keyblock.primeNotes puts the tonic there),
   * so it is free, as the note under the hand always is. Evidence goes in at
   * passage scope: the set is context, not a probe.
   */
  primeQuestion() {
    const k = this.block.key;
    const tiers = this.stage.current === 'exact' ? this.engine.state.tiersUnlocked : 0;
    const prime = primeNotes(k, this.anchor, this.lo, this.hi, { tiers });
    const notes = prime.notes.map(([midi, b, dur], i) => ({ midi, b, dur, voice: 0, free: i === 0 && midi === this.anchor }));
    const off = prime.dropped ? ` (${prime.dropped} note${prime.dropped === 1 ? '' : 's'} off the keyboard)` : '';
    return {
      kind: 'prime',
      prime: true,
      optionalAnchor: true,
      notes,
      meter: 4,
      label: `key: ${keyName(k)}, ${prime.set} scrambled: ${notes.map((n) => name(n.midi)).join(' ')}${off}`,
    };
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
    if (harmonic) ivs.forEach((iv, i) => notes.push({ midi: a, b: i * 2, dur: 2, voice: 0, free: i === 0 }, { midi: a + iv, b: i * 2, dur: 2, voice: 1 }));
    else ivs.forEach((iv, i) => notes.push({ midi: a, b: i * 2, dur: 1, voice: 0, free: i === 0 }, { midi: a + iv, b: i * 2 + 1, dur: 1, voice: 0 }));
    return {
      kind: 'exposure',
      exposure: true,
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
    const { phrase, notes, octave, key } = picked;
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
      return { midi, b: phrase.pickup + off, dur, voice, free: i === phrase.pivot || (kind === 'retry' && firstInVoice) };
    });
    const pivotMidi = notes[phrase.pivot][0];
    const start = key ? `, in ${keyName(key)}` : octave === 0 ? '' : `, starts ${name(pivotMidi)} (octave ${octave > 0 ? 'above' : 'below'} anchor)`;
    const poly = phrase.kind !== 'mono';
    return {
      kind,
      notes: placed,
      meter: phrase.meter,
      phrase,
      octave,
      placed: picked,
      label: `${kind === 'passage' ? '' : `${kind}: `}${poly ? `${phrase.kind}: ` : ''}${phrase.composer} ${phrase.catalog} "${phrase.title}" bar ${phrase.bar}, ${phrase.meter}-beat bars, ${poly ? `${phrase.voices} voices, ` : ''}${notes.length} notes in ${phrase.key || '?'}${start}`,
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

  /** A passage of this kind (first asking, not a retry) ended clean or not, on pitch. */
  updatePassageLength(kind, clean) {
    const before = this.passageLength(kind); // also creates the kind's state
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
        exclude: this.askedThisSession,
      };
      // In the block key first; on the anchor only if nothing fits the key.
      const picked = (this.block && bank.pick(this.anchor, this.lo, this.hi, { ...opts, key: this.block.key })) ||
        bank.pick(this.anchor, this.lo, this.hi, opts);
      if (picked) return picked;
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
    if (!picked && v.placed?.notes) {
      const step = [2, -2, 3, -3].find((s) => v.placed.notes.every((n) => n[0] + s >= this.lo && n[0] + s <= this.hi));
      if (step !== undefined) {
        picked = { phrase, notes: v.placed.notes.map((n) => [n[0] + step, ...n.slice(1)]), octave: 0, key: null, shift: v.placed.shift + step };
        how = `${signed(step)} semitones`;
      }
    }
    if (!picked && phrase.tonalKey && v.placed?.notes) {
      const notes = modeSwap(v.placed.notes, { tonic: (((phrase.tonalKey.tonic + v.placed.shift) % 12) + 12) % 12, mode: phrase.tonalKey.mode });
      if (notes.every((n) => n[0] >= this.lo && n[0] <= this.hi)) {
        picked = { phrase, notes, octave: 0, key: null, shift: v.placed.shift };
        how = `in the ${phrase.tonalKey.mode === 'major' ? 'minor' : 'major'} mode`;
      }
    }
    if (!picked) return null;
    const q = this.passageQuestion('variant', picked);
    q.label += ` (${how})`;
    return q;
  }

  /** A new key block opens on the note you are on. */
  openBlock() {
    const key = chooseKey(this.anchor, this.block?.key ?? null);
    this.blockN += 1;
    this.block = { key, asked: 0, n: this.blockN };
    this.log(`key block: ${keyName(key)}`);
    return this.primeQuestion();
  }

  makeQuestion() {
    const engine = this.engine;
    const level = this.polyState.level;
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
    if (this.retry) {
      // Straight back, before anything else, in the SAME key and register:
      // the correction has to be adjacent to the miss to be one, and constant
      // practice until correct is what the evidence backs.
      if (this.fits(this.retry.placed)) return this.passageQuestion('retry', this.retry.placed);
      this.log('  (retry dropped: the phrase no longer fits the keyboard)');
      this.retry = null;
    }
    // A key block opens (and re-opens after a burst) with its prime.
    if (!this.block || this.block.asked >= BLOCK_QUESTIONS) return this.openBlock();
    const pair = top ? engine.takeExposure() : null;
    if (pair) {
      const q = this.pairQuestion(pair);
      if (q) return q;
    }
    const dyadPair = top && level >= 1 ? this.harmonic.takeExposure() : null;
    if (dyadPair) {
      const q = this.pairQuestion(dyadPair, { harmonic: true });
      if (q) return q;
    }
    while (this.remediationQueue.length > 0) {
      const raw = this.remediationQueue.shift();
      const iv = engine.inwardVariant(raw, a);
      if (iv !== null) {
        const target = engine.ask(iv, a, prev) + this.lo;
        return this.intervalQuestion('remediation', target);
      }
    }
    while (level >= 1 && this.harmonicRemediationQueue.length > 0) {
      const raw = this.harmonicRemediationQueue.shift();
      const iv = this.harmonic.inwardVariant(raw, a);
      if (iv !== null) {
        const target = this.harmonic.ask(iv, a, null) + this.lo;
        return this.dyadQuestion('dyad remediation', target);
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
        if (picked) return this.passageQuestion('passage', picked);
      }
    }
    // The echo game: at the lowest stage every question; at contour, every third.
    if (this.stage.current === 'echo' || (this.stage.current === 'contour' && this.plainQuestions % 3 === 2)) {
      this.plainQuestions += 1;
      return { kind: 'echo', collect: true, notes: [], meter: 4, label: 'echo: the drill is quiet -- play two or three notes and it will ask for them back' };
    }
    this.plainQuestions += 1;
    if (level >= 1 && top && this.plainQuestions % POLY.dyadEvery === 0) {
      if (this.harmonic.state.tiersUnlocked >= POLY.harmonicTiersForChords && this.plainQuestions % (POLY.dyadEvery * 3) === 0) {
        const q = this.chordQuestion();
        if (q) return q;
      }
      // Fixed bass: the anchor stays the bottom note while dyads are new.
      const target = this.harmonic.nextTargetIndex(a, null, { bounds: { lo: a + 1, hi: this.idx(this.hi) } }) + this.lo;
      return this.dyadQuestion(this.harmonic.servedQueue ? 'dyad discrimination' : 'dyad', target);
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
    const target = this.engine.nextTargetIndex(a, prev, { extraTiers: extra, scope: 'round', bounds: { lo: this.idx(this.win.lo), hi: this.idx(this.win.hi) } }) + this.lo;
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
      g.notes.push({ midi: n.midi, dur: n.dur, voice: n.voice, free: Boolean(n.free), silent: Boolean(n.silent), done: false, played: null, melodicFrom: null, melodicPrev: null, harmonicFrom: null, graded: false });
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
    // The echo ask-back's first note is found again from the playback's last
    // note (the anchor): graded, on the stage's rung, like every other.
    if (this.q?.echoOf) lastInVoice.set(0, [this.anchor, this.prevAnchor]);
    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi];
      const bass = Math.min(...g.notes.map((e) => e.midi));
      for (const e of g.notes) {
        const hist = lastInVoice.get(e.voice) || [];
        if (hist.length > 0) {
          e.melodicFrom = hist[0];
          e.melodicPrev = hist.length > 1 ? hist[1] : (e.free || gi > 0 ? null : this.prevAnchor);
        }
        if (g.notes.length > 1 && e.midi !== bass) e.harmonicFrom = bass;
        e.graded = !e.free && ((e.melodicFrom !== null && e.melodicFrom !== e.midi) || e.harmonicFrom !== null);
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
        this.endSession(`${Math.round(this.stage.timeoutMs / 1000)}s of silence`);
        return;
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
        if (now >= quietSince + quiet * this.beat - this.toleranceMs / 1000) this.abandonResponse({ waited: quiet });
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
        const earliest = Math.max(quietSince - this.toleranceMs / 1000 + QUIET_BEATS_BEFORE_NEXT * this.beat, now);
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
    const passage = Boolean(q.phrase) || Boolean(q.gesture) || Boolean(q.prime) || Boolean(q.exposure) || Boolean(q.correction);
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
    if ((isolated || q.prime) && exp.melodicFrom !== null) {
      credit = this.stage.credit(exp.melodicFrom, exp.midi, played);
      // A compound ask: the interval skill is judged on pitch class, the
      // octave on its own.
      if (q.wide && !correct && played !== null && Math.abs(played - exp.midi) === 12) { heightErr = true; credit = true; }
    }
    if (exp.graded) {
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
        const iv = exp.midi - exp.harmonicFrom;
        const dyad = Boolean(q.dyad) && !q.chord; // a dyad was framed by nextTargetIndex; chord tones are framed here
        if (!dyad) this.harmonic.ask(iv, this.idx(exp.harmonicFrom), null, { scope: 'passage' });
        if (!correct) {
          this.harmonic.reportMiss(this.idx(exp.harmonicFrom), played === null ? this.idx(exp.harmonicFrom) : this.idx(note), { confuse: dyad });
          if (!dyad && this.polyState.level >= 1 && this.remediated < REMEDIATE_MAX_PER_PASSAGE &&
              this.harmonic.predictedAcc(iv, this.idx(exp.harmonicFrom)) < 0.8) {
            this.harmonicRemediationQueue.push(simpleOf(iv));
            this.remediated += 1;
          }
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
    const why = correct ? '' : ` (${exp.melodicFrom !== null ? signed(exp.midi - exp.melodicFrom) : exp.harmonicFrom !== null ? `+${exp.midi - exp.harmonicFrom} above bass` : 'anchor'})`;
    const mark = correct ? 'correct' : credit ? `~ ${name(note)} wanted` : `x ${name(note)} wanted`;
    const creditNote = !correct && credit ? (heightErr ? ' -- right note, wrong octave' : this.stage.current === 'contour' || this.stage.current === 'echo' ? ' -- right direction' : ' -- close') : '';
    this.log(
      `  ${mark} ${name(exp.midi)}${why}${chord}, onset ${onsetMs >= 0 ? '+' : ''}${onsetMs.toFixed(0)}ms${correct && !inTime ? (onsetMs < 0 ? ' EARLY' : ' LATE') : ''}${creditNote}`,
    );
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
    const top = (grp) => {
      const played = grp.notes.filter((e) => e.played !== null).map((e) => e.played);
      return Math.max(...(played.length ? played : grp.notes.map((e) => e.midi)));
    };
    if (n > 0) {
      this.prevAnchor = n >= 2 ? top(this.groups[n - 2]) : this.anchor;
      this.anchor = this.clampAnchor(top(this.groups[n - 1]));
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
          this.recordPolyOutcome(q.phrase.kind, this.pitchClean);
          this.updatePassageLength(q.phrase.kind, this.pitchClean);
        }
        const verdict = this.retryVerdict(q, rungs, bank);
        const tail = this.pitchClean ? (verdict ? ` -- ${verdict}` : '') : ` -- ${describeRungs(rungs)}; ${verdict}`;
        this.log(`  passage ${this.pitchClean ? 'clean' : 'done with errors'} (streak ${this.streak})${tail}${timing}`);
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
    this.correction = serve.length ? { notes: serve, bpm: w.bpm } : null;
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
export { TIER_WIDTHS, WARMUP_QUESTIONS };
