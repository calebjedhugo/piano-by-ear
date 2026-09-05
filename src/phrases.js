// Passage selection from corpus/phrases.json (Bach chorale sopranos, Mozart
// sonata right hands; see scripts/build-corpus.mjs).
//
// A phrase is transposed so its first note lands on the current anchor,
// then octave-shifted if needed to fit the controller's range. Phrases are
// weighted by the adaptive engine's per-interval weights (so passages full
// of intervals you're shaky on come up more), and by their own history in
// kv `phraseStats` (a clean pass rests a phrase for a few days; a failed one
// comes back sooner).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORPUS_PATH = fileURLToPath(new URL('../corpus/phrases.json', import.meta.url));
const REST_AFTER_PASS_MS = 3 * 24 * 60 * 60 * 1000;

export class PhraseBank {
  /**
   * @param {object} opts
   * @param {string} [opts.composer]   case-insensitive substring filter
   * @param {{load: () => object|null, save: (v: object) => void}} opts.store  phraseStats persistence
   */
  constructor({ composer, store }) {
    const all = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
    this.phrases = composer
      ? all.filter((p) => p.composer.toLowerCase().includes(composer.toLowerCase()))
      : all;
    this.store = store;
    this.stats = store.load() || {};
  }

  get size() {
    return this.phrases.length;
  }

  /**
   * Pick a phrase for `anchor` (MIDI) within [lo, hi], using `engine` for
   * interval weights. Returns {phrase, notes: [midi, offsetBeats, dur][], shift}
   * or null when nothing fits.
   */
  pick(anchor, lo, hi, engine) {
    const now = Date.now();
    const candidates = [];
    const weights = [];
    for (const phrase of this.phrases) {
      const notes = transpose(phrase.notes, anchor, lo, hi);
      if (!notes) continue;
      let w = 0;
      let count = 0;
      for (let i = 1; i < notes.length; i += 1) {
        const interval = notes[i][0] - notes[i - 1][0];
        if (interval === 0) continue;
        w += engine.weight(interval, notes[i - 1][0] - lo, now);
        count += 1;
      }
      if (count === 0) continue;
      w /= count;
      const st = this.stats[phrase.id];
      if (st) {
        if (st.clean) w *= 0.25 + 0.75 * Math.min(1, (now - st.last) / REST_AFTER_PASS_MS);
        else w *= 1.6;
      }
      candidates.push({ phrase, notes, shift: notes[0][0] - phrase.notes[0][0] });
      weights.push(w);
    }
    if (candidates.length === 0) return null;
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < candidates.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  record(id, clean) {
    this.stats[id] = { last: Date.now(), clean, n: (this.stats[id]?.n || 0) + 1 };
    this.store.save(this.stats);
  }
}

/** Shift so the first note == anchor, then by octaves until in range. */
function transpose(notes, anchor, lo, hi) {
  let shift = anchor - notes[0][0];
  const min = Math.min(...notes.map((n) => n[0]));
  const max = Math.max(...notes.map((n) => n[0]));
  // Prefer the anchor exactly; fall back to octave shifts that fit.
  for (const oct of [0, -12, 12, -24, 24]) {
    const s = shift + oct;
    if (min + s >= lo && max + s <= hi) {
      return notes.map(([m, off, dur]) => [m + s, off, dur]);
    }
  }
  return null;
}
