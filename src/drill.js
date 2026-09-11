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
//               interval:  call = anchor for two beats, target on beat 3.
//               dyad:      call = anchor and target TOGETHER for two beats;
//                          you play both together.
//               passage:   call = a real phrase transposed so its pivot note
//                          is the anchor, in its own meter with its pickup.
//                          'mono' is one voice; 'duo' soprano and bass;
//                          'chorale' all four voices; 'poly' both hands.
//             WHICH KIND: a passage you just failed comes STRAIGHT BACK (the
//             call is the correction: you hear that you missed and what it
//             really sounds like), up to three tries while the rungs beneath
//             exact pitch keep improving; nailing it is the reward, stalling
//             rests it (retryVerdict). Then a discrimination run or a
//             remediation (an interval you missed inside a passage);
//             otherwise three clean questions in a row (correct AND in time)
//             earn a passage, and clean passages keep them coming, with an
//             interval question after every three passages. POLYPHONY LEVEL
//             (0 melody, 1 dyads + duos, 2 chorales, 3 both hands) is
//             derived from history at each session start (see polyLevel()).
//             GRADING: ONE pass, by ONSET GROUP. Notes that sound together
//             form a group; each note you play is matched by pitch to a
//             pending note of the current group (any order within a chord),
//             judged on timing against the constant grid and on how long you
//             hold it. A wrong note consumes the nearest pending note of the
//             group. Starting the next group abandons what was left of this
//             one. Each note carries up to two skills: the melodic interval
//             from the previous note in its voice (melodic engine) and the
//             interval above its chord's bass (harmonic engine). There are
//             no retries and NO feedback sounds: the reply is the next
//             question, anchored on the last note you actually played (right
//             or wrong). A BEAT OF SILENCE MEANS YOU ARE DONE: after the last
//             note the next question comes on the following click; before
//             the last note, whatever is left is missed and the next question
//             comes anyway. Ten seconds with no response at all ends the session.
//
// The ONLY sounds are the metronome, the call (the system's turn), the piano
// under your keys (the controller has no sound of its own), and a two-note
// tone when the session ends.

import { TIER_WIDTHS, WARMUP_QUESTIONS } from './engine.js';
import { floorFromHistory, passageTempo, toleranceMsFor } from './tempo.js';
import { summarizeRungs, describeRungs, rungScore } from './rungs.js';
import { TonalField, keyName } from './tonalfield.js';

const TIMEOUT_MS = 10000;
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
// The pulse the anchor rings on before the first question sets its own tempo.
const LEAD_IN_BPM = 72;
// Interval-question tempo: a calm centre that eases a little as the key firms
// up (a settled tonal area can breathe) and drags when it dissolves. Kept
// narrow -- interval questions are about hearing, not speed.
const INTERVAL_TEMPO = { base: 72, span: 12 };
// A gesture -- two or three notes in a row instead of a bare target -- happens
// this often among plain interval questions, but only once a key has emerged
// to make the extra notes mean something. Caleb: "play two or three notes in
// a row once in a while... make the whole thing a musical experience."
const GESTURE_RATE = 0.34;
const GESTURE_MIN_STRENGTH = 0.4;
// Polyphony levels and how they are earned (see polyLevel()).
export const POLY_KINDS = ['mono', 'duo', 'chorale', 'poly'];
const POLY = {
  window: 12, // passages of a level's kind judged for promotion/demotion
  promoteRate: 0.7,
  demoteRate: 0.3,
  melodicTiersForDyads: 6, // melodic tiers unlocked before dyads begin (through the M6)
  harmonicTiersForChorale: 4, // harmonic tiers unlocked before four-part chords
  dyadEvery: 3, // at level >= 1, every third plain question is a dyad
  historyMax: 200,
};
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
    this.len = this.lenStore.load() || {};
    this.state = 'IDLE';
    this.clockOffset = performance.now() / 1000 - audio.now;
    this.field = new TonalField(); // replaced per session; here so it always exists
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
      const phrase = this.phrases.byId.get(r.phrase_id) ?? this.poly?.byId.get(r.phrase_id);
      if (!phrase) continue; // a phrase the corpus no longer has
      rows.push({ fastestSec: (phrase.minDur * r.beat_ms) / 1000, clean: Boolean(r.correct && r.in_time) });
    }
    return floorFromHistory(rows);
  }

  /** The tempo for a question: what its music wants, never what you earned. */
  questionTempo(q) {
    if (this.bpmOverride) return this.bpmOverride;
    if (q.phrase) return passageTempo(q.phrase, this.floorSec);
    // Interval and gesture questions breathe with the tonal centre: a firm key
    // eases forward, a dissolving one hangs back. Still calm and still about
    // hearing, not speed -- INTERVAL_TEMPO.base (72) is the centre and this
    // only leans a few bpm either way with the key's strength.
    const s = this.field.key().strength;
    return Math.round(INTERVAL_TEMPO.base + INTERVAL_TEMPO.span * (s - 0.5));
  }

  // --- polyphony level -----------------------------------------------------

  /**
   * The level is earned, never set. Promotion needs the last POLY.window
   * passages of the current level's kind at least 70% clean (plus, for the
   * first steps, enough tiers unlocked on the relevant engine); demotion
   * follows a run under 30%. Lower kinds keep being asked at every level.
   */
  polyLevel() {
    const st = this.polyStore.load() || { level: 0, history: [] };
    if (!this.poly) return { ...st, level: 0 };
    const recent = (kind) => st.history.filter((h) => h.kind === kind).slice(-POLY.window);
    const rate = (rows) => (rows.length ? rows.filter((h) => h.clean).length / rows.length : 0);
    let level = st.level || 0;
    const cur = recent(POLY_KINDS[level]);
    if (cur.length >= POLY.window && rate(cur) >= POLY.promoteRate && level < POLY_KINDS.length - 1) {
      const gate =
        level === 0 ? this.engine.state.tiersUnlocked >= POLY.melodicTiersForDyads :
        level === 1 ? this.harmonic.state.tiersUnlocked >= POLY.harmonicTiersForChorale : true;
      if (gate) level += 1;
    } else if (level > 0 && cur.length >= POLY.window && rate(cur) < POLY.demoteRate) {
      level -= 1;
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
    this.engine = this.makeEngine(this.lo, this.hi, FLUENT_NORM_MS, 'engine');
    this.engine.startSession();
    this.harmonic = this.makeEngine(this.lo, this.hi, FLUENT_NORM_MS, 'harmonic');
    this.harmonic.startSession();
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
    this.remediationQueue = [];
    this.harmonicRemediationQueue = [];
    this.retry = null; // the passage in the corrective loop: { id, kind, tries, score }
    // A fresh tonal centre each session (src/tonalfield.js): fed every note the
    // player hears, read back to colour interval questions. It holds no key of
    // its own; the centre is whatever the recent notes imply.
    this.field = new TonalField();
    this.askedThisSession = new Set();
    this.passagesInARow = 0;
    this.anchor = anchor;
    this.prevAnchor = null;
    this.lastInputAt = performance.now();
    this.lastPlayedAt = this.audio.now;
    this.syncClock(1);
    this.state = 'QUESTION';
    const level = this.polyState.level;
    this.log(`session started: anchor ${name(anchor)}, range ${this.lo}..${this.hi}, tempo per excerpt (shortest note ${Math.round(this.floorSec * 1000)}ms), tiers ${this.engine.state.tiersUnlocked}${level > 0 ? `/${this.harmonic.state.tiersUnlocked} harmonic` : ''}, polyphony level ${level} (${LEVEL_NAMES[level]})`);

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

  /** Notes are { midi, b, dur, voice, free }. */
  intervalQuestion(kind, target) {
    return {
      kind,
      // The anchor is the note you just played, so the call sounds only the
      // target, on the downbeat. The anchor stays in the question, silent, a
      // beat before it: it is the target's melodic context for grading and
      // the free note you may echo or skip when you answer.
      notes: [{ midi: this.anchor, b: -1, dur: 1, voice: 0, free: true, silent: true }, { midi: target, b: 0, dur: 1, voice: 0 }],
      meter: 4,
      label: `${kind === 'interval' ? '' : `${kind}: `}${name(this.anchor)} -> ? (${signed(target - this.anchor)})`,
    };
  }

  /**
   * A GESTURE: the drilled anchor->target interval wrapped in a two- or
   * three-note musical figure in the emergent key, so an interval question is
   * sometimes a small phrase to play rather than a bare probe. The anchor
   * sounds (it is the figure's first note, free), the target is the graded
   * leap, and a diatonic step off the target -- toward the centre of the range
   * -- continues the line. When the target is chromatic in the current key,
   * that borrowed colour is exactly the point. Evidence goes to the engines at
   * passage scope, so gestures never move the interval tier ladder; the clean
   * isolated interval probes still own that.
   */
  gestureQuestion(target) {
    const k = this.field.key();
    const scale = k.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const inKey = (m) => scale.includes((((m - k.tonic) % 12) + 12) % 12);
    // A diatonic step off the target: the nearest scale tone 1-2 semitones
    // away, chosen toward the middle of the range so the line does not wander
    // to an edge. Falls back to a whole tone if the key gives nothing close.
    const mid = (this.lo + this.hi) / 2;
    const dir = target > mid ? -1 : 1;
    let step = null;
    for (const d of [dir, -dir]) {
      for (const semis of [1, 2]) {
        const cand = target + d * semis;
        if (cand >= this.lo && cand <= this.hi && inKey(cand)) { step = cand; break; }
      }
      if (step !== null) break;
    }
    const notes = [{ midi: this.anchor, b: 0, dur: 1, voice: 0, free: true }, { midi: target, b: 1, dur: 1, voice: 0 }];
    if (step !== null) notes.push({ midi: step, b: 2, dur: 2, voice: 0 });
    const tail = step === null ? '' : ` ${signed(step - target)}`;
    return {
      kind: 'gesture',
      gesture: true,
      notes,
      meter: 4,
      label: `gesture: ${name(this.anchor)} -> ${name(target)} (${signed(target - this.anchor)})${tail}${k.strength > 0 ? ` in ${keyName(k)}${this.field.diatonic(target, k) ? '' : ', borrowed'}` : ''}`,
    };
  }

  dyadQuestion(kind, target) {
    return {
      kind,
      dyad: true,
      notes: [{ midi: this.anchor, b: 0, dur: 2, voice: 0, free: true }, { midi: target, b: 0, dur: 2, voice: 1 }],
      meter: 4,
      label: `${kind}: ${name(this.anchor)} + ? (${signed(target - this.anchor)} together)`,
    };
  }

  passageQuestion(kind, picked) {
    const { phrase, notes, octave } = picked;
    const placed = notes.map(([midi, off, dur, voice], i) => ({ midi, b: phrase.pickup + off, dur, voice, free: i === phrase.pivot }));
    const pivotMidi = notes[phrase.pivot][0];
    const start = octave === 0 ? '' : `, starts ${name(pivotMidi)} (octave ${octave > 0 ? 'above' : 'below'} anchor)`;
    const poly = phrase.kind !== 'mono';
    return {
      kind,
      notes: placed,
      meter: phrase.meter,
      phrase,
      octave,
      label: `${kind === 'retry' ? 'retry: ' : ''}${poly ? `${phrase.kind}: ` : ''}${phrase.composer} ${phrase.catalog} "${phrase.title}" bar ${phrase.bar}, ${phrase.meter}-beat bars, ${poly ? `${phrase.voices} voices, ` : ''}${notes.length} notes in ${phrase.key || '?'}${start}`,
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

  /** A passage of this kind (first asking, not a retry) ended clean or not. */
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
      const picked = bank.pick(this.anchor, this.lo, this.hi, {
        engine: this.engine,
        harmonic: kind === 'mono' ? null : this.harmonic,
        kind,
        maxNotes: this.passageLength(kind),
        exclude: this.askedThisSession,
      });
      if (picked) return picked;
    }
    return null;
  }

  makeQuestion() {
    const engine = this.engine;
    const level = this.polyState.level;
    const prev = this.prevAnchor === null ? null : this.idx(this.prevAnchor);
    const a = this.idx(this.anchor);
    if (this.retry) {
      // Straight back, before anything else: the correction has to be adjacent
      // to the miss to be one. The phrase is re-placed on whatever note you
      // actually ended on, so it may come back in another key.
      const bank = this.retry.kind === 'mono' ? this.phrases : this.poly;
      const picked = bank ? bank.pickById(this.retry.id, this.anchor, this.lo, this.hi) : null;
      if (picked) return this.passageQuestion('retry', picked);
      this.log(`  (retry dropped: the phrase does not fit from ${name(this.anchor)})`);
      this.retry = null;
    }
    if (engine.discriminationQueue.length > 0) {
      const target = engine.nextTargetIndex(a, prev) + this.lo;
      return this.intervalQuestion(engine.servedQueue ? 'discrimination' : 'interval', target);
    }
    if (level >= 1 && this.harmonic.discriminationQueue.length > 0) {
      const target = this.harmonic.nextTargetIndex(a, null) + this.lo;
      return this.dyadQuestion(this.harmonic.servedQueue ? 'dyad discrimination' : 'dyad', target);
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
    if (this.phrases) {
      if ((this.streak >= STREAK_FOR_PASSAGE || this.cleanNotes >= CLEAN_NOTES_FOR_PASSAGE) && this.passagesInARow < MAX_PASSAGES_IN_A_ROW) {
        const picked = this.pickPassage();
        if (picked) return this.passageQuestion('passage', picked);
      }
    }
    this.plainQuestions += 1;
    if (level >= 1 && this.plainQuestions % POLY.dyadEvery === 0) {
      const target = this.harmonic.nextTargetIndex(a, null) + this.lo;
      return this.dyadQuestion('dyad', target);
    }
    const target = engine.nextTargetIndex(a, prev) + this.lo;
    // Once a key has emerged, a plain interval question is sometimes a gesture
    // instead -- the same drilled interval, made musical. Never during the
    // measurement-critical kinds above (they returned already).
    if (this.field.key().strength >= GESTURE_MIN_STRENGTH && Math.random() < GESTURE_RATE) {
      return this.gestureQuestion(target);
    }
    return this.intervalQuestion('interval', target);
  }

  beginQuestion() {
    if (this.rangeDirty) this.rebuildEngine();
    const q = this.nextQ || this.makeQuestion();
    this.nextQ = null;
    this.q = q;
    this.questions += 1;
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
    // Feed the tonal centre what the player hears. Each sounded call note goes
    // in; targets become the next anchor, so the centre tracks the whole walk.
    for (const [midi] of this.callNotes) this.field.observe(midi);
    this.callScheduled = 0;
    const lastCall = this.callNotes[this.callNotes.length - 1];
    this.callEndAt = lastCall[1] + Math.max(lastCall[2], this.beat);
    this.buildGroups(notes);
    this.earliestStart = this.callNotes[0][1] + this.beat; // one beat behind the call
    this.responseStarted = false;
    this.gi = 0;
    this.questionClean = true;
    this.remediated = 0;
    this.answered = false;
    this.lastNoteOn = null;
    this.held = new Map(); // midi -> { rowId, onAt, durSec } for notes awaiting release
    this.awaitingFinalize = false;
    if (q.phrase) this.askedThisSession.add(q.phrase.id);
    // Show the emergent centre on a bare interval question (a gesture's label
    // already carries it) once there is one, so the key forming across the
    // walk is visible in the log.
    const kk = this.field.key();
    const ctx = q.kind === 'interval' && kk.strength >= GESTURE_MIN_STRENGTH ? `  [${keyName(kk)}]` : '';
    this.log(`Q${this.questions}: ${q.label} @ ${this.bpm} bpm (±${this.toleranceMs.toFixed(0)}ms)${ctx}`);
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
    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi];
      const bass = Math.min(...g.notes.map((e) => e.midi));
      for (const e of g.notes) {
        const hist = lastInVoice.get(e.voice) || [];
        if (hist.length > 0) {
          e.melodicFrom = hist[0];
          e.melodicPrev = hist.length > 1 ? hist[1] : (e.free || gi > 0 ? null : this.prevAnchor);
        } else if (gi > 0 && this.q.notes.length > 0 && !this.q.dyad) {
          // a voice entering late: measured from the anchor's line is meaningless; leave melodic null
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
      if (performance.now() - idleSince > TIMEOUT_MS) {
        this.endSession('10s of silence');
        return;
      }
    }
    const horizon = now + SCHEDULE_AHEAD_S;
    while (this.scheduledUntil < horizon) {
      const beatIndex = Math.round((this.scheduledUntil - this.nextBarAt) / this.beat);
      const beatTime = this.nextBarAt + beatIndex * this.beat;
      if (beatTime >= now && beatTime < horizon) {
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
    if (this.responseStarted && !this.answered && this.keysDown.size === 0) {
      // A beat of silence once the pending group's time has come means you
      // are done, whatever is left: the rest is missed and the reply comes.
      const g = this.groups[this.gi];
      const quietSince = Math.max(this.lastPlayedAt ?? -Infinity, this.lastReleasedAt ?? -Infinity, g.at);
      if (now >= quietSince + QUIET_BEATS_BEFORE_NEXT * this.beat - this.toleranceMs / 1000) this.abandonResponse();
    }
    if (this.answered) {
      // The reply comes as soon as you have been silent for a beat: no key
      // down, nothing pressed or released for QUIET_BEATS_BEFORE_NEXT beats.
      // The next call starts on the first click after that. The pulse itself
      // never moves; only the bar's accent pattern restarts there.
      if (this.keysDown.size === 0) {
        const quietSince = Math.max(this.lastPlayedAt ?? -Infinity, this.lastReleasedAt ?? -Infinity);
        // A release within the timing tolerance after a click counts as on it.
        const earliest = quietSince - this.toleranceMs / 1000 + QUIET_BEATS_BEFORE_NEXT * this.beat;
        const n = Math.ceil((earliest - this.nextBarAt) / this.beat - 1e-6);
        this.nextQuestionAt = this.nextBarAt + n * this.beat;
      } else {
        this.nextQuestionAt = Infinity;
      }
      if (now >= this.nextQuestionAt - SCHEDULE_AHEAD_S) {
        if (this.awaitingFinalize) this.finalizeQuestion();
        this.nextBarAt = this.nextQuestionAt;
        this.beginQuestion();
      }
    }
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
    // when it matches it, or whenever the anchor was never sounded: with a
    // silent anchor, a wrong first note is a wrong target, not a wrong anchor.
    if (g.length > 1 && g[0].notes.every((e) => e.free) && !g[0].notes.some((e) => this.matches(e, note)) &&
        (g[1].notes.some((e) => !e.free && this.matches(e, note)) || g[0].notes.every((e) => e.silent))) {
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
      this.questionClean = false;
      this.cleanNotes = 0;
      this.log(`  hold ${heldSec < shortMin ? 'short' : 'long'} ${(heldSec * 1000).toFixed(0)}ms (want ~${(h.heardSec * 1000).toFixed(0)}ms)`);
    }
  }

  handleAnswer(note, velocity, atAudio) {
    if (this.answered) return; // between questions: free play
    if (!this.responseStarted) {
      if (atAudio < this.earliestStart - this.beat / 2) return; // still the call: free
      this.startResponse(note, atAudio);
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
      // Wrong note: it consumes the nearest pending note of the group (a
      // graded one if any is left).
      const cands = pending(g).filter((e) => !e.free);
      const pool = cands.length ? cands : pending(g);
      exp = pool.reduce((best, e) => (Math.abs(e.midi - note) < Math.abs(best.midi - note) ? e : best), pool[0]);
      correct = false;
    }
    this.gradeNote(g, exp, note, velocity, atAudio, correct);
    exp.done = true;
    exp.played = note;
    if (pending(g).every((e) => e.free)) {
      for (const e of g.notes) e.done = true;
      this.gi += 1;
      if (this.gi >= this.groups.length) this.completeQuestion(atAudio);
    }
  }

  /**
   * ONE attempt per note, on pitch AND timing (against its group's onset).
   * Each of the note's skills is reported to its engine. `atAudio` null =
   * the note was never played (its group was abandoned).
   */
  gradeNote(g, exp, note, velocity, atAudio, correct, { abandoned = false } = {}) {
    const onsetMs = atAudio === null ? null : (atAudio - g.at) * 1000;
    const tol = Math.min(this.toleranceMs, 0.4 * g.gapMs);
    const inTime = correct && onsetMs !== null && Math.abs(onsetMs) <= tol;
    // A gesture is scored like a passage for engine evidence: its intervals are
    // heard in context, so they inform the engine at passage scope but never
    // move the interval tier ladder, which only clean isolated probes own.
    const passage = Boolean(this.q.phrase) || Boolean(this.q.gesture);
    const rtNorm = inTime ? Math.min(Math.abs(onsetMs), this.beat * 1000) / this.beat : null;
    const from = exp.melodicFrom ?? exp.harmonicFrom ?? this.anchor;
    if (exp.graded) {
      if (exp.melodicFrom !== null && exp.melodicFrom !== exp.midi) {
        const iv = exp.midi - exp.melodicFrom;
        const prev = exp.melodicPrev;
        if (passage) this.engine.ask(iv, this.idx(exp.melodicFrom), prev === null ? null : this.idx(prev), { scope: 'passage' });
        if (!correct) {
          this.engine.reportMiss(this.idx(exp.melodicFrom), this.idx(note), { confuse: !passage });
          if (passage && Math.abs(iv) >= 3 && this.remediated < REMEDIATE_MAX_PER_PASSAGE &&
              this.engine.predictedAcc(iv, this.idx(exp.melodicFrom)) < 0.8) {
            this.remediationQueue.push(iv);
            this.remediated += 1;
          }
        }
        this.engine.reportResolved(rtNorm);
      }
      if (exp.harmonicFrom !== null) {
        const iv = exp.midi - exp.harmonicFrom;
        const dyad = Boolean(this.q.dyad);
        if (!dyad) this.harmonic.ask(iv, this.idx(exp.harmonicFrom), null, { scope: 'passage' });
        if (!correct) {
          this.harmonic.reportMiss(this.idx(exp.harmonicFrom), this.idx(note), { confuse: dyad });
          if (!dyad && this.polyState.level >= 1 && this.remediated < REMEDIATE_MAX_PER_PASSAGE &&
              this.harmonic.predictedAcc(iv, this.idx(exp.harmonicFrom)) < 0.8) {
            this.harmonicRemediationQueue.push(iv);
            this.remediated += 1;
          }
        }
        this.harmonic.reportResolved(rtNorm);
      }
    }
    const rowId = this.db.attempt({
      sessionId: this.sessionId, anchor: from, target: exp.midi, played: note, velocity, correct,
      firstAttempt: true, onsetMs, question: this.questions, kind: this.q.kind,
      phraseId: this.q.phrase?.id ?? null, position: g.index, graded: exp.graded, inTime, beatMs: this.beat * 1000,
    });
    // Remember this key press so its release can be graded for duration.
    if (exp.graded && correct) {
      const durSec = exp.dur * this.beat;
      this.held.set(note, { rowId, onAt: atAudio, durSec, heardSec: Math.min(durSec, CALL_MAX_S) });
    }
    const noteClean = correct && inTime;
    if (noteClean && exp.graded) this.cleanNotes += 1;
    else if (!noteClean) this.cleanNotes = 0;
    if (!noteClean) this.questionClean = false;
    const chord = g.notes.length > 1 ? ` [chord ${g.index + 1}]` : '';
    if (abandoned) {
      this.log(`  missed ${name(exp.midi)}${chord}`);
      return;
    }
    const why = correct ? '' : ` (${exp.melodicFrom !== null ? signed(exp.midi - exp.melodicFrom) : exp.harmonicFrom !== null ? `+${exp.midi - exp.harmonicFrom} above bass` : 'anchor'})`;
    this.log(
      `  ${correct ? 'correct' : `x ${name(note)} wanted`} ${name(exp.midi)}${why}${chord}, onset ${onsetMs >= 0 ? '+' : ''}${onsetMs.toFixed(0)}ms${correct && !inTime ? (onsetMs < 0 ? ' EARLY' : ' LATE') : ''}`,
    );
  }

  /** You stopped before the end: every note still pending is a miss. */
  abandonResponse() {
    let missed = 0;
    const last = this.lastNoteOn?.midi ?? this.anchor;
    for (let gi = this.gi; gi < this.groups.length; gi += 1) {
      const g = this.groups[gi];
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
    this.questionClean = false;
    this.log(`  response ended after a beat of silence: ${missed} note${missed === 1 ? '' : 's'} missed`);
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
    this.prevAnchor = n >= 2 ? top(this.groups[n - 2]) : this.anchor;
    this.anchor = top(this.groups[n - 1]);
    // When the next question starts is decided in tick(): a beat of silence.
    this.nextQuestionAt = Infinity;
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
    this.streak = this.questionClean ? this.streak + 1 : 0;
    this.passagesInARow = q.phrase ? this.passagesInARow + 1 : 0;
    if (q.phrase) {
      this.cleanNotes = 0;
      this.passagesDone += 1;
      const bank = q.phrase.kind === 'mono' ? this.phrases : this.poly;
      bank.record(q.phrase.id, this.questionClean);
      this.recordPolyOutcome(q.phrase.kind, this.questionClean);
      if (q.kind !== 'retry') this.updatePassageLength(q.phrase.kind, this.questionClean);
      // The rungs beneath exact pitch, kept per passage so an encounter can be
      // compared with the last one (src/rungs.js). `played` is only ever set on
      // a note that was struck; a note the player never reached stays null.
      const rungs = summarizeRungs(
        this.groups.flatMap((g) => g.notes.map((e) => ({ expected: e.midi, played: e.played ?? null, free: e.free || e.silent, b: g.b, voice: e.voice }))),
      );
      this.db.passage({
        sessionId: this.sessionId, question: this.questions, phraseId: q.phrase.id, kind: q.phrase.kind, qkind: q.kind,
        bpm: this.bpm, clean: this.questionClean, ...rungs,
      });
      const verdict = this.retryVerdict(q, rungs, bank);
      const tail = this.questionClean ? (verdict ? ` -- ${verdict}` : '') : ` -- ${describeRungs(rungs)}; ${verdict}`;
      this.log(`  passage ${this.questionClean ? 'clean' : 'done with errors'} (streak ${this.streak})${tail}`);
    }
    this.nextQ = this.makeQuestion();
  }

  /**
   * THE CORRECTIVE LOOP. A failed passage comes straight back: hearing the
   * call again right after missing it says both that you missed and what it
   * actually sounds like, and the retry is the chance to use that. It keeps
   * coming back while the rungs say you are getting closer (rungScore), up to
   * RETRY_MAX_TRIES attempts in all; nailing it is the reward -- you move on.
   * No closer, or out of tries, means it is too hard just yet: the phrase
   * rests (PhraseBank.rest) instead of being hammered. Returns the log verdict.
   */
  retryVerdict(q, rungs, bank) {
    const score = rungScore(rungs);
    const loop = q.kind === 'retry' ? this.retry ?? { tries: 1, score: -1 } : null;
    if (this.questionClean) {
      this.retry = null;
      return loop ? `nailed on try ${loop.tries + 1}` : '';
    }
    if (!loop) {
      this.retry = { id: q.phrase.id, kind: q.phrase.kind, tries: 1, score };
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

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function name(midi) {
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}
export { TIER_WIDTHS, WARMUP_QUESTIONS };
