// The drill state machine. Everything is decided from the keyboard and from
// history; there are no settings.
//
//   IDLE      no metronome. The first note played (velocity >= 20) becomes
//             the anchor and starts a session. Tempo for the session is
//             chosen from your in-time history (see chooseTempo).
//   QUESTION  metronome throughout. A question is a CALL (notes the app
//             plays, spanning `bars` bars) followed, after any rest bar
//             needed so the call has finished, by a RESPONSE of the same
//             length in which you play the GRADED notes at the same beat
//             positions. The response downbeat is a double tick.
//               interval:  call = anchor on beat 1, target on beat 3 (one bar);
//                          graded = the target only (the anchor is free).
//               passage:   call = a real phrase transposed to start on the
//                          anchor, in its own meter with its pickup;
//                          graded = every note of it.
//             WHICH KIND: a discrimination run or a remediation interval
//             (an interval you missed inside a passage) always comes first;
//             a passage you failed earlier is retried a couple of questions
//             later; otherwise three clean questions in a row (correct AND
//             in time) earn a passage, and clean passages keep them coming,
//             with an interval question after every three passages so the
//             tier ladder (which only interval questions move) keeps rising.
//             Passage length is capped by the engine's unlocked tiers and
//             its fastest note by the session tempo.
//             GRADING: each note-on is matched against the next graded note
//             once its own accept window has opened (notes before that are
//             free play). Right pitch -> onset error recorded, advance;
//             wrong pitch -> miss (buzz), stay on that note, retries free.
//             After 2 misses the app demonstrates the note; after 4 it
//             replays the previous note and the target; after 6 it plays the
//             note for you and moves on (scored as a miss).
//             The last note becomes the next anchor. Silence for 10 s once
//             an answer was possible ends the session.
//
// Every note-on is echoed through the synth: the controller has no sounds
// of its own, so this process IS the piano.

import { TIER_WIDTHS, WARMUP_QUESTIONS } from './engine.js';

const TIMEOUT_MS = 10000;
const MIN_VELOCITY = 20; // key brushes are echoed but never graded
const SCHEDULE_AHEAD_S = 0.15;
const TICK_MS = 25;
const STREAK_FOR_PASSAGE = 3;
const RETRY_AFTER_QUESTIONS = 2;
const REMEDIATE_MAX_PER_PASSAGE = 2;
const MAX_PASSAGES_IN_A_ROW = 3; // interval questions are what move the tier ladder
const DEBOUNCE_S = 0.06;
const FLUENT_NORM_MS = 120; // mastery: onset error <= 12% of a beat (ms at 60 bpm)
const MIN_NOTE_SEC = 0.15; // fastest passage note allowed at the session tempo
export const TEMPO = { default: 72, min: 50, max: 132, step: 4, window: 40, minRows: 20, minCorrect: 10, up: 0.8, down: 0.5 };

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
    this.audio = audio;
    this.db = db;
    this.range = range;
    this.makeEngine = makeEngine;
    this.phrases = phrases;
    this.log = log;
    this.bpmOverride = bpmOverride;
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
    this.audio.note(note, { velocity });
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
    this.handleAnswer(note, velocity, this.perfToAudio(at));
  }

  // --- tempo ---------------------------------------------------------------

  /** One tempo per session, from the in-time rate of recent correct first attempts. */
  chooseTempo() {
    if (this.bpmOverride) return this.bpmOverride;
    const prev = this.db.lastBpm() ?? TEMPO.default;
    const rows = this.db.recentGraded(TEMPO.window);
    if (rows.length < TEMPO.minRows) return prev;
    const correct = rows.filter((r) => r.correct);
    if (correct.length < TEMPO.minCorrect) return prev;
    const inTime = correct.filter((r) => r.in_time).length / correct.length;
    let bpm = prev;
    if (inTime >= TEMPO.up) bpm += TEMPO.step;
    else if (inTime < TEMPO.down) bpm -= TEMPO.step;
    return Math.max(TEMPO.min, Math.min(TEMPO.max, Math.round(bpm)));
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
    this.beat = 60 / this.bpm;
    this.toleranceMs = Math.max(45, Math.min(110, 7500 / this.bpm));
    this.sessionId = this.db.newSession({ bpm: this.bpm, anchor });
    this.questions = 0;
    this.passagesDone = 0;
    this.streak = 0;
    this.remediationQueue = [];
    this.retryQueue = [];
    this.askedThisSession = new Set();
    this.passagesInARow = 0;
    this.anchor = anchor;
    this.prevAnchor = null;
    this.lastInputAt = performance.now();
    this.syncClock(1);
    this.state = 'QUESTION';
    this.log(`session started: anchor ${name(anchor)}, range ${this.lo}..${this.hi}, ${this.bpm} bpm (±${this.toleranceMs.toFixed(0)}ms), tiers ${this.engine.state.tiersUnlocked}`);

    // The anchor rings for a beat, then the grid starts on an accented downbeat.
    this.nextBarAt = this.audio.now + this.beat;
    this.scheduledUntil = this.nextBarAt;
    this.meter = 4;
    this.responseStartAt = -1;
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
      call: [[this.anchor, 0], [target, 2]],
      graded: [[target, 2]],
      durs: [1, 1],
      meter: 4,
      bars: 1,
      restBars: 0,
      gradeFrom: 0,
      label: `${kind === 'interval' ? '' : `${kind}: `}${name(this.anchor)} -> ? (${signed(target - this.anchor)})`,
    };
  }

  passageQuestion(kind, picked) {
    const { phrase, notes, octave } = picked;
    const last = notes[notes.length - 1];
    const span = phrase.pickup + last[1] + last[2];
    const bars = Math.max(1, Math.ceil(span / phrase.meter - 1e-9));
    const lastOnset = phrase.pickup + last[1];
    const restBars = bars * phrase.meter - lastOnset < 1 ? 1 : 0;
    const placed = notes.map(([midi, off]) => [midi, phrase.pickup + off]);
    const start = octave === 0 ? '' : `, starts ${name(notes[0][0])} (octave ${octave > 0 ? 'above' : 'below'} anchor)`;
    return {
      kind,
      call: placed,
      graded: placed,
      durs: notes.map((n) => n[2]),
      meter: phrase.meter,
      bars,
      restBars,
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
      return this.intervalQuestion(target === this.anchor ? 'interval' : 'discrimination', target);
    }
    while (this.remediationQueue.length > 0) {
      const iv = this.remediationQueue.shift();
      if (engine.feasible(this.idx(this.anchor), iv)) {
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
      if (this.streak >= STREAK_FOR_PASSAGE && this.passagesInARow < MAX_PASSAGES_IN_A_ROW) {
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
    const responseOffset = (q.bars + q.restBars) * q.meter * this.beat;
    this.responseStartAt = t0 + responseOffset;
    this.callNotes = q.call.map(([midi, b], i) => [midi, t0 + b * this.beat, Math.min(2, q.durs[i] * this.beat)]);
    this.callScheduled = 0;
    const lastCallAt = this.callNotes[this.callNotes.length - 1][1];
    this.expected = q.graded.map(([midi, b]) => ({ midi, at: t0 + b * this.beat + responseOffset }));
    // Each graded note accepts input from halfway back to the previous event.
    let prevAt = lastCallAt;
    for (const e of this.expected) {
      const gap = e.at - prevAt;
      e.gapMs = gap * 1000;
      e.acceptFrom = e.at - Math.min(this.beat / 2, gap / 2);
      prevAt = e.at;
    }
    this.windowOpensAt = this.expected[0].acceptFrom;
    this.k = 0;
    this.firstAttempt = true;
    this.missesOnNote = 0;
    this.prevNoteClean = true;
    this.questionClean = true;
    this.remediated = 0;
    this.answered = false;
    this.lastAccepted = null;
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
    const idleSince = Math.max(this.lastInputAt, this.audioToPerf(this.windowOpensAt));
    if (performance.now() - idleSince > TIMEOUT_MS) {
      this.endSession('10s of silence');
      return;
    }
    const horizon = now + SCHEDULE_AHEAD_S;
    while (this.scheduledUntil < horizon) {
      const beatIndex = Math.round((this.scheduledUntil - this.nextBarAt) / this.beat);
      const beatTime = this.nextBarAt + beatIndex * this.beat;
      if (beatTime >= now && beatTime < horizon) {
        const inBar = ((beatIndex % this.meter) + this.meter) % this.meter;
        const response = Math.abs(beatTime - this.responseStartAt) < 1e-3;
        this.audio.click(beatTime, { accent: inBar === 0, response });
      }
      this.scheduledUntil = beatTime + this.beat;
    }
    while (this.callScheduled < this.callNotes.length && this.callNotes[this.callScheduled][1] < horizon) {
      const [midi, at, duration] = this.callNotes[this.callScheduled];
      this.audio.note(midi, { at: Math.max(at, now), velocity: 90, duration });
      this.callScheduled += 1;
    }
    if (this.answered && now >= this.nextQuestionAt - SCHEDULE_AHEAD_S) {
      this.nextBarAt = this.nextQuestionAt;
      this.beginQuestion();
    }
  }

  // --- grading -------------------------------------------------------------

  handleAnswer(note, velocity, atAudio) {
    if (this.answered) return; // between resolve and the next call: free play
    const exp = this.expected[this.k];
    if (atAudio < exp.acceptFrom) return; // playing along with the call: free
    if (
      this.lastAccepted && note === this.lastAccepted.midi && note !== exp.midi &&
      atAudio - this.lastAccepted.at < DEBOUNCE_S
    ) return; // key bounce
    const onsetMs = (atAudio - exp.at) * 1000;
    const correct = note === exp.midi || (this.k === 0 && this.q.octave && note === this.anchor);
    const prevMidi = this.k === 0 ? this.anchor : this.expected[this.k - 1].midi;
    const graded = this.k >= this.q.gradeFrom && exp.midi !== prevMidi;
    const passage = Boolean(this.q.phrase);
    const iv = exp.midi - prevMidi;
    const tol = Math.min(this.toleranceMs, 0.4 * exp.gapMs);
    const inTime = correct ? Math.abs(onsetMs) <= tol : null;

    if (passage && graded && this.firstAttempt) {
      const prev2 = this.k >= 2 ? this.expected[this.k - 2].midi : this.prevAnchor;
      this.engine.ask(iv, this.idx(prevMidi), prev2 === null ? null : this.idx(prev2), { scope: 'passage' });
    }
    this.db.attempt({
      sessionId: this.sessionId, anchor: prevMidi, target: exp.midi, played: note, velocity, correct,
      firstAttempt: this.firstAttempt, onsetMs, question: this.questions, kind: this.q.kind,
      phraseId: this.q.phrase?.id ?? null, position: this.k, graded, inTime, beatMs: this.beat * 1000,
    });

    if (!correct) {
      if (graded && this.firstAttempt) {
        this.engine.reportMiss(this.idx(prevMidi), this.idx(note), { confuse: !passage });
        if (passage && Math.abs(iv) >= 3 && this.remediated < REMEDIATE_MAX_PER_PASSAGE &&
            this.engine.predictedAcc(iv, this.idx(prevMidi)) < 0.8) {
          this.remediationQueue.push(iv);
          this.remediated += 1;
        }
      }
      this.firstAttempt = false;
      this.questionClean = false;
      this.missesOnNote += 1;
      this.audio.bad(this.audio.now, this.missesOnNote > 6 ? 0.03 : 0.06);
      this.log(`  x ${name(note)} wanted ${name(exp.midi)} (${this.k === 0 && passage ? 'anchor' : signed(iv)})`);
      if (this.missesOnNote === 2) {
        this.audio.note(exp.midi, { at: this.audio.now + 0.35, velocity: 70 });
      } else if (this.missesOnNote === 4) {
        this.audio.note(prevMidi, { at: this.audio.now + 0.35, velocity: 70 });
        this.audio.note(exp.midi, { at: this.audio.now + 0.35 + this.beat / 2, velocity: 70 });
      } else if (this.missesOnNote >= 6) {
        this.audio.note(exp.midi, { at: this.audio.now + 0.35, velocity: 80 });
        this.log(`  assisted: moving on`);
        this.resolveNote(exp, atAudio, { graded, inTime: false, assisted: true });
      }
      return;
    }
    this.resolveNote(exp, atAudio, { graded, inTime, onsetMs });
  }

  resolveNote(exp, atAudio, { graded, inTime, onsetMs = 0, assisted = false }) {
    const clean = this.firstAttempt && !assisted;
    const rtNorm = clean && this.prevNoteClean ? (Math.min(Math.abs(onsetMs), this.beat * 1000) / this.beat) : null;
    let missed = !clean;
    let tierDelta = 0;
    let newlyMastered = false;
    if (graded) ({ missed, tierDelta, newlyMastered } = this.engine.reportResolved(rtNorm));
    const now = this.audio.now;
    if (tierDelta > 0) this.audio.tierUp(now);
    else if (newlyMastered) this.audio.passageDone(now, true);
    else if (assisted) { /* the demonstrated note was the cue */ }
    else if (missed) this.audio.okAfterMiss(now);
    else if (!inTime) this.audio.offbeat(now, onsetMs < 0);
    else this.audio.good(now, graded ? 0.07 : 0.03);
    const noteClean = !missed && inTime;
    if (!noteClean) this.questionClean = false;
    this.prevNoteClean = noteClean;
    this.log(
      `  ${assisted ? 'assisted' : missed ? 'ok (after miss)' : 'correct'} ${name(exp.midi)}, onset ${onsetMs >= 0 ? '+' : ''}${onsetMs.toFixed(0)}ms${inTime === false && !assisted ? (onsetMs < 0 ? ' EARLY' : ' LATE') : ''}${tierDelta > 0 ? `  TIER ${this.engine.state.tiersUnlocked} UNLOCKED` : ''}${newlyMastered ? '  mastered' : ''}`,
    );
    this.lastAccepted = { midi: exp.midi, at: atAudio };
    this.k += 1;
    this.firstAttempt = true;
    this.missesOnNote = 0;
    if (this.k < this.expected.length) return;
    this.completeQuestion(exp, atAudio);
  }

  completeQuestion(exp, atAudio) {
    this.answered = true;
    const q = this.q;
    this.streak = this.questionClean ? this.streak + 1 : 0;
    this.passagesInARow = q.phrase ? this.passagesInARow + 1 : 0;
    if (q.phrase) {
      this.passagesDone += 1;
      this.phrases.record(q.phrase.id, this.questionClean);
      this.audio.passageDone(this.audio.now + 0.3, this.questionClean);
      if (!this.questionClean && q.kind !== 'retry') this.retryQueue.push({ id: q.phrase.id, askedAt: this.questions });
      this.log(`  passage ${this.questionClean ? 'clean' : 'done with errors'} (streak ${this.streak})`);
    }
    const n = this.expected.length;
    this.prevAnchor = n >= 2 ? this.expected[n - 2].midi : this.anchor;
    this.anchor = exp.midi;

    // Next question on the first bar line at least one beat after the last
    // answer (judged on the EXPECTED onset unless the answer was really late),
    // plus a breathing bar after a passage.
    const barLen = this.meter * this.beat;
    const ref = Math.max(exp.at, atAudio - this.toleranceMs / 1000);
    const barsAhead = Math.ceil((ref + this.beat - this.nextBarAt) / barLen - 1e-6);
    this.nextQuestionAt = this.nextBarAt + (Math.max(1, barsAhead) + (q.phrase ? 1 : 0)) * barLen;

    // Decide the next question now, off the scheduling path, so a passage
    // pick never delays a click, and cue it if it is a passage.
    this.nextQ = this.makeQuestion();
    if (this.nextQ.phrase) this.audio.passageCue(this.nextQuestionAt - this.beat);
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
