#!/usr/bin/env node
// piano-by-ear: headless learn-piano-by-ear drill for a MIDI controller.
//
//   node src/main.js [--bpm 80] [--tolerance 80] [--mode mix|passages|intervals] [--composer bach]
//                    [--port keystation] [--db path] [--debug-midi]
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Audio } from './audio.js';
import { Db } from './db.js';
import { Midi } from './midi.js';
import { RangeTracker } from './range.js';
import { AdaptiveEngine } from './engine.js';
import { Drill } from './drill.js';
import { PhraseBank } from './phrases.js';

const { values: args } = parseArgs({
  options: {
    bpm: { type: 'string', default: '80' },
    tolerance: { type: 'string', default: '80' }, // ms of onset error that still counts as in time
    mode: { type: 'string', default: 'mix' }, // mix | passages | intervals
    composer: { type: 'string' }, // e.g. bach, mozart
    port: { type: 'string' },
    db: { type: 'string', default: join(homedir(), '.piano-by-ear', 'piano-by-ear.db') },
    'debug-midi': { type: 'boolean', default: false },
  },
});

const bpm = Number(args.bpm);
const toleranceMs = Number(args.tolerance);
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

const db = new Db(args.db);
const audio = new Audio();

const kvStore = (key) => ({
  load: () => {
    const row = db.stmts.getKv.get(key);
    return row ? JSON.parse(row.value) : null;
  },
  save: (v) => db.stmts.setKv.run(key, JSON.stringify(v)),
});
const range = new RangeTracker(kvStore('ranges'));
const phrases = args.mode === 'intervals' ? null : new PhraseBank({ composer: args.composer, store: kvStore('phraseStats') });

const drill = new Drill({
  phrases,
  mode: args.mode,
  audio,
  db,
  range,
  bpm,
  toleranceMs,
  log,
  makeEngine: (lo, hi) =>
    new AdaptiveEngine({
      range: hi - lo,
      fluentMs: toleranceMs,
      pitchClassOffset: lo % 12,
      store: db.engineStore(),
    }),
});

const midi = new Midi({
  match: args.port,
  onNoteOn: (e) => drill.onNoteOn(e),
  onPort: (portName) => {
    range.setPort(portName);
    if (portName) {
      const { lo, hi, guessed } = range.current;
      log(`MIDI in: ${portName} (range ${lo}..${hi}${guessed ? ', guessed from name' : ''})`);
    } else {
      log('MIDI controller disconnected; waiting...');
      drill.stop();
    }
  },
});
midi.debug = args['debug-midi'];

log(`piano-by-ear  ${bpm} bpm, ±${toleranceMs}ms, mode ${drill.mode}${phrases ? `, ${phrases.size} passages${args.composer ? ` (${args.composer})` : ''}` : ''}  db: ${args.db}`);
const ports = midi.listPorts();
if (ports.length === 0) log('no MIDI inputs yet; plug in a controller (polling every 2s)');
midi.start();
log('play any note to start a session');

function shutdown() {
  drill.stop();
  midi.stop();
  audio.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
