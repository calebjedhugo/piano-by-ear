// The tonal centre, which EMERGES from the notes rather than being declared.
//
// Caleb's brief: don't bolt a contrived I-IV-V-I onto the drill; let the key
// arise from the stream of notes actually played, let it modulate, admit
// borrowed notes, and dissolve into atonality now and then. So this holds no
// key of its own. It watches the notes go by in a recency-weighted
// pitch-class histogram and, on request, names the key that best fits the
// recent past (Krumhansl-Schmuckler: correlate the histogram against the 24
// major/minor tone profiles, take the best). The anchor of each question is
// the last note the player chose, so the sequence of anchors is a melody the
// player is walking -- the centre is read off that walk.
//
// It never forces a note. It reports what key the recent notes imply and how
// strongly; the drill uses that to colour presentation (register, whether a
// target is diatonic here or a borrowed note) while the adaptive engine still
// decides WHICH interval is drilled. When the histogram is flat -- a chromatic
// stretch, a wide leap drill -- strength falls and the field says so, which is
// the atonal spell arriving on its own rather than on a schedule.

// Krumhansl & Kessler probe-tone profiles, tonic-relative.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]; // natural minor; the drill is not fussy about 6/7

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function corr(hist, profile, tonic) {
  const n = 12;
  let sh = 0;
  let sp = 0;
  for (let i = 0; i < n; i += 1) {
    sh += hist[i];
    sp += profile[i];
  }
  const mh = sh / n;
  const mp = sp / n;
  let num = 0;
  let dh = 0;
  let dp = 0;
  for (let i = 0; i < n; i += 1) {
    const a = hist[i] - mh;
    const b = profile[(i - tonic + n) % n] - mp;
    num += a * b;
    dh += a * a;
    dp += b * b;
  }
  const den = Math.sqrt(dh * dp);
  return den === 0 ? 0 : num / den;
}

export class TonalField {
  /**
   * @param {number} [halfLife] notes after which a note's weight halves
   * @param {number} [minMass] total weight before a key is worth naming
   */
  constructor({ halfLife = 8, minMass = 6 } = {}) {
    this.hist = new Array(12).fill(0);
    this.decay = 0.5 ** (1 / halfLife);
    this.minMass = minMass;
    this.mass = 0;
  }

  /** One note went by (any octave). */
  observe(midi, weight = 1) {
    for (let i = 0; i < 12; i += 1) this.hist[i] *= this.decay;
    this.mass *= this.decay;
    this.hist[((midi % 12) + 12) % 12] += weight;
    this.mass += weight;
  }

  /**
   * The key the recent notes imply: { tonic (pitch class), mode, strength }.
   * strength in [0,1] folds the correlation together with how much evidence
   * there is, so a thin or flat history reads as weak -- the atonal spell.
   */
  key() {
    let best = { tonic: 0, mode: 'major', r: -2 };
    for (let t = 0; t < 12; t += 1) {
      const rj = corr(this.hist, MAJOR, t);
      if (rj > best.r) best = { tonic: t, mode: 'major', r: rj };
      const rn = corr(this.hist, MINOR, t);
      if (rn > best.r) best = { tonic: t, mode: 'minor', r: rn };
    }
    const evidence = Math.min(1, this.mass / this.minMass);
    const strength = Math.max(0, best.r) * evidence;
    return { tonic: best.tonic, mode: best.mode, strength };
  }

  /**
   * The scale degree of a note in a key (0 = tonic .. 6), or null if the note
   * is chromatic there -- a borrowed note. Defaults to the current key.
   */
  degree(midi, k = this.key()) {
    const scale = k.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
    const rel = (((midi % 12) - k.tonic) % 12 + 12) % 12;
    const i = scale.indexOf(rel);
    return i === -1 ? null : i;
  }

  /** True when the note is in the current key. */
  diatonic(midi, k = this.key()) {
    return this.degree(midi, k) !== null;
  }
}

export function keyName(k) {
  return `${NAMES[k.tonic]} ${k.mode}`;
}
