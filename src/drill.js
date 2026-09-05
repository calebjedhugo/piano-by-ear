// The drill state machine.
//
//   IDLE      no metronome. The first note played becomes the anchor and
//             starts a session.
//   QUESTION  metronome throughout. A question is a CALL (notes the app
//             plays, spanning `bars` bars) followed by a RESPONSE of the same
//             length in which you play the GRADED notes at the same beat
//             positions. Two flavors:
//               interval:  call = anchor on beat 1, target on beat 3 (one bar);
//                          graded = the target only (the anchor is free).
//               passage:   call = a real phrase (Bach, Mozart...) transposed
//                          to start on the anchor, with its own meter and
//                          pickup; graded = every note of it.
//             The answer window opens half a beat before the first graded
//             onset. Each note-on is matched against the next graded note:
//             right pitch -> onset error recorded, advance; wrong pitch ->
//             miss (buzz), stay on that note, retries free. The last note
//             becomes the next anchor and the next question starts on the
//             following bar line.
//   Silence for TIMEOUT_MS during a session ends it (back to IDLE).
//
// Every note-on is always echoed through the synth: the controller has no
// sounds of its own, so this process IS the piano.

const TIMEOUT_MS = 10000;
const ANCHOR_MIN_VELOCITY = 20; // ignore key brushes when idle
const SCHEDULE_AHEAD_S = 0.15;
const TICK_MS = 25;

export class Drill {
  /**
   * @param {object} deps
   * @param {import('./audio.js').Audio} deps.audio
   * @param {import('./db.js').Db} deps.db
   * @param {import('./range.js').RangeTracker} deps.range
   * @param {(lo: number, hi: number) => import('./engine.js').AdaptiveEngine} deps.makeEngine
   * @param {import('./phrases.js').PhraseBank|null} deps.phrases
   * @param {'intervals'|'passages'|'mix'} deps.mode
   * @param {number} deps.bpm
   * @param {number} deps.toleranceMs   |onset error| under this = "in time"
   * @param {(msg: string) => void} deps.log
   */
  constructor({ audio, db, range, makeEngine, phrases, mode, bpm, toleranceMs, log }) {
    this.audio = audio;
    this.db = db;
    this.range = range;
    this.makeEngine = makeEngine;
    this.phrases = phrases;
    this.mode = phrases ? mode : 'intervals';
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
    this.lo = lo;
    this.hi = hi;
    this.engine = this.makeEngine(lo, hi);
    this.engine.startSession();
    this.sessionId = this.db.newSession({ bpm: this.bpm, anchor });
    this.questions = 0;
    this.anchor = anchor;
    this.prevAnchor = null;
    this.lastInputAt = performance.now();
    this.state = 'QUESTION';
    this.log(`session started, anchor ${name(anchor)}, range ${lo}..${hi}, ${this.bpm} bpm, ${this.mode}`);

    // Give the anchor a moment to ring, then the grid starts.
    this.nextBarAt = this.audio.now + this.beat;
    this.scheduledUntil = this.audio.now;
    this.meter = 4;
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

  /** Build the next question: {call, graded, meter, bars, label, phraseId?} */
  makeQuestion() {
    const wantPassage =
      this.mode === 'passages' || (this.mode === 'mix' && Math.random() < 0.5);
    // Discrimination runs queued by the engine always take priority.
    if (wantPassage && this.engine.discriminationQueue.length === 0) {
      const picked = this.phrases.pick(this.anchor, this.lo, this.hi, this.engine);
      if (picked) {
        const { phrase, notes, shift } = picked;
        const last = notes[notes.length - 1];
        const span = phrase.pickup + last[1] + last[2];
        const bars = Math.max(1, Math.ceil(span / phrase.meter - 1e-9));
        const placed = notes.map(([midi, off]) => [midi, phrase.pickup + off]);
        const key = shift === 0 ? '' : ` (shifted ${shift > 0 ? '+' : ''}${shift})`;
        return {
          call: placed,
          graded: placed,
          meter: phrase.meter,
          bars,
          phraseId: phrase.id,
          label: `${phrase.composer} ${phrase.catalog} "${phrase.title}" bar ${phrase.bar}, ${notes.length} notes${key}`,
        };
      }
    }
    const idx = this.engine.nextTargetIndex(this.anchor - this.lo);
    const target = idx + this.lo;
    return {
      call: [[this.anchor, 0], [target, 2]],
      graded: [[target, 2]],
      meter: 4,
      bars: 1,
      label: `${name(this.anchor)} -> ? (${signed(target - this.anchor)})`,
    };
  }

  beginQuestion() {
    const q = this.makeQuestion();
    this.q = q;
    this.questions += 1;
    this.meter = q.meter;
    const t0 = this.nextBarAt;
    const responseOffset = q.bars * q.meter * this.beat;
    this.callNotes = q.call.map(([midi, beat]) => [midi, t0 + beat * this.beat]);
    this.expected = q.graded.map(([midi, beat]) => ({ midi, at: t0 + beat * this.beat + responseOffset }));
    this.k = 0;
    this.windowOpensAt = this.expected[0].at - this.beat / 2;
    this.answered = false;
    this.firstAttempt = true;
    this.cleanSoFar = true;
    this.callScheduled = 0;
    // Passage: the first graded note has no interval to grade (it IS the anchor).
    this.gradeFrom = q.phraseId !== undefined ? 1 : 0;
    this.log(`Q${this.questions}: ${q.label}`);
  }

  /** Runs every TICK_MS: schedules clicks/calls just ahead of the audio clock. */
  tick() {
    const now = this.audio.now;
    if (performance.now() - this.lastInputAt > TIMEOUT_MS) {
      this.endSession('10s of silence');
      return;
    }
    const horizon = now + SCHEDULE_AHEAD_S;
    // Metronome: schedule every beat up to the horizon.
    while (this.scheduledUntil < horizon) {
      const beatIndex = Math.round((this.scheduledUntil - this.nextBarAt) / this.beat);
      const beatTime = this.nextBarAt + beatIndex * this.beat;
      if (beatTime >= this.scheduledUntil - 1e-6 && beatTime < horizon) {
        const inBar = ((beatIndex % this.meter) + this.meter) % this.meter;
        this.audio.click(beatTime, { accent: inBar === 0 });
      }
      this.scheduledUntil = beatTime + this.beat;
    }
    while (this.callScheduled < this.callNotes.length && this.callNotes[this.callScheduled][1] < horizon) {
      const [midi, at] = this.callNotes[this.callScheduled];
      this.audio.note(midi, { at, velocity: 90 });
      this.callScheduled += 1;
    }
    if (this.answered && now >= this.nextQuestionAt - SCHEDULE_AHEAD_S) {
      this.nextBarAt = this.nextQuestionAt;
      this.beginQuestion();
    }
  }

  handleAnswer(note, velocity, atAudio) {
    if (this.answered) return; // between resolve and the next call: free play
    if (atAudio < this.windowOpensAt) return; // playing along with the call: free
    const exp = this.expected[this.k];
    const onsetMs = (atAudio - exp.at) * 1000;
    const correct = note === exp.midi;
    const prevMidi = this.k === 0 ? this.anchor : this.expected[this.k - 1].midi;
    const graded = this.k >= this.gradeFrom && exp.midi !== prevMidi;
    this.db.attempt({
      sessionId: this.sessionId,
      anchor: prevMidi,
      target: exp.midi,
      played: note,
      velocity,
      correct,
      firstAttempt: this.firstAttempt,
      onsetMs,
    });

    if (graded && this.firstAttempt && this.q.phraseId !== undefined) {
      // Frame this note's interval for the engine (interval mode already did).
      const prev2 = this.k >= 2 ? this.expected[this.k - 2].midi : this.prevAnchor;
      this.engine.ask(exp.midi - prevMidi, prevMidi - this.lo, prev2 === null ? null : prev2 - this.lo);
    }

    if (!correct) {
      if (graded && this.firstAttempt) this.engine.reportMiss(prevMidi - this.lo, note - this.lo);
      this.firstAttempt = false;
      this.cleanSoFar = false;
      this.audio.bad();
      this.log(`  x ${name(note)} wanted ${name(exp.midi)} (${signed(exp.midi - prevMidi)})`);
      return;
    }

    const absErr = Math.abs(onsetMs);
    const inTime = absErr <= this.toleranceMs;
    let missed = !this.firstAttempt;
    if (graded) ({ missed } = this.engine.reportResolved(absErr));
    if (!missed && inTime) this.audio.good(); else if (!inTime) this.cleanSoFar = false;
    this.log(
      `  ${missed ? 'ok (after miss)' : 'correct'} ${name(note)}, onset ${onsetMs >= 0 ? '+' : ''}${onsetMs.toFixed(0)}ms${inTime ? '' : ' OFF-BEAT'}`,
    );
    this.k += 1;
    this.firstAttempt = true;
    if (this.k < this.expected.length) return;

    // Question complete.
    this.answered = true;
    if (this.q.phraseId !== undefined) {
      this.phrases.record(this.q.phraseId, this.cleanSoFar);
      this.log(`  passage ${this.cleanSoFar ? 'clean' : 'done with errors'}`);
    }
    this.prevAnchor = this.expected.length >= 2 ? this.expected[this.expected.length - 2].midi : this.anchor;
    this.anchor = exp.midi;
    // Next question on the first bar line at least one beat after the last answer.
    const barLen = this.meter * this.beat;
    const barsAhead = Math.ceil((atAudio + this.beat - this.nextBarAt) / barLen);
    this.nextQuestionAt = this.nextBarAt + Math.max(1, barsAhead) * barLen;
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
