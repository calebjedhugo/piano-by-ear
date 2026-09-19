// WHICH MACHINE THIS IS. Every row a machine writes is stamped with this id,
// which is what lets two computers (and a laptop that played a week with no
// network) merge their histories into one profile instead of overwriting each
// other -- see src/sync.js. The id is random and permanent; the label is only
// for the log.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let cached = null;

/** This machine's stable id, created on first run. */
export function deviceId(path) {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw?.id) return (cached = raw);
  } catch {
    /* first run, or a file we cannot read: make a new one */
  }
  cached = { id: randomUUID().slice(0, 8), label: hostname().replace(/\.local$/, ''), createdAt: Date.now() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cached, null, 2));
  return cached;
}
