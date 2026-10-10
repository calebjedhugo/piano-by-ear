// The opt-in pianos, for a downloaded copy (2026-10-10). Most people play a
// keyboard with its own sound, so the downloads carry no samples; someone with
// a silent controller fetches them once, and that choice IS the choice of the
// app's sound (src/midiout.js `hardwareSound`).
//
//   node src/download-pianos.js             fetch, unpack, use the app's pianos
//   node src/download-pianos.js --keyboard  go back to the keyboard's own sound
//   node src/download-pianos.js --app       use the app's pianos (already fetched)
//
// The archive is packaging/build.sh's trimmed set (the kept Salamander layers
// as FLAC, the KW upright as published), attached to a GitHub release. build.sh
// stamps its URL and SHA-256 into the copy it ships; an unstamped copy (this
// repo) fetches nothing -- use `npm run fetch-samples` there.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SAMPLES_ROOT, SampledPiano } from './sampler.js';

const URL_ = '@@PIANOS_URL@@';
const SHA256 = '@@PIANOS_SHA256@@';
const SOUND_FILE = join(homedir(), '.piano-by-ear', 'sound');
const say = (msg) => console.log(`  ${msg}`);

function use(which) {
  mkdirSync(join(homedir(), '.piano-by-ear'), { recursive: true });
  writeFileSync(SOUND_FILE, `${which}\n`);
}

const arg = process.argv[2];
if (arg === '--keyboard') {
  use('hardware');
  say("Using your keyboard's own sound. Restart Piano by Ear to hear it.");
  process.exit(0);
}
if (SampledPiano.available('grand') && SampledPiano.available('upright')) {
  use('app');
  say('The pianos are already here. Using them. Restart Piano by Ear to hear them.');
  process.exit(0);
}
if (arg === '--app' || URL_.startsWith('@@')) {
  say(URL_.startsWith('@@') ? 'This copy has no download address; run npm run fetch-samples.' : 'The pianos have not been downloaded yet.');
  process.exit(1);
}

say('Downloading the pianos (about 75 MB)...');
const res = await fetch(URL_);
if (!res.ok) {
  say(`The download failed (HTTP ${res.status}). Check the internet connection and try again.`);
  process.exit(1);
}
const data = Buffer.from(await res.arrayBuffer());
if (createHash('sha256').update(data).digest('hex') !== SHA256) {
  say('The download was damaged or is not the expected file. Nothing was installed.');
  process.exit(1);
}
mkdirSync(SAMPLES_ROOT, { recursive: true });
const zip = join(SAMPLES_ROOT, 'pianos.zip');
writeFileSync(zip, data);
// tar reads zip on macOS and on Windows 10 and later (both are bsdtar).
const r = spawnSync('tar', ['-xf', zip, '-C', SAMPLES_ROOT], { stdio: 'inherit' });
rmSync(zip, { force: true });
if (r.status !== 0 || !SampledPiano.available('grand') || !SampledPiano.available('upright')) {
  say('The pianos could not be unpacked.');
  process.exit(1);
}
use('app');
say('Done. Restart Piano by Ear to hear them.');
