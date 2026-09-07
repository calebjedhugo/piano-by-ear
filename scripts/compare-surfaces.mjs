#!/usr/bin/env node
// Per-interval accuracy on the piano vs the computer keyboard, side by side:
// the ear-versus-hand diagnostic. Isolated interval questions only (kinds
// interval/discrimination/remediation, graded target notes).
//
//   node scripts/compare-surfaces.mjs ~/.piano-by-ear/profiles/Caleb.db ~/.piano-by-ear/profiles/Caleb-keys.db [--since YYYY-MM-DD]
import { DatabaseSync } from 'node:sqlite';

const [pianoPath, keysPath, ...rest] = process.argv.slice(2);
if (!pianoPath || !keysPath) { console.error('usage: compare-surfaces.mjs <piano.db> <keys.db> [--since YYYY-MM-DD]'); process.exit(2); }
const sinceIdx = rest.indexOf('--since');
const since = sinceIdx >= 0 ? Date.parse(rest[sinceIdx + 1]) : 0;

function stats(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare(`SELECT target - anchor AS iv, correct, in_time FROM attempts
    WHERE kind IN ('interval','discrimination','remediation') AND graded = 1 AND ts >= ?`).all(since);
  const by = new Map();
  for (const r of rows) {
    const k = r.iv > 0 ? `+${r.iv}` : String(r.iv);
    const s = by.get(k) || { n: 0, c: 0, t: 0 };
    s.n += 1; s.c += r.correct ? 1 : 0; s.t += r.in_time ? 1 : 0;
    by.set(k, s);
  }
  db.close();
  return by;
}
const piano = stats(pianoPath);
const keys = stats(keysPath);
const ivs = [...new Set([...piano.keys(), ...keys.keys()])].sort((a, b) => Number(a) - Number(b));
const pct = (s) => (s && s.n ? `${Math.round((100 * s.c) / s.n)}% (${s.c}/${s.n})` : '-');
console.log('interval   piano             keys              gap');
for (const iv of ivs) {
  const p = piano.get(iv); const k = keys.get(iv);
  const gap = p && k && p.n >= 4 && k.n >= 4 ? `${Math.round(100 * (k.c / k.n - p.c / p.n))}` : '';
  console.log(`${iv.padEnd(10)} ${pct(p).padEnd(17)} ${pct(k).padEnd(17)} ${gap ? (Number(gap) > 0 ? '+' : '') + gap + ' pts (keys - piano)' : ''}`);
}
const tot = (m) => [...m.values()].reduce((a, s) => ({ n: a.n + s.n, c: a.c + s.c }), { n: 0, c: 0 });
console.log(`\noverall    ${pct(tot(piano)).padEnd(17)} ${pct(tot(keys))}`);
console.log('Read: an interval weak on BOTH surfaces is an ear gap; weak on the piano only is an ear-to-hand gap.');
