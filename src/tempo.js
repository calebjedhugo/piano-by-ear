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

// RE-METERING. Sixteenths cannot be given air by tempo alone: at 0.38s a
// sixteenth the pulse is 39 bpm, under ABS_MIN_BPM, and every quarter and
// half note in the excerpt drags behind it. So when the fastest note would
// still go by too quickly, the excerpt is re-metered instead -- THE SHORTEST
// NOTE BECOMES THE BEAT, and the long notes are capped so they do not scale
// with it. Caleb, 2026-09-14: "Those passages need to be slowed down to
// half-time and then any longer notes put back at the regular tempo so things
// don't get too slow. If I play the right notes, it's because I'm ignoring
// the metronome -- less experienced musicians aren't going to know what to
// do." The click then lands on every note and its accent still marks the
// written beat, which is what a teacher does with a metronome.
// The data that bought this (Caleb, mono first askings, same composer and
// length band): Mozart in sixteenths 16% clean (n=63), eighths 25% (n=53),
// quarters 57% (n=21); sixteenths at 7-9 notes, 3% (n=31).
export const REMETER_BELOW_S = 0.32; // fastest note this short: re-meter it
export const UNIT_TARGET_S = 0.4; // what the shortest note gets to last
export const MAX_NOTE_BEATS = 2; // nothing is held longer than a half note

// floorFromHistory: bins of fastest-note duration, and what counts as coping.
const BIN_S = 0.04;
const CONSIDER_BELOW_S = 0.32; // above this, speed is not what is failing
const MIN_SAMPLES = 20;
// A PASSAGE is clean only when EVERY note lands, so the note-level rate this
// compares against has to be the one that adds up to a passage worth serving:
// 0.5 per note over a six-note excerpt is 3% clean, which is what the drill
// was actually serving (2026-09-14: 0.20-0.24s notes 55% correct, and the
// passages built from them 3-16% clean -- the net never fired because it was
// measuring the wrong unit). 0.85^6 is about half.
const OK_RATE = 0.85;

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
  // The floor has to clear EVERY bin being failed, so it is the top of the
  // SLOWEST failing one. (It used to return at the fastest, which let a bin
  // that was also being failed sit above the floor it had just set.)
  let floor = AUDIATION_FLOOR_S;
  for (const b of bins.keys()) {
    const { n, clean } = bins.get(b);
    if (n < MIN_SAMPLES) continue;
    if (clean / n < OK_RATE) floor = Math.max(floor, (b + 1) * BIN_S);
  }
  return floor;
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

/**
 * Should this excerpt be re-metered, and into what? Null when the music is
 * already slow enough to be heard at its own tempo (so chorales in halves and
 * quarters are untouched -- the transform only bites where there are fast
 * notes).
 *
 * @param {{collection: string, minDur: number, kind: string}} phrase
 * @param {number} floorSec the shortest note worth asking for right now
 */
export function remeterPlan(phrase, floorSec = AUDIATION_FLOOR_S) {
  // AGAINST THE TEMPO THE MUSIC WANTS, never the floor-reduced one. Reading
  // the reduced tempo here inverted the whole thing: a raised floor (a player
  // who is FAILING at speed) slowed the excerpt until its fastest note
  // cleared the trigger, switched re-metering off, and handed him the 43 bpm
  // version with quarters dragging at 1.4s -- the exact state this exists to
  // prevent. A raised floor now widens the click below instead.
  const beatSec = 60 / passageTempo(phrase, AUDIATION_FLOOR_S);
  if (!(phrase.minDur > 0) || phrase.minDur * beatSec >= REMETER_BELOW_S) return null;
  const unitSec = Math.max(UNIT_TARGET_S, floorSec);
  return {
    beatSec, // one written beat, in seconds, at the tempo the music wanted
    unitSec,
    // Caleb, 2026-09-14: the longest note in these drills should be a half
    // note. Held longer than that it is dead air in an ear drill, and the
    // written value is no longer telling the player anything they have to
    // reproduce. (Only re-metered excerpts are capped -- music slow enough to
    // be heard at its own tempo still keeps its own rhythm exactly.)
    cap: Math.max(1, Math.round((MAX_NOTE_BEATS * beatSec) / unitSec)),
    bpm: Math.round(60 / unitSec),
    // Roughly the written bar, so the accent still means something.
    meter: Math.min(16, Math.max(1, Math.round(beatSec / unitSec)) * (phrase.meter || 4)),
  };
}

/**
 * THE EXCERPT RE-QUANTISED ONTO A CLICK THAT RUNS AT THE AUDIATION RATE.
 * Every gap and length is measured in REAL SECONDS at the tempo the music
 * wanted, then rounded to whole clicks with a minimum of one. So a note that
 * was already long enough keeps very nearly the duration it had -- a quarter
 * at 0.88s comes out 0.80s, not 1.60s -- and only the notes that were too
 * fast to hear are stretched, which is the whole point: "any longer notes put
 * back at the regular tempo so things don't get too slow."
 *
 * The cost, and it is a real one: sixteenths and eighths both become one
 * click, so a 2:1 written ratio flattens. The pitch task is preserved exactly
 * and the rhythm is approximated -- the trade this transform exists to make.
 *
 * Simultaneity survives (one onset maps to one onset, so voices stay
 * together) and everything lands on the click, because every value is a whole
 * number of units.
 *
 * @param {number[][]} notes [midi, offsetBeats, durationBeats, voice?]
 */
export function remeterNotes(notes, { beatSec, unitSec, cap }) {
  const clicks = (beats) => Math.min(cap, Math.max(1, Math.round((beats * beatSec) / unitSec)));
  const onsets = [...new Set(notes.map((n) => n[1]))].sort((a, b) => a - b);
  const at = new Map();
  let t = 0;
  for (let i = 0; i < onsets.length; i += 1) {
    at.set(onsets[i], t);
    if (i + 1 < onsets.length) t += clicks(onsets[i + 1] - onsets[i]);
  }
  // NEVER MORE THAN ONE CLICK OF SILENCE between onsets. The corpus already
  // excludes any phrase holding a beat of rest (MAX_REST_BEATS in phrases.js:
  // a beat of silence is what asks for the next question, so a call must
  // never contain one), and rounding a 0.79s rest up to two clicks would put
  // that back. The note is lengthened, never the gap: articulation survives,
  // the false "your turn" does not.
  const next = new Map();
  for (let i = 0; i < onsets.length - 1; i += 1) next.set(onsets[i], at.get(onsets[i + 1]));
  return notes.map(([midi, off, dur, voice]) => {
    const b = at.get(off);
    const gap = next.has(off) ? next.get(off) - b : Infinity;
    return [midi, b, Math.max(clicks(dur), Math.min(cap, gap - 1)), voice];
  });
}
