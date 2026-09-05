#!/usr/bin/env node
// Download and unpack the Salamander Grand Piano sample set (~410 MB) into
// ~/.piano-by-ear/samples so the drill plays a real piano for your keys.
// Samples by Alexander Holm, CC BY 3.0, via freepats.zenvoid.org.
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { DEFAULT_SAMPLES_DIR, SampledPiano } from '../src/sampler.js';

const URL = 'https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPianoV3+20161209_44khz16bit.tar.xz';
const root = dirname(DEFAULT_SAMPLES_DIR);
const archive = join(root, 'salamander-44k16.tar.xz');

if (SampledPiano.available()) {
  console.log(`already installed: ${DEFAULT_SAMPLES_DIR}`);
  process.exit(0);
}
mkdirSync(root, { recursive: true });
if (!existsSync(archive)) {
  console.log(`downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -1;
  const progress = new TransformStream({
    transform(chunk, controller) {
      got += chunk.byteLength;
      const pct = total ? Math.floor((100 * got) / total) : -1;
      if (pct !== lastPct && pct % 5 === 0) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }
      controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body.pipeThrough(progress)), createWriteStream(archive));
  } catch (err) {
    try { unlinkSync(archive); } catch { /* nothing to remove */ }
    throw err;
  }
  process.stdout.write('\n');
}
console.log(`unpacking ${archive} (${Math.round(statSync(archive).size / 1e6)} MB)`);
const tar = spawnSync('tar', ['-xJf', archive, '-C', root], { stdio: 'inherit' });
if (tar.status !== 0) throw new Error('tar failed');
if (!SampledPiano.available()) throw new Error(`unpacked, but ${DEFAULT_SAMPLES_DIR} is missing the sfz`);
console.log(`installed: ${DEFAULT_SAMPLES_DIR}\nSalamander Grand Piano by Alexander Holm, CC BY 3.0 (https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html)`);
