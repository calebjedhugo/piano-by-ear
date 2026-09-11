// KEY BLOCKS: the key is established, held for a block of questions, then
// changed. The emergent tonal field (src/tonalfield.js) turned out to name a
// new key almost every question, and a frame that is almost-but-not-quite
// there is worse than none for a scale-step encoder (Dowling 1986; Bartlett &
// Dowling 1980 near-key lures). Three right notes are enough to set a key
// (Cuddy & Badertscher 1987: a tonic arpeggio recovers the whole hierarchy),
// so a block opens with do-mi-sol-do, about two seconds, then silence -- no
// cadence, no drone (Springer et al. 2021: drones do nothing measurable).
//
// Inside a block: passages are transposed INTO the key (not onto the anchor),
// gestures step diatonically in it, and plain interval targets lean diatonic.
// A block's key is the note the player happened to be on when it opened, so
// keys rotate with the walk (varied across blocks, constant within one), and
// a retry always lands in the key it was missed in.
import { simpleOf } from './engine.js';

export const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
// Minor as natural plus the raised leading note (harmonic): a phrase is "in"
// a minor key if it stays inside that. The full melodic union would hold
// nine pitch classes and call nearly any chromatic run "minor".
const MINOR = [0, 2, 3, 5, 7, 8, 10, 11];
const MINOR_STRICT = [0, 2, 3, 5, 7, 8, 10];
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]; // pitch class -> position on the circle

export const BLOCK_QUESTIONS = 8;

/** Parse a corpus key string ("B-", "f#", "E-") into { tonic, mode }. */
export function parseKey(str) {
  if (!str) return null;
  const m = /^([A-Ga-g])([#-]?)$/.exec(str.trim());
  if (!m) return null;
  let pc = PC[m[1].toUpperCase()];
  if (m[2] === '#') pc += 1;
  if (m[2] === '-') pc += 11;
  return { tonic: ((pc % 12) + 12) % 12, mode: m[1] === m[1].toLowerCase() ? 'minor' : 'major' };
}

export function keyName(k) {
  return k ? `${NAMES[k.tonic]} ${k.mode}` : 'no key';
}

export function degreeIn(midi, k, { strict = false } = {}) {
  const scale = k.mode === 'minor' ? (strict ? MINOR_STRICT : MINOR) : MAJOR;
  const rel = (((midi % 12) - k.tonic) % 12 + 12) % 12;
  const i = scale.indexOf(rel);
  return i === -1 ? null : rel;
}

export function diatonicIn(midi, k) {
  return degreeIn(midi, k) !== null;
}

function fifthsDistance(a, b) {
  const d = Math.abs(FIFTHS.indexOf(a) - FIFTHS.indexOf(b));
  return Math.min(d, 12 - d);
}

/**
 * The key a phrase is actually in, for priming: the piece's key when every
 * note fits it; otherwise the nearest key (circle of fifths from the piece
 * key) that holds every note; null when the phrase is chromatic in all of
 * them -- then it gets no prime, because a wrong frame is worse than none.
 */
export function phraseKey(phrase) {
  const piece = parseKey(phrase.key);
  const pcs = new Set(phrase.notes.map((n) => ((n[0] % 12) + 12) % 12));
  const fits = (k) => [...pcs].every((pc) => diatonicIn(pc, k));
  // The piece's key stands when at most one NOTE of a phrase of four or more
  // is foreign to it: one chromatic neighbour does not change key; a
  // recurring foreign note is a modulation, and gets the key it implies.
  const foreignNotes = (k) => phrase.notes.filter((n) => !diatonicIn(n[0], k)).length;
  if (piece && (fits(piece) || (phrase.notes.length >= 4 && foreignNotes(piece) <= 1))) return piece;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ['major', 'minor']) {
      const k = { tonic, mode };
      if (!fits(k)) continue;
      const d = piece ? fifthsDistance(piece.tonic, tonic) + (mode === piece.mode ? 0 : 0.5) : 0;
      if (!best || d < best.d) best = { k, d };
    }
  }
  return best ? best.k : null;
}

/**
 * The semitone shift that puts `from` (a phrase's key) onto the block key
 * `to`, modes reconciled through the relative key (a minor phrase in a major
 * block sits on the relative minor: same pitch set), with the octave chosen
 * so the phrase's pivot lands nearest `near` inside [lo, hi]. null if it
 * cannot fit.
 */
export function shiftToKey(phrase, from, to, near, lo, hi) {
  let tonic = to.tonic;
  if (from.mode !== to.mode) tonic = to.mode === 'major' ? (to.tonic + 9) % 12 : (to.tonic + 3) % 12;
  const base = ((tonic - from.tonic) % 12 + 12) % 12;
  const pivot = phrase.notes[phrase.pivot ?? 0][0];
  let best = null;
  for (let shift = base - 48; shift <= base + 48; shift += 12) {
    if (phrase.min + shift < lo || phrase.max + shift > hi) continue;
    const d = Math.abs(pivot + shift - near);
    if (!best || d < best.d) best = { shift, d };
  }
  return best ? best.shift : null;
}

/**
 * THE PRIME'S TONAL SETS. Each is scale degrees above the tonic, and each
 * one names a key on its own: a triad, a seventh, the pentatonic, the first
 * five degrees, an extended tertian stack. `tiers` is how many interval
 * tiers must be open before a set is in the running, so the material grows
 * with the ear rather than with a setting.
 */
const PRIME_SETS = [
  { name: 'triad', tiers: 0, major: [0, 4, 7], minor: [0, 3, 7] },
  { name: 'seventh', tiers: 4, major: [0, 4, 7, 11], minor: [0, 3, 7, 10] },
  { name: 'pentatonic', tiers: 6, major: [0, 2, 4, 7, 9], minor: [0, 3, 5, 7, 10] },
  { name: 'first five', tiers: 8, major: [0, 2, 4, 5, 7], minor: [0, 2, 3, 5, 7] },
  { name: 'ninth', tiers: 10, major: [0, 4, 7, 11, 14], minor: [0, 3, 7, 10, 14] },
];

/**
 * THE BLOCK'S PRIME: one of the sets above, IN A RANDOM ORDER, as
 * [midi, beatOffset, beatDur], one note per beat (the last held two).
 *
 * The old do-mi-sol-do' announced the key and asked nothing of the ear: the
 * player knew every interval before he heard it, which is not a thing anyone
 * needs to be able to do. Scrambled, the set still names the key -- the
 * pitches are what does that, not their order -- while every interval after
 * the first has to be caught cold. That is the real skill: walking in on
 * music already in progress and finding your feet in it.
 *
 * DO IS THE NOTE UNDER YOUR HAND and always comes first: it is both the
 * placement rule every call in this drill obeys (a call that starts
 * somewhere else is failed on its first note -- the 2026-09-11 lesson) and
 * the strongest key cue there is. chooseKey takes the anchor's pitch class
 * as the tonic, so the two nearly always agree; only when they do not does
 * this fall back to the nearest tonic.
 */
export function primeNotes(k, near, lo, hi, { tiers = 0, rand = Math.random } = {}) {
  const pc = (m) => ((m % 12) + 12) % 12;
  let tonic = near;
  if (pc(near) !== pc(k.tonic)) {
    tonic = k.tonic + 12 * Math.round((near - 7 - k.tonic) / 12);
    while (tonic + 12 > hi) tonic -= 12;
    while (tonic < lo) tonic += 12;
  }
  const fits = (set) => tonic + Math.max(...set[k.mode]) <= hi && tonic >= lo;
  const open = PRIME_SETS.filter((set) => set.tiers <= tiers && fits(set));
  // Weighted toward the widest set the ear has earned, without ever dropping
  // the narrow ones: a triad among ninths is interleaving, not a holiday.
  const weight = (set) => PRIME_SETS.indexOf(set) + 1;
  let roll = rand() * open.reduce((a, x) => a + weight(x), 0);
  let set = PRIME_SETS[0];
  for (const cand of open) {
    roll -= weight(cand);
    set = cand;
    if (roll <= 0) break;
  }
  // The tonic leads; everything above it is shuffled (Fisher-Yates).
  const rest = set[k.mode].slice(1);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const all = [0, ...rest].map((iv) => tonic + iv);
  const kept = all.filter((m) => m >= lo && m <= hi);
  const notes = kept.map((m, i) => [m, i, i === kept.length - 1 ? 2 : 1]);
  return { notes, dropped: all.length - kept.length, set: set.name };
}

/** Where a keyed phrase is placed: the anchor drawn halfway back toward the middle of the keyboard. */
export function placementPoint(anchor, lo, hi) {
  return (anchor + (lo + hi) / 2) / 2;
}

/**
 * The same phrase in the other mode: degrees 3, 6 and 7 lowered (major ->
 * minor) or raised (minor -> major), leaving everything else alone. For the
 * "nailed it: now in a new mode" variant. Notes are [midi, off, dur, voice?].
 */
export function modeSwap(notes, k) {
  const down = k.mode === 'major';
  const moved = down ? new Set([4, 9, 11]) : new Set([3, 8, 10]);
  return notes.map((n) => {
    const rel = (((n[0] % 12) - k.tonic) % 12 + 12) % 12;
    const m = moved.has(rel) ? n[0] + (down ? -1 : 1) : n[0];
    return [m, ...n.slice(1)];
  });
}

/** A new block key on the note the player is on: the mode rotates away from the last block's. */
export function chooseKey(anchorMidi, last) {
  const tonic = ((anchorMidi % 12) + 12) % 12;
  let mode = Math.random() < 0.5 ? 'major' : 'minor';
  if (last && last.tonic === tonic && last.mode === mode) mode = mode === 'major' ? 'minor' : 'major';
  return { tonic, mode };
}

/** A diatonic step off `midi` in key k, 1-2 semitones, toward `toward`; null if none. */
export function diatonicStep(midi, k, toward, lo, hi) {
  const dir = midi > toward ? -1 : 1;
  for (const d of [dir, -dir]) {
    for (const semis of [1, 2]) {
      const cand = midi + d * semis;
      if (cand >= lo && cand <= hi && degreeIn(cand, k, { strict: true }) !== null) return cand;
    }
  }
  return null;
}

export { simpleOf };
