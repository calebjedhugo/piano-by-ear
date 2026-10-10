#!/usr/bin/env node
// Check scripts/ly2kern.mjs against the MIDI Mutopia publishes beside each
// .ly file (the same source, rendered by LilyPond itself):
//
//   node scripts/check-ly2kern.mjs <kern-dir> <midi-dir>
//
// Every sounding note, ties merged, is compared as (pitch, onset, duration)
// in quarters, all voices pooled -- Mutopia's MIDI has one track per staff,
// and a voice that crosses staves splits across tracks, so voice assignment
// is not what is checked here; it comes straight from the source's three
// named parts. Exit status 1 on any difference.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMidi(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const vlq = () => { let v = 0; let b; do { b = buf[p]; p += 1; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('not a MIDI file');
  p = 8;
  u16();
  const ntrk = u16();
  const ppq = u16();
  const notes = [];
  for (let k = 0; k < ntrk; k += 1) {
    while (buf.toString('latin1', p, p + 4) !== 'MTrk') p += 1;
    p += 4;
    const end = u32() + p;
    let t = 0;
    let status = 0;
    const open = new Map();
    while (p < end) {
      t += vlq();
      let b = buf[p];
      if (b & 0x80) { status = b; p += 1; } else b = status;
      const type = status & 0xf0;
      if (status === 0xff) { p += 1; const len = vlq(); p += len; continue; }
      if (status === 0xf0 || status === 0xf7) { const len = vlq(); p += len; continue; }
      const d1 = buf[p]; p += 1;
      const d2 = type === 0xc0 || type === 0xd0 ? 0 : buf[p++];
      if (type === 0x90 && d2 > 0) open.set(d1, t);
      else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        if (open.has(d1)) { notes.push({ midi: d1, on: open.get(d1) / ppq, dur: (t - open.get(d1)) / ppq }); open.delete(d1); }
      }
    }
    p = end;
  }
  return notes;
}

const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
function readKern(text) {
  const notes = [];
  let cols = null;
  const open = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('!') || line.startsWith('*') || line.startsWith('=')) {
      if (line.startsWith('**')) { cols = line.split('\t').map(() => 0); line.split('\t').forEach((_, i) => { open[i] = null; }); }
      continue;
    }
    line.split('\t').forEach((cell, i) => {
      if (cell === '.') return;
      const at = cols[i];
      let advance = 0;
      const chordOpen = [];
      for (const tok of cell.split(' ')) { // a chord is several notes in one cell
      const m = tok.match(/^(\[?)(\d+)(\.*)(r|([a-gA-G])\5*([#-]*))(.*)$/);
      if (!m) throw new Error(`bad token ${tok}`);
      let q = 4 / Number(m[2]);
      let add = q;
      for (let d = 0; d < m[3].length; d += 1) { add /= 2; q += add; }
      advance = q;
      if (m[4] === 'r') continue;
      const letters = m[4].match(/[a-gA-G]+/)[0];
      const lower = letters[0] === letters[0].toLowerCase();
      const oct = lower ? 3 + letters.length : 4 - letters.length;
      const midi = 12 * (oct + 1) + STEP[letters[0].toLowerCase()] + (m[6].match(/#/g) || []).length - (m[6].match(/-/g) || []).length;
      const cont = /[_\]]/.test(m[7]);
      const held = (open[i] || []).find((o) => o.midi === midi);
      if (cont && held) { held.dur += q; if (m[7].includes('_')) chordOpen.push(held); continue; }
      const n = { midi, on: at, dur: q };
      notes.push(n);
      if (m[1] === '[') chordOpen.push(n);
      }
      open[i] = chordOpen;
      cols[i] += advance;
    });
  }
  return notes;
}

// A UNISON BETWEEN TWO VOICES IS ONE NOTE IN THE MIDI. Two voices on one
// staff share a channel, and a channel cannot sound one key twice: LilyPond
// keeps the first strike and lets it ring to the later release. So the check
// is per pitch: (1) every MIDI onset is one of ours; (2) an onset of ours the
// MIDI lacks must land while another of our notes on that pitch is already
// sounding or starts with it; (3) the time each pitch sounds -- the union of
// its notes -- is identical.
const r4 = (x) => Math.round(x * 1e4) / 1e4;
function cover(list) {
  const iv = list.map((n) => [r4(n.on), r4(n.on + n.dur)]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return JSON.stringify(out);
}
// Known differences, none of them a misread note:
// - BWV 797 bar 62 ties the bass D into a pitched rest, and LilyPond's MIDI
//   keeps the D sounding through the rest. ly2kern reads the rest as silence.
// - GRACE NOTES. ly2kern drops them, as build-corpus.mjs drops kern graces;
//   the MIDI plays them and shifts or shortens the main note. BWV 848 has two
//   appoggiaturas (A#, and G#-A# before a B), BWV 529 mvt 2 an acciaccatura
//   (A before G#) and an appoggiatura (D# before E).
const EXPECTED = {
  'bwv797.krn': ['50 sounds for different spans'],
  'bwv848b.krn': ['70 sounds for different spans', '80 sounds for different spans', '82@47.9349 missing here', '82 sounds for different spans'],
  'bwv529-2.krn': ['69 sounds for different spans', '68@159.1016 missing here', '68@159 extra here', '68 sounds for different spans',
    '63@158.7734 missing here', '63 sounds for different spans'],
};
const [kernDir, midiDir] = process.argv.slice(2);
let bad = 0;
for (const f of readdirSync(kernDir).filter((x) => x.endsWith('.krn')).sort()) {
  const ours = readKern(readFileSync(join(kernDir, f), 'utf8'));
  const theirs = readMidi(readFileSync(join(midiDir, f.replace(/\.krn$/, '.mid'))));
  const problems = [];
  let unisons = 0;
  for (const midi of new Set([...ours, ...theirs].map((n) => n.midi))) {
    const a = ours.filter((n) => n.midi === midi);
    const b = theirs.filter((n) => n.midi === midi);
    const onA = new Set(a.map((n) => r4(n.on)));
    const onB = new Set(b.map((n) => r4(n.on)));
    for (const t of onB) if (!onA.has(t)) problems.push(`${midi}@${t} missing here`);
    for (const n of a) {
      if (onB.has(r4(n.on))) continue;
      const covered = a.some((o) => o !== n && r4(o.on) <= r4(n.on) && r4(o.on + o.dur) > r4(n.on));
      if (covered) unisons += 1; else problems.push(`${midi}@${r4(n.on)} extra here`);
    }
    const sameOnset = a.length - new Set(a.map((n) => r4(n.on))).size;
    unisons += sameOnset;
    if (cover(a) !== cover(b)) problems.push(`${midi} sounds for different spans`);
  }
  const known = EXPECTED[f] || [];
  const unexplained = problems.filter((p) => !known.includes(p));
  if (unexplained.length) bad += 1;
  const note = problems.length && !unexplained.length ? ` (known: ${problems.join('; ')})` : '';
  console.log(`${f}: ${ours.length} notes, ${theirs.length} in the MIDI, ${unisons} unisons -- ${unexplained.length ? `${unexplained.length} PROBLEMS: ${unexplained.slice(0, 6).join('; ')}` : `match${note}`}`);
}
process.exit(bad ? 1 : 0);
