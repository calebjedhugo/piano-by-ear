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
// given). WHEN A PHRASE COMES BACK is a schedule, not a mood: a failed one
// is re-tested the next day (the corrective loop already gave it its
// immediate tries; a same-session re-test is performance, not learning), a
// clean one after 3 days, then a week, then three weeks (Cepeda 2008; Kang
// 2014) -- and a phrase due for review is wanted a little more.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { phraseKey, shiftToKey } from './keyblock.js';

export const MONO_PATH = fileURLToPath(new URL('../corpus/phrases.json', import.meta.url));
export const HYMNS_PATH = fileURLToPath(new URL('../corpus/hymns.json', import.meta.url));
export const POLY_PATH = fileURLToPath(new URL('../corpus/poly.json', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_AFTER_FAIL_MS = 1 * DAY_MS;
const DUE_AFTER_CLEAN_MS = [3 * DAY_MS, 7 * DAY_MS, 21 * DAY_MS]; // by clean passes in a row
const FAILED_BOOST = 1.6;
const DUE_BOOST = 1.3;
// Each melodic interval not open for passages (engine.openInPassage: locked
// leaps and semitones) and each harmonic interval outside the harmonic
// engine's tiers multiplies a phrase's weight by this, on top of its low
// score, so a chromatic line waits for the ladder to reach semitones.
const LOCKED_PENALTY = 0.6;
// Consecutive semitones (a chromatic run) are the thing that actually fails;
// each adjacent pair multiplies the weight by this as well.
const CHROMATIC_PENALTY = 0.3;
// A call never holds a beat of silence (a beat of silence is what asks for
// the next question), so phrases with such a rest are never asked.
const MAX_REST_BEATS = 1;

export class PhraseBank {
  /**
   * @param {object} opts
   * @param {{load: () => object|null, save: (v: object) => void}} opts.store  stats persistence
   * @param {string} [opts.composer]  optional case-insensitive filter (debugging)
   * @param {string|string[]} [opts.path]  corpus file(s) (default: the melodic corpus)
   */
  constructor({ store, composer, path = MONO_PATH }) {
    const all = [].concat(...[].concat(path).map((f) => JSON.parse(readFileSync(f, 'utf8'))));
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
   * @param {Set<string>} [opts.exclude] phrase ids to skip this session
   * @param {{tonic:number, mode:string}} [opts.key]  place phrases IN this key
   *   (src/keyblock.js) rather than on the anchor; phrases with no clear key
   *   of their own are skipped then
   * @returns {{phrase, notes: number[][], octave: number, key, shift}|null}
   *
   * Nothing here filters on tempo: a phrase's tempo is derived FROM the phrase
   * once it is chosen (src/tempo.js), so no excerpt is out of reach for being
   * too quick. The old speed filter hid 38% of the corpus at a fast session
   * tempo, which is exactly backwards.
   */
  pick(anchor, lo, hi, { engine, harmonic = null, kind = 'mono', maxNotes, exclude, key = null }) {
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
        if (phrase.melodic.length + phrase.harmonic.length === 0) continue;
        if (exclude && exclude.has(phrase.id)) continue;
        const st = this.stats[phrase.id];
        if (st && st.dueAt > now) continue;
        if (st && st.restUntil > now) continue;
        let shift;
        if (key) {
          if (octave > 0 || !phrase.tonalKey) continue; // the key decides the octave
          // The octave nearest the anchor, drawn halfway back toward the
          // middle of the keyboard so a walk that wandered low is not pinned there.
          shift = shiftToKey(phrase, phrase.tonalKey, key, (anchor + (lo + hi) / 2) / 2, lo, hi);
        } else shift = placement(phrase, anchor, lo, hi, octave);
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
        let locked = 0;
        for (const iv of phrase.melodic) if (!engine.openInPassage(iv)) locked += 1;
        if (harmonic) for (const iv of phrase.harmonic) if (!harmonic.unlockedWidth(iv)) locked += 1;
        w *= LOCKED_PENALTY ** locked;
        if (!engine.unlockedWidth(1)) w *= CHROMATIC_PENALTY ** phrase.chromatic;
        if (st && !st.clean) w *= FAILED_BOOST;
        else if (st && st.dueAt) w *= DUE_BOOST; // due for review
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
    return this.place(chosen.phrase, chosen.shift, anchor, key);
  }

  /** A specific phrase placed in `key` (a variant), or null if it has no key or cannot fit. */
  pickInKey(id, key, anchor, lo, hi) {
    const phrase = this.byId.get(id);
    if (!phrase || !phrase.tonalKey) return null;
    const shift = shiftToKey(phrase, phrase.tonalKey, key, (anchor + (lo + hi) / 2) / 2, lo, hi);
    return shift === null ? null : this.place(phrase, shift, anchor, key);
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

  place(phrase, shift, anchor, key = null) {
    const notes = phrase.notes.map(([m, off, dur, voice = 0]) => [m + shift, off, dur, voice]);
    return { phrase, notes, octave: key ? 0 : notes[phrase.pivot][0] - anchor, key, shift };
  }

  /** The outcome of a first asking or a retry (not a variant): sets when the phrase is due again. */
  record(id, clean) {
    const prev = this.stats[id];
    const now = Date.now();
    const cleanRun = clean ? (prev?.cleanRun || 0) + 1 : 0;
    const dueAt = now + (clean ? DUE_AFTER_CLEAN_MS[Math.min(cleanRun - 1, DUE_AFTER_CLEAN_MS.length - 1)] : DUE_AFTER_FAIL_MS);
    this.stats[id] = { ...prev, last: now, clean, cleanRun, dueAt, n: (prev?.n || 0) + 1, fails: (prev?.fails || 0) + (clean ? 0 : 1) };
    this.store.save(this.stats);
  }

  /**
   * Too hard just yet: keep the phrase out of pick() for `ms`. A failed phrase
   * otherwise comes back SOONER (FAILED_BOOST); this is the opposite, for one
   * the corrective loop gave up on.
   */
  rest(id, ms) {
    this.stats[id] = { ...(this.stats[id] ?? {}), restUntil: Date.now() + ms };
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
  let chromatic = 0; // adjacent semitone pairs within a voice
  for (const notes of byVoice.values()) {
    notes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    let prevSemi = false;
    for (let i = 1; i < notes.length; i += 1) {
      if (notes[i][0] === notes[i - 1][0]) continue;
      const iv = notes[i][0] - notes[i - 1][0];
      melodic.push(iv);
      const semi = Math.abs(iv) === 1;
      if (semi && prevSemi) chromatic += 1;
      prevSemi = semi;
    }
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
    tonalKey: phraseKey(p),
    min: Math.min(...midis),
    max: Math.max(...midis),
    melodic,
    chromatic,
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
