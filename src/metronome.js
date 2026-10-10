// Where the metronome comes from when the keyboard makes the sound: its own
// woodblock (General MIDI channel 10) or the computer. See computerClicks()
// in src/midiout.js. Read at startup, so a change needs a restart.
//
//   node src/metronome.js            print: keyboard | computer
//   node src/metronome.js toggle     switch, and print the new one
//   node src/metronome.js keyboard|computer
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computerClicks } from './midiout.js';

const dir = join(homedir(), '.piano-by-ear');
const now = computerClicks() ? 'computer' : 'keyboard';
const arg = process.argv[2];
const want = arg === 'toggle' ? (now === 'computer' ? 'keyboard' : 'computer') : arg;
if (want === 'keyboard' || want === 'computer') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'clicks'), `${want}\n`);
  console.log(want);
} else if (arg) {
  console.error('usage: node src/metronome.js [toggle|keyboard|computer]');
  process.exit(2);
} else console.log(now);
