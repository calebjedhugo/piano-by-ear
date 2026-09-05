// The player's piano: the Salamander Grand Piano sample set (Alexander Holm,
// CC BY 3.0 -- a Yamaha C5, 16 velocity layers, sampled in minor thirds)
// played through the drill's AudioContext. Fetch it once with
// `npm run fetch-samples`; without it the app falls back to a synth.
//
// A key down starts the nearest sampled note pitched to the key, at the
// velocity layer nearest the strike, trimmed continuously for the exact
// velocity. A key up damps it and plays the hammer-release noise, like the
// real instrument. Buffers are decoded once at startup and capped at
// BUFFER_CAP_S so the whole set stays a few hundred MB.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_SAMPLES_DIR = join(homedir(), '.piano-by-ear', 'samples', 'SalamanderGrandPianoV3_44.1khz16bit');
const SFZ_FILE = 'SalamanderGrandPianoV3.sfz';
// Of the 16 velocity layers, load these (1-based). Velocity still varies
// continuously through the gain trim, so four layers cover the dynamics.
const LAYERS = [2, 6, 10, 14];
const BUFFER_CAP_S = 6;
const BUFFER_FADE_S = 0.3;
const DECODE_CONCURRENCY = 8;
const DAMPER_S = 0.12; // key-up release
const RESTRIKE_S = 0.015; // same key struck again
const AMP_VELTRACK = 0.73; // from the sfz: how much of the level follows velocity
const RELEASE_VOLUME = 10 ** (-37 / 20); // hammer-release noise, from the sfz
const RELEASE_VELTRACK = 0.82;
const RELEASE_RT_DECAY_DB = 2; // quieter the longer the note was held

const NOTE_NAMES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** SFZ-style velocity curve: a floor plus a square law on the strike. */
function veltrack(track, velocity) {
  return (1 - track) + track * (velocity / 127) ** 2;
}

/** Parse the regions we use out of the sfz: main notes and hammer releases. */
export function parseSfz(text) {
  const notes = []; // { file, lokey, hikey, lovel, hivel, center }
  const releases = new Map(); // key -> file
  let group = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('<group>')) {
      group = {};
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) group[m[1]] = m[2];
      continue;
    }
    if (!line.startsWith('<region>')) continue;
    const r = { ...group };
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) r[m[1]] = m[2];
    if (!r.sample) continue;
    const file = r.sample.split(/[\\/]/).pop();
    const lokey = Number(r.lokey);
    const hikey = Number(r.hikey);
    if (r.trigger === 'release') {
      if (/^rel\d+\.wav$/.test(file)) releases.set(lokey, file);
      continue;
    }
    const m = file.match(/^([A-G]#?)(\d)v(\d+)\.wav$/);
    if (!m || r.trigger) continue;
    const center = r.pitch_keycenter ? Number(r.pitch_keycenter) : (Number(m[2]) + 1) * 12 + NOTE_NAMES[m[1]];
    notes.push({
      file, layer: Number(m[3]), lokey, hikey, center,
      lovel: r.lovel ? Number(r.lovel) : 1, hivel: r.hivel ? Number(r.hivel) : 127,
    });
  }
  return { notes, releases };
}

export class SampledPiano {
  static available(dir = DEFAULT_SAMPLES_DIR) {
    return existsSync(join(dir, SFZ_FILE));
  }

  constructor(ctx, dest, dir = DEFAULT_SAMPLES_DIR) {
    this.ctx = ctx;
    this.dest = dest;
    this.dir = dir;
    this.ready = false;
    this.byKey = new Map(); // key -> [{ center, lovel, hivel, buffer }] for the loaded layers
    this.releases = new Map(); // key -> buffer
    this.voices = new Map(); // key -> { source, gain, start, velocity }
  }

  /** Decode every sample for keys lo..hi (inclusive). Returns load stats. */
  async load({ lo = 21, hi = 108 } = {}) {
    const t0 = performance.now();
    const { notes, releases } = parseSfz(readFileSync(join(this.dir, SFZ_FILE), 'utf8'));
    const wanted = notes.filter((n) => LAYERS.includes(n.layer) && n.hikey >= lo && n.lokey <= hi);
    const relWanted = [...releases].filter(([key]) => key >= lo && key <= hi);
    const jobs = [];
    for (const n of wanted) jobs.push(async () => { n.buffer = await this.decode(n.file, BUFFER_CAP_S); });
    for (const [key, file] of relWanted) jobs.push(async () => { this.releases.set(key, await this.decode(file, 1.5)); });
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

  async decode(file, capSeconds) {
    const bytes = readFileSync(join(this.dir, '44.1khz16bit', file));
    const full = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (full.duration <= capSeconds) return full;
    const sr = full.sampleRate;
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

  /** Nearest loaded velocity layer for this key: the one whose range holds
   *  or is closest to the strike. */
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

  startVoice(key, velocity = 100, at = this.ctx.currentTime) {
    if (!this.ready) return false;
    const n = this.pickLayer(key, velocity);
    if (!n) return false;
    this.stopVoice(key, RESTRIKE_S, { silent: true });
    const source = this.ctx.createBufferSource();
    source.buffer = n.buffer;
    source.playbackRate.value = 2 ** ((key - n.center) / 12);
    const gain = this.ctx.createGain();
    // The layer already carries most of the dynamics; trim to the exact
    // velocity relative to the layer's own centre.
    const layerMid = (n.lovel + n.hivel) / 2;
    gain.gain.value = veltrack(AMP_VELTRACK, velocity) / veltrack(AMP_VELTRACK, layerMid);
    source.connect(gain).connect(this.dest);
    source.start(at);
    source.onended = () => { try { gain.disconnect(); } catch { /* gone */ } };
    this.voices.set(key, { source, gain, start: at, velocity });
    return true;
  }

  /** Damp a held key. Plays the hammer-release noise unless `silent`. */
  stopVoice(key, release = DAMPER_S, { silent = false } = {}) {
    const v = this.voices.get(key);
    if (!v) return false;
    this.voices.delete(key);
    const t = Math.max(this.ctx.currentTime, v.start + 0.02);
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + release);
      v.source.stop(t + release + 0.01);
    } catch { /* already stopped */ }
    if (!silent) this.playRelease(key, v.velocity, t - v.start, t);
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
    source.connect(gain).connect(this.dest);
    source.start(at);
    source.onended = () => { try { gain.disconnect(); } catch { /* gone */ } };
  }

  stopAll(release = 0.01) {
    for (const key of [...this.voices.keys()]) this.stopVoice(key, release, { silent: true });
  }
}
