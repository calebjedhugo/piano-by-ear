#!/usr/bin/env node
// piano-by-ear free play: the same two-piano audio, no drill. Every key you
// press sounds on the grand for as long as you hold it; nothing is graded or
// recorded. Started by the launcher's "Free play" (launcher/pbe.sh start
// <user> free); src/main.js is the drill and is untouched by this.
//
//   node src/free.js [--port <substring>] [--debug-midi]
import { parseArgs } from 'node:util';
import { Audio } from './audio.js';
import { Midi } from './midi.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    'debug-midi': { type: 'boolean', default: false },
  },
});

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const audio = new Audio();
const midi = new Midi({
  match: args.port,
  onNoteOn: ({ note, velocity }) => audio.startVoice(note, velocity),
  onNoteOff: ({ note }) => audio.stopVoice(note),
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
