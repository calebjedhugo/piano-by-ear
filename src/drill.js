// The drill state machine.
//
//   IDLE      no metronome. The first note played becomes the anchor and
//             starts a session.
//   QUESTION  4/4, two bars per question, metronome throughout:
//               bar 1 beat 1: anchor sounds     bar 1 beat 3: target sounds
//               bar 2 beat 1: (you may play the anchor — free)
//               bar 2 beat 3: you play the target  <- graded on pitch + onset
//             The answer window opens half a beat before the expected onset.
//             The first note inside the window is the answer: right pitch
//             resolves the question (onset error recorded); wrong pitch is a
//             miss, and the question stays open (metronome keeps going,
//             retries free) until the right pitch arrives.
//             The target then becomes the next anchor and the next question
//             starts on the following bar line.
//   Silence for TIMEOUT_MS during a session ends it (back to IDLE).
//
// Every note-on is always echoed through the synth: the controller has no
// sounds of its own, so this process IS the piano.

const BEATS_PER_BAR = 4;
const TIMEOUT_MS = 10000;
const ANCHOR_MIN_VELOCITY = 20; // ignore key brushes when idle
const SCHEDULE_AHEAD_S = 0.15;
const TICK_MS = 25;

export class Drill {
  /**
   * @param {object} deps
   * @param {import('./audio.js').Audio} deps.audio
   * @param {import('./engine.js').AdaptiveEngine} deps.engine   (re-created per session)
   * @param {import('./db.js').Db} deps.db
   * @param {import('./range.js').RangeTracker} deps.range
   * @param {(lo: number, hi: number) => import('./engine.js').AdaptiveEngine} deps.makeEngine
   * @param {number} deps.bpm
   * @param {number} deps.toleranceMs   |onset error| under this = "in time"
   * @param {(msg: string) => void} deps.log
   */
  constructor({ audio, db, range, makeEngine, bpm, toleranceMs, log }) {
    this.audio = audio;
    this.db = db;
    this.range = range;
    this.makeEngine = makeEngine;
    this.bpm = bpm;
    this.beat = 60 / bpm;
    this.toleranceMs = toleranceMs;
    this.log = log;
    this.state = 'IDLE';
    // performance.now() (ms) -> audio clock (s): perfMs / 1000 - offset
    this.clockOffset = performance.now() / 1000 - audio.now;
  }

  perfToAudio(perfMs) {
    return perfMs / 1000 - this.clockOffset;
  }

  // --- input ---------------------------------------------------------------

  onNoteOn({ note, velocity, at }) {
    this.audio.note(note, { velocity });
    if (this.range.observe(note)) {
      const { lo, hi } = this.range.current;
      this.log(`range widened to ${lo}..${hi} (applies from the next session)`);
    }
    if (this.state === 'IDLE') {
      if (velocity >= ANCHOR_MIN_VELOCITY) this.startSession(note);
      return;
    }
    this.lastInputAt = performance.now();
    this.handleAnswer(note, velocity, this.perfToAudio(at));
  }

  // --- session -------------------------------------------------------------

  startSession(anchor) {
    const { lo, hi } = this.range.current;
    // A note outside the known range still starts a session — the range
    // tracker has already widened to include it.
    this.lo = lo;
    this.engine = this.makeEngine(lo, hi);
    this.engine.startSession();
    this.sessionId = this.db.newSession({ bpm: this.bpm, anchor });
    this.questions = 0;
    this.anchor = anchor;
    this.lastInputAt = performance.now();
    this.state = 'QUESTION';
    this.log(`session started, anchor ${name(anchor)}, range ${lo}..${hi}, ${this.bpm} bpm`);

    // Give the anchor a moment to ring, then the grid starts.
    this.nextBarAt = this.audio.now + this.beat;
    this.scheduledUntil = this.audio.now;
    this.beginQuestion();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  endSession(reason) {
    clearInterval(this.ticker);
    this.ticker = null;
    this.db.endSession(this.sessionId, this.questions);
    this.audio.sessionOver();
    this.state = 'IDLE';
    this.log(`session over (${reason}): ${this.questions} questions. Play a note to start again.`);
  }

  beginQuestion() {
    const idx = this.engine.nextTargetIndex(this.anchor - this.lo);
    this.target = idx + this.lo;
    this.questions += 1;
    const t0 = this.nextBarAt;
    this.callAnchorAt = t0;
    this.callTargetAt = t0 + 2 * this.beat;
    this.expectedAt = t0 + (BEATS_PER_BAR + 2) * this.beat;
    this.windowOpensAt = this.expectedAt - this.beat / 2;
    this.answered = false;
    this.firstAttempt = true;
    this.callScheduled = false;
    this.log(`Q${this.questions}: ${name(this.anchor)} -> ? (${signed(this.target - this.anchor)})`);
  }

  /** Runs every TICK_MS: schedules clicks/calls just ahead of the audio clock. */
  tick() {
    const now = this.audio.now;
    if (performance.now() - this.lastInputAt > TIMEOUT_MS) {
      this.endSession('10s of silence');
      return;
    }
    // Metronome: schedule every beat up to SCHEDULE_AHEAD_S ahead.
    const horizon = now + SCHEDULE_AHEAD_S;
    while (this.scheduledUntil < horizon) {
      const beatIndex = Math.round((this.scheduledUntil - this.nextBarAt) / this.beat);
      const beatTime = this.nextBarAt + beatIndex * this.beat;
      if (beatTime >= this.scheduledUntil && beatTime < horizon) {
        const inBar = ((beatIndex % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
        this.audio.click(beatTime, { accent: inBar === 0 });
      }
      this.scheduledUntil = beatTime + this.beat;
    }
    if (!this.callScheduled && this.callAnchorAt < horizon) {
      this.audio.note(this.anchor, { at: this.callAnchorAt, velocity: 90 });
      this.audio.note(this.target, { at: this.callTargetAt, velocity: 90 });
      this.callScheduled = true;
    }
    // Answered: the next question starts on the bar line after the answer bar.
    if (this.answered && now >= this.nextQuestionAt - SCHEDULE_AHEAD_S) {
      this.nextBarAt = this.nextQuestionAt;
      this.beginQuestion();
    }
  }

  handleAnswer(note, velocity, atAudio) {
    if (this.answered) return; // between resolve and the next call: free play
    if (atAudio < this.windowOpensAt) return; // playing along with the call / anchor: free
    const onsetMs = (atAudio - this.expectedAt) * 1000;
    const correct = note === this.target;
    this.db.attempt({
      sessionId: this.sessionId,
      anchor: this.anchor,
      target: this.target,
      played: note,
      velocity,
      correct,
      firstAttempt: this.firstAttempt,
      onsetMs,
    });

    if (!correct) {
      if (this.firstAttempt) this.engine.reportMiss(this.anchor - this.lo, note - this.lo);
      this.firstAttempt = false;
      this.audio.bad();
      this.log(`  x ${name(note)} (${signed(note - this.anchor)})`);
      return;
    }

    const absErr = Math.abs(onsetMs);
    const inTime = absErr <= this.toleranceMs;
    const { missed } = this.engine.reportResolved(absErr);
    if (!missed && inTime) this.audio.good();
    this.log(
      `  ${missed ? 'ok (after miss)' : 'correct'} ${name(note)}, onset ${onsetMs >= 0 ? '+' : ''}${onsetMs.toFixed(0)}ms${inTime ? '' : ' LATE/EARLY'}`,
    );
    this.answered = true;
    this.anchor = this.target;
    // Next question on the first bar line at least one beat after the answer.
    const barsFromExpected = Math.ceil((atAudio + this.beat - (this.expectedAt - 2 * this.beat)) / (BEATS_PER_BAR * this.beat));
    this.nextQuestionAt = this.expectedAt - 2 * this.beat + Math.max(1, barsFromExpected) * BEATS_PER_BAR * this.beat;
  }

  stop() {
    if (this.state !== 'IDLE') this.endSession('stopped');
  }
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function name(midi) {
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}
