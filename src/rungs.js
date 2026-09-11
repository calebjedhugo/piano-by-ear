// The rungs below exact pitch. A passage is still passed or failed on exact
// pitch alone (failing to recover to the right note IS the error), but that
// binary hides most of what happened: on dense material the player's contour
// was 98% right while exact pitch was 48%. These summaries make the lower
// rungs visible so retry and difficulty decisions can be made on them:
//
//   direction      the interval went the right way         (contour)
//   near           the interval was within a semitone      (sizing)
//   selfCorrected  the note was missed and then caught: the player went back
//                  and played it right before the next one was due (one
//                  re-attack per note, src/drill.js). NOT the same as
//                  `recovered`, which is the professional recovery -- play
//                  on, say nothing, get back onto the line further down.
//                  This is the amateur one, and it is the one that says the
//                  player HEARD the mistake.
//   recovered      after the first wrong note, a later note landed exactly
//   exact          the note itself
//
// Contour is measured between adjacent notes of ONE voice that were both
// actually played, so a missed note never fakes an interval across the gap.
// A free note (the pivot on the anchor) is context: it counts toward contour
// if it was played and is never an error if it was skipped.

/**
 * @param {{expected: number, played: number|null, free?: boolean, b: number, voice?: number,
 *   selfCorrected?: boolean}[]} notes
 *   every note of the passage; `played` null = never attempted; `b` orders them
 */
export function summarizeRungs(notes) {
  const r = { notes: 0, attempted: 0, exact: 0, intervals: 0, direction: 0, near: 0, exactInterval: 0, firstError: null, recovered: null, selfCorrected: 0 };
  const inOrder = notes.slice().sort((x, y) => x.b - y.b);
  const real = inOrder.filter((n) => !n.free);
  real.forEach((n, i) => {
    r.notes += 1;
    if (n.played !== null) r.attempted += 1;
    if (n.played === n.expected) r.exact += 1;
    else {
      // A caught note is still a miss on the first attempt -- it is where the
      // error was, so firstError still points here -- but it is not nothing.
      if (n.selfCorrected) r.selfCorrected += 1;
      if (r.firstError === null) r.firstError = i;
    }
  });
  if (r.firstError !== null && r.firstError < real.length - 1) {
    r.recovered = real.slice(r.firstError + 1).some((n) => n.played === n.expected);
  }
  const voices = new Map();
  for (const n of inOrder) {
    const v = n.voice ?? 0;
    if (!voices.has(v)) voices.set(v, []);
    voices.get(v).push(n);
  }
  for (const line of voices.values()) {
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      if (a.played === null || b.played === null) continue;
      const want = b.expected - a.expected;
      const got = b.played - a.played;
      r.intervals += 1;
      if (Math.sign(want) === Math.sign(got)) r.direction += 1;
      if (Math.abs(want - got) <= 1) r.near += 1;
      if (want === got) r.exactInterval += 1;
    }
  }
  return r;
}

/**
 * Orders two attempts at the same passage: exact pitch counts most, then
 * sizing, then shape, so "closer" means climbing the ladder even before any
 * note is exactly right. The weights are a judgment, not a measurement.
 */
export function rungScore(r) {
  const rate = (a, b) => (b > 0 ? a / b : 0);
  // A self-corrected note is worth half an exact one: the same pitch
  // knowledge, arrived at late. A player who catches his own notes IS closer
  // than one who does not notice, and "closer" is what keeps a retry coming.
  return rate(r.exact, r.notes) + 0.5 * rate(r.selfCorrected, r.notes)
    + 0.5 * rate(r.near, r.intervals) + 0.25 * rate(r.direction, r.intervals);
}

/** One log phrase for a failed passage: what was right beneath the wrong notes. */
export function describeRungs(r) {
  const parts = [];
  if (r.intervals > 0) parts.push(`shape ${r.direction}/${r.intervals}`, `sizing ${r.near}/${r.intervals}`);
  if (r.selfCorrected > 0) parts.push(`${r.selfCorrected} caught`);
  if (r.attempted < r.notes) parts.push(`${r.notes - r.attempted} not played`);
  if (r.recovered !== null) parts.push(r.recovered ? 'recovered' : 'no recovery');
  return parts.join(', ');
}
