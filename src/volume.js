// THE VOLUME IS A FADER ON THE KEYBOARD (Caleb, 2026-09-20: "I moved a fader
// on the Keystation from min to max to min again. I'd like that to control
// the volume"). No setting, no flag: the binding IS that gesture. The first
// controller that sweeps its whole range -- down to 0 and up to 127 within a
// few seconds -- becomes the volume fader, and stays it across restarts
// (`~/.piano-by-ear/volume.json`). Any other fader or knob is ignored until
// it is swept too, which re-binds. CC 64 (sustain) can never be it.
//
// The fader drives the app's master gain, not the codec's mixer, so it works
// the same on every machine and nothing shells out. A square law keeps the
// bottom half of the throw useful (a linear fader is all loudness in the top
// quarter).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SUSTAIN_CC = 64;
const SWEEP_WINDOW_MS = 8000;
const MAX_GAIN = 1.0;

export class VolumeFader {
  constructor({ path, audio, log }) {
    this.path = path;
    this.audio = audio;
    this.log = log;
    this.seen = new Map(); // cc -> { lo: ms, hi: ms } when each end was last touched
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (Number.isInteger(raw?.cc)) { this.cc = raw.cc; this.apply(raw.value ?? 127, { quiet: true }); }
    } catch { this.cc = null; }
  }

  onControl({ type, number, value }) {
    if (type !== 'cc' || number === SUSTAIN_CC) return;
    const now = Date.now();
    if (number !== this.cc) {
      const s = this.seen.get(number) ?? { lo: 0, hi: 0 };
      if (value === 0) s.lo = now;
      if (value === 127) s.hi = now;
      this.seen.set(number, s);
      // Both ends inside the window: that is the sweep, and this is the fader.
      if (!(s.lo && s.hi && Math.abs(s.lo - s.hi) <= SWEEP_WINDOW_MS)) return;
      this.cc = number;
      this.seen.clear();
      this.log(`volume: fader is CC ${number} (it swept the whole range)`);
    }
    this.apply(value);
  }

  apply(value, { quiet = false } = {}) {
    const gain = MAX_GAIN * (value / 127) ** 2;
    this.audio.master.gain.setTargetAtTime(gain, this.audio.ctx.currentTime, 0.02);
    try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify({ cc: this.cc, value })); } catch { /* best effort */ }
    if (!quiet) this.log(`volume: ${Math.round((value / 127) * 100)}%`);
  }
}
