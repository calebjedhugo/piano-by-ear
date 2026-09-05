// Headless audio: a small additive "piano" voice, a metronome click, and a
// fixed vocabulary of cues, all scheduled on the AudioContext clock so the
// grid is sample-accurate rather than setTimeout-accurate.
//
// Cue registers never overlap the piano: clicks are 1-2 kHz squares, "good"
// cues are sines above 1.7 kHz, timing cues are mid glides, the wrong-pitch
// buzz is a 110 Hz sawtooth.
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
    this.voices = new Map(); // midi -> sustained voice held while a key is down
  }

  get now() {
    return this.ctx.currentTime;
  }

  /**
   * The SYSTEM's voice (the call): a softer, bell-like tone -- triangle
   * fundamental with a couple of shimmering partials and a fast decay -- so
   * it is clearly a different instrument from the piano you play. `duration`
   * in s, capped.
   */
  note(midi, { at = this.now, velocity = 100, duration = 1.2 } = {}) {
    const start = Math.max(at, this.now);
    const dur = Math.max(0.15, Math.min(2.0, duration));
    const hz = midiToHz(midi);
    const amp = 0.2 * (velocity / 127) ** 1.5;
    const partials = [
      [1, 1.0, 'triangle', 1.0],
      [2.005, 0.3, 'sine', 0.5],
      [3.01, 0.12, 'sine', 0.35],
    ];
    for (const [mult, level, type, decayFrac] of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(amp * level, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0005, start + Math.max(0.06, dur * decayFrac));
      osc.connect(g).connect(this.master);
      osc.start(start);
      osc.stop(start + dur);
    }
  }

  /**
   * A sustained piano voice for a key that is down. It rises quickly, decays
   * gently while held (like a real string), and is silenced by stopVoice()
   * when the key is released -- so the sound tracks how long you actually
   * hold the note. Retriggering the same pitch restarts it.
   */
  startVoice(midi, velocity = 100) {
    this.stopVoice(midi, 0.005);
    const start = this.now;
    const hz = midiToHz(midi);
    const amp = 0.28 * (velocity / 127) ** 1.5;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, start);
    out.gain.linearRampToValueAtTime(amp, start + 0.006);
    out.gain.setTargetAtTime(amp * 0.55, start + 0.006, 0.9); // slow decay while held
    out.connect(this.master);
    const oscs = [];
    for (const [mult, level] of [[1, 1], [2, 0.5], [3, 0.25], [4, 0.12], [5, 0.06]]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz * mult;
      const g = this.ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(out);
      osc.start(start);
      oscs.push(osc);
    }
    const safety = setTimeout(() => this.stopVoice(midi), 15000);
    safety.unref?.();
    this.voices.set(midi, { out, oscs, safety });
  }

  /** Release a held voice (damper): a fast fade so the note stops with the key. */
  stopVoice(midi, release = 0.08) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);
    clearTimeout(v.safety);
    const t = this.now;
    try {
      v.out.gain.cancelScheduledValues(t);
      const cur = Math.max(0.0002, v.out.gain.value);
      v.out.gain.setValueAtTime(cur, t);
      v.out.gain.exponentialRampToValueAtTime(0.0004, t + release);
    } catch {
      /* fall through to hard stop */
    }
    for (const osc of v.oscs) {
      try { osc.stop(t + release + 0.03); } catch { /* already stopped */ }
    }
  }

  tone(hz, at, dur, gain, type = 'sine', glideTo = null) {
    const start = Math.max(at, this.now);
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0005, start + dur);
    osc.connect(g).connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.01);
  }

  /** Metronome. `accent` = bar downbeat; `response` = the downbeat you answer on (double tick). */
  click(at, { accent = false, response = false } = {}) {
    this.tone(accent ? 1600 : 1000, at, 0.03, accent ? 0.18 : 0.1, 'square');
    if (response) this.tone(2200, at + 0.045, 0.03, 0.16, 'square');
  }

  /** Correct AND in time: soft high chime. */
  good(at = this.now, gain = 0.07) {
    this.tone(1760, at, 0.25, gain);
    this.tone(2637, at + 0.06, 0.25, gain);
  }

  /** Correct pitch, off the beat: a glide in the direction your onset must move. */
  offbeat(at = this.now, early) {
    if (early) this.tone(880, at, 0.12, 0.07, 'sine', 660); // drop: pull back
    else this.tone(660, at, 0.12, 0.07, 'sine', 880); // lift: push forward
  }

  /** Correct pitch after an earlier miss: accepted, not credited. */
  okAfterMiss(at = this.now) {
    this.tone(660, at, 0.08, 0.05);
  }

  /** Wrong pitch: low buzz. */
  bad(at = this.now, gain = 0.06) {
    this.tone(110, at, 0.18, gain, 'sawtooth');
  }

  /** A real passage is coming (plays in the gap before the call). */
  passageCue(at = this.now) {
    this.tone(1319, at, 0.12, 0.06);
    this.tone(1760, at + 0.12, 0.16, 0.06);
  }

  /** Passage finished: rising arpeggio if clean, one neutral tone otherwise. */
  passageDone(at = this.now, clean) {
    if (clean) {
      for (const [hz, d] of [[1047, 0], [1319, 0.09], [1568, 0.18]]) this.tone(hz, at + d, 0.28, 0.06);
    } else {
      this.tone(880, at, 0.15, 0.05);
    }
  }

  /** A new interval tier unlocked. */
  tierUp(at = this.now) {
    for (const [hz, d] of [[784, 0], [1047, 0.07], [1319, 0.14], [1568, 0.21]]) this.tone(hz, at + d, 0.22, 0.06);
  }

  /** MIDI controller connected and listening. */
  ready(at = this.now) {
    this.tone(1047, at, 0.15, 0.06);
    this.tone(1568, at + 0.15, 0.2, 0.06);
  }

  /** Two descending tones: session over. */
  sessionOver(at = this.now) {
    this.note(64, { at, velocity: 60, duration: 0.5 });
    this.note(57, { at: at + 0.25, velocity: 60, duration: 0.8 });
  }

  async close() {
    for (const midi of [...this.voices.keys()]) this.stopVoice(midi, 0.01);
    await this.ctx.close();
  }
}
