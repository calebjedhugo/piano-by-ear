#!/usr/bin/env node
// Download and unpack the two piano sample sets into ~/.piano-by-ear/samples:
//   grand    Salamander Grand Piano (~410 MB), Alexander Holm, CC BY 3.0 -- yours
//   upright  Upright Piano KW (~33 MB), FreePats, CC0 -- the teacher's
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { INSTRUMENTS, SAMPLES_ROOT, SampledPiano } from '../src/sampler.js';

async function download(url, to) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
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
    await pipeline(Readable.fromWeb(res.body.pipeThrough(progress)), createWriteStream(to));
  } catch (err) {
    try { unlinkSync(to); } catch { /* nothing to remove */ }
    throw err;
  }
  process.stdout.write('\n');
}

/** bsdtar (macOS tar) reads tar.xz and 7z alike; fall back to 7z if present. */
function unpack(archive) {
  console.log(`unpacking ${archive} (${Math.round(statSync(archive).size / 1e6)} MB)`);
  let r = spawnSync('tar', ['-xf', archive, '-C', SAMPLES_ROOT], { stdio: 'inherit' });
  if (r.status !== 0 && archive.endsWith('.7z')) r = spawnSync('7z', ['x', '-y', `-o${SAMPLES_ROOT}`, archive], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not unpack ${archive} (need tar with 7z support, or 7z)`);
}

mkdirSync(SAMPLES_ROOT, { recursive: true });
for (const [which, inst] of Object.entries(INSTRUMENTS)) {
  if (SampledPiano.available(which)) {
    console.log(`${which}: already installed (${join(SAMPLES_ROOT, inst.dir)})`);
    continue;
  }
  const archive = join(SAMPLES_ROOT, inst.archive);
  if (!existsSync(archive)) await download(inst.url, archive);
  unpack(archive);
  if (!SampledPiano.available(which)) throw new Error(`unpacked, but ${join(SAMPLES_ROOT, inst.dir, inst.sfz)} is missing`);
  console.log(`${which}: installed -- ${inst.credit}`);
}
console.log('Both pianos from https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html');
