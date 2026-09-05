// Two real pianos in one studio, played through the drill's AudioContext:
//
//   grand    the Salamander Grand Piano (Alexander Holm, CC BY 3.0): a Yamaha
//            C5, 16 velocity layers sampled in minor thirds. YOUR instrument.
//   upright  Upright Piano KW (FreePats, CC0): a Kawai upright in a living
//            room, two velocity layers, looped bass. THE TEACHER'S instrument,
//            playing the call from the other side of the room.
//
// Fetch both once with `npm run fetch-samples`; without them the app falls
// back to synths. A key down starts the nearest sampled note pitched to the
// key at the velocity layer nearest the strike, trimmed for the exact
// velocity; a key up damps it (and plays the hammer-release noise where the
// set has one). Buffers are decoded once at startup, capped in length so the
// whole set stays a few hundred MB.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SAMPLES_ROOT = join(homedir(), '.piano-by-ear', 'samples');
const SALAMANDER_LAYERS = [2, 6, 10, 14]; // of 16; velocity still varies continuously via gain
const layerOf = (file) => { const m = file.match(/v(\d+)\.\w+$/); return m ? Number(m[1]) : null; };

export const INSTRUMENTS = {
  grand: {
    dir: 'SalamanderGrandPianoV3_44.1khz16bit',
    sfz: 'SalamanderGrandPianoV3.sfz',
    keep: (file) => SALAMANDER_LAYERS.includes(layerOf(file)),
    cap: 6,
    credit: 'Salamander Grand Piano, Alexander Holm, CC BY 3.0',
    url: 'https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPianoV3+20161209_44khz16bit.tar.xz',
    archive: 'salamander-44k16.tar.xz',
  },
  upright: {
    dir: 'UprightPianoKW-SFZ+FLAC-20220221',
    sfz: 'UprightPianoKW-20220221.sfz',
    keep: () => true,
    cap: 8,
    credit: 'Upright Piano KW, FreePats, CC0',
    url: 'https://freepats.zenvoid.org/Piano/UprightPianoKW/UprightPianoKW-SFZ+FLAC-20220221.7z',
    archive: 'UprightPianoKW-SFZ+FLAC-20220221.7z',
  },
};

const BUFFER_FADE_S = 0.3;
const DECODE_CONCURRENCY = 8;
const DAMPER_S = 0.12; // key-up release
const RESTRIKE_S = 0.015; // same key struck again
const AMP_VELTRACK = 0.73; // how much of the level follows velocity (sfz default region)
const RELEASE_VOLUME = 10 ** (-37 / 20); // hammer-release noise, from the Salamander sfz
const RELEASE_VELTRACK = 0.82;
const RELEASE_RT_DECAY_DB = 2; // quieter the longer the note was held

const NOTE_NAMES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** SFZ-style velocity curve: a floor plus a square law on the strike. */
function veltrack(track, velocity) {
  return (1 - track) + track * (velocity / 127) ** 2;
}

/**
 * Parse an sfz (opcodes may follow their header on later lines; <global> and
 * <group> opcodes are inherited by regions). Returns the note regions and the
 * per-key hammer-release samples.
 */
export function parseSfz(text) {
  const notes = [];
  const releases = new Map(); // key -> file
  let global = {};
  let group = {};
  let region = null;
  const flush = () => {
    if (!region) return;
    const r = { ...global, ...group, ...region };
    region = null;
    if (!r.sample) return;
    const file = r.sample.replace(/\\/g, '/');
    const base = file.split('/').pop();
    const lokey = Number(r.lokey);
    const hikey = Number(r.hikey);
    if (!(lokey >= 0) || !(hikey >= 0)) return; // pedal noises etc.
    if (r.trigger === 'release') {
      if (lokey === hikey) releases.set(lokey, file);
      return;
    }
    if (r.trigger) return;
    let center = r.pitch_keycenter !== undefined ? Number(r.pitch_keycenter) : null;
    if (center === null) {
      const m = base.match(/^([A-G]#?)(\d)/);
      center = m ? (Number(m[2]) + 1) * 12 + NOTE_NAMES[m[1]] : lokey;
    }
    notes.push({
      file, base, lokey, hikey, center,
      lovel: r.lovel !== undefined ? Number(r.lovel) : 1,
      hivel: r.hivel !== undefined ? Number(r.hivel) : 127,
      loop: r.loop_mode === 'loop_continuous' && r.loop_start !== undefined && r.loop_end !== undefined
        ? { start: Number(r.loop_start), end: Number(r.loop_end) } : null,
    });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/(?=<\w+>)/);
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      const h = p.match(/^<(\w+)>(.*)$/);
      let body = p;
      if (h) {
        flush();
        body = h[2];
        if (h[1] === 'global') { global = {}; group = {}; }
        else if (h[1] === 'group') group = {};
        else if (h[1] === 'region') region = {};
        else continue; // <control>, <curve>, ...
        var target = h[1]; // eslint-disable-line no-var
      }
      const into = region ? region : target === 'global' ? global : group;
      for (const m of body.matchAll(/(\w+)=(\S+)/g)) into[m[1]] = m[2];
    }
  }
  flush();
  return { notes, releases };
}

export class SampledPiano {
  static available(which) {
    const inst = INSTRUMENTS[which];
    return existsSync(join(SAMPLES_ROOT, inst.dir, inst.sfz));
  }

  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} dest
   * @param {'grand'|'upright'} which
   * @param {{pan?: number, volume?: number}} [opts]  stereo position -1..1 and level trim
   */
  constructor(ctx, dest, which, { pan = 0, volume = 1 } = {}) {
    this.ctx = ctx;
    this.which = which;
    this.inst = INSTRUMENTS[which];
    this.dir = join(SAMPLES_ROOT, this.inst.dir);
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = pan;
    this.out.connect(this.panner).connect(dest);
    this.ready = false;
    this.byKey = new Map(); // key -> [region with buffer]
    this.releases = new Map(); // key -> buffer
    this.voices = new Map(); // key -> { source, gain, start, velocity } while a key is down
  }

  /** Decode every kept sample for keys lo..hi (inclusive). Returns load stats. */
  async load({ lo = 21, hi = 108 } = {}) {
    const t0 = performance.now();
    const { notes, releases } = parseSfz(readFileSync(join(this.dir, this.inst.sfz), 'utf8'));
    const wanted = notes.filter((n) => this.inst.keep(n.base) && n.hikey >= lo && n.lokey <= hi);
    const relWanted = [...releases].filter(([key]) => key >= lo && key <= hi);
    const jobs = [];
    for (const n of wanted) jobs.push(async () => { n.buffer = await this.decode(n.file, this.inst.cap, n.loop); });
    for (const [key, file] of relWanted) jobs.push(async () => { this.releases.set(key, await this.decode(file, 1.5, null)); });
    let next = 0;
    const worker = async () => { while (next < jobs.length) await jobs[next++](); };
    await Promise.all(Array.from({ length: DECODE_CONCURRENCY }, worker));
    let seconds = 0;
    for (const n of wanted) {
      seconds += n.buffer.duration;
      for (let k = n.lokey; k <= n.hikey; k += 1) {
        if (!this.byKey.has(k)) this.byKey.set(k, []);
        this.byKey.get(k).push(n);
      }
    }
    this.ready = true;
    return { files: wanted.length + relWanted.length, seconds: Math.round(seconds), ms: Math.round(performance.now() - t0) };
  }

  /** Decode a sample, trimmed to `capSeconds` with a fade (never inside a loop). */
  async decode(file, capSeconds, loop) {
    const bytes = readFileSync(join(this.dir, file));
    const full = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const sr = full.sampleRate;
    if (loop) capSeconds = Math.max(capSeconds, loop.end / sr + 0.01);
    if (full.duration <= capSeconds) return full;
    const len = Math.floor(capSeconds * sr);
    const out = this.ctx.createBuffer(full.numberOfChannels, len, sr);
    const fadeLen = Math.floor(BUFFER_FADE_S * sr);
    for (let c = 0; c < full.numberOfChannels; c += 1) {
      const src = full.getChannelData(c).subarray(0, len);
      const dst = new Float32Array(src);
      for (let i = 0; i < fadeLen; i += 1) dst[len - fadeLen + i] *= 1 - i / fadeLen;
      out.copyToChannel(dst, c);
    }
    return out;
  }

  /** The loaded region for this key whose velocity range holds (or is nearest to) the strike. */
  pickLayer(key, velocity) {
    const layers = this.byKey.get(key);
    if (!layers) return null;
    let best = null;
    let bestDist = Infinity;
    for (const n of layers) {
      const d = velocity < n.lovel ? n.lovel - velocity : velocity > n.hivel ? velocity - n.hivel : 0;
      if (d < bestDist) { best = n; bestDist = d; }
    }
    return best;
  }

  /** Build a note's graph: source (looped if the sample loops) -> gain -> out. */
  strike(key, velocity, at) {
    const n = this.pickLayer(key, velocity);
    if (!n) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = n.buffer;
    source.playbackRate.value = 2 ** ((key - n.center) / 12);
    if (n.loop) {
      const sr = n.buffer.sampleRate;
      source.loop = true;
      source.loopStart = n.loop.start / sr;
      source.loopEnd = Math.min(n.loop.end / sr, n.buffer.duration);
    }
    const gain = this.ctx.createGain();
    // The layer already carries most of the dynamics; trim to the exact
    // velocity relative to the layer's own centre.
    const layerMid = (n.lovel + n.hivel) / 2;
    gain.gain.value = veltrack(AMP_VELTRACK, velocity) / veltrack(AMP_VELTRACK, layerMid);
    source.connect(gain).connect(this.out);
    source.start(at);
    source.onended = () => { try { gain.disconnect(); } catch { /* gone */ } };
    return { source, gain, start: at, velocity };
  }

  damp(v, t, release) {
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + release);
      v.source.stop(t + release + 0.01);
    } catch { /* already stopped */ }
  }

  /** A key went down: sound it until stopVoice(). */
  startVoice(key, velocity = 100, at = this.ctx.currentTime) {
    if (!this.ready) return false;
    this.stopVoice(key, RESTRIKE_S, { silent: true });
    const v = this.strike(key, velocity, at);
    if (!v) return false;
    this.voices.set(key, v);
    return true;
  }

  /** The key came up: damp it, and play the hammer-release noise unless `silent`. */
  stopVoice(key, release = DAMPER_S, { silent = false } = {}) {
    const v = this.voices.get(key);
    if (!v) return false;
    this.voices.delete(key);
    const t = Math.max(this.ctx.currentTime, v.start + 0.02);
    this.damp(v, t, release);
    if (!silent) this.playRelease(key, v.velocity, t - v.start, t);
    return true;
  }

  /**
   * A note scheduled on the clock (the teacher's call): strike at `at`, damp
   * at `at + duration`. Independent of the key-down voices, so a repeated
   * pitch scheduled ahead never cuts its predecessor short.
   */
  play(key, velocity, at, duration) {
    if (!this.ready) return false;
    const v = this.strike(key, velocity, at);
    if (!v) return false;
    const end = at + Math.max(0.05, duration);
    this.damp(v, end, DAMPER_S);
    this.playRelease(key, velocity, duration, end);
    return true;
  }

  playRelease(key, velocity, heldSeconds, at) {
    const buffer = this.releases.get(key);
    if (!buffer) return;
    const level = RELEASE_VOLUME * veltrack(RELEASE_VELTRACK, velocity) * 10 ** ((-RELEASE_RT_DECAY_DB * heldSeconds) / 20);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    source.connect(gain).connect(this.out);
    source.start(at);
    source.onended = () => { try { gain.disconnect(); } catch { /* gone */ } };
  }

  stopAll(release = 0.01) {
    for (const key of [...this.voices.keys()]) this.stopVoice(key, release, { silent: true });
  }
}
