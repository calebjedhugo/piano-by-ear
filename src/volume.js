// THE VOLUME IS CC 7 (Caleb, 2026-09-20: he swept a Keystation fader, it
// reported as CC 7 -- MIDI's own volume controller -- and he wants it FIXED,
// not learned). It drives the app's master gain, not the codec's mixer, so
// it is the same on every machine and nothing shells out. A square law keeps
// the bottom half of the throw useful (a linear fader is all loudness in the
// top quarter). The last position is kept across restarts in
// `~/.piano-by-ear/volume.json`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const VOLUME_CC = 7;
const MAX_GAIN = 1.0;

export class VolumeFader {
  constructor({ path, audio, log }) {
    this.path = path;
    this.audio = audio;
    this.log = log;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (Number.isInteger(raw?.value)) this.apply(raw.value, { quiet: true });
    } catch { /* first run: the master gain's default stands until the fader moves */ }
  }

  onControl({ type, number, value }) {
    if (type !== 'cc' || number !== VOLUME_CC) return;
    this.apply(value);
  }

  apply(value, { quiet = false } = {}) {
    const gain = MAX_GAIN * (value / 127) ** 2;
    this.audio.master.gain.setTargetAtTime(gain, this.audio.ctx.currentTime, 0.02);
    try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify({ cc: VOLUME_CC, value })); } catch { /* best effort */ }
    if (!quiet) this.log(`volume: ${Math.round((value / 127) * 100)}%`);
  }
}
