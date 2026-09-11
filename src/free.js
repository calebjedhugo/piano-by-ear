#!/usr/bin/env node
// piano-by-ear free play: the same two-piano audio, no drill. Every key you
// press sounds on the grand for as long as you hold it (or the sustain
// pedal holds it); nothing is graded or recorded. Started by the launcher's "Free play" (launcher/pbe.sh start
// <user> free); src/main.js is the drill and is untouched by this.
//
//   node src/free.js [--port <substring>] [--debug-midi]
import { parseArgs } from 'node:util';
import { Audio } from './audio.js';
import { Midi } from './midi.js';
import { hardwareSound } from './midiout.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    'debug-midi': { type: 'boolean', default: false },
  },
});

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
// On its own sound the instrument is the whole of free play: it voices its own
// keys and its own pedal, and this process only keeps the port open.
const audio = new Audio({ hardware: hardwareSound() });

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

log('piano-by-ear  free play (nothing is graded or recorded)');
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
