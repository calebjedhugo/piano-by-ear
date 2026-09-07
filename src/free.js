#!/usr/bin/env node
// piano-by-ear free play: the same two-piano audio, no drill. Every key you
// press sounds on the grand for as long as you hold it (or the sustain
// pedal holds it); nothing is graded or recorded. Started by the launcher's "Free play" (launcher/pbe.sh start
// <user> free); src/main.js is the drill and is untouched by this.
//
//   node src/free.js [--port <substring>] [--debug-midi] [--keys]
//
// --keys also plays from the computer keyboard (needs a terminal), in the
// GarageBand / Ableton "musical typing" layout:
//   white keys  A S D F G H J K L ; '   = C D E F G A B C D E F
//   black keys  W E   T Y U   O P       = C# D#  F# G# A#  C# D#
//   Z / X octave down / up, C / V softer / louder, Space = sustain on/off,
//   Q quits. A terminal never reports key release, so a note is held while
//   the key autorepeats and damped ~0.35 s after the last repeat.
import { parseArgs } from 'node:util';
import { Audio } from './audio.js';
import { Midi } from './midi.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    'debug-midi': { type: 'boolean', default: false },
    keys: { type: 'boolean', default: false },
  },
});

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const audio = new Audio();

// Sustain pedal (CC 64): while it is down, a released key keeps ringing; when
// it comes up, everything released meanwhile is damped unless the key is
// still held. Restriking a sustained key just restrikes it.
const SUSTAIN_CC = 64;
let pedal = false;
const down = new Set(); // keys physically held
const sustained = new Set(); // keys released while the pedal was down
const onNoteOn = ({ note, velocity }) => { down.add(note); sustained.delete(note); audio.startVoice(note, velocity); };
const onNoteOff = ({ note }) => { down.delete(note); if (pedal) sustained.add(note); else audio.stopVoice(note); };
const onControl = ({ type, number, value }) => {
  if (type !== 'cc' || number !== SUSTAIN_CC) return;
  const was = pedal;
  pedal = value >= 64;
  if (was && !pedal) { for (const n of sustained) if (!down.has(n)) audio.stopVoice(n); sustained.clear(); }
};

const midi = new Midi({
  match: args.port,
  onNoteOn,
  onNoteOff,
  onControl,
  onPort: (portName, connected) => {
    if (connected) { log(`MIDI in: ${portName}`); audio.ready(); } else log(`MIDI disconnected: ${portName}`);
  },
});
midi.debug = args['debug-midi'];

// --- computer keyboard ----------------------------------------------------
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
const KEY_RELEASE_MS = 350; // > macOS's initial autorepeat delay (~250 ms)
function startKeys() {
  if (!process.stdin.isTTY) { log('--keys needs a terminal; computer keyboard disabled'); return; }
  let octave = 4; // A = C4
  let velocity = 90;
  const timers = new Map(); // note -> release timer
  const release = (note) => { timers.delete(note); onNoteOff({ note }); };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const ch of chunk) {
      if (ch === '\u0003' || ch === 'q') { shutdown(); return; }
      const lower = ch.toLowerCase();
      if (lower === 'z') { octave = Math.max(0, octave - 1); log(`octave: A = C${octave}`); continue; }
      if (lower === 'x') { octave = Math.min(8, octave + 1); log(`octave: A = C${octave}`); continue; }
      if (lower === 'c') { velocity = Math.max(20, velocity - 10); log(`velocity ${velocity}`); continue; }
      if (lower === 'v') { velocity = Math.min(127, velocity + 10); log(`velocity ${velocity}`); continue; }
      if (ch === ' ') { onControl({ type: 'cc', number: SUSTAIN_CC, value: pedal ? 0 : 127 }); log(`sustain ${pedal ? 'on' : 'off'}`); continue; }
      const off = KEYMAP[lower];
      if (off === undefined) continue;
      const note = 12 * (octave + 1) + off;
      if (timers.has(note)) clearTimeout(timers.get(note)); // autorepeat: still held
      else { onNoteOn({ note, velocity }); process.stdout.write(`${noteName(note)} `); }
      timers.set(note, setTimeout(() => release(note), KEY_RELEASE_MS));
    }
  });
  log('computer keyboard: A S D F G H J K L ; \' = C D E F G A B C D E F, W E T Y U O P = sharps, Z/X octave, C/V velocity, Space sustain, Q quit');
}

log('piano-by-ear  free play (nothing is graded or recorded)');
if (args.keys) startKeys();
audio.load().then(({ detail }) => log(`voice: ${detail}`), (err) => log(`voice: synth (samples failed to load: ${err.message})`));
midi.start();
if (midi.portNames.length === 0) log('no MIDI inputs yet; plug in a controller (polling every 2s)');
log('play freely');

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  midi.stop();
  audio.close().catch(() => {}).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
