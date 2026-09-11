// Tempo is a property of the music, never a reward for playing in time.
//
// The rule this replaced raised the session tempo 4 bpm whenever 80% of recent
// notes landed in time, which optimised the wrong thing: an ear drill's tempo
// exists to give you time to HEAR the note, predict it and find it, not to
// test how fast your hands are. It also quietly ate the corpus, because the
// phrase picker drops any excerpt whose fastest note falls under MIN_NOTE_SEC
// at the session tempo -- past 110 bpm that is every sixteenth-note phrase,
// 38% of the collection. Play well, get rhythmically simpler music. Backwards.
//
// So tempo is decided per question, from three things in this order:
//   1. WHAT THE MUSIC IS. A style band per collection, and an audiation floor:
//      the fastest note in the excerpt has to last long enough to be heard.
//      A chorale in eighths sits near its band; running sixteenths pull the
//      same band down, because of what they are.
//   2. HOW THICK IT IS. Texture only ever slows it: four voices under both
//      hands is not the same task as one line.
//   3. WHAT THE HANDS HAVE SHOWN. A ceiling from history that can only lower
//      the tempo, never raise it -- see floorFromHistory, which tightens ONLY
//      on demonstrated failure at speed, never on how slow the material you
//      happened to be given was. Nothing here can turn into a treadmill.

// Where a collection's felt beat naturally sits. `pref` is what the music
// wants when nothing is in the way; `max` is as fast as it is ever worth
// asking, whatever the hands can do.
export const BANDS = {
  'bach-371-chorales': { pref: 68, max: 84 },
  'mozart-piano-sonatas': { pref: 88, max: 108 },
  hymns: { pref: 76, max: 96 },
};
export const DEFAULT_BAND = { pref: 76, max: 100 };

// Texture discounts. These only ever multiply below 1: thicker is slower.
export const TEXTURE = { mono: 1, duo: 0.94, chorale: 0.88, poly: 0.82 };

// An interval question is not an excerpt and has no tempo of its own. It gets
// a calm pulse, because the task is hearing rather than execution.
export const INTERVAL_BPM = 72;

// The fastest a note may go by and still be heard as a pitch rather than a
// blur. Everything else is measured against this.
export const AUDIATION_FLOOR_S = 0.19;

export const ABS_MIN_BPM = 40;

// floorFromHistory: bins of fastest-note duration, and what counts as coping.
const BIN_S = 0.04;
const CONSIDER_BELOW_S = 0.32; // above this, speed is not what is failing
const MIN_SAMPLES = 20;
const OK_RATE = 0.5;

/**
 * How fast a note this player has actually placed cleanly, as a floor in
 * seconds. Returns AUDIATION_FLOOR_S unless there is real evidence of failing
 * at speed, so a player who has simply never been given fast notes is never
 * locked into slow ones.
 *
 * @param {{fastestSec: number, clean: boolean}[]} rows recent graded notes,
 *   each tagged with the fastest note in the excerpt it came from
 */
export function floorFromHistory(rows) {
  const bins = new Map(); // bin index -> {n, clean}
  for (const { fastestSec, clean } of rows) {
    if (!(fastestSec > 0) || fastestSec >= CONSIDER_BELOW_S) continue;
    const b = Math.floor(fastestSec / BIN_S);
    const cur = bins.get(b) ?? { n: 0, clean: 0 };
    cur.n += 1;
    if (clean) cur.clean += 1;
    bins.set(b, cur);
  }
  // Fastest bin first: the floor is the top of the fastest one being failed.
  for (const b of [...bins.keys()].sort((x, y) => x - y)) {
    const { n, clean } = bins.get(b);
    if (n < MIN_SAMPLES) continue;
    if (clean / n < OK_RATE) return (b + 1) * BIN_S;
  }
  return AUDIATION_FLOOR_S;
}

/**
 * The tempo for one excerpt.
 * @param {{collection: string, minDur: number, kind: string}} phrase
 *   `minDur` is the shortest note in the phrase, in felt beats.
 * @param {number} floorSec the shortest note worth asking for right now
 */
export function passageTempo(phrase, floorSec = AUDIATION_FLOOR_S) {
  const band = BANDS[phrase.collection] ?? DEFAULT_BAND;
  const floor = Math.max(AUDIATION_FLOOR_S, floorSec);
  const wanted = band.pref * (TEXTURE[phrase.kind] ?? 1);
  // The fastest note has to last at least `floor`, which caps the tempo.
  const allowed = (60 * phrase.minDur) / floor;
  return Math.round(Math.max(ABS_MIN_BPM, Math.min(band.max, wanted, allowed)));
}

/** Timing tolerance for a tempo: an eighth of a beat, held within reason. */
export function toleranceMsFor(bpm) {
  return Math.max(45, Math.min(110, 7500 / bpm));
}
