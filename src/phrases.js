// Real musical phrases, chosen for the anchor you just played.
//
// Two banks share this class: corpus/phrases.json (one melodic line) and
// corpus/poly.json (several voices: 'duo', 'chorale', 'poly'). A phrase's
// notes are [midi, offsetBeats, durationBeats, voice?]; `pivot` (default 0)
// indexes the note placed on the anchor -- the first note of a melody, the
// highest note of the first chord otherwise.
//
// A phrase is wanted in proportion to how much its intervals are wanted:
// melodic intervals within each voice are scored by the melodic engine,
// vertical intervals above each chord's bass by the harmonic engine (when
// given). A phrase you failed comes back sooner; one you played clean rests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REVIEW_FULL_MS } from './engine.js';

export const MONO_PATH = fileURLToPath(new URL('../corpus/phrases.json', import.meta.url));
export const POLY_PATH = fileURLToPath(new URL('../corpus/poly.json', import.meta.url));
const FAILED_BOOST = 1.6;
// A call never holds a beat of silence (a beat of silence is what asks for
// the next question), so phrases with such a rest are never asked.
const MAX_REST_BEATS = 1;

export class PhraseBank {
  /**
   * @param {object} opts
   * @param {{load: () => object|null, save: (v: object) => void}} opts.store  stats persistence
   * @param {string} [opts.composer]  optional case-insensitive filter (debugging)
   * @param {string} [opts.path]      corpus file (default: the melodic corpus)
   */
  constructor({ store, composer, path = MONO_PATH }) {
    const all = JSON.parse(readFileSync(path, 'utf8'));
    this.phrases = (composer ? all.filter((p) => p.composer.toLowerCase().includes(composer.toLowerCase())) : all)
      .map((p) => analyse(p))
      .filter((p) => p.maxRest < MAX_REST_BEATS);
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
   * @param {import('./engine.js').AdaptiveEngine} opts.engine    melodic engine
   * @param {import('./engine.js').AdaptiveEngine} [opts.harmonic] harmonic engine (chords)
   * @param {string} [opts.kind]        'mono' (default) | 'duo' | 'chorale' | 'poly'
   * @param {number} opts.maxNotes
   * @param {number} opts.beatSec        seconds per felt beat
   * @param {number} opts.minNoteSec     fastest note allowed at this tempo
   * @param {Set<string>} [opts.exclude] phrase ids to skip this session
   * @returns {{phrase, notes: number[][], octave: number}|null}
   */
  pick(anchor, lo, hi, { engine, harmonic = null, kind = 'mono', maxNotes, beatSec, minNoteSec, exclude }) {
    const now = Date.now();
    const memo = (eng) => {
      const m = new Map();
      return (iv) => {
        let s = m.get(iv);
        if (s === undefined) {
          s = eng.scoreInterval(iv, now);
          m.set(iv, s);
        }
        return s;
      };
    };
    const scoreM = memo(engine);
    const scoreH = harmonic ? memo(harmonic) : null;
    const candidates = [];
    const weights = [];
    for (const octave of [0, 12]) {
      for (const phrase of this.phrases) {
        if (phrase.kind !== kind) continue;
        if (phrase.notes.length > maxNotes) continue;
        if (phrase.minDur * beatSec < minNoteSec) continue;
        if (phrase.melodic.length + phrase.harmonic.length === 0) continue;
        if (exclude && exclude.has(phrase.id)) continue;
        const st = this.stats[phrase.id];
        if (st && st.clean && now - st.last < REVIEW_FULL_MS) continue;
        const shift = placement(phrase, anchor, lo, hi, octave);
        if (shift === null) continue;
        let max = 0;
        let sum = 0;
        let n = 0;
        for (const iv of phrase.melodic) {
          const s = scoreM(iv);
          if (s > max) max = s;
          sum += s;
          n += 1;
        }
        if (scoreH) {
          for (const iv of phrase.harmonic) {
            const s = scoreH(iv);
            if (s > max) max = s;
            sum += s;
            n += 1;
          }
        }
        let w = n > 0 ? 0.5 * max + 0.5 * (sum / n) : 1;
        if (st && !st.clean) w *= FAILED_BOOST;
        const lastNote = phrase.notes[phrase.pivot][0] + phrase.lastRel + shift;
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
    const notes = phrase.notes.map(([m, off, dur, voice = 0]) => [m + shift, off, dur, voice]);
    return { phrase, notes, octave: notes[phrase.pivot][0] - anchor };
  }

  record(id, clean) {
    const prev = this.stats[id];
    this.stats[id] = { last: Date.now(), clean, n: (prev?.n || 0) + 1, fails: (prev?.fails || 0) + (clean ? 0 : 1) };
    this.store.save(this.stats);
  }
}

/** Precompute what picking needs: range, the intervals, rests. */
function analyse(p) {
  const kind = p.kind || 'mono';
  const pivot = p.pivot || 0;
  const midis = p.notes.map((n) => n[0]);
  // melodic intervals: consecutive notes within each voice
  const byVoice = new Map();
  for (const n of p.notes) {
    const v = n[3] || 0;
    if (!byVoice.has(v)) byVoice.set(v, []);
    byVoice.get(v).push(n);
  }
  const melodic = [];
  for (const notes of byVoice.values()) {
    notes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (let i = 1; i < notes.length; i += 1) if (notes[i][0] !== notes[i - 1][0]) melodic.push(notes[i][0] - notes[i - 1][0]);
  }
  // harmonic intervals: each chord note above its chord's bass
  const groups = new Map();
  for (const n of p.notes) {
    if (!groups.has(n[1])) groups.set(n[1], []);
    groups.get(n[1]).push(n[0]);
  }
  const harmonic = [];
  let lastGroupTop = null;
  for (const [, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    const bass = Math.min(...g);
    for (const m of g) if (m !== bass) harmonic.push(m - bass);
    lastGroupTop = Math.max(...g);
  }
  let maxRest = 0;
  let maxEnd = 0;
  for (const n of [...p.notes].sort((a, b) => a[1] - b[1])) {
    maxRest = Math.max(maxRest, n[1] - maxEnd);
    maxEnd = Math.max(maxEnd, n[1] + n[2]);
  }
  return {
    ...p,
    kind,
    pivot,
    min: Math.min(...midis),
    max: Math.max(...midis),
    melodic,
    harmonic,
    minDur: Math.min(...p.notes.map((n) => n[2])),
    span: maxEnd,
    lastRel: lastGroupTop - p.notes[pivot][0],
    maxRest,
  };
}

/** Semitone shift putting the pivot note on anchor (+/- octave), or null if out of range. */
function placement(phrase, anchor, lo, hi, octave) {
  const base = anchor - phrase.notes[phrase.pivot][0];
  for (const s of octave === 0 ? [base] : [base - octave, base + octave]) {
    if (phrase.min + s >= lo && phrase.max + s <= hi) return s;
  }
  return null;
}
