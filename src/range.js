// Per-controller key range. MIDI doesn't advertise how many keys a
// controller has, so: guess from a standalone key count in the port name
// ("Keystation Pro 88" -> 21..108, "Launchkey 25" -> 48..72; "MPK249" does
// NOT match 49), otherwise start from two octaves around middle C. A note
// outside the range widens it: while the range is still a guess it snaps to
// the smallest standard layout containing both the old range and the note,
// so one A0 turns a fallback into a full 88 instead of a lopsided 21..72.
// Persisted per port name so a controller is recognized next time.

const LAYOUTS = [
  [25, 48, 72],
  [32, 48, 79],
  [37, 48, 84],
  [49, 36, 84],
  [61, 36, 96],
  [73, 28, 100],
  [76, 28, 103],
  [88, 21, 108],
];
const FALLBACK = [48, 72];
const KEY_COUNT = /(?:^|\D)(25|32|37|49|61|73|76|88)(?!\d)/;

export function guessRange(portName) {
  const m = portName.match(KEY_COUNT);
  if (m) {
    const layout = LAYOUTS.find((l) => l[0] === Number(m[1]));
    return { lo: layout[1], hi: layout[2], guessed: true, named: true };
  }
  return { lo: FALLBACK[0], hi: FALLBACK[1], guessed: true, named: false };
}

export class RangeTracker {
  /** @param {{load: () => object|null, save: (v: object) => void}} store */
  constructor(store) {
    this.store = store;
    this.byPort = store.load() || {};
    this.portName = null;
  }

  setPort(portName) {
    this.portName = portName;
    if (portName && !this.byPort[portName]) {
      this.byPort[portName] = guessRange(portName);
      this.store.save(this.byPort);
    }
  }

  get current() {
    return (this.portName && this.byPort[this.portName]) || { lo: FALLBACK[0], hi: FALLBACK[1], guessed: true };
  }

  /** Returns true when the range widened. */
  observe(note) {
    if (!this.portName) return false;
    const r = this.byPort[this.portName];
    if (note >= r.lo && note <= r.hi) return false;
    if (r.guessed) {
      const fit = LAYOUTS.find((l) => l[1] <= Math.min(r.lo, note) && l[2] >= Math.max(r.hi, note));
      if (fit) {
        r.lo = fit[1];
        r.hi = fit[2];
      } else {
        r.lo = Math.min(r.lo, note);
        r.hi = Math.max(r.hi, note);
      }
      r.guessed = false;
    } else {
      r.lo = Math.min(r.lo, note);
      r.hi = Math.max(r.hi, note);
    }
    this.store.save(this.byPort);
    return true;
  }
}
