// Headless audio, all scheduled on the AudioContext clock so the grid is
// sample-accurate rather than setTimeout-accurate.
//
// Two instruments, two roles:
//   - YOUR keys play a real piano: the Salamander Grand sample set once it has
//     been fetched (src/sampler.js), else resound-sound's additive Piano. A
//     key rings while it is down and is damped when it comes up, so what you
//     hear tracks how long you actually held the note.
//   - THE SYSTEM's call is a sustained, hollow reed-like tone whose partials
//     sit on exact harmonics. Nothing in it beats or wobbles, so a held call
//     note sounds like one note for its whole length -- the rhythm you are
//     asked to copy is only ever in the onsets.
import { AudioContext } from 'node-web-audio-api';
import { Piano, audioContextManager } from 'resound-sound';
import { SampledPiano } from './sampler.js';

// A held key rings this long before the model's own damper; releasing the key
// damps it much sooner (stopVoice), so this only bounds a key left down.
const HOLD_MS = 12000;
// Never cut a strike shorter than this: a tapped key still sounds the hammer.
const MIN_STRIKE_S = 0.03;

export function midiToHz(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

export class Audio {
  constructor({ ctx } = {}) {
    this.ctx = ctx ?? new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);

    // resound-sound instruments take their context from a browser-oriented
    // singleton; hand it ours so the piano shares the drill's clock and mix.
    audioContextManager.context = this.ctx;
    audioContextManager.unlocked = true;
    // Pure live synthesis: continuous velocity, no OfflineAudioContext renders
    // competing with the real-time thread.
    this.piano = new Piano('player', { autoSample: false });
    this.piano.limiter.disconnect();
    this.piano.limiter.connect(this.master);

    this.voices = new Map(); // midi -> the synth note's graph while the key is down
    this.sampled = null; // SampledPiano once load() finds the sample set
  }

  /**
   * Load the sampled piano if the sample set is present. Resolves to a short
   * description of the voice in use either way; the synth keeps working
   * meanwhile, so this can run while the MIDI port is already open.
   */
  async load({ lo = 21, hi = 108 } = {}) {
    if (!SampledPiano.available()) return { voice: 'synth', detail: 'resound-sound piano (run "npm run fetch-samples" for the sampled grand)' };
    const sampled = new SampledPiano(this.ctx, this.master);
    const stats = await sampled.load({ lo, hi });
    this.sampled = sampled;
    return { voice: 'sampled', detail: `Salamander Grand Piano, ${stats.files} samples decoded in ${stats.ms} ms` };
  }

  get now() {
    return this.ctx.currentTime;
  }

  /**
   * The SYSTEM's voice (the call). Exact-harmonic partials (triangle
   * fundamental, a sine octave and double octave) with a soft onset, held at
   * level for `duration` seconds and then released: a steady tone whose length
   * you can hear, and clearly not the piano you play. `duration` in s, capped.
   */
  note(midi, { at = this.now, velocity = 100, duration = 1.2 } = {}) {
    const start = Math.max(at, this.now);
    const dur = Math.max(0.15, Math.min(2.0, duration));
    const hz = midiToHz(midi);
    const amp = 0.16 * (velocity / 127) ** 1.5;
    const attack = 0.012;
    const release = 0.04;
    const partials = [
      [1, 1.0, 'triangle'],
      [2, 0.35, 'sine'],
      [4, 0.08, 'sine'],
    ];
    for (const [mult, level, type] of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz * mult;
      const g = this.ctx.createGain();
      const peak = amp * level;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(peak, start + attack);
      g.gain.setTargetAtTime(peak * 0.7, start + attack, 0.6); // gentle settle while held
      g.gain.setValueAtTime(peak * 0.7, start + dur - 0.001);
      g.gain.linearRampToValueAtTime(0, start + dur + release);
      osc.connect(g).connect(this.master);
      osc.start(start);
      osc.stop(start + dur + release + 0.01);
    }
  }

  /**
   * YOUR voice: strike the piano for a key that just went down. It rings on
   * its own decay while held and is damped by stopVoice() when the key comes
   * up. Retriggering the same pitch restrikes it.
   */
  startVoice(midi, velocity = 100) {
    if (this.sampled && this.sampled.startVoice(midi, velocity)) return;
    this.stopVoice(midi, 0.01);
    const before = this.piano.activeOscillators;
    const seen = new Set(before);
    this.piano.startNote(midiToHz(midi), HOLD_MS, Math.max(0.05, Math.min(1, velocity / 127)));
    const parts = [...before].filter((d) => !seen.has(d));
    this.voices.set(midi, { parts, start: this.now });
  }

  /** Damper: release a held key's note with a fast fade. */
  stopVoice(midi, release = 0.08) {
    if (this.sampled && this.sampled.stopVoice(midi)) return;
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);
    const t = Math.max(this.now, v.start + MIN_STRIKE_S);
    // The live piano routes every partial of one strike through one gain node.
    const gains = new Set(v.parts.map((p) => p.gainNode));
    for (const g of gains) {
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + release);
      } catch {
        /* graph already torn down */
      }
    }
    for (const { oscillator } of v.parts) {
      try { oscillator.stop(t + release + 0.01); } catch { /* already stopped */ }
    }
    // Free the strike's graph once it is silent (onended would too; belt and braces).
    const free = setTimeout(() => {
      for (const g of gains) { try { g.disconnect(); } catch { /* gone */ } }
    }, (t - this.now + release + 0.1) * 1000);
    free.unref?.();
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

  /** Metronome. `accent` = bar downbeat. */
  click(at, { accent = false } = {}) {
    this.tone(accent ? 1600 : 1000, at, 0.03, accent ? 0.18 : 0.1, 'square');
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
    this.piano.stopAll(0.01);
    this.sampled?.stopAll();
    await this.ctx.close();
  }
}
