#!/usr/bin/env node
// piano-by-ear: headless learn-piano-by-ear drill for a MIDI controller.
//
//   node src/main.js [--port <substring>] [--db <path>] [--debug-midi]
//
// No musical settings: tempo, question type, passage length and timing
// tolerance are all decided from your history (see src/drill.js).
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Audio } from './audio.js';
import { Db } from './db.js';
import { Midi } from './midi.js';
import { RangeTracker } from './range.js';
import { AdaptiveEngine } from './engine.js';
import { Drill } from './drill.js';
import { PhraseBank, POLY_PATH } from './phrases.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    db: { type: 'string', default: join(homedir(), '.piano-by-ear', 'piano-by-ear.db') },
    'debug-midi': { type: 'boolean', default: false },
    // developer overrides, not for normal use
    bpm: { type: 'string' },
    composer: { type: 'string' },
  },
});

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const bpmOverride = args.bpm ? Number(args.bpm) : null;
if (args.bpm && !(bpmOverride > 0)) {
  console.error('--bpm must be a positive number');
  process.exit(1);
}

const db = new Db(args.db);
const audio = new Audio();
const range = new RangeTracker(db.kv('ranges'));
const phrases = new PhraseBank({ store: db.kv('phraseStats'), composer: args.composer });
const poly = new PhraseBank({ store: db.kv('polyStats'), composer: args.composer, path: POLY_PATH });

const drill = new Drill({
  audio,
  db,
  range,
  phrases,
  poly,
  log,
  bpmOverride,
  makeEngine: (lo, hi, fluentMs, which) =>
    new AdaptiveEngine({ range: hi - lo, fluentMs, pitchClassOffset: lo % 12, store: db.engineStore(which) }),
});

const midi = new Midi({
  match: args.port,
  onNoteOn: (e) => drill.onNoteOn(e),
  onNoteOff: (e) => drill.onNoteOff(e),
  onPort: (portName, connected) => {
    if (connected) {
      range.setPort(portName);
      const { lo, hi, guessed, named } = range.current;
      log(`MIDI in: ${portName} (range ${lo}..${hi}${guessed ? (named ? ', guessed from name' : ', default until you play wider') : ''})`);
      audio.ready();
    } else {
      log(`MIDI disconnected: ${portName}`);
      if (midi.portNames.length === 0) drill.stop();
    }
  },
});
midi.debug = args['debug-midi'];

log(`piano-by-ear  ${phrases.size} melodic + ${poly.size} polyphonic passages  db: ${args.db}`);
audio.load().then(({ detail }) => log(`voice: ${detail}`), (err) => log(`voice: synth (samples failed to load: ${err.message})`));
midi.start();
if (midi.portNames.length === 0) log('no MIDI inputs yet; plug in a controller (polling every 2s)');
log('play any note to start a session');

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  drill.stop({ silent: true });
  midi.stop();
  audio.close().catch(() => {}).finally(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
