// THE PLAYER'S STAGE, derived from history: what a note is judged on.
//
// Contour is acquired first, size last (Welch's phases; Dowling; Flowers &
// Dunne-Sousa 1990): a nine-year-old who moves the right way 88% of the time
// and lands seven semitones off is not "10% right", he is on the direction
// rung. So the rung a player is graded on is the highest one not yet secure:
//
//   echo     cannot yet hold the game: the drill imitates THEM first, then
//            asks their own two notes back (adult self-imitation advantage,
//            Pfordresher & Mantell 2014; untested at four -- new data)
//   contour  credit for the right direction
//   sizing   credit within two semitones
//   exact    the note itself (the ladder in src/engine.js takes over)
//
// Everything about a stage follows from history, never from a setting: the
// pool of intervals (steps and small intervals first, then fifth and octave
// as the first leaps -- Nichols 2016: single intervals before patterns), a
// one-and-a-half-octave window the questions stay inside (a beginner
// wanders to the keyboard's ends), whether the anchor is sounded (it converts
// the task to a relative one; faded at the top), and how long silence may
// last before a session ends. An experienced player never sees any of it: a
// new profile starts at exact and only drops when twenty answers say so.

export const STAGES = ['echo', 'contour', 'sizing', 'exact'];
const WINDOW = 20;
const MIN_EVIDENCE = 8;
// Promotion thresholds, and a margin below each for demotion (hysteresis).
const EXACT_UP = 0.4;
// Promotion is on DIRECTION for the two lower bars: contour is what you
// work on at 'echo'/'contour', and once direction is secure the next thing
// to work on is size -- so 'sizing' is entered on direction, not on size,
// and left for 'exact' on exact pitch. Chance for direction is 0.5 and the
// binomial noise at n=20 is about 0.11, so the contour bar sits well above it.
const SIZING_UP = 0.85; // direction right
const CONTOUR_UP = 0.75; // direction right
const HYSTERESIS = 0.15;
export const POOLS = {
  echo: [2, 3, 4],
  contour: [2, 3, 4, 5, 7],
  sizing: [2, 3, 5, 7, 12],
  exact: null, // the tier ladder
};
const TIMEOUT_MS = { echo: 30000, contour: 25000, sizing: 25000, exact: 10000 };
const WINDOW_SEMITONES = 19; // an octave and a half of keyboard for the lower stages
const ANCHOR_SOUNDED_TIERS = 3; // at exact, the anchor still sounds until this many tiers are open

export class Stage {
  /**
   * @param {{anchor:number, target:number, played:number|null}[]} recent  isolated first attempts, newest first
   * @param {string|null} last  the stage the player was last graded at
   */
  constructor(recent = [], last = null) {
    this.rows = recent.slice(0, WINDOW).reverse(); // oldest first
    this.current = last && STAGES.includes(last) ? last : 'exact';
    this.reassess();
  }

  /** One more isolated answer (played null = never played). */
  observe(anchor, target, played) {
    this.rows.push({ anchor, target, played });
    if (this.rows.length > WINDOW) this.rows.shift();
    const before = this.current;
    this.reassess();
    return before !== this.current;
  }

  metrics() {
    const n = this.rows.length;
    let dir = 0;
    let near = 0;
    let exact = 0;
    for (const r of this.rows) {
      if (r.played === null || r.played === undefined) continue;
      if (Math.sign(r.played - r.anchor) === Math.sign(r.target - r.anchor) && r.target !== r.anchor) dir += 1;
      if (Math.abs(r.played - r.target) <= 2) near += 1;
      if (r.played === r.target) exact += 1;
    }
    return { n, dir: n ? dir / n : 0, near: n ? near / n : 0, exact: n ? exact / n : 0 };
  }

  reassess() {
    const m = this.metrics();
    if (m.n < MIN_EVIDENCE) return; // not enough to move anyone
    const cur = STAGES.indexOf(this.current);
    // The stage a fresh reading would assign.
    let want = m.exact >= EXACT_UP ? 3 : m.dir >= SIZING_UP ? 2 : m.dir >= CONTOUR_UP ? 1 : 0;
    // Hysteresis: only drop when clearly below the current stage's own bar.
    if (want < cur) {
      const holds = cur === 3 ? m.exact >= EXACT_UP - HYSTERESIS : cur === 2 ? m.dir >= SIZING_UP - HYSTERESIS : m.dir >= CONTOUR_UP - HYSTERESIS;
      if (holds) want = cur;
      else want = cur - 1; // one rung at a time
    } else if (want > cur) {
      want = cur + 1;
    }
    this.current = STAGES[want];
  }

  /** Is this note right, for the stage? */
  credit(anchor, target, played) {
    if (played === null || played === undefined) return false;
    switch (this.current) {
      case 'echo':
      case 'contour':
        return target === anchor ? played === target : Math.sign(played - anchor) === Math.sign(target - anchor);
      case 'sizing':
        return Math.abs(played - target) <= 2;
      default:
        return played === target;
    }
  }

  get pool() {
    return POOLS[this.current];
  }

  get timeoutMs() {
    return TIMEOUT_MS[this.current];
  }

  /** Does the call sound the anchor as well as the target? */
  soundsAnchor(tiersUnlocked) {
    return this.current !== 'exact' || tiersUnlocked <= ANCHOR_SOUNDED_TIERS;
  }

  /** The keyboard window questions stay inside, for the lower stages. */
  window(lo, hi) {
    if (this.current === 'exact') return { lo, hi };
    const mid = Math.round((lo + hi) / 2);
    const half = Math.floor(WINDOW_SEMITONES / 2);
    return { lo: Math.max(lo, mid - half), hi: Math.min(hi, mid + WINDOW_SEMITONES - half) };
  }
}
