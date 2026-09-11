// Adaptive interval selection, ported from ear-training (calebjedhugo/ear-training).
//
// A difficulty controller that holds first-attempt success near ~80% by
// choosing WHICH signed semitone interval the next target makes with the
// anchor. Skills are signed intervals (+7 = up a P5, -7 = down a P5),
// tracked separately. Persistence is injected: `store.load()` returns the
// saved state object (or null), `store.save(state)` writes it.
//
// TWO KINDS OF EVIDENCE. Isolated interval questions update the interval's
// parent stats, its situation cells, the confusion matrix and the tier
// controller, exactly as in the reference. Notes inside a PASSAGE are
// scope 'passage': they only update a dedicated `+7|src:passage` cell, so a
// step heard inside a chorale line never makes the isolated step look
// mastered, and one 12-note phrase cannot push the tier ladder.
//
// "Response time" here is the onset error of the correct note against the
// beat, NORMALIZED to milliseconds at 60 bpm (|err| / beat), so the fluency
// gate on mastery means the same thing at every tempo.

const SCHEMA_VERSION = 2;

// Simple intervals only. A compound interval is not a skill of its own: it is
// a simple interval plus an OCTAVE PLACEMENT, and the two are scored apart
// (no study of compound-interval training exists; octave equivalence is weak
// and height-dominated in untrained ears, so height error is its own thing).
// nextTargetIndex sometimes asks the simple interval an octave wider
// (wideRate), the interval skill is credited on pitch CLASS, and the octave
// goes to `state.height`.
export const TIER_WIDTHS = [12, 7, 5, 4, 3, 9, 2, 8, 1, 10, 11, 6];
const ASKABLE = new Set(TIER_WIDTHS);
// Fold a signed interval wider than an octave onto its simple interval.
export function simpleOf(interval) {
  const sign = interval < 0 ? -1 : 1;
  let w = Math.abs(interval);
  while (w > 12) w -= 12;
  return sign * w;
}
const WIDE_BASE_RATE = 0.12; // how often a secure simple interval is asked an octave wider
const WIDE_GOOD_RATE = 0.25; // once octave placement itself is reliable
const WIDE_MIN_TIERS = 4;
const WIDE_MAX_SIMPLE = 9; // up to a sixth plus an octave; a minor seventh plus an octave is nobody's melody

const MIN_TIERS = 2;
const ACC_ALPHA = 0.3;
const OVERALL_ALPHA = 0.15;
const RT_ALPHA = 0.3;
const TARGET_LOW = 0.65;
const TARGET_HIGH = 0.85;
const TIER_CHANGE_COOLDOWN = 8;
const MASTERED_ACC = 0.9;
export const REVIEW_FULL_MS = 3 * 24 * 60 * 60 * 1000;
const CONFUSION_THRESHOLD = 2;
// Confusion evidence halves once a DAY, not once a session: sessions are often
// one-minute bursts, and halving at each of them meant the evidence never
// reached the threshold (16 discrimination questions in 1500 notes).
const CONFUSION_HALF_LIFE_MS = 20 * 60 * 60 * 1000;
// A confused pair is drilled as two-label categorisation INTERLEAVED among
// ordinary questions (Goldstone 1994 acquired distinctiveness; Wong, Chen &
// Lim 2021 interleaving beats blocking), not as an A-B-A-B run: about half of
// the next FOCUS_TRIALS plain questions are one of the pair, in a constant
// register, and the focus opens with one listen-only pass of both
// (practice + exposure, Little, Cheng & Wright 2019).
const FOCUS_TRIALS = 30; // persists in state, so it spans sittings; Little et al. needed ~1000 trials over days
const FOCUS_SHARE = 0.5;
const FOCUS_LISTEN_EVERY = 6; // exposure recurs: a listen pass every this many pair trials
const FOCUS_DONE_WINDOW = 8; // close early once the last N pair trials are this accurate
const FOCUS_DONE_ACC = 0.85;
export const WARMUP_QUESTIONS = 5;
const CELL_SHRINK_K = 4;
const LOCKED_SCORE = 0.25; // phrase score for an interval outside the unlocked tiers
const DEFAULT_STATS = Object.freeze({ acc: 0.5, n: 0, rt: null, last: 0 });

const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
const colorOf = (pc) => (WHITE_PCS.has(((pc % 12) + 12) % 12) ? 'w' : 'b');
const PERFECT_PCS = new Set([0, 5, 7]);
const CONSONANT_PCS = new Set([3, 4, 8, 9]);
function contextBucket(semitones) {
  const pc = ((semitones % 12) + 12) % 12;
  if (PERFECT_PCS.has(pc)) return 'perfect';
  if (CONSONANT_PCS.has(pc)) return 'consonant';
  return 'dissonant';
}

function freshState() {
  return {
    version: SCHEMA_VERSION,
    tiersUnlocked: MIN_TIERS,
    overall: { ewma: 0.75, n: 0 },
    attemptsSinceTierChange: 0,
    intervals: {},
    cells: {},
    confusions: {},
    confusionsDecayedAt: 0,
    focus: null, // { a, b, left, listen } the confused pair being categorised
    height: { n: 0, acc: 0.5 }, // octave placement on compound asks
  };
}

export class AdaptiveEngine {
  /**
   * @param {object} opts
   * @param {number} opts.range              highest valid pitch index (lowest is 0)
   * @param {number} opts.fluentMs           max normalized onset error (ms at 60 bpm) for mastery
   * @param {number} opts.pitchClassOffset   pitch class of index 0 (MIDI 21 = A = 9)
   * @param {{load: () => object|null, save: (state: object) => void}} opts.store
   */
  constructor({ range, fluentMs, pitchClassOffset = 0, store }) {
    this.range = range;
    this.fluentMs = fluentMs;
    this.pcOffset = pitchClassOffset;
    this.store = store;
    const loaded = store.load();
    this.state = loaded && loaded.version === SCHEMA_VERSION ? loaded : freshState();
    if (!this.state.cells) this.state.cells = {};
    if (!this.state.height) this.state.height = { n: 0, acc: 0.5 };
    if (!('focus' in this.state)) this.state.focus = null;
    if (!this.state.confusionsDecayedAt) this.state.confusionsDecayedAt = 0;
    // The ladder used to run on into compound intervals; those tiers fold away.
    if (this.state.tiersUnlocked > TIER_WIDTHS.length) this.state.tiersUnlocked = TIER_WIDTHS.length;
    this.lastWide = false;
    this.questionInSession = 0;
    this.prevAnchorIndex = null;
    this.lastAsked = null;
    this.lastAskedCells = [];
    this.lastScope = 'interval';
    this.pending = null;
  }

  save() {
    this.store.save(this.state);
  }

  /** `questionInSession` may be carried in from a burst a few minutes ago (the warm-up is per sitting, not per burst). */
  startSession({ questionInSession = 0 } = {}) {
    this.questionInSession = questionInSession;
    this.prevAnchorIndex = null;
    this.lastAsked = null;
    this.lastAskedCells = [];
    this.pending = null;
    // Confusion evidence decays by the day, so old near-misses don't pile up
    // into endless categorisation while today's can still add up.
    const now = Date.now();
    if (now - this.state.confusionsDecayedAt >= CONFUSION_HALF_LIFE_MS) {
      for (const k of Object.keys(this.state.confusions)) {
        const v = Math.floor(this.state.confusions[k] / 2);
        if (v > 0) this.state.confusions[k] = v; else delete this.state.confusions[k];
      }
      this.state.confusionsDecayedAt = now;
    }
  }

  /** The confused pair in focus, if any: { a, b, left, listen }. */
  get focus() {
    return this.state.focus;
  }

  /** True once, when a focus has just opened: the drill plays both intervals for listening. */
  takeListen() {
    const f = this.state.focus;
    if (!f || !f.listen) return null;
    f.listen = false;
    this.save();
    return { a: f.a, b: f.b };
  }

  /** Called once per question of either kind (drives the warm-up ramp). */
  beginQuestion() {
    this.questionInSession += 1;
  }

  /** Carry session state into a rebuilt engine (range widened mid-session). */
  adopt(other, indexShift) {
    this.questionInSession = other.questionInSession;
    this.prevAnchorIndex = other.prevAnchorIndex === null ? null : other.prevAnchorIndex + indexShift;
    // The framing of the in-flight question (cells are absolute-pitch
    // strings, the interval is index-independent) so a question framed on
    // the old engine still resolves against the right interval.
    this.lastAsked = other.lastAsked;
    this.lastAskedCells = other.lastAskedCells.slice();
    this.lastScope = other.lastScope;
    this.pending = other.pending;
  }

  unlockedIntervals(tiers = this.state.tiersUnlocked) {
    const signed = [];
    for (const w of TIER_WIDTHS.slice(0, tiers)) signed.push(w, -w);
    return signed;
  }

  poolFor(anchorIndex, extraTiers = 0) {
    for (let tiers = Math.min(TIER_WIDTHS.length, this.state.tiersUnlocked + extraTiers); tiers <= TIER_WIDTHS.length; tiers += 1) {
      const pool = this.unlockedIntervals(tiers).filter((i) => this.feasible(anchorIndex, i));
      if (pool.length > 0) return pool;
    }
    return [];
  }

  feasible(anchorIndex, interval) {
    const target = anchorIndex + interval;
    return target >= 0 && target <= this.range;
  }

  static key(interval) {
    return interval > 0 ? `+${interval}` : `${interval}`;
  }

  /** Read-only stats (never inserts). */
  peekStats(interval) {
    return this.state.intervals[AdaptiveEngine.key(interval)] || DEFAULT_STATS;
  }

  intervalStats(interval) {
    const key = AdaptiveEngine.key(interval);
    let s = this.state.intervals[key];
    if (!s) {
      s = { acc: 0.5, n: 0, rt: null, last: 0 };
      this.state.intervals[key] = s;
    }
    return s;
  }

  isMastered(s, predictedAcc) {
    return s.n >= 3 && predictedAcc >= MASTERED_ACC && s.rt !== null && s.rt <= this.fluentMs;
  }

  /**
   * Cell keys framing `interval` from `anchorIndex`: key-color pair, the
   * echoic-context bucket against `prevIndex` (null = none), and for
   * passage-scope evidence the dedicated in-melody cell.
   */
  cellKeysFor(interval, anchorIndex, prevIndex, scope = 'interval') {
    const iKey = AdaptiveEngine.key(interval);
    if (scope === 'passage' || scope === 'round') return [`${iKey}|src:${scope}`];
    const target = anchorIndex + interval;
    const keys = [`${iKey}|${colorOf(anchorIndex + this.pcOffset)}${colorOf(target + this.pcOffset)}`];
    if (prevIndex !== null && prevIndex !== undefined) {
      keys.push(`${iKey}|ctx:${contextBucket(target - prevIndex)}`);
    }
    return keys;
  }

  cellStats(key) {
    let c = this.state.cells[key];
    if (!c) {
      c = { acc: 0.5, n: 0 };
      this.state.cells[key] = c;
    }
    return c;
  }

  /** Parent accuracy adjusted by the given cells (shrinkage toward the parent). Read-only. */
  predictedAccFrom(interval, cellKeys) {
    const parent = this.peekStats(interval);
    let acc = parent.acc;
    for (const key of cellKeys) {
      const c = this.state.cells[key];
      if (c && c.n > 0) acc += (c.n / (c.n + CELL_SHRINK_K)) * (c.acc - parent.acc);
    }
    return Math.max(0, Math.min(1, acc));
  }

  predictedAcc(interval, anchorIndex, prevIndex = this.prevAnchorIndex) {
    return this.predictedAccFrom(interval, this.cellKeysFor(interval, anchorIndex, prevIndex));
  }

  /** Base ZPD weight for an interval given its predicted accuracy (no session terms). */
  baseWeight(interval, acc, now) {
    const s = this.peekStats(interval);
    let w;
    if (s.n < 3) w = 1.5;
    else if (this.isMastered(s, acc)) w = 0.2 + 0.7 * Math.min(1, (now - s.last) / REVIEW_FULL_MS);
    else w = 2.2 - 2 * Math.abs(acc - 0.7);
    return Math.max(w, 0.15);
  }

  weight(interval, anchorIndex, now, prevIndex = this.prevAnchorIndex) {
    const s = this.peekStats(interval);
    const acc = this.predictedAcc(interval, anchorIndex, prevIndex);
    let w = this.baseWeight(interval, acc, now);
    const warmLeft = WARMUP_QUESTIONS - this.questionInSession;
    if (warmLeft > 0 && s.n >= 3) w *= 1 + (warmLeft / WARMUP_QUESTIONS) * 1.5 * acc;
    return w * this.centerPull(anchorIndex, anchorIndex + interval);
  }

  /**
   * Keep the anchor's random walk near the middle of the keyboard: the
   * further out it is, the more a move back toward the center is favored
   * and a move further out is discouraged (x2 / x0.33 two octaves out).
   */
  centerPull(fromIndex, toIndex) {
    const center = this.range / 2;
    const dist = Math.abs(fromIndex - center);
    const inward = Math.abs(toIndex - center) < dist;
    return inward ? 1 + dist / 24 : Math.max(0.3, 1 - dist / 36);
  }

  /**
   * For a queued/remediation interval, the feasible signed variant (iv or
   * -iv) whose target moves toward the keyboard center, or null if neither
   * fits. Direction-agnostic skills (a fifth is a fifth up or down) stay
   * near the middle instead of walking off an edge.
   */
  inwardVariant(interval, anchorIndex) {
    const opts = [interval, -interval].filter((iv) => this.feasible(anchorIndex, iv));
    if (opts.length === 0) return null;
    opts.sort((a, b) => this.centerPull(anchorIndex, anchorIndex + b) - this.centerPull(anchorIndex, anchorIndex + a));
    return opts[0];
  }

  /**
   * How much a passage containing this interval is wanted: the ZPD weight
   * using in-melody evidence (parent + src:passage cell). Read-only, no
   * warm-up or center terms. Intervals wider than the tier list score low.
   */
  scoreInterval(interval, now) {
    if (Math.abs(interval) > 12) return 0.85 * this.scoreInterval(simpleOf(interval), now);
    if (!ASKABLE.has(Math.abs(interval))) return 0.15;
    // Beyond the unlocked tiers: not "unseen, explore" but "not yet", so
    // passages stay a step ahead of the drills rather than several.
    if (!this.openInPassage(interval)) return LOCKED_SCORE;
    const parent = this.peekStats(interval);
    const cell = this.state.cells[`${AdaptiveEngine.key(interval)}|src:passage`];
    if (cell && cell.n >= 3) {
      // enough in-melody evidence: score its accuracy on the ZPD curve
      const acc = Math.max(0, Math.min(1, cell.acc));
      if (acc >= 0.9) return 0.3;
      return Math.max(0.2, 2.2 - 2 * Math.abs(acc - 0.7));
    }
    if (parent.n >= 3) return this.baseWeight(interval, parent.acc, now);
    return 1.5; // unseen: explore
  }

  /** Frame `interval` from `anchorIndex` as the question in flight. */
  ask(interval, anchorIndex, prevIndex = this.prevAnchorIndex, { scope = 'interval' } = {}) {
    this.lastAsked = interval;
    this.lastScope = scope;
    this.lastAskedCells = this.cellKeysFor(interval, anchorIndex, prevIndex, scope);
    this.prevAnchorIndex = anchorIndex;
    return anchorIndex + interval;
  }

  /**
   * Choose the next target index from `anchorIndex`. Discrimination runs
   * take priority; infeasible entries wait for a later anchor instead of
   * being lost.
   */
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.allowWide]  may ask a secure interval an octave wider
   * @param {number[]} [opts.pool]      signed intervals to choose from instead of the ladder (a stage's pool)
   * @param {{lo:number, hi:number}} [opts.bounds]  index window the target must stay inside
   * @param {number} [opts.extraTiers] tiers beyond the unlocked ones (a round's escalation)
   * @param {(targetIndex:number) => number} [opts.lean]  weight multiplier per candidate target (diatonic lean)
   * @param {string} [opts.scope]      evidence scope for the ask ('interval' | 'round')
   */
  nextTargetIndex(anchorIndex, prevIndex = this.prevAnchorIndex, { allowWide = false, pool: poolOverride = null, bounds = null, extraTiers = 0, lean = null, scope = 'interval' } = {}) {
    this.servedQueue = false;
    this.lastWide = false;
    const inBounds = (t) => !bounds || (t >= bounds.lo && t <= bounds.hi);
    this.lastFromFocus = false;
    const f = this.state.focus;
    // Never inside a round: its evidence is scoped away, so a focus trial
    // served there would be spent without being seen.
    if (!poolOverride && scope !== 'round' && f && f.left > 0 && Math.random() < FOCUS_SHARE) {
      // One of the confused pair, in its own direction so the register stays
      // put (register and direction shift perceived size); flipped only when
      // the keyboard runs out.
      const pick = Math.random() < 0.5 ? f.a : f.b;
      const ok = (iv) => this.feasible(anchorIndex, iv) && inBounds(anchorIndex + iv);
      const iv = ok(pick) ? pick : ok(-pick) ? -pick : null;
      if (iv !== null) {
        f.left -= 1;
        f.served = (f.served || 0) + 1;
        if (f.served % FOCUS_LISTEN_EVERY === 0) f.listen = true;
        if (f.left <= 0) this.state.focus = null;
        this.save();
        this.servedQueue = true;
        this.lastFromFocus = true;
        return this.ask(iv, anchorIndex, prevIndex, { scope });
      }
    }

    const now = Date.now();
    let pool;
    if (poolOverride) {
      pool = poolOverride.filter((i) => this.feasible(anchorIndex, i) && inBounds(anchorIndex + i));
      if (pool.length === 0) pool = poolOverride.filter((i) => this.feasible(anchorIndex, i));
      if (pool.length === 0) pool = this.poolFor(anchorIndex);
    } else {
      pool = this.poolFor(anchorIndex, extraTiers).filter((i) => inBounds(anchorIndex + i));
      if (pool.length === 0) pool = this.poolFor(anchorIndex, extraTiers);
    }
    if (pool.length === 0) return anchorIndex;
    const weights = pool.map((i) => this.weight(i, anchorIndex, now, prevIndex) * (lean ? lean(anchorIndex + i) : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let interval = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) {
        interval = pool[i];
        break;
      }
    }
    // A secure simple interval is sometimes asked an octave wider: the skill
    // stays the simple interval; the octave is judged apart (reportHeight).
    if (allowWide && this.state.tiersUnlocked >= WIDE_MIN_TIERS && Math.abs(interval) <= WIDE_MAX_SIMPLE) {
      const wide = interval + (interval < 0 ? -12 : 12);
      const s = this.peekStats(interval);
      const rate = this.state.height.acc >= 0.8 && this.state.height.n >= 6 ? WIDE_GOOD_RATE : WIDE_BASE_RATE;
      if (s.n >= 3 && s.acc >= 0.8 && this.feasible(anchorIndex, wide) && inBounds(anchorIndex + wide) && Math.random() < rate) {
        this.lastWide = true;
        this.ask(interval, anchorIndex, prevIndex, { scope });
        return anchorIndex + wide;
      }
    }
    return this.ask(interval, anchorIndex, prevIndex, { scope });
  }

  /** How many intervals are mastered right now (the dyad gate). */
  masteredCount() {
    let n = 0;
    for (const [k, s] of Object.entries(this.state.intervals)) {
      const iv = Number(k);
      if (this.isMastered(s, this.predictedAccFrom(iv, this.cellKeysFor(iv, Math.floor(this.range / 2), null)))) n += 1;
    }
    return n;
  }

  /** Octave placement on a compound ask: right or wrong, apart from the interval. */
  reportHeight(ok) {
    const h = this.state.height;
    h.acc = h.acc * (1 - ACC_ALPHA) + (ok ? ACC_ALPHA : 0);
    h.n += 1;
    this.save();
  }

  updateCells(cells, success) {
    for (const key of cells) {
      const c = this.cellStats(key);
      c.acc = c.acc * (1 - ACC_ALPHA) + (success ? ACC_ALPHA : 0);
      c.n += 1;
    }
  }

  /** First wrong note of a question. `confuse:false` records the miss without confusion tracking. */
  reportMiss(anchorIndex, playedIndex, { confuse = true } = {}) {
    if (this.pending) return;
    this.pending = {
      asked: this.lastAsked,
      cells: this.lastAskedCells,
      scope: this.lastScope,
      tapped: confuse ? playedIndex - anchorIndex : 0,
    };
  }

  /**
   * May a passage lean on this interval? Unlocked widths, plus the whole
   * step: the ladder names it late (it is hard to identify cold) but it is
   * the ordinary motion of every melody. Semitones stay gated, so chromatic
   * lines wait for the ladder.
   */
  openInPassage(interval) {
    return Math.abs(interval) === 2 || this.unlockedWidth(interval);
  }

  /** Widths currently in play (unlocked tiers), for gating discrimination. */
  unlockedWidth(w) {
    return TIER_WIDTHS.slice(0, this.state.tiersUnlocked).includes(Math.abs(w));
  }

  recordConfusion(asked, tapped) {
    if (tapped === asked || tapped === 0) return;
    // Only pairs whose widths are in play, adjacent in size (the confusions
    // that actually happen: fourth/fifth, minor/major sixth) or the same
    // width the other way; a wild miss is not a category boundary.
    if (!this.openInPassage(asked) || !this.openInPassage(tapped)) return;
    if (Math.sign(asked) !== Math.sign(tapped) || Math.abs(Math.abs(asked) - Math.abs(tapped)) > 2) return;
    const key = `${AdaptiveEngine.key(asked)}|${AdaptiveEngine.key(tapped)}`;
    const count = (this.state.confusions[key] || 0) + 1;
    if (count >= CONFUSION_THRESHOLD) {
      delete this.state.confusions[key];
      if (!this.state.focus) { // one pair at a time, never a cascade
        this.state.focus = { a: asked, b: tapped, left: FOCUS_TRIALS, listen: true };
      }
    } else {
      this.state.confusions[key] = count;
    }
  }

  /** A clean success clears the interval's standing confusion pairs. */
  clearConfusions(interval) {
    const k = AdaptiveEngine.key(interval);
    for (const key of Object.keys(this.state.confusions)) {
      const [a, b] = key.split('|');
      if (a === k || b === k) delete this.state.confusions[key];
    }
  }

  /**
   * The correct note arrived. `rtNorm` is the normalized onset error (ms at
   * 60 bpm) or null when timing isn't attributable to this interval.
   * Returns { asked, missed, tierDelta, newlyMastered }.
   */
  reportResolved(rtNorm) {
    const missed = this.pending !== null;
    // A focus closes early once the pair has separated.
    const f = this.state.focus;
    if (this.lastFromFocus && f) {
      f.recent = [...(f.recent || []), missed ? 0 : 1].slice(-FOCUS_DONE_WINDOW);
      if (f.recent.length >= FOCUS_DONE_WINDOW && f.recent.reduce((a, b) => a + b, 0) / f.recent.length >= FOCUS_DONE_ACC) this.state.focus = null;
      this.lastFromFocus = false;
    }
    const asked = missed ? this.pending.asked : this.lastAsked;
    const cells = missed ? this.pending.cells : this.lastAskedCells;
    const scope = missed ? this.pending.scope : this.lastScope;
    const tiersBefore = this.state.tiersUnlocked;
    let newlyMastered = false;

    if (scope === 'passage' || scope === 'round') {
      this.updateCells(cells, !missed);
      // A near miss inside a phrase is the same category boundary as one in
      // isolation, and it is where most of them happen.
      if (missed && scope === 'passage') this.recordConfusion(asked, this.pending.tapped);
    } else {
      const s = this.intervalStats(asked);
      const wasMastered = this.isMastered(s, this.predictedAccFrom(asked, cells));
      s.n += 1;
      s.last = Date.now();
      if (missed) {
        s.acc = s.acc * (1 - ACC_ALPHA);
        this.recordConfusion(asked, this.pending.tapped);
      } else {
        s.acc = s.acc * (1 - ACC_ALPHA) + ACC_ALPHA;
        if (rtNorm !== null && rtNorm !== undefined) {
          s.rt = s.rt === null ? rtNorm : s.rt * (1 - RT_ALPHA) + RT_ALPHA * rtNorm;
        }
        this.clearConfusions(asked);
      }
      this.updateCells(cells, !missed);
      newlyMastered = !wasMastered && this.isMastered(s, this.predictedAccFrom(asked, cells));
      this.state.overall.ewma = this.state.overall.ewma * (1 - OVERALL_ALPHA) + (missed ? 0 : OVERALL_ALPHA);
      this.state.overall.n += 1;
      this.state.attemptsSinceTierChange += 1;
      this.adjustTiers();
    }
    this.pending = null;
    this.save();
    return { asked, missed, tierDelta: this.state.tiersUnlocked - tiersBefore, newlyMastered };
  }

  adjustTiers() {
    if (this.state.attemptsSinceTierChange < TIER_CHANGE_COOLDOWN) return;
    const { ewma } = this.state.overall;
    if (ewma > TARGET_HIGH && this.state.tiersUnlocked < TIER_WIDTHS.length) {
      const frontierWidth = TIER_WIDTHS[this.state.tiersUnlocked - 1];
      const seen = [frontierWidth, -frontierWidth].every((i) => this.peekStats(i).n >= 3);
      if (seen) {
        this.state.tiersUnlocked += 1;
        this.state.attemptsSinceTierChange = 0;
        this.state.overall.ewma = 0.78;
      }
    } else if (ewma < TARGET_LOW && this.state.tiersUnlocked > MIN_TIERS) {
      this.state.tiersUnlocked -= 1;
      this.state.attemptsSinceTierChange = 0;
      this.state.overall.ewma = 0.75;
    }
  }
}
