// The drill state machine. Everything is decided from the keyboard and from
// history; there are no settings.
//
//   IDLE      no metronome. The first note played (velocity >= 20) becomes
//             the anchor and starts a session. Tempo for the session is
//             chosen from your in-time history (see chooseTempo).
//   QUESTION  metronome throughout. A question is a CALL (notes the app
//             plays) and your RESPONSE: the same notes, same rhythm. THE
//             RESPONSE STARTS WHEN YOU START PLAYING. You may follow the
//             call one beat behind, like a canon, or wait as many clicks as
//             you like; your first note snaps to the nearest click (keeping
//             the phrase's own beat fraction), the rest of the phrase is
//             expected relative to it, and the bar accents re-align to your
//             entry. The first note is the anchor you already know, so it is
//             free; you may also skip it and begin with the second note.
//               interval:  call = anchor on beat 1, target on beat 3;
//                          graded = the target.
//               passage:   call = a real phrase transposed to start on the
//                          anchor, in its own meter with its pickup;
//                          graded = every note after the first.
//             WHICH KIND: a discrimination run or a remediation interval
//             (an interval you missed inside a passage) always comes first;
//             a passage you failed earlier is retried a couple of questions
//             later; otherwise three clean questions in a row (correct AND
//             in time) earn a passage, and clean passages keep them coming,
//             with an interval question after every three passages so the
//             tier ladder (which only interval questions move) keeps rising.
//             Passage length is capped by the engine's unlocked tiers and
//             its fastest note by the session tempo.
//             GRADING: ONE pass. Each note you play is matched by position to
//             the next expected note and judged on pitch, on timing (onset vs
//             the constant grid, the first note included) AND on how long you
//             hold it (cutting a note short or overholding is a defect), then
//             the next note is expected. There are no retries and NO feedback sounds:
//             the system's reply is simply the next question it chooses -- a
//             harder one, a passage, a drill on an interval you missed, or a
//             failed phrase again. The last note becomes the next anchor. Ten
//             seconds of silence ends the session.
//
// The ONLY sounds are the metronome, the call (the system's turn), the echo
// of the keys you press (the controller has no sound of its own, so this
// process IS the piano), and a two-note tone when the session ends.

import { TIER_WIDTHS, WARMUP_QUESTIONS } from './engine.js';

const TIMEOUT_MS = 10000;
const MIN_VELOCITY = 20; // key brushes are echoed but never graded
const SCHEDULE_AHEAD_S = 0.15;
const TICK_MS = 25;
// Articulation between consecutive call notes: at least this long, or this
// fraction of the gap between their onsets.
const CALL_GAP_MIN_S = 0.03;
const CALL_GAP_FRAC = 0.12;
const STREAK_FOR_PASSAGE = 3;
const CLEAN_NOTES_FOR_PASSAGE = 6; // clean graded notes (any kind) also earn a passage
const RETRY_AFTER_QUESTIONS = 2;
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
const MIN_NOTE_SEC = 0.15; // fastest passage note allowed at the session tempo
export const TEMPO = { default: 80, min: 50, max: 132, step: 4, window: 40, minRows: 20, minCorrect: 10, up: 0.8, down: 0.5 };

export class Drill {
  /**
   * @param {object} deps
   * @param {import('./audio.js').Audio} deps.audio
   * @param {import('./db.js').Db} deps.db
   * @param {import('./range.js').RangeTracker} deps.range
   * @param {(lo: number, hi: number, fluentMs: number) => import('./engine.js').AdaptiveEngine} deps.makeEngine
   * @param {import('./phrases.js').PhraseBank|null} deps.phrases
   * @param {(msg: string) => void} deps.log
   * @param {number} [deps.bpmOverride]  debugging only
   */
  constructor({ audio, db, range, makeEngine, phrases, log, bpmOverride = null }) {
    this.keysDown = new Set(); // every key currently down, graded or not
    this.lastReleasedAt = null; // audio time of the last key-up
    this.audio = audio;
    this.db = db;
    this.range = range;
    this.makeEngine = makeEngine;
    this.phrases = phrases;
    this.log = log;
    this.bpmOverride = bpmOverride;
    this.baseBpmStore = db.kv('baseBpm');
    this.state = 'IDLE';
    this.clockOffset = performance.now() / 1000 - audio.now;
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

  /** One tempo per session, from the in-time rate of recent correct first attempts. */
  chooseTempo() {
    if (this.bpmOverride) return this.bpmOverride;
    const clamp = (b) => Math.max(TEMPO.min, Math.min(TEMPO.max, Math.round(b)));
    const prev = clamp(this.baseBpmStore.load()?.bpm ?? TEMPO.default);
    const rows = this.db.recentGraded(TEMPO.window);
    if (rows.length < TEMPO.minRows) return prev;
    const correct = rows.filter((r) => r.correct);
    if (correct.length < TEMPO.minCorrect) return prev;
    const inTime = correct.filter((r) => r.in_time).length / correct.length;
    let bpm = prev;
    if (inTime >= TEMPO.up) bpm += TEMPO.step;
    else if (inTime < TEMPO.down) bpm -= TEMPO.step;
    return clamp(bpm);
  }

  // --- session -------------------------------------------------------------

  startSession(anchor) {
    const { lo, hi } = this.range.current;
    this.lo = Math.min(lo, anchor);
    this.hi = Math.max(hi, anchor);
    this.rangeDirty = false;
    this.engine = this.makeEngine(this.lo, this.hi, FLUENT_NORM_MS);
    this.engine.startSession();
    this.bpm = this.chooseTempo();
    if (!this.bpmOverride) this.baseBpmStore.save({ bpm: this.bpm });
    this.beat = 60 / this.bpm;
    this.toleranceMs = Math.max(45, Math.min(110, 7500 / this.bpm));
    this.sessionId = this.db.newSession({ bpm: this.bpm, anchor });
    this.questions = 0;
    this.passagesDone = 0;
    this.streak = 0;
    this.cleanNotes = 0;
    this.remediationQueue = [];
    this.retryQueue = [];
    this.askedThisSession = new Set();
    this.passagesInARow = 0;
    this.anchor = anchor;
    this.prevAnchor = null;
    this.lastInputAt = performance.now();
    this.lastPlayedAt = this.audio.now;
    this.syncClock(1);
    this.state = 'QUESTION';
    this.log(`session started: anchor ${name(anchor)}, range ${this.lo}..${this.hi}, ${this.bpm} bpm (±${this.toleranceMs.toFixed(0)}ms), tiers ${this.engine.state.tiersUnlocked}`);

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

  intervalQuestion(kind, target) {
    return {
      kind,
      // The anchor rings until the target: a call never holds a beat of silence.
      call: [[this.anchor, 0], [target, 2]],
      graded: [[this.anchor, 0], [target, 2]],
      durs: [2, 1],
      meter: 4,
      gradeFrom: 1,
      label: `${kind === 'interval' ? '' : `${kind}: `}${name(this.anchor)} -> ? (${signed(target - this.anchor)})`,
    };
  }

  passageQuestion(kind, picked) {
    const { phrase, notes, octave } = picked;
    const last = notes[notes.length - 1];
    const span = phrase.pickup + last[1] + last[2];
    const placed = notes.map(([midi, off]) => [midi, phrase.pickup + off]);
    const start = octave === 0 ? '' : `, starts ${name(notes[0][0])} (octave ${octave > 0 ? 'above' : 'below'} anchor)`;
    return {
      kind,
      call: placed,
      graded: placed,
      durs: notes.map((n) => n[2]),
      meter: phrase.meter,
      gradeFrom: 1,
      phrase,
      octave,
      label: `${kind === 'retry' ? 'retry: ' : ''}${phrase.composer} ${phrase.catalog} "${phrase.title}" bar ${phrase.bar}, ${phrase.meter}-beat bars, ${notes.length} notes in ${phrase.key || '?'}${start}`,
    };
  }

  makeQuestion() {
    const engine = this.engine;
    const prev = this.prevAnchor === null ? null : this.idx(this.prevAnchor);
    if (engine.discriminationQueue.length > 0) {
      const target = engine.nextTargetIndex(this.idx(this.anchor), prev) + this.lo;
      return this.intervalQuestion(engine.servedQueue ? 'discrimination' : 'interval', target);
    }
    while (this.remediationQueue.length > 0) {
      const raw = this.remediationQueue.shift();
      const iv = engine.inwardVariant(raw, this.idx(this.anchor));
      if (iv !== null) {
        const target = engine.ask(iv, this.idx(this.anchor), prev) + this.lo;
        return this.intervalQuestion('remediation', target);
      }
    }
    if (this.phrases) {
      const retry = this.retryQueue[0];
      if (retry && this.questions - retry.askedAt >= RETRY_AFTER_QUESTIONS) {
        this.retryQueue.shift();
        const picked = this.phrases.pickById(retry.id, this.anchor, this.lo, this.hi);
        if (picked) return this.passageQuestion('retry', picked);
      }
      if ((this.streak >= STREAK_FOR_PASSAGE || this.cleanNotes >= CLEAN_NOTES_FOR_PASSAGE) && this.passagesInARow < MAX_PASSAGES_IN_A_ROW) {
        const picked = this.phrases.pick(this.anchor, this.lo, this.hi, {
          engine,
          maxNotes: 3 + engine.state.tiersUnlocked,
          beatSec: this.beat,
          minNoteSec: MIN_NOTE_SEC,
          exclude: this.askedThisSession,
        });
        if (picked) return this.passageQuestion('passage', picked);
      }
    }
    const target = engine.nextTargetIndex(this.idx(this.anchor), prev) + this.lo;
    return this.intervalQuestion('interval', target);
  }

  beginQuestion() {
    if (this.rangeDirty) this.rebuildEngine();
    const q = this.nextQ || this.makeQuestion();
    this.nextQ = null;
    this.q = q;
    this.questions += 1;
    this.engine.beginQuestion();
    this.meter = q.meter;
    const t0 = this.nextBarAt;
    // Each call note sounds for its written length, but never into the next
    // note: a short articulation gap before every onset keeps a fast note
    // short and a repeated pitch a clear re-attack, so the rhythm is unambiguous.
    this.callNotes = q.call.map(([midi, b], i) => {
      const at = t0 + b * this.beat;
      let dur = Math.min(2, q.durs[i] * this.beat);
      const next = q.call[i + 1];
      if (next) {
        const gap = (next[1] - b) * this.beat;
        dur = Math.min(dur, gap - Math.max(CALL_GAP_MIN_S, CALL_GAP_FRAC * gap));
      }
      return [midi, at, Math.max(0.05, dur)];
    });
    this.callScheduled = 0;
    const lastCall = this.callNotes[this.callNotes.length - 1];
    this.callEndAt = lastCall[1] + Math.max(lastCall[2], this.beat);
    // Expected notes carry their beat offsets; `.at` is filled in when the
    // response starts (your first note sets the grid).
    this.expected = q.graded.map(([midi, b], i) => ({ midi, b, dur: q.durs[i], at: null, acceptFrom: null, gapMs: null }));
    this.earliestStart = this.callNotes[0][1] + this.beat; // one beat behind the call
    this.responseStarted = false;
    this.k = 0;
    this.questionClean = true;
    this.remediated = 0;
    this.answered = false;
    this.lastAccepted = null;
    this.lastNoteOn = null;
    this.held = new Map(); // midi -> { rowId, onAt, durSec } for notes awaiting release
    this.awaitingFinalize = false;
    if (q.phrase) this.askedThisSession.add(q.phrase.id);
    this.log(`Q${this.questions}: ${q.label}`);
  }

  rebuildEngine() {
    const { lo, hi } = this.range.current;
    const newLo = Math.min(lo, this.anchor);
    const newHi = Math.max(hi, this.anchor);
    if (newLo === this.lo && newHi === this.hi) {
      this.rangeDirty = false;
      return;
    }
    const old = this.engine;
    this.engine = this.makeEngine(newLo, newHi, FLUENT_NORM_MS);
    this.engine.adopt(old, this.lo - newLo);
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

  /**
   * Your first note starts the response. It may be the phrase's first note
   * (the anchor) or, since you already know that one, its second note. It
   * snaps to the nearest beat that keeps the phrase's own beat fraction, at
   * least one beat behind the call; every later note is expected relative
   * to it, and the bar line moves so the accents fit the phrase.
   */
  startResponse(note, atAudio) {
    const e = this.expected;
    let j = 0;
    if (
      this.q.gradeFrom === 1 && e.length > 1 && note !== e[0].midi && note === e[1].midi &&
      !(this.q.octave && note === this.anchor)
    ) j = 1;
    const callAt = this.callNotes[j][1];
    const behind = Math.max(1, Math.round((atAudio - callAt) / this.beat));
    const T = callAt + behind * this.beat;
    for (let k = 0; k < e.length; k += 1) e[k].at = T + (e[k].b - e[j].b) * this.beat;
    let prevAt = T - this.beat; // the first note's own window is +/- half a beat
    for (let k = j; k < e.length; k += 1) {
      const gap = e[k].at - prevAt;
      e[k].gapMs = gap * 1000;
      e[k].acceptFrom = e[k].at - Math.min(this.beat / 2, gap / 2);
      prevAt = e[k].at;
    }
    this.k = j;
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
    const shortMin = DUR_SHORT_FRAC * h.durSec;
    const longMax = DUR_LONG_FRAC * h.durSec + DUR_LONG_PAD_S;
    const ok = heldSec >= shortMin && (stillHeld || heldSec <= longMax);
    this.db.updateHeld(h.rowId, heldSec * 1000, ok);
    if (!ok) {
      this.questionClean = false;
      this.cleanNotes = 0;
      this.log(`  hold ${heldSec < shortMin ? 'short' : 'long'} ${(heldSec * 1000).toFixed(0)}ms (want ~${(h.durSec * 1000).toFixed(0)}ms)`);
    }
  }

  handleAnswer(note, velocity, atAudio) {
    if (this.answered) return; // between questions: free play
    if (!this.responseStarted) {
      if (atAudio < this.earliestStart - this.beat / 2) return; // still the call: free
      this.startResponse(note, atAudio);
    }
    const exp = this.expected[this.k];
    if (atAudio < exp.acceptFrom) return; // ahead of this note's slot: free
    // Ignore an exact double-trigger of the same key (hardware bounce, or a
    // controller that sends on two ports at once).
    if (this.lastNoteOn && note === this.lastNoteOn.midi && atAudio - this.lastNoteOn.at < DEBOUNCE_S) {
      this.lastNoteOn = { midi: note, at: atAudio };
      return;
    }
    this.lastNoteOn = { midi: note, at: atAudio };

    const onsetMs = (atAudio - exp.at) * 1000;
    const correct = note === exp.midi || (this.k === 0 && this.q.octave && note === this.anchor);
    const prevMidi = this.k === 0 ? this.anchor : this.expected[this.k - 1].midi;
    const graded = this.k >= this.q.gradeFrom && exp.midi !== prevMidi;
    const passage = Boolean(this.q.phrase);
    const iv = exp.midi - prevMidi;
    const tol = Math.min(this.toleranceMs, 0.4 * exp.gapMs);
    const inTime = correct && Math.abs(onsetMs) <= tol;

    // ONE attempt per note, graded by position on pitch AND timing. No sound
    // is made: the system's reply is the next question it chooses. Playing a
    // wrong note or an off-beat note just shapes what comes next.
    if (graded) {
      if (passage) {
        const prev2 = this.k >= 2 ? this.expected[this.k - 2].midi : this.prevAnchor;
        this.engine.ask(iv, this.idx(prevMidi), prev2 === null ? null : this.idx(prev2), { scope: 'passage' });
      }
      if (!correct) {
        this.engine.reportMiss(this.idx(prevMidi), this.idx(note), { confuse: !passage });
        if (passage && Math.abs(iv) >= 3 && this.remediated < REMEDIATE_MAX_PER_PASSAGE &&
            this.engine.predictedAcc(iv, this.idx(prevMidi)) < 0.8) {
          this.remediationQueue.push(iv);
          this.remediated += 1;
        }
      }
      const rtNorm = inTime ? Math.min(Math.abs(onsetMs), this.beat * 1000) / this.beat : null;
      this.engine.reportResolved(rtNorm);
    }
    const rowId = this.db.attempt({
      sessionId: this.sessionId, anchor: prevMidi, target: exp.midi, played: note, velocity, correct,
      firstAttempt: true, onsetMs, question: this.questions, kind: this.q.kind,
      phraseId: this.q.phrase?.id ?? null, position: this.k, graded, inTime, beatMs: this.beat * 1000,
    });
    // Remember this key press so its release can be graded for duration.
    if (graded && correct) this.held.set(note, { rowId, onAt: atAudio, durSec: exp.dur * this.beat });
    const noteClean = correct && inTime;
    if (noteClean && graded) this.cleanNotes += 1;
    else if (!noteClean) this.cleanNotes = 0;
    if (!noteClean) this.questionClean = false;
    this.log(
      `  ${correct ? 'correct' : `x ${name(note)} wanted`} ${name(exp.midi)}${correct ? '' : ` (${this.k === 0 ? 'anchor' : signed(iv)})`}, onset ${onsetMs >= 0 ? '+' : ''}${onsetMs.toFixed(0)}ms${correct && !inTime ? (onsetMs < 0 ? ' EARLY' : ' LATE') : ''}`,
    );

    this.lastAccepted = { midi: note, at: atAudio };
    this.k += 1;
    if (this.k >= this.expected.length) this.completeQuestion(exp, atAudio);
  }

  /** All notes played. Mark the response done; grade releases and choose the
   *  next question at finalize (so a note still held now is still graded). */
  completeQuestion(exp, atAudio) {
    this.answered = true;
    this.awaitingFinalize = true;
    const n = this.expected.length;
    this.prevAnchor = n >= 2 ? this.expected[n - 2].midi : this.anchor;
    this.anchor = exp.midi;
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
      this.phrases.record(q.phrase.id, this.questionClean);
      if (!this.questionClean && q.kind !== 'retry') this.retryQueue.push({ id: q.phrase.id, askedAt: this.questions });
      this.log(`  passage ${this.questionClean ? 'clean' : 'done with errors'} (streak ${this.streak})`);
    }
    this.nextQ = this.makeQuestion();
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
