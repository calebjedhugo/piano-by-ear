// Adaptive interval selection, ported from ear-training (calebjedhugo/ear-training).
//
// A difficulty controller that chooses WHICH signed semitone interval the
// next target makes with the anchor. (It used to hold isolated success near
// ~80%; since 2026-10-23 the plain slot asks only unsecured intervals and the
// 80% is held by passage length instead -- drill.js LEN.) Skills are signed intervals (+7 = up a P5, -7 = down a P5),
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

// THE SIMPLE LADDER. Compound intervals have a ladder of their own
// (COMPOUND_WIDTHS, below); until 2026-10-23 a compound was "a simple interval
// plus an octave placement", asked by a coin flip and credited to the simple
// interval on pitch class, which is why the drill never knew WHICH compound
// was weak.
// ORDERED BY HOW HARD THE INTERVAL IS TO PLAY, not how hard it is to NAME.
// Those two orders are nearly opposite, and this drill is production: the
// octave and the fifth are the easiest intervals to LABEL in an ear-training
// class and among the hardest to FIND cold on a keyboard, because finding
// them means knowing the span before you move. A step you can find by feel.
// The list used to open octave-then-fifth, and the effect on beginners was
// exactly what you would expect: three of four profiles sat at two tiers
// forever (William 209 isolated trials at 30%, Liz 119 at 60%), never
// reaching the 0.85 the ladder wants, so a whole step -- which sat at tier 7
// -- was unreachable until octaves, fifths, fourths, thirds and sixths were
// all mastered first. A beginner's entire session was descending fifths.
// Steps, then thirds, then the fourth and fifth, then the octave, then
// sixths, sevenths, and the tritone last.
export const TIER_WIDTHS = [2, 1, 3, 4, 5, 7, 12, 9, 8, 10, 11, 6];
// Below this many tiers the plain slot stays INSIDE THE BLOCK KEY: the white
// keys in C, and the half step arrives where the scale actually puts it
// (E-F, B-C) rather than as an interval of its own. The black keys turn on
// with the octave, once steps, thirds, the fourth and the fifth are open.
export const DIATONIC_TIERS = 6;
const ASKABLE = new Set(TIER_WIDTHS);
// Fold a signed interval wider than an octave onto its simple interval.
export function simpleOf(interval) {
  const sign = interval < 0 ? -1 : 1;
  let w = Math.abs(interval);
  while (w > 12) w -= 12;
  return sign * w;
}
// THE COMPOUND LADDER (2026-10-23, melodic engine only). A compound interval
// (13..24 semitones) is ITS OWN SIGNED SKILL with its own stats -- acc, n,
// reflex, rt, as for a simple one -- never credited to the simple interval and
// never moving the simple ladder. It used to be the simple interval asked an
// octave wider on a coin flip (12% of secure intervals, 25% once octave
// placement was reliable) and credited to the simple interval on pitch class,
// the octave going to a separate `height` record. The result, Caleb's profile
// 10-12..10-23: 47 compound answers over 15 signed sizes in 11 days, 43%
// right, ONE of 47 right within two beats, and not one of the 27 misses an
// octave error (it is the note he cannot find, not the register) -- and
// nothing in the drill knew which compound was the weak one, because every
// answer was filed under a simple interval he already had. Order: the simple ladder's order
// an octave up. The first opens once the simple ladder has opened the octave;
// each next one opens when the newest is SECURE both ways and its simple
// counterpart (width - 12) is open on the simple ladder. Never closes.
export const COMPOUND_WIDTHS = TIER_WIDTHS.map((w) => w + 12);
const OCTAVE_TIERS = TIER_WIDTHS.indexOf(12) + 1; // the simple tier count at which the octave is open
// The dyad slot still asks a secure span an octave wider (drill.js
// DYAD_WIDE_RATE passes the rate); the melodic plain slot no longer does.
const WIDE_MIN_TIERS = 4;
const WIDE_MAX_SIMPLE = 9;

const MIN_TIERS = 2;
const ACC_ALPHA = 0.3;
const OVERALL_ALPHA = 0.15;
const RT_ALPHA = 0.3;
const TIER_CHANGE_COOLDOWN = 8;
const MASTERED_ACC = 0.9;
// SECURE = RIGHT AND QUICK (2026-10-23). `reflex` is an EWMA (ACC_ALPHA) of
// "right AND started within two beats of the call" (drill.js passes `quick`;
// the threshold is WIDE.reflexBeats, the same line the wide spans and the
// round's unlock draw). `rt` cannot stand in for it: it is onset error
// against the beat, not how long he took to start. Retrieval, not
// calculation (Logan 1988): his plain intervals started within 2 beats were
// 88% right, 3-4 beats 78%, 6+ 59% or worse.
const SECURE_REFLEX = 0.8;
// The top of the ZPD curve (baseWeight: ZPD_PEAK - 2 * |acc - 0.7|).
const ZPD_PEAK = 2.2;
const REFLEX_PRIOR = 0.5; // an unmeasured record starts where acc does
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
// register, and the focus opens with one call that serves BOTH of them from
// one anchor (practice + exposure, Little, Cheng & Wright 2019). That call is
// played back like every other: nothing here is listen-only.
const FOCUS_TRIALS = 30; // persists in state, so it spans sittings; Little et al. needed ~1000 trials over days
const FOCUS_SHARE = 0.5;
const FOCUS_EXPOSE_EVERY = 6; // exposure recurs: a both-of-them call every this many pair trials
const FOCUS_DONE_WINDOW = 8; // close early once the last N pair trials are this accurate
const FOCUS_DONE_ACC = 0.85;
export const WARMUP_QUESTIONS = 5;
const CELL_SHRINK_K = 4;
const LOCKED_SCORE = 0.25; // phrase score for an interval outside the unlocked tiers
const DEFAULT_STATS = Object.freeze({ acc: 0.5, n: 0, rt: null, last: 0, reflex: null });

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

function freshState(minTiers = MIN_TIERS) {
  return {
    version: SCHEMA_VERSION,
    tiersUnlocked: minTiers,
    overall: { ewma: 0.75, n: 0 },
    attemptsSinceTierChange: 0,
    intervals: {},
    cells: {},
    confusions: {},
    confusionsDecayedAt: 0,
    focus: null, // { a, b, left, expose } the confused pair being categorised
    compoundTiers: 0, // COMPOUND_WIDTHS open (melodic engine only)
    attemptsSinceCompoundChange: 0,
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
  constructor({ range, fluentMs, pitchClassOffset = 0, store, minTiers = MIN_TIERS, unsigned = false, timed = true, compound = !unsigned }) {
    this.range = range;
    this.fluentMs = fluentMs;
    this.pcOffset = pitchClassOffset;
    this.store = store;
    // THE HARMONIC ENGINE IS UNSIGNED: its skills are SIZES (a third is a third
    // whichever note was already under a hand), so every key it holds is +w
    // and the frontier gate below counts |w| rather than waiting for a -w that
    // can never arrive. That wait is why the harmonic ladder never moved in
    // the profile's first sixteen days (278 trials, zero tier changes).
    this.unsigned = unsigned;
    // AN UNTIMED ENGINE MASTERS ON ACCURACY ALONE. A dyad answer records no
    // response time, so on the harmonic engine `rt` is null for every width
    // and, while mastery demanded a fluent rt, NOTHING could ever be
    // mastered: the m2 at 99% (n=14) and M2 at 99.9% (n=17) kept full ZPD
    // weight, crowded out the m3 he was failing (served about once per
    // hundred questions), and held the ladder under the 85% that opens the M3.
    // Found 2026-09-22 from "why am I still only getting m2 and M2?"
    this.timed = timed;
    // THE COMPOUND LADDER IS MELODIC (COMPOUND_WIDTHS). The harmonic engine's
    // wide spans are drill.js WIDE records, not engine skills.
    this.compound = compound;
    this.minTiers = minTiers;
    const loaded = store.load();
    this.state = loaded && loaded.version === SCHEMA_VERSION ? loaded : freshState(minTiers);
    if (this.state.tiersUnlocked < minTiers) this.state.tiersUnlocked = minTiers;
    if (!this.state.cells) this.state.cells = {};
    if (!('focus' in this.state)) this.state.focus = null;
    if (!this.state.confusionsDecayedAt) this.state.confusionsDecayedAt = 0;
    // The ladder used to run on into compound intervals; those tiers fold away.
    if (this.state.tiersUnlocked > TIER_WIDTHS.length) this.state.tiersUnlocked = TIER_WIDTHS.length;
    // A profile from before the compound ladder that has the octave open
    // starts with the first compound open; the ratchet takes it from there.
    if (this.state.compoundTiers === undefined) this.state.compoundTiers = compound && this.state.tiersUnlocked >= OCTAVE_TIERS ? 1 : 0;
    if (this.state.attemptsSinceCompoundChange === undefined) this.state.attemptsSinceCompoundChange = 0;
    if (!compound) this.state.compoundTiers = 0;
    // Told when a tier opens (drill.js logs it): ({ ladder, width, tier, of }).
    this.onOpen = null;
    this.lastWide = false;
    this.lastFallback = null;
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

  /** The confused pair in focus, if any: { a, b, left, expose }. */
  get focus() {
    return this.state.focus;
  }

  /** True once, when a focus has just opened (and every FOCUS_EXPOSE_EVERY
   *  trials after): the drill asks for both intervals in one call. */
  takeExposure() {
    const f = this.state.focus;
    if (!f || !f.expose) return null;
    f.expose = false;
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
      s = { acc: 0.5, n: 0, rt: null, last: 0, reflex: null };
      this.state.intervals[key] = s;
    }
    return s;
  }

  isMastered(s, predictedAcc) {
    return s.n >= 3 && predictedAcc >= MASTERED_ACC && (!this.timed || (s.rt !== null && s.rt <= this.fluentMs));
  }

  /**
   * SECURE = RIGHT AND QUICK, on the interval's own record (2026-10-23): seen
   * three times, accuracy at MASTERED_ACC, and right-within-two-beats at
   * SECURE_REFLEX. Separate from isMastered, which gates dyads and keeps its
   * meaning. A secure interval leaves the plain slot (passages already carry
   * it thousands of times) and lets the ladder open the next one.
   */
  isSecure(interval) {
    const s = this.peekStats(interval);
    return s.n >= 3 && s.acc >= MASTERED_ACC && (s.reflex ?? 0) >= SECURE_REFLEX;
  }

  /**
   * Is the newest open simple width secure? Signed above DIATONIC_TIERS: BOTH
   * directions, each on its own record (each seen 3 times, as the old rule
   * asked). Unsigned (the harmonic engine, whose keys are all +w) and at the
   * entry level: EITHER direction -- in C the half step exists only at E-F and
   * B-C, and "three each way" was what held a perfect player on tier 2
   * (2026-09-27), so the combined rule stays combined.
   */
  frontierSecure(w) {
    if (this.unsigned) return this.isSecure(w);
    if (this.state.tiersUnlocked < DIATONIC_TIERS) return this.isSecure(w) || this.isSecure(-w);
    return this.isSecure(w) && this.isSecure(-w);
  }

  /** The open compound intervals, signed (COMPOUND_WIDTHS). */
  openCompounds() {
    const signed = [];
    for (const w of COMPOUND_WIDTHS.slice(0, this.state.compoundTiers || 0)) signed.push(w, -w);
    return signed;
  }

  /** Is this compound interval open on the compound ladder? */
  compoundOpen(interval) {
    return COMPOUND_WIDTHS.slice(0, this.state.compoundTiers || 0).includes(Math.abs(interval));
  }

  /**
   * Cell keys framing `interval` from `anchorIndex`: key-color pair, the
   * echoic-context bucket against `prevIndex` (null = none), and for
   * passage-scope evidence the dedicated in-melody cell.
   */
  cellKeysFor(interval, anchorIndex, prevIndex, scope = 'interval') {
    const iKey = AdaptiveEngine.key(interval);
    // Every scope but the isolated probe is its own cell family and nothing
    // else: 'passage', 'round', and the dyad rungs 'departure' (both notes
    // measured from the anchor being left) and 'twohand' (each hand from its
    // own). None of them moves the tier ladder or the parent stats.
    if (scope !== 'interval') return [`${iKey}|src:${scope}`];
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
    else w = ZPD_PEAK - 2 * Math.abs(acc - 0.7);
    return Math.max(w, 0.15);
  }

  /**
   * ACCURATE BUT NOT SECURE (2026-10-24): seen three times and right at
   * MASTERED_ACC on its own record, but not yet quick (isSecure). After the
   * 10-23 build 23 of Caleb's 24 open intervals were unsecured and many of
   * them were exactly this (-3: acc .99, reflex .61; -8: .98 / .14), and
   * baseWeight filed them as review material (isMastered: 0.2-0.9) -- so
   * inside the hard pool they were rarely asked, the low-accuracy ones took
   * the slot, and single-interval accuracy sat low. Caleb: balance it by
   * also asking the intervals not yet secure but highly accurate. In a HARD
   * pick these get the ZPD peak; nothing else changes. Record acc, as
   * isSecure reads it: the speed is what is missing, not the cell context.
   */
  accurateUnsecured(interval) {
    const s = this.peekStats(interval);
    return s.n >= 3 && s.acc >= MASTERED_ACC && !this.isSecure(interval);
  }

  weight(interval, anchorIndex, now, prevIndex = this.prevAnchorIndex, { hard = false } = {}) {
    const s = this.peekStats(interval);
    const acc = this.predictedAcc(interval, anchorIndex, prevIndex);
    let w = hard && this.accurateUnsecured(interval) ? ZPD_PEAK : this.baseWeight(interval, acc, now);
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
    // Past an octave and a half out, the pull is steep: on 88 keys the gentle
    // slope let the walk reach C7 and C2.
    if (dist > 18) return inward ? 3 : 0.15;
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
   * @param {boolean} [opts.hard]       the melodic plain slot: only open intervals (simple and compound) that are not secure
   * @param {boolean} [opts.allowWide]  may ask a secure interval an octave wider (the dyad slot)
   * @param {number[]} [opts.pool]      signed intervals to choose from instead of the ladder (a stage's pool)
   * @param {{lo:number, hi:number}} [opts.bounds]  index window the target must stay inside
   * @param {number} [opts.extraTiers] tiers beyond the unlocked ones (a round's escalation)
   * @param {(targetIndex:number) => number} [opts.lean]  weight multiplier per candidate target (diatonic lean)
   * @param {string} [opts.scope]      evidence scope for the ask ('interval' | 'round')
   * @param {number} [opts.wideMax]    widest simple interval that may be asked wide
   * @param {number} [opts.wideRate]   how often a secure one is asked wide (0 = never)
   */
  nextTargetIndex(anchorIndex, prevIndex = this.prevAnchorIndex, { hard = false, allowWide = false, pool: poolOverride = null, bounds = null, extraTiers = 0, lean = null, only = null, scope = 'interval', wideMax = WIDE_MAX_SIMPLE, wideRate = 0 } = {}) {
    this.servedQueue = false;
    this.lastWide = false;
    this.lastFallback = null;
    const inBounds = (t) => !bounds || (t >= bounds.lo && t <= bounds.hi);
    // `only` is a hard filter on the TARGET (the key gate below DIATONIC_TIERS
    // uses it), applied after bounds and dropped if it would leave nothing --
    // a filter must never be able to end the drill.
    const allowed = (t) => inBounds(t) && (!only || only(t));
    this.lastFromFocus = false;
    const f = this.state.focus;
    // Never inside a round: its evidence is scoped away, so a focus trial
    // served there would be spent without being seen.
    if (!poolOverride && scope !== 'round' && f && f.left > 0 && Math.random() < FOCUS_SHARE) {
      // One of the confused pair, in its own direction so the register stays
      // put (register and direction shift perceived size); flipped only when
      // the keyboard runs out.
      const pick = Math.random() < 0.5 ? f.a : f.b;
      // `allowed`, not just inBounds: the focus branch returns before the pool
      // is ever built, so the entry level's key gate has to be applied here
      // too or a confused pair is the one thing that still lands on a black
      // key. When neither direction fits the key, the focus is not served at
      // all this time (and no trial is spent) -- the pool below is filtered.
      const ok = (iv) => this.feasible(anchorIndex, iv) && allowed(anchorIndex + iv);
      const iv = ok(pick) ? pick : ok(-pick) ? -pick : null;
      if (iv !== null) {
        f.left -= 1;
        f.served = (f.served || 0) + 1;
        if (f.served % FOCUS_EXPOSE_EVERY === 0) f.expose = true;
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
      pool = poolOverride.filter((i) => this.feasible(anchorIndex, i) && allowed(anchorIndex + i));
      if (pool.length === 0) pool = poolOverride.filter((i) => this.feasible(anchorIndex, i) && inBounds(anchorIndex + i));
      if (pool.length === 0) pool = poolOverride.filter((i) => this.feasible(anchorIndex, i));
      if (pool.length === 0) pool = this.poolFor(anchorIndex);
    } else if (hard) {
      // ALL SINGLE INTERVALS HARD (2026-10-23). The plain slot is the one
      // place an interval is heard on its own, and passages already carry the
      // secure ones thousands of times (his profile on 10-23: 4,306 graded
      // first-asked passage notes to 507 plain intervals, most of them steps),
      // so the slot asks only what is NOT secure: open simple
      // widths and open compounds, each on its own record. The ZPD weights,
      // centre pull, key lean and the `only` gate all still apply inside it.
      // There is no easy-interval reorientation when he struggles: passages
      // get shorter (drill.js LEN), single intervals do not get easier.
      // A FILTER MUST NEVER END THE DRILL: nothing unsecured that fits here
      // falls back to the whole open pool, the key gate before the hardness.
      const simple = this.poolFor(anchorIndex, extraTiers);
      const open = [...simple, ...this.openCompounds().filter((i) => this.feasible(anchorIndex, i))];
      const unsecured = open.filter((i) => !this.isSecure(i));
      const tiers = [
        [unsecured, (i) => allowed(anchorIndex + i)],
        [open, (i) => allowed(anchorIndex + i)],
        [unsecured, (i) => inBounds(anchorIndex + i)],
        [open, (i) => inBounds(anchorIndex + i)],
        [simple, () => true], // past every bound: never a compound
      ];
      pool = [];
      for (const [from, ok] of tiers) {
        pool = from.filter(ok);
        if (pool.length > 0) {
          if (from !== unsecured) this.lastFallback = unsecured.length === 0 ? 'every open interval is secure' : 'nothing unsecured fits from here';
          break;
        }
      }
    } else {
      const open = this.poolFor(anchorIndex, extraTiers);
      pool = open.filter((i) => allowed(anchorIndex + i));
      if (pool.length === 0) pool = open.filter((i) => inBounds(anchorIndex + i));
      if (pool.length === 0) pool = open;
    }
    if (pool.length === 0) return anchorIndex;
    // A hard pick weights accurate-but-slow intervals at the ZPD peak
    // (accurateUnsecured); every other pick, and every other interval, as before.
    const weights = pool.map((i) => this.weight(i, anchorIndex, now, prevIndex, { hard: hard && !poolOverride }) * (lean ? lean(anchorIndex + i) : 1));
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
    // A secure simple span is sometimes asked an octave wider: the DYAD slot's
    // wide ask (drill.js DYAD_WIDE_RATE; the span is judged there as a WIDE
    // record). The melodic plain slot stopped doing this on 2026-10-23: its
    // compounds are skills of their own now (COMPOUND_WIDTHS).
    if (allowWide && wideRate > 0 && this.state.tiersUnlocked >= WIDE_MIN_TIERS && Math.abs(interval) <= wideMax) {
      const wide = interval + (interval < 0 ? -12 : 12);
      const s = this.peekStats(interval);
      if (s.n >= 3 && s.acc >= 0.8 && this.feasible(anchorIndex, wide) && inBounds(anchorIndex + wide) && Math.random() < wideRate) {
        this.lastWide = true;
        this.ask(interval, anchorIndex, prevIndex, { scope });
        return anchorIndex + wide;
      }
    }
    return this.ask(interval, anchorIndex, prevIndex, { scope });
  }

  /** How many SIMPLE intervals are mastered right now (the dyad gate; compound records never count). */
  masteredCount() {
    let n = 0;
    for (const [k, s] of Object.entries(this.state.intervals)) {
      const iv = Number(k);
      if (!Number.isFinite(iv) || Math.abs(iv) > 12) continue;
      if (this.isMastered(s, this.predictedAccFrom(iv, this.cellKeysFor(iv, Math.floor(this.range / 2), null)))) n += 1;
    }
    return n;
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

  /**
   * @param {number} weight  1 for an isolated miss; passage near-misses count
   *   half, and only for leaps (a wrong step inside a phrase is usually the
   *   key's degree, not the interval's category)
   */
  recordConfusion(asked, tapped, weight = 1) {
    if (tapped === asked || tapped === 0) return;
    // Only pairs whose widths are in play and ADJACENT in size (the
    // confusions that actually happen: minor/major sixth, and fourth/fifth
    // across the tritone as the one two-semitone pair); a wild miss is not a
    // category boundary.
    // A compound pair is its own category boundary (a tenth against a
    // ninth), never folded onto the simple pair: both must be open compounds.
    const inPlay = (x) => (Math.abs(x) > 12 ? this.compoundOpen(x) : this.openInPassage(x));
    if (!inPlay(asked) || !inPlay(tapped)) return;
    if (Math.sign(asked) !== Math.sign(tapped)) return;
    const wa = Math.abs(asked);
    const wt = Math.abs(tapped);
    const fourthFifth = (wa === 5 && wt === 7) || (wa === 7 && wt === 5);
    if (Math.abs(wa - wt) > 1 && !fourthFifth) return;
    const key = `${AdaptiveEngine.key(asked)}|${AdaptiveEngine.key(tapped)}`;
    const count = (this.state.confusions[key] || 0) + weight;
    if (count >= CONFUSION_THRESHOLD) {
      delete this.state.confusions[key];
      if (!this.state.focus) { // one pair at a time, never a cascade
        this.state.focus = { a: asked, b: tapped, left: FOCUS_TRIALS, expose: true };
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
   * 60 bpm) or null when timing isn't attributable to this interval. `quick`:
   * the answer started within WIDE.reflexBeats of the call (drill.js); only
   * a right answer can be quick, whatever the caller says.
   * Returns { asked, missed, tierDelta, newlyMastered }.
   */
  reportResolved(rtNorm, { quick = false } = {}) {
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

    if (scope !== 'interval') {
      this.updateCells(cells, !missed);
      // A near miss inside a phrase is the same category boundary as one in
      // isolation, and it is where most of them happen.
      if (missed && scope === 'passage' && Math.abs(asked) >= 3) this.recordConfusion(asked, this.pending.tapped, 0.5);
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
      s.reflex = (s.reflex ?? REFLEX_PRIOR) * (1 - ACC_ALPHA) + (!missed && quick ? ACC_ALPHA : 0);
      this.updateCells(cells, !missed);
      newlyMastered = !wasMastered && this.isMastered(s, this.predictedAccFrom(asked, cells));
      // Kept as a reading only: it no longer moves the ladder (adjustTiers).
      this.state.overall.ewma = this.state.overall.ewma * (1 - OVERALL_ALPHA) + (missed ? 0 : OVERALL_ALPHA);
      this.state.overall.n += 1;
      this.state.attemptsSinceTierChange += 1;
      this.state.attemptsSinceCompoundChange += 1;
      this.adjustTiers();
    }
    this.pending = null;
    this.save();
    return { asked, missed, tierDelta: this.state.tiersUnlocked - tiersBefore, newlyMastered };
  }

  /**
   * THE LADDERS RATCHET (2026-10-23): a tier opens when the NEWEST open
   * interval is SECURE, and nothing ever closes.
   *
   * It used to run on the OVERALL EWMA of isolated answers: open above 85%,
   * close below 65%. Two things end that. (1) The plain slot now asks only
   * what is not secure (nextTargetIndex `hard`): every interval that gets
   * reliable leaves the pool, so the average of what it asks is held under
   * the 85% bar by construction -- it would never open a tier, and on a
   * bad week it would close them. (2) The average was never about the frontier: on 10-23
   * Caleb's frontier, the major seventh, read -11 at 50% (n=9) under an
   * overall 79%, and a closing tier took away an interval for a bad run on
   * others. The question the ladder asks is "is the newest one his yet?", so
   * that is what it reads: the frontier's own record, right AND quick
   * (isSecure), with the old seen-rules folded in (frontierSecure). The
   * cooldown stays: a width can be secure before its tier opens (remediation
   * and rounds reach past the ladder), and without it a run of those would
   * open several tiers on one answer.
   * Struggling is answered by SHORTER PASSAGES (drill.js LEN), not by a
   * smaller interval set: the hard pool stays hard.
   */
  adjustTiers() {
    const st = this.state;
    if (st.attemptsSinceTierChange >= TIER_CHANGE_COOLDOWN && st.tiersUnlocked < TIER_WIDTHS.length
      && this.frontierSecure(TIER_WIDTHS[st.tiersUnlocked - 1])) {
      st.tiersUnlocked += 1;
      st.attemptsSinceTierChange = 0;
      this.onOpen?.({ ladder: this.unsigned ? 'harmonic' : 'simple', width: TIER_WIDTHS[st.tiersUnlocked - 1], tier: st.tiersUnlocked, of: TIER_WIDTHS.length });
    }
    if (!this.compound || st.attemptsSinceCompoundChange < TIER_CHANGE_COOLDOWN) return;
    const ct = st.compoundTiers || 0;
    if (ct >= COMPOUND_WIDTHS.length) return;
    const next = COMPOUND_WIDTHS[ct];
    // The first opens with the octave; each next one with the newest secure
    // both ways and its simple counterpart open below.
    const ready = ct === 0
      ? st.tiersUnlocked >= OCTAVE_TIERS
      : this.isSecure(COMPOUND_WIDTHS[ct - 1]) && this.isSecure(-COMPOUND_WIDTHS[ct - 1]) && this.unlockedWidth(next - 12);
    if (!ready) return;
    st.compoundTiers = ct + 1;
    st.attemptsSinceCompoundChange = 0;
    this.onOpen?.({ ladder: 'compound', width: next, tier: ct + 1, of: COMPOUND_WIDTHS.length });
  }

  /**
   * SEED THE REFLEX RECORDS FROM HISTORY (2026-10-23, once per profile:
   * drill.js runs it under Db.runOnce). `rows`, oldest first:
   * { interval, correct, quick, ts, rt }. A simple interval's record gets ONLY
   * its `reflex` replayed -- acc and n were measured live and stay exactly as
   * they are. A compound row (|interval| > 12, melodic only) builds the
   * compound record whole, acc/n/reflex/rt/last, since none existed: those
   * answers were filed under the simple interval until today.
   */
  seedReflex(rows) {
    let simple = 0;
    let compound = 0;
    for (const r of rows) {
      const iv = this.unsigned ? Math.abs(r.interval) : r.interval;
      if (!Number.isFinite(iv) || iv === 0) continue;
      const quick = Boolean(r.correct && r.quick);
      if (Math.abs(iv) > 12) {
        if (!this.compound || Math.abs(iv) > 24) continue;
        const s = this.intervalStats(iv);
        s.acc = s.acc * (1 - ACC_ALPHA) + (r.correct ? ACC_ALPHA : 0);
        s.n += 1;
        s.last = Math.max(s.last, r.ts ?? 0);
        if (r.correct && r.rt !== null && r.rt !== undefined) s.rt = s.rt === null ? r.rt : s.rt * (1 - RT_ALPHA) + RT_ALPHA * r.rt;
        s.reflex = (s.reflex ?? REFLEX_PRIOR) * (1 - ACC_ALPHA) + (quick ? ACC_ALPHA : 0);
        compound += 1;
      } else {
        const s = this.intervalStats(iv);
        s.reflex = (s.reflex ?? REFLEX_PRIOR) * (1 - ACC_ALPHA) + (quick ? ACC_ALPHA : 0);
        simple += 1;
      }
    }
    this.save();
    return { simple, compound };
  }
}
