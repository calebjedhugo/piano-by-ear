#!/usr/bin/env node
// Build corpus/phrases.json from Humdrum **kern files.
//
//   node scripts/build-corpus.mjs <kern-dir> [<kern-dir>...]
//
// For each file the MELODY is taken to be the rightmost **kern spine
// (soprano in the chorales, right hand in the sonatas), top note of any
// chord, tied notes merged, grace notes dropped. The melody is then cut into
// short phrases: at fermatas (chorales), at rests, and at a maximum note
// count. Each phrase keeps its notes as [midi, offsetBeats, durationBeats]
// with beat = quarter note, plus its meter and pickup position so it can be
// played back with its real metric placement.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const MIN_NOTES = 3;
const MAX_NOTES = 12;
const MAX_SPAN_BEATS = 16;
const REST_BREAK_BEATS = 1; // a rest this long or longer ends a phrase

const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function parsePitch(token) {
  const m = token.match(/([a-gA-G])\1*/);
  if (!m) return null;
  const letters = m[0];
  const lower = letters[0] === letters[0].toLowerCase();
  const octave = lower ? 3 + letters.length : 4 - letters.length; // c=C4 (midi 60)
  const sharps = (token.match(/#/g) || []).length;
  const flats = (token.match(/-/g) || []).length;
  return 12 * (octave + 1) + STEP[letters[0].toLowerCase()] + sharps - flats;
}

function parseDuration(token) {
  const m = token.match(/(\d+)(\.*)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 0) return 8; // breve
  let beats = 4 / n;
  let add = beats;
  for (let i = 0; i < m[2].length; i += 1) {
    add /= 2;
    beats += add;
  }
  return beats;
}

function isGrace(token) {
  return /[qQPp]/.test(token.replace(/[^qQPp]/g, (c) => c)) && /[qQ]/.test(token);
}

/** Track spine types through *^ / *v so we can find the rightmost **kern column. */
function updateSpines(types, tokens) {
  const next = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '*^') next.push(types[i], types[i]);
    else if (t === '*v') {
      if (i === 0 || tokens[i - 1] !== '*v') next.push(types[i]);
    } else if (t === '*-') {
      /* spine ends */
    } else next.push(types[i]);
  }
  return next;
}

const ENTITIES = { uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä', szlig: 'ß', eacute: 'é', egrave: 'è', amp: '&' };
function decode(s) {
  return s.replace(/&([a-zA-Z]+);/g, (m, e) => ENTITIES[e] ?? '');
}

function meta(text, key) {
  const m = text.match(new RegExp(`^!!!${key}[^:]*:\\s*(.+)$`, 'm'));
  return m ? decode(m[1].trim().replace(/<[^>]+>/g, '')) : null;
}

function extractMelody(text) {
  const lines = text.split('\n');
  let types = null;
  let beatsPerBar = 4;
  let abs = 0; // beats since the start of the melody spine
  const bars = []; // abs positions of NUMBERED barlines
  const notes = []; // {midi, abs, dur, fermata, rest}
  let tie = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('!')) continue;
    const tokens = line.split('\t');
    if (line.startsWith('**')) {
      types = tokens;
      continue;
    }
    if (!types) continue;
    if (line.startsWith('*')) {
      const m = line.match(/\*M(\d+)\/(\d+)/);
      if (m) beatsPerBar = (Number(m[1]) * 4) / Number(m[2]);
      if (tokens.some((t) => t === '*^' || t === '*v' || t === '*-')) types = updateSpines(types, tokens);
      continue;
    }
    if (line.startsWith('=')) {
      // Only numbered barlines are real bar starts; "=:|!" style repeat
      // lines sit between a pickup and the numbered bar that follows.
      if (/^=\d+/.test(line)) bars.push({ n: Number(line.match(/=(\d+)/)[1]), abs });
      continue;
    }
    let col = -1;
    for (let i = types.length - 1; i >= 0; i -= 1) {
      if (types[i] === '**kern') {
        col = i;
        break;
      }
    }
    if (col < 0 || col >= tokens.length) continue;
    const token = tokens[col];
    if (token === '.') continue;
    const parts = token.split(' ');
    let best = null;
    for (const p of parts) {
      if (isGrace(p)) continue;
      const dur = parseDuration(p);
      if (dur === null) continue;
      if (p.includes('r')) {
        if (!best) best = { rest: true, dur, midi: null };
        continue;
      }
      const midi = parsePitch(p);
      if (midi === null) continue;
      if (!best || best.rest || midi > best.midi) {
        best = {
          rest: false, dur, midi,
          tieStart: p.includes('['), tieCont: p.includes('_') || p.includes(']'), fermata: p.includes(';'),
        };
      }
    }
    if (!best) continue;
    if (!best.rest && best.tieCont && tie && tie.midi === best.midi) {
      tie.dur += best.dur;
      if (best.fermata) tie.fermata = true;
      if (token.includes(']')) tie = null;
      abs += best.dur;
      continue;
    }
    const note = { midi: best.midi, rest: best.rest, abs, dur: best.dur, fermata: !!best.fermata };
    notes.push(note);
    tie = !best.rest && best.tieStart ? note : null;
    abs += best.dur;
  }
  return { notes, bars, beatsPerBar };
}

function segment(melody, source) {
  const { notes, bars, beatsPerBar } = melody;
  const phrases = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= MIN_NOTES) {
      const first = cur[0];
      const last = cur[cur.length - 1];
      const span = last.abs + last.dur - first.abs;
      if (span <= MAX_SPAN_BEATS) {
        // Metric placement: distance to the next numbered barline gives the
        // first note's beat within its bar (handles pickups and repeats).
        const next = bars.find((b) => b.abs > first.abs);
        const at = bars.filter((b) => b.abs <= first.abs).pop();
        let pickup = 0;
        if (next) pickup = (beatsPerBar - ((next.abs - first.abs) % beatsPerBar)) % beatsPerBar;
        else if (at) pickup = (first.abs - at.abs) % beatsPerBar;
        phrases.push({
          ...source,
          bar: at ? at.n : 0,
          meter: beatsPerBar,
          pickup,
          notes: cur.map((n) => [n.midi, n.abs - first.abs, n.dur]),
        });
      }
    }
    cur = [];
  };
  for (const n of notes) {
    if (n.rest) {
      if (n.dur >= REST_BREAK_BEATS) flush();
      continue;
    }
    cur.push(n);
    if (n.fermata || cur.length >= MAX_NOTES) flush();
  }
  flush();
  return phrases;
}

const out = [];
for (const dir of process.argv.slice(2)) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.krn')).sort();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const composer = (meta(text, 'COM') || 'Unknown').split(',')[0];
    const title = meta(text, 'OTL@EN') || meta(text, 'OTL') || basename(f, '.krn');
    const catalog = meta(text, 'SCT') || meta(text, 'SCT1') || '';
    const movement = meta(text, 'OMV');
    const source = {
      composer,
      title: movement ? `${title}, mvt ${movement}` : title,
      catalog,
      file: basename(f),
    };
    const melody = extractMelody(text);
    for (const p of segment(melody, source)) out.push(p);
  }
}
out.forEach((p, i) => {
  p.id = i;
});
mkdirSync('corpus', { recursive: true });
writeFileSync('corpus/phrases.json', JSON.stringify(out));
const byComposer = {};
for (const p of out) byComposer[p.composer] = (byComposer[p.composer] || 0) + 1;
console.log(`${out.length} phrases`, byComposer);
