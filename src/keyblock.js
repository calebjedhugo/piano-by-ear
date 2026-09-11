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
 * The block's prime: do-mi-sol-do' (minor: do-me-sol-do'), as
 * [midi, beatOffset, beatDur], one note per beat.
 *
 * DO IS THE NOTE UNDER YOUR HAND whenever it can be -- and chooseKey takes
 * the anchor's pitch class as the tonic, so it nearly always is. The prime
 * is a call the player plays back like any other, and every call in this
 * drill starts where the player is already sitting (the 2026-09-11 lesson:
 * a call that starts somewhere else is failed on its first note). Only when
 * the tonic is some other pitch class does it fall back to the nearest one.
 */
export function primeNotes(k, near, lo, hi) {
  const pc = (m) => ((m % 12) + 12) % 12;
  let tonic = near;
  if (pc(near) !== pc(k.tonic)) {
    tonic = k.tonic + 12 * Math.round((near - 7 - k.tonic) / 12);
    while (tonic + 12 > hi) tonic -= 12;
    while (tonic < lo) tonic += 12;
  }
  const third = k.mode === 'minor' ? 3 : 4;
  // ONE NOTE PER BEAT. It used to run in half beats, which was fine when it
  // was only heard; it is now played back, and four notes at 150 ms apart is
  // a different task from the one being taught.
  const all = [[tonic, 0, 1], [tonic + third, 1, 1], [tonic + 7, 2, 1], [tonic + 12, 3, 2]];
  const notes = all.filter(([m]) => m >= lo && m <= hi);
  return { notes, dropped: all.length - notes.length };
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
