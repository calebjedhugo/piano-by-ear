// Headless audio, all scheduled on the AudioContext clock so the grid is
// sample-accurate rather than setTimeout-accurate.
//
// A teacher's studio with two pianos (src/sampler.js):
//   - YOU play the grand (the Salamander sample set), a little to the right.
//     A key rings while it is down and is damped when it comes up, so what
//     you hear tracks how long you actually held the note.
//   - THE TEACHER plays the call on the upright (Upright Piano KW), off to
//     the left: the same kind of instrument, a different piano, a different
//     place in the room, so the call is as real as your answer and still
//     unmistakably not yours.
// Until the sample sets are fetched (npm run fetch-samples) both fall back to
// synths: resound-sound's additive Piano for you, an exact-harmonic reed tone
// for the call (nothing in it beats, so a held note never sounds like two).
import { AudioContext } from 'node-web-audio-api';
import { Piano, audioContextManager } from 'resound-sound';
import { SampledPiano } from './sampler.js';

// A held key rings this long before the model's own damper; releasing the key
// damps it much sooner (stopVoice), so this only bounds a key left down.
const HOLD_MS = 12000;
// Never cut a strike shorter than this: a tapped key still sounds the hammer.
const MIN_STRIKE_S = 0.03;
// Where the two pianos sit in the room, and the upright's level against the grand.
const STUDENT_PAN = 0.15;
const TEACHER_PAN = -0.5;
const TEACHER_TRIM = 0.6; // measured: the upright peaks ~1.55x the grand at equal velocity

export function midiToHz(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

export class Audio {
  /**
   * @param {object} [opts]
   * @param {AudioContext} [opts.ctx]
   * @param {boolean} [opts.hardware] the instrument makes its own sound: the
   *   two pianos below give way to it (src/midiout.js), their samples are
   *   never loaded, and the clicks and chimes go out to it as well, so a
   *   player wearing headphones on the piano hears the whole drill. Every one
   *   of those falls back to the voice below if the output port is missing,
   *   so a pulled cable leaves the drill audible rather than mute.
   */
  constructor({ ctx, hardware = false } = {}) {
    this.ctx = ctx ?? new AudioContext();
    this.hardware = hardware;
    this.out = null; // the MidiOut, once one is attached
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
    this.sampled = null; // your grand, once load() finds its samples
    this.teacher = null; // the teacher's upright, likewise
  }

  /**
   * Load the sampled piano if the sample set is present. Resolves to a short
   * description of the voice in use either way; the synth keeps working
   * meanwhile, so this can run while the MIDI port is already open.
   */
  /** Send the call to the instrument instead of the upright. */
  attach(out) {
    this.out = out;
  }

  async load({ lo = 21, hi = 108 } = {}) {
    if (this.hardware) return { voice: 'hardware', detail: "your keyboard's own sound (call on its own channel, clicks on its woodblock)" };
    const parts = [];
    if (SampledPiano.available('grand')) {
      const grand = new SampledPiano(this.ctx, this.master, 'grand', { pan: STUDENT_PAN });
      const s = await grand.load({ lo, hi });
      this.sampled = grand;
      parts.push(`you: Salamander grand (${s.files} samples, ${s.ms} ms)`);
    } else parts.push('you: resound-sound synth piano');
    if (SampledPiano.available('upright')) {
      const upright = new SampledPiano(this.ctx, this.master, 'upright', { pan: TEACHER_PAN, volume: TEACHER_TRIM });
      const s = await upright.load({ lo, hi });
      this.teacher = upright;
      parts.push(`teacher: Kawai upright (${s.files} samples, ${s.ms} ms)`);
    } else parts.push('teacher: reed synth');
    const missing = !this.sampled || !this.teacher;
    return { voice: missing ? 'partly synth' : 'sampled', detail: parts.join('; ') + (missing ? ' -- run "npm run fetch-samples" for the real pianos' : '') };
  }

  get now() {
    return this.ctx.currentTime;
  }

  /**
   * The TEACHER's voice (the call): the upright, scheduled on the clock.
   * Fallback: exact-harmonic partials (triangle
   * fundamental, a sine octave and double octave) with a soft onset, held at
   * level for `duration` seconds and then released: a steady tone whose length
   * you can hear, and clearly not the piano you play. `duration` in s, capped.
   */
  note(midi, { at = this.now, velocity = 100, duration = 1.2 } = {}) {
    const start = Math.max(at, this.now);
    const dur = Math.max(0.15, Math.min(2.0, duration));
    if (this.out?.ready && this.out.play(midi, velocity, (start - this.now) * 1000, dur)) return;
    if (this.teacher && this.teacher.play(midi, velocity, start, dur)) return;
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
    // Gated on the setting, not on the output port: a key press can only have
    // come from the instrument the player is sitting at, and that instrument
    // sounded it locally before the event ever reached us.
    if (this.hardware) return;
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
    if (this.hardware) return; // its own damper, not ours
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
    if (this.out?.ready && this.out.click((Math.max(at, this.now) - this.now) * 1000, accent)) return;
    this.tone(accent ? 1600 : 1000, at, 0.03, accent ? 0.18 : 0.1, 'square');
  }

  /**
   * MIDI controller connected and listening. On the instrument's own sound the
   * same two pitches are played rather than sounded here, so a player wearing
   * headphones on the piano still hears it.
   */
  ready(at = this.now) {
    if (this.out?.ready) {
      this.note(84, { at, velocity: 70, duration: 0.15 }); // C6
      this.note(91, { at: at + 0.15, velocity: 70, duration: 0.3 }); // G6
      return;
    }
    this.tone(1047, at, 0.15, 0.06);
    this.tone(1568, at + 0.15, 0.2, 0.06);
  }

  /**
   * Cues for a state change the player must hear (there is no screen):
   * 'round' = the round is on (two quick rising notes), 'roundOver' = back
   * to call and response (the same two falling), 'stage' = the rung you are
   * graded on moved (three quick notes up, or down), 'judge' = the judge
   * window is open (a soft rising fourth, low: a question, never an error --
   * it follows clean passages too; the high version was heard as a buzzer),
   * 'variant' = the phrase you nailed, back somewhere new (a rising triad,
   * so it is never mistaken for a correction). All through note(), so
   * the instrument's own sound carries them too.
   */
  cue(kind, at = this.now) {
    const v = 64;
    if (kind === 'round') { this.note(79, { at, velocity: v, duration: 0.12 }); this.note(86, { at: at + 0.12, velocity: v, duration: 0.3 }); }
    else if (kind === 'roundOver') { this.note(86, { at, velocity: v, duration: 0.12 }); this.note(79, { at: at + 0.12, velocity: v, duration: 0.3 }); }
    else if (kind === 'judge') { this.note(55, { at, velocity: 48, duration: 0.12 }); this.note(60, { at: at + 0.14, velocity: 48, duration: 0.3 }); }
    else if (kind === 'variant') { this.note(67, { at, velocity: 44, duration: 0.1 }); this.note(72, { at: at + 0.11, velocity: 44, duration: 0.1 }); this.note(76, { at: at + 0.22, velocity: 44, duration: 0.28 }); }
    else if (kind === 'stageUp') for (const [i, m] of [72, 76, 79].entries()) this.note(m, { at: at + i * 0.1, velocity: v, duration: 0.15 });
    else if (kind === 'stageDown') for (const [i, m] of [79, 76, 72].entries()) this.note(m, { at: at + i * 0.1, velocity: v, duration: 0.15 });
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
    this.teacher?.stopAll();
    await this.ctx.close();
  }
}
