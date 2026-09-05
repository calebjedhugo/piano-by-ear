// Adaptive interval selection, ported from ear-training (calebjedhugo/ear-training).
//
// A difficulty controller that holds first-attempt success near ~80% by
// choosing WHICH signed semitone interval the next target makes with the
// anchor. Skills are signed intervals (+7 = up a P5, -7 = down a P5),
// tracked separately. Persistence is injected: `store.load()` returns the
// saved state object (or null), `store.save(state)` writes it.
//
// In the metered drill, "response time" is the ABSOLUTE ONSET ERROR of the
// correct note against the beat, so the fluency gate on mastery means
// "accurate AND in time".

const SCHEMA_VERSION = 1;

// Interval widths ordered by AURAL difficulty, not width — an octave is
// easier to hear than a major sixth. Each tier unlocks both directions.
export const TIER_WIDTHS = [
  12, 7, 5, 4, 3, 9, 2, 8, 1, 10, 11, 6,
  // compounds, ordered by their simple interval's difficulty
  19, 17, 16, 15, 21, 14, 20, 13, 22, 23, 18,
];

const MIN_TIERS = 2; // never shrink below P8 + P5
const ACC_ALPHA = 0.3;
const OVERALL_ALPHA = 0.15;
const RT_ALPHA = 0.3;
const TARGET_LOW = 0.65;
const TARGET_HIGH = 0.85;
const TIER_CHANGE_COOLDOWN = 8;
const MASTERED_ACC = 0.9;
const REVIEW_FULL_MS = 3 * 24 * 60 * 60 * 1000;
const CONFUSION_THRESHOLD = 2;
const DISCRIMINATION_RUN = 4;
const WARMUP_QUESTIONS = 5;

const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
function colorOf(pc) {
  return WHITE_PCS.has(((pc % 12) + 12) % 12) ? 'w' : 'b';
}

const PERFECT_PCS = new Set([0, 5, 7]);
const CONSONANT_PCS = new Set([3, 4, 8, 9]);
function contextBucket(semitones) {
  const pc = ((semitones % 12) + 12) % 12;
  if (PERFECT_PCS.has(pc)) return 'perfect';
  if (CONSONANT_PCS.has(pc)) return 'consonant';
  return 'dissonant';
}

const CELL_SHRINK_K = 4;

function freshState() {
  return {
    version: SCHEMA_VERSION,
    tiersUnlocked: MIN_TIERS,
    overall: { ewma: 0.75, n: 0 },
    attemptsSinceTierChange: 0,
    intervals: {},
    cells: {},
    confusions: {},
  };
}

export class AdaptiveEngine {
  /**
   * @param {object} opts
   * @param {number} opts.range        highest valid pitch index (lowest is 0)
   * @param {number} opts.fluentMs     max "response time" (onset error) for mastery
   * @param {number} opts.pitchClassOffset  pitch class of index 0 (MIDI 21 = A = 9)
   * @param {{load: () => object|null, save: (state: object) => void}} opts.store
   */
  constructor({ range, fluentMs, pitchClassOffset = 0, store }) {
    this.range = range;
    this.fluentMs = fluentMs;
    this.pcOffset = pitchClassOffset;
    this.store = store;
    const loaded = store.load();
    this.state = loaded && loaded.version === SCHEMA_VERSION ? loaded : freshState();
    this.discriminationQueue = [];
    this.questionInSession = 0;
    this.prevAnchorIndex = null;
    this.lastAskedCells = [];
    this.pending = null;
  }

  save() {
    this.store.save(this.state);
  }

  startSession() {
    this.questionInSession = 0;
    this.discriminationQueue = [];
    this.prevAnchorIndex = null;
    this.lastAskedCells = [];
    this.pending = null;
  }

  unlockedIntervals(tiers = this.state.tiersUnlocked) {
    const signed = [];
    for (const w of TIER_WIDTHS.slice(0, tiers)) signed.push(w, -w);
    return signed;
  }

  poolFor(anchorIndex) {
    for (let tiers = this.state.tiersUnlocked; tiers <= TIER_WIDTHS.length; tiers += 1) {
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

  cellKeysFor(interval, anchorIndex) {
    const iKey = AdaptiveEngine.key(interval);
    const target = anchorIndex + interval;
    const keys = [`${iKey}|${colorOf(anchorIndex + this.pcOffset)}${colorOf(target + this.pcOffset)}`];
    if (this.prevAnchorIndex !== null) {
      keys.push(`${iKey}|ctx:${contextBucket(target - this.prevAnchorIndex)}`);
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

  predictedAcc(interval, anchorIndex) {
    const parent = this.intervalStats(interval);
    let acc = parent.acc;
    for (const key of this.cellKeysFor(interval, anchorIndex)) {
      const c = this.state.cells[key];
      if (c && c.n > 0) acc += (c.n / (c.n + CELL_SHRINK_K)) * (c.acc - parent.acc);
    }
    return Math.max(0, Math.min(1, acc));
  }

  weight(interval, anchorIndex, now) {
    const s = this.intervalStats(interval);
    const acc = this.predictedAcc(interval, anchorIndex);
    let w;
    if (s.n < 3) {
      w = 1.5;
    } else if (this.isMastered(s, acc)) {
      w = 0.2 + 0.7 * Math.min(1, (now - s.last) / REVIEW_FULL_MS);
    } else {
      w = 2.2 - 2 * Math.abs(acc - 0.7);
    }
    w = Math.max(w, 0.15);

    const warmLeft = WARMUP_QUESTIONS - this.questionInSession;
    if (warmLeft > 0 && s.n >= 3) w *= 1 + (warmLeft / WARMUP_QUESTIONS) * 1.5 * acc;

    const center = this.range / 2;
    const movesToCenter =
      Math.abs(anchorIndex + interval - center) < Math.abs(anchorIndex - center);
    if (movesToCenter) w *= 1.25;

    return w;
  }

  nextTargetIndex(anchorIndex) {
    this.questionInSession += 1;

    const commit = (interval) => {
      this.lastAsked = interval;
      this.lastAskedCells = this.cellKeysFor(interval, anchorIndex);
      this.prevAnchorIndex = anchorIndex;
      return anchorIndex + interval;
    };

    while (this.discriminationQueue.length > 0) {
      const interval = this.discriminationQueue.shift();
      if (this.feasible(anchorIndex, interval)) return commit(interval);
    }

    const now = Date.now();
    const pool = this.poolFor(anchorIndex);
    if (pool.length === 0) return anchorIndex;
    const weights = pool.map((i) => this.weight(i, anchorIndex, now));
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
    return commit(interval);
  }

  updateCells(cells, success) {
    for (const key of cells) {
      const c = this.cellStats(key);
      c.acc = c.acc * (1 - ACC_ALPHA) + (success ? ACC_ALPHA : 0);
      c.n += 1;
    }
  }

  reportMiss(anchorIndex, playedIndex) {
    if (this.pending) return;
    this.pending = {
      asked: this.lastAsked,
      cells: this.lastAskedCells,
      tapped: playedIndex - anchorIndex,
    };
  }

  recordConfusion(asked, tapped) {
    if (tapped === asked || tapped === 0) return;
    const key = `${AdaptiveEngine.key(asked)}|${AdaptiveEngine.key(tapped)}`;
    const count = (this.state.confusions[key] || 0) + 1;
    if (count >= CONFUSION_THRESHOLD) {
      delete this.state.confusions[key];
      for (let i = 0; i < DISCRIMINATION_RUN; i += 1) {
        this.discriminationQueue.push(i % 2 === 0 ? asked : tapped);
      }
    } else {
      this.state.confusions[key] = count;
    }
  }

  /** The correct note finally arrived. `rtMs` = abs onset error vs the beat. */
  reportResolved(rtMs) {
    const missed = this.pending !== null;
    const asked = missed ? this.pending.asked : this.lastAsked;
    const cells = missed ? this.pending.cells : this.lastAskedCells;

    const s = this.intervalStats(asked);
    s.n += 1;
    s.last = Date.now();
    if (missed) {
      s.acc = s.acc * (1 - ACC_ALPHA);
      this.recordConfusion(asked, this.pending.tapped);
    } else {
      s.acc = s.acc * (1 - ACC_ALPHA) + ACC_ALPHA;
      s.rt = s.rt === null ? rtMs : s.rt * (1 - RT_ALPHA) + RT_ALPHA * rtMs;
    }
    this.updateCells(cells, !missed);
    this.state.overall.ewma =
      this.state.overall.ewma * (1 - OVERALL_ALPHA) + (missed ? 0 : OVERALL_ALPHA);
    this.state.overall.n += 1;
    this.state.attemptsSinceTierChange += 1;
    this.pending = null;

    this.adjustTiers();
    this.save();
    return { asked, missed };
  }

  adjustTiers() {
    if (this.state.attemptsSinceTierChange < TIER_CHANGE_COOLDOWN) return;
    const { ewma } = this.state.overall;

    if (ewma > TARGET_HIGH && this.state.tiersUnlocked < TIER_WIDTHS.length) {
      const frontierWidth = TIER_WIDTHS[this.state.tiersUnlocked - 1];
      const seen = [frontierWidth, -frontierWidth].every((i) => this.intervalStats(i).n >= 3);
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
