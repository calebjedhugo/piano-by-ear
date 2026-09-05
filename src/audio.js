// Headless audio: a small additive "piano" voice, a metronome click, and
// feedback cues, all scheduled on the AudioContext clock so the grid is
// sample-accurate rather than setTimeout-accurate.
import { AudioContext } from 'node-web-audio-api';

export function midiToHz(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

export class Audio {
  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
  }

  get now() {
    return this.ctx.currentTime;
  }

  /** Piano-ish note: fundamental + a few decaying harmonics. */
  note(midi, { at = this.now, velocity = 100, duration = 1.2 } = {}) {
    const hz = midiToHz(midi);
    const amp = 0.25 * (velocity / 127) ** 1.5;
    const partials = [
      [1, 1.0, 0.9],
      [2, 0.5, 0.6],
      [3, 0.25, 0.45],
      [4, 0.12, 0.35],
      [5, 0.06, 0.3],
    ];
    const out = this.ctx.createGain();
    out.gain.value = 1;
    out.connect(this.master);
    for (const [mult, level, decayFrac] of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(amp * level, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0005, at + duration * decayFrac);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + duration);
    }
  }

  click(at, { accent = false } = {}) {
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1600 : 1000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(accent ? 0.18 : 0.1, at);
    g.gain.exponentialRampToValueAtTime(0.0005, at + 0.03);
    osc.connect(g).connect(this.master);
    osc.start(at);
    osc.stop(at + 0.04);
  }

  /** Soft high chime: correct AND in time. */
  good(at = this.now) {
    for (const [hz, delay] of [[1760, 0], [2637, 0.06]]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.07, at + delay);
      g.gain.exponentialRampToValueAtTime(0.0005, at + delay + 0.25);
      osc.connect(g).connect(this.master);
      osc.start(at + delay);
      osc.stop(at + delay + 0.3);
    }
  }

  /** Low buzz: wrong pitch. */
  bad(at = this.now) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 110;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.06, at);
    g.gain.exponentialRampToValueAtTime(0.0005, at + 0.18);
    osc.connect(g).connect(this.master);
    osc.start(at);
    osc.stop(at + 0.2);
  }

  /** Two descending tones: session over. */
  sessionOver(at = this.now) {
    this.note(64, { at, velocity: 60, duration: 0.5 });
    this.note(57, { at: at + 0.25, velocity: 60, duration: 0.8 });
  }

  async close() {
    await this.ctx.close();
  }
}
