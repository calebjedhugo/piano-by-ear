// Passage selection from corpus/phrases.json (Bach chorale sopranos, Mozart
// sonata right hands; see scripts/build-corpus.mjs).
//
// A phrase is transposed so its first note lands EXACTLY on the anchor; an
// octave-displaced placement is used only when nothing fits exactly. The
// drill passes what it can handle right now (max notes, the fastest note it
// allows at this tempo) and the bank weights the survivors by how much the
// engine wants their intervals drilled (in-melody evidence), pulls the walk
// back toward the middle of the keyboard, and applies phrase history from
// kv `phraseStats`: a cleanly played phrase is rested for three days, a
// failed one comes back sooner. Explicit retries are the drill's job.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REVIEW_FULL_MS } from './engine.js';

const CORPUS_PATH = fileURLToPath(new URL('../corpus/phrases.json', import.meta.url));
const FAILED_BOOST = 1.6;

export class PhraseBank {
  /**
   * @param {object} opts
   * @param {{load: () => object|null, save: (v: object) => void}} opts.store  phraseStats persistence
   * @param {string} [opts.composer]  optional case-insensitive filter (debugging)
   */
  constructor({ store, composer }) {
    const all = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
    this.phrases = (composer ? all.filter((p) => p.composer.toLowerCase().includes(composer.toLowerCase())) : all)
      .map((p) => {
        const midis = p.notes.map((n) => n[0]);
        const intervals = [];
        for (let i = 1; i < midis.length; i += 1) if (midis[i] !== midis[i - 1]) intervals.push(midis[i] - midis[i - 1]);
        const last = p.notes[p.notes.length - 1];
        return {
          ...p,
          min: Math.min(...midis),
          max: Math.max(...midis),
          intervals,
          minDur: Math.min(...p.notes.map((n) => n[2])),
          span: last[1] + last[2],
          lastRel: last[0] - midis[0],
        };
      });
    this.byId = new Map(this.phrases.map((p) => [p.id, p]));
    this.store = store;
    this.stats = store.load() || {};
  }

  get size() {
    return this.phrases.length;
  }

  /**
   * Pick a phrase for `anchor` (MIDI) within [lo, hi].
   * @param {object} opts
   * @param {import('./engine.js').AdaptiveEngine} opts.engine
   * @param {number} opts.maxNotes
   * @param {number} opts.beatSec        seconds per felt beat
   * @param {number} opts.minNoteSec     fastest note allowed at this tempo
   * @param {Set<string>} [opts.exclude] phrase ids to skip this session
   * @returns {{phrase, notes: number[][], octave: number}|null}
   */
  pick(anchor, lo, hi, { engine, maxNotes, beatSec, minNoteSec, exclude }) {
    const now = Date.now();
    const scoreMemo = new Map();
    const score = (iv) => {
      let s = scoreMemo.get(iv);
      if (s === undefined) {
        s = engine.scoreInterval(iv, now);
        scoreMemo.set(iv, s);
      }
      return s;
    };
    const candidates = [];
    const weights = [];
    for (const octave of [0, 12]) {
      for (const phrase of this.phrases) {
        if (phrase.notes.length > maxNotes) continue;
        if (phrase.minDur * beatSec < minNoteSec) continue;
        if (phrase.intervals.length === 0) continue;
        if (exclude && exclude.has(phrase.id)) continue;
        const st = this.stats[phrase.id];
        if (st && st.clean && now - st.last < REVIEW_FULL_MS) continue;
        const shift = placement(phrase, anchor, lo, hi, octave);
        if (shift === null) continue;
        let max = 0;
        let sum = 0;
        for (const iv of phrase.intervals) {
          const s = score(iv);
          if (s > max) max = s;
          sum += s;
        }
        let w = 0.5 * max + 0.5 * (sum / phrase.intervals.length);
        if (st && !st.clean) w *= FAILED_BOOST;
        const lastNote = phrase.notes[0][0] + phrase.lastRel + shift;
        w *= engine.centerPull(anchor - lo, lastNote - lo);
        candidates.push({ phrase, shift });
        weights.push(w);
      }
      if (candidates.length > 0) break; // exact placements exist: never displace
    }
    if (candidates.length === 0) return null;
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let chosen = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) {
        chosen = candidates[i];
        break;
      }
    }
    return this.place(chosen.phrase, chosen.shift, anchor);
  }

  /** Transpose a specific phrase (retry) onto `anchor`, or null if it can't fit. */
  pickById(id, anchor, lo, hi) {
    const phrase = this.byId.get(id);
    if (!phrase) return null;
    for (const octave of [0, 12]) {
      const shift = placement(phrase, anchor, lo, hi, octave);
      if (shift !== null) return this.place(phrase, shift, anchor);
    }
    return null;
  }

  place(phrase, shift, anchor) {
    const notes = phrase.notes.map(([m, off, dur]) => [m + shift, off, dur]);
    return { phrase, notes, octave: notes[0][0] - anchor };
  }

  record(id, clean) {
    const prev = this.stats[id];
    this.stats[id] = { last: Date.now(), clean, n: (prev?.n || 0) + 1, fails: (prev?.fails || 0) + (clean ? 0 : 1) };
    this.store.save(this.stats);
  }
}

/** Semitone shift putting note 1 on anchor (+/- octave), or null if out of range. */
function placement(phrase, anchor, lo, hi, octave) {
  const base = anchor - phrase.notes[0][0];
  for (const s of octave === 0 ? [base] : [base - octave, base + octave]) {
    if (phrase.min + s >= lo && phrase.max + s <= hi) return s;
  }
  return null;
}
