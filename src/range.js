// Per-controller key range. MIDI doesn't advertise how many keys a
// controller has, so: guess from a key count in the port name ("Keystation
// Pro 88" -> 21..108, "MPK mini 25" -> 48..72), then widen as notes outside
// the guess are actually observed. Persisted per port name so a controller
// is recognized the next time it's plugged in.

const LAYOUTS = {
  88: [21, 108],
  76: [28, 103],
  73: [28, 100],
  61: [36, 96],
  49: [36, 84],
  37: [48, 84],
  32: [48, 79],
  25: [48, 72],
};
const FALLBACK = [48, 72]; // two octaves from C3 until we see otherwise

export function guessRange(portName) {
  const nums = (portName.match(/\d+/g) || []).map(Number);
  for (const n of nums) if (LAYOUTS[n]) return { lo: LAYOUTS[n][0], hi: LAYOUTS[n][1], guessed: true };
  return { lo: FALLBACK[0], hi: FALLBACK[1], guessed: true };
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
    return (this.portName && this.byPort[this.portName]) || { lo: FALLBACK[0], hi: FALLBACK[1] };
  }

  /** Returns true when the range widened. */
  observe(note) {
    if (!this.portName) return false;
    const r = this.byPort[this.portName];
    let changed = false;
    if (note < r.lo) { r.lo = note; changed = true; }
    if (note > r.hi) { r.hi = note; changed = true; }
    if (changed) {
      r.guessed = false;
      this.store.save(this.byPort);
    }
    return changed;
  }
}
