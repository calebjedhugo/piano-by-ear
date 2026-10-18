// Per-controller key range. MIDI doesn't advertise how many keys a
// controller has, so: guess from a standalone key count in the port name
// ("Keystation Pro 88" -> 21..108, "Launchkey 25" -> 48..72; "MPK249" does
// NOT match 49), otherwise start from two octaves around middle C. A note
// outside the range widens it, ALWAYS to the smallest standard layout
// containing both the old range and the note, so one A0 turns a fallback
// into a full 88 instead of a lopsided 21..72.
//
// THE RANGE IS THE KEYBOARD'S, NOT THE PLAYER'S (2026-10-17). It used to be
// kept per profile and widened only to the notes that profile had played, so
// the same 88-key piano was 44..108 for one player and 24..108 for another.
// The middle of that range is where the anchor's walk is pulled back to
// (AdaptiveEngine.centerPull), so a lopsided range moved the middle: on
// 44..108 it was E5, and a session sat around E-flat 6 all night. Now one
// record per port name is shared by every profile on the machine
// (~/.piano-by-ear/ranges.json, `fileStore`), and a learned range snaps to a
// real keyboard size just as a guessed one does. A profile's old per-profile
// record is folded in when it opens (`legacy`), so nothing it learned is lost.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** The smallest standard keyboard holding lo..hi; past every layout, lo..hi as is. */
function snap(lo, hi) {
  const fit = LAYOUTS.find((l) => l[1] <= lo && l[2] >= hi);
  return fit ? { lo: fit[1], hi: fit[2] } : { lo, hi };
}

/** A JSON file as a {load, save} store: the machine's ranges, shared by every profile. */
export function fileStore(path) {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(v) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
    },
  };
}

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
  /**
   * @param {{load: () => object|null, save: (v: object) => void}} store
   * @param {object|null} legacy a profile's own per-port record, folded in (widen only)
   */
  constructor(store, legacy = null) {
    this.store = store;
    this.byPort = store.load() || {};
    this.portName = null;
    let changed = false;
    for (const [port, r] of Object.entries(legacy || {})) {
      const mine = this.byPort[port];
      const lo = Math.min(r.lo, mine?.lo ?? r.lo);
      const hi = Math.max(r.hi, mine?.hi ?? r.hi);
      if (!mine || lo < mine.lo || hi > mine.hi) {
        this.byPort[port] = { ...(mine || r), lo, hi };
        changed = true;
      }
    }
    // Every record on a real keyboard size, learned ones included.
    for (const r of Object.values(this.byPort)) {
      const s = snap(r.lo, r.hi);
      if (s.lo !== r.lo || s.hi !== r.hi) {
        Object.assign(r, s);
        changed = true;
      }
    }
    if (changed) this.store.save(this.byPort);
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
    Object.assign(r, snap(Math.min(r.lo, note), Math.max(r.hi, note)));
    r.guessed = false;
    this.store.save(this.byPort);
    return true;
  }
}
