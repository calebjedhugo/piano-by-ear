#!/usr/bin/env node
// Build corpus/phrases.json from Humdrum **kern files.
//
//   node scripts/build-corpus.mjs <kern-dir> [<kern-dir>...]
//
// MELODY: the rightmost **kern spine at the header (soprano in the chorales,
// right hand in the sonatas) and every sub-spine it splits into (*^). On each
// time slice the highest attacked pitch across those columns is taken, unless
// another column is still holding a higher note (so an inner voice never
// replaces a sustained melody note). Ties are merged, grace notes dropped.
//
// TIME: integer ticks (TPQ per quarter) so triplets and dotted values never
// accumulate float error. Output offsets/durations are in FELT BEATS of the
// phrase's meter: quarter in x/4, eighth in 3/8, dotted quarter in 6/8,
// half in x/2. `beatLen` gives that beat in quarters; `meter` is an integer
// count of beats per bar.
//
// PHRASES: cut at fermatas, at a beat or more of rest, at meter changes, and
// (softly) at the last bar line before MAX_NOTES; phrases over MAX_SPAN are
// split at the bar line nearest the middle. Accompaniment textures are then
// filtered out (see suitable()).
//
// POLYPHONY (corpus/poly.json): every voice of the same files, cut into
// bar-aligned windows inside the melodic phrases above. Four-voice files
// (the chorales) yield 'duo' (soprano + bass) and 'chorale' (all voices)
// phrases; two-staff files (the sonatas) yield 'poly' (both hands). Notes
// are [midi, offset, duration, voice] with voice 0 the lowest staff;
// `pivot` indexes the highest note of the first onset, which is placed on
// the player's anchor.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const TPQ = 1680; // 2^4 * 3 * 5 * 7: exact for 64ths, triplets, quintuplets, septuplets
const MIN_NOTES = 3;
const MAX_NOTES = 12;
const MAX_SPAN_BEATS = 16; // felt beats
const MIN_SPAN_BEATS = 2;
const REST_BREAK_BEATS = 1; // felt beats of silence that end a phrase
const MIN_DUR_QUARTERS = 0.25; // fastest note allowed: a sixteenth, in any meter
const MAX_LEAP = 12;
const MAX_AMBITUS = 19;
// polyphonic windows
const POLY = {
  duo: { maxNotes: 14, maxSimul: 2, minVoices: 2, maxAmbitus: 36 },
  chorale: { maxNotes: 16, maxSimul: 4, minVoices: 3, maxAmbitus: 36 },
  poly: { maxNotes: 16, maxSimul: 4, minVoices: 2, maxAmbitus: 36 },
};
const POLY_MIN_NOTES = 4;
const POLY_MAX_SPAN_BEATS = 8;

const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const ENTITIES = { uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä', szlig: 'ß', eacute: 'é', egrave: 'è', amp: '&' };
const COMPOSER_FIX = { 'Müler August Eberhard': 'Müller' };

function decode(s) {
  return s.replace(/&([a-zA-Z]+);/g, (m, e) => ENTITIES[e] ?? '');
}

function meta(text, key) {
  const m = text.match(new RegExp(`^!!!${key}[^:]*:\\s*(.+)$`, 'm'));
  return m ? decode(m[1].trim().replace(/<[^>]+>/g, '')) : null;
}

function parsePitch(token) {
  const m = token.match(/([a-gA-G])\1*/);
  if (!m) return null;
  const letters = m[0];
  const lower = letters[0] === letters[0].toLowerCase();
  const octave = lower ? 3 + letters.length : 4 - letters.length; // c = C4 = 60
  const sharps = (token.match(/#/g) || []).length;
  const flats = (token.match(/-/g) || []).length;
  return 12 * (octave + 1) + STEP[letters[0].toLowerCase()] + sharps - flats;
}

/** Duration in ticks, or null. */
function parseTicks(token) {
  const m = token.match(/(\d+)(\.*)/);
  if (!m) return null;
  const n = Number(m[1]);
  let ticks = n === 0 ? 8 * TPQ : (4 * TPQ) / n; // 0 = breve
  if (!Number.isInteger(ticks)) ticks = Math.round(ticks);
  let add = ticks;
  for (let i = 0; i < m[2].length; i += 1) {
    add /= 2;
    ticks += add;
  }
  return Math.round(ticks);
}

// q / Q mark grace notes. P / p mark appoggiatura pairs that carry real
// written durations and are kept as ordinary notes.
const isGrace = (token) => /[qQ]/.test(token);

/** Felt beat for a time signature: [beatLen in quarters, beats per bar]. */
function beatUnit(num, den) {
  if (den === 8 && num % 3 === 0 && num > 3) return [1.5, num / 3];
  if (den === 8) return [0.5, num];
  if (den === 16) return [0.25, num];
  if (den === 2) return [2, num];
  if (den === 1) return [4, num];
  return [1, num];
}

/** Advance spine bookkeeping through *^ / *v / *-. Each column = {type, mel}. */
function updateSpines(cols, tokens) {
  const next = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const c = cols[i];
    if (t === '*^') next.push({ ...c }, { ...c });
    else if (t === '*v') {
      if (i === 0 || tokens[i - 1] !== '*v') next.push({ ...c });
    } else if (t === '*-') {
      /* spine ends */
    } else next.push(c);
  }
  return next;
}

function extractMelody(text) {
  const lines = text.split('\n');
  let cols = null;
  let meterNum = 4;
  let meterDen = 4;
  let key = null;
  const bars = []; // {n, ticks, num, den, key}
  const notes = []; // {midi, ticks, dur, fermata, rest}
  const open = new Map(); // tied pitch -> note object
  let restRun = 0;
  // per-column clocks: ticks at which the column's next token starts
  let colTicks = [];
  const sounding = new Map(); // column index -> {midi, until}
  let lastTicks = 0;

  const pushRest = (ticks, dur) => {
    notes.push({ rest: true, ticks, dur, midi: null });
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('!')) continue;
    const tokens = line.split('\t');
    if (line.startsWith('**')) {
      cols = tokens.map((t) => ({ type: t, mel: false }));
      for (let i = cols.length - 1; i >= 0; i -= 1) {
        if (cols[i].type === '**kern') {
          cols[i].mel = true;
          break;
        }
      }
      colTicks = cols.map(() => 0);
      continue;
    }
    if (!cols) continue;
    if (line.startsWith('*')) {
      const m = line.match(/\*M(\d+)\/(\d+)/);
      if (m) {
        meterNum = Number(m[1]);
        meterDen = Number(m[2]);
      }
      const k = line.match(/\*([a-gA-G][#-]*):/);
      if (k) key = k[1];
      if (tokens.some((t) => t === '*^' || t === '*v' || t === '*-')) {
        const before = cols;
        cols = updateSpines(before, tokens);
        // rebuild per-column clocks: children inherit the parent's clock
        const nextTicks = [];
        for (let i = 0, j = 0; i < tokens.length; i += 1) {
          const t = tokens[i];
          if (t === '*^') {
            nextTicks.push(colTicks[i], colTicks[i]);
          } else if (t === '*v') {
            if (i === 0 || tokens[i - 1] !== '*v') nextTicks.push(Math.max(colTicks[i], lastTicks));
          } else if (t === '*-') {
            /* drop */
          } else nextTicks.push(colTicks[i]);
          j += 1;
        }
        colTicks = nextTicks;
        sounding.clear();
      }
      continue;
    }
    if (line.startsWith('=')) {
      const m = line.match(/^=(\d+)/);
      if (m) {
        const at = Math.max(...cols.map((c, i) => (c.mel ? colTicks[i] : 0)));
        bars.push({ n: Number(m[1]), ticks: at, num: meterNum, den: meterDen, key });
      }
      continue;
    }

    // Data line: gather attacks in melody-group columns.
    let lineTicks = null;
    const attacks = [];
    for (let i = 0; i < cols.length && i < tokens.length; i += 1) {
      if (!cols[i].mel) continue;
      const token = tokens[i];
      if (token === '.') continue;
      const t = colTicks[i];
      lineTicks = lineTicks === null ? t : Math.min(lineTicks, t);
      let best = null;
      let dur = null;
      for (const p of token.split(' ')) {
        if (isGrace(p)) continue;
        const d = parseTicks(p);
        if (d === null) continue;
        if (dur === null || d < dur) dur = d;
        if (p.includes('r')) {
          if (!best) best = { rest: true, dur: d, col: i };
          continue;
        }
        const midi = parsePitch(p);
        if (midi === null) continue;
        if (!best || best.rest || midi > best.midi) {
          best = {
            rest: false, dur: d, midi, col: i,
            tieStart: p.includes('['), tieCont: p.includes('_') || p.includes(']'), tieEnd: p.includes(']'),
            fermata: p.includes(';'),
          };
        }
      }
      if (dur !== null) colTicks[i] = t + dur;
      if (best) attacks.push({ ...best, ticks: t });
    }
    if (lineTicks === null) continue;
    lastTicks = lineTicks;

    // Choose the melody event for this slice.
    let ev = null;
    for (const a of attacks) {
      if (a.rest) continue;
      if (!ev || a.midi > ev.midi) ev = a;
    }
    if (ev) {
      // suppressed if another column still holds a higher note
      let suppressed = false;
      for (const [ci, s] of sounding) {
        if (ci !== ev.col && s.until > ev.ticks && s.midi > ev.midi) suppressed = true;
      }
      sounding.set(ev.col, { midi: ev.midi, until: ev.ticks + ev.dur });
      if (suppressed) continue;
      if (ev.tieCont && open.has(ev.midi)) {
        const t = open.get(ev.midi);
        t.dur = ev.ticks + ev.dur - t.ticks;
        if (ev.fermata) t.fermata = true;
        if (ev.tieEnd) open.delete(ev.midi);
        continue;
      }
      if (ev.tieCont && !ev.tieStart) continue; // orphan continuation: not a new attack
      const note = { midi: ev.midi, rest: false, ticks: ev.ticks, dur: ev.dur, fermata: ev.fermata };
      notes.push(note);
      restRun = 0;
      if (ev.tieStart) open.set(ev.midi, note);
    } else if (attacks.length > 0) {
      // every attacking column rests; only a rest if nothing is sounding
      const held = [...sounding.values()].some((s) => s.until > lineTicks);
      if (!held) {
        const r = attacks[0];
        pushRest(r.ticks, r.dur);
      }
    }
  }
  return { notes, bars };
}

function barAt(bars, ticks) {
  let at = null;
  for (const b of bars) {
    if (b.ticks <= ticks) at = b;
    else break;
  }
  return at;
}
function barAfter(bars, ticks) {
  return bars.find((b) => b.ticks > ticks) || null;
}

function segment(melody, source) {
  const { notes, bars } = melody;
  const phrases = [];
  let cur = [];
  let restRun = 0;

  const emit = (group) => {
    if (group.length < MIN_NOTES) return;
    const first = group[0];
    const bar = barAt(bars, first.ticks) || barAfter(bars, first.ticks) || { n: 0, ticks: 0, num: 4, den: 4, key: null };
    const [beatLen, meter] = beatUnit(bar.num, bar.den);
    const beatTicks = beatLen * TPQ;
    const last = group[group.length - 1];
    const spanTicks = last.ticks + last.dur - first.ticks;
    if (spanTicks > MAX_SPAN_BEATS * beatTicks) {
      // split at the bar line nearest the middle
      const mid = first.ticks + spanTicks / 2;
      let best = -1;
      let bestDist = Infinity;
      for (let i = MIN_NOTES; i <= group.length - MIN_NOTES; i += 1) {
        const onBar = bars.some((b) => b.ticks === group[i].ticks);
        const dist = Math.abs(group[i].ticks - mid);
        if (onBar && dist < bestDist) {
          best = i;
          bestDist = dist;
        }
      }
      if (best > 0) {
        emit(group.slice(0, best));
        emit(group.slice(best));
      }
      return;
    }
    const next = barAfter(bars, first.ticks);
    let pickup = 0;
    const barTicks = meter * beatTicks;
    if (next) pickup = (barTicks - ((next.ticks - first.ticks) % barTicks)) % barTicks;
    else pickup = (first.ticks - bar.ticks) % barTicks;
    const phrase = {
      ...source,
      at: first.ticks,
      spanTicks,
      beatTicks,
      key: bar.key,
      bar: bar.n,
      meter,
      beatLen,
      pickup: pickup / beatTicks,
      notes: group.map((n) => [n.midi, (n.ticks - first.ticks) / beatTicks, n.dur / beatTicks]),
    };
    if (suitable(phrase)) phrases.push(phrase);
  };

  const flush = () => {
    emit(cur);
    cur = [];
  };

  let curMeter = null;
  for (const n of notes) {
    if (n.rest) {
      const bar = barAt(bars, n.ticks) || { num: 4, den: 4 };
      const [beatLen] = beatUnit(bar.num, bar.den);
      restRun += n.dur / (beatLen * TPQ);
      if (restRun >= REST_BREAK_BEATS) flush();
      continue;
    }
    restRun = 0;
    const bar = barAt(bars, n.ticks);
    const m = bar ? `${bar.num}/${bar.den}` : null;
    if (curMeter !== null && m !== curMeter && cur.length > 0) flush();
    curMeter = m;
    cur.push(n);
    if (n.fermata) {
      flush();
      continue;
    }
    if (cur.length >= MAX_NOTES) {
      // soft cut: back up to the last bar line inside the window
      let cutAt = -1;
      for (let i = cur.length - 1; i >= MIN_NOTES; i -= 1) {
        if (bars.some((b) => b.ticks === cur[i].ticks)) {
          cutAt = i;
          break;
        }
      }
      if (cutAt > 0) {
        emit(cur.slice(0, cutAt));
        cur = cur.slice(cutAt);
      } else flush();
    }
  }
  flush();
  return phrases;
}

/** Reject accompaniment textures and unplayable-by-ear fragments. */
function suitable(p) {
  const midis = p.notes.map((n) => n[0]);
  const durs = p.notes.map((n) => n[2]);
  const last = p.notes[p.notes.length - 1];
  const span = last[1] + last[2];
  if (span < MIN_SPAN_BEATS) return false;
  if (Math.min(...durs) * p.beatLen < MIN_DUR_QUARTERS - 1e-9) return false;
  const pcs = new Set(midis.map((m) => m % 12));
  if (new Set(midis).size < 3) return false;
  const lo = Math.min(...midis);
  const hi = Math.max(...midis);
  if (hi - lo > MAX_AMBITUS) return false;
  let leaps = 0;
  let oscillating = 0;
  let steps = 0;
  for (let i = 1; i < midis.length; i += 1) {
    const iv = Math.abs(midis[i] - midis[i - 1]);
    if (iv > MAX_LEAP) return false;
    if (iv > 2) leaps += 1;
    else if (iv > 0) steps += 1;
    if (i >= 2 && midis[i] === midis[i - 2] && midis[i] !== midis[i - 1]) oscillating += 1;
  }
  const n = midis.length - 1;
  if (oscillating >= 0.7 * (n - 1) && pcs.size <= 3) return false; // tremolo / broken octave
  if (steps === 0 && leaps >= 4 && pcs.size <= 4) return false; // pure arpeggio
  return true;
}

/**
 * Every note of every **kern column, with the column's header index as its
 * voice (0 = lowest staff). Ties merged per voice; chords split into notes;
 * grace notes dropped. Returns { notes: [{midi, ticks, dur, voice}], voices }.
 */
function extractPoly(text) {
  const lines = text.split('\n');
  let cols = null;
  let colTicks = [];
  const notes = [];
  const open = new Map(); // `voice:midi` -> note
  let lastTicks = 0;
  let voices = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('!')) continue;
    const tokens = line.split('\t');
    if (line.startsWith('**')) {
      cols = tokens.map((t, i) => ({ type: t, kern: t === '**kern', root: i }));
      let v = 0;
      for (const c of cols) if (c.kern) { c.voice = v; v += 1; }
      voices = v;
      colTicks = cols.map(() => 0);
      continue;
    }
    if (!cols) continue;
    if (line.startsWith('*')) {
      if (tokens.some((t) => t === '*^' || t === '*v' || t === '*-')) {
        cols = updateSpines(cols, tokens);
        const nextTicks = [];
        for (let i = 0; i < tokens.length; i += 1) {
          const t = tokens[i];
          if (t === '*^') nextTicks.push(colTicks[i], colTicks[i]);
          else if (t === '*v') { if (i === 0 || tokens[i - 1] !== '*v') nextTicks.push(Math.max(colTicks[i], lastTicks)); }
          else if (t === '*-') { /* drop */ }
          else nextTicks.push(colTicks[i]);
        }
        colTicks = nextTicks;
      }
      continue;
    }
    if (line.startsWith('=')) continue;
    let lineTicks = null;
    for (let i = 0; i < cols.length && i < tokens.length; i += 1) {
      if (!cols[i].kern) continue;
      const token = tokens[i];
      if (token === '.') continue;
      const t = colTicks[i];
      lineTicks = lineTicks === null ? t : Math.min(lineTicks, t);
      let dur = null;
      for (const p of token.split(' ')) {
        if (isGrace(p)) continue;
        const d = parseTicks(p);
        if (d === null) continue;
        if (dur === null || d < dur) dur = d;
        if (p.includes('r')) continue;
        const midi = parsePitch(p);
        if (midi === null) continue;
        const voice = cols[i].voice;
        const key = `${voice}:${midi}`;
        const tieCont = p.includes('_') || p.includes(']');
        if (tieCont && open.has(key)) {
          const o = open.get(key);
          o.dur = t + d - o.ticks;
          if (p.includes(']')) open.delete(key);
          continue;
        }
        if (tieCont && !p.includes('[')) continue;
        const note = { midi, ticks: t, dur: d, voice };
        notes.push(note);
        if (p.includes('[')) open.set(key, note);
      }
      if (dur !== null) colTicks[i] = t + dur;
    }
    if (lineTicks !== null) lastTicks = lineTicks;
  }
  notes.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
  return { notes, voices };
}

/** Bar-aligned polyphonic windows inside each melodic phrase. */
function polyPhrases(monoPhrases, poly, bars, source) {
  const out = [];
  const seen = new Set();
  const kinds = poly.voices >= 4 ? ['duo', 'chorale'] : poly.voices === 2 ? ['poly'] : [];
  if (kinds.length === 0) return out;
  const top = poly.voices - 1;
  for (const mono of monoPhrases) {
    const { at, spanTicks, beatTicks, meter } = mono;
    const end = at + spanTicks;
    const barTicks = meter * beatTicks;
    const cuts = [at, ...bars.map((b) => b.ticks).filter((t) => t > at && t < end), end];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      for (let j = i + 1; j < cuts.length; j += 1) {
        const from = cuts[i];
        const to = cuts[j];
        const spanBeats = (to - from) / beatTicks;
        if (spanBeats < MIN_SPAN_BEATS || spanBeats > POLY_MAX_SPAN_BEATS) continue;
        for (const kind of kinds) {
          const want = kind === 'duo' ? new Set([0, top]) : null;
          const notes = poly.notes
            .filter((n) => n.ticks >= from && n.ticks < to && (!want || want.has(n.voice)))
            .map((n) => ({ ...n, dur: Math.min(n.dur, to - n.ticks) }));
          const p = polyPhrase(kind, notes, from, to, mono, source);
          if (!p) continue;
          const id = createHash('sha1').update(`${p.file}|${kind}|${from}|${JSON.stringify(p.notes)}`).digest('hex').slice(0, 12);
          if (seen.has(id)) continue;
          seen.add(id);
          p.id = id;
          out.push(p);
        }
      }
    }
  }
  return out;
}

function polyPhrase(kind, raw, from, to, mono, source) {
  const cfg = POLY[kind];
  if (raw.length < POLY_MIN_NOTES || raw.length > cfg.maxNotes) return null;
  const { beatTicks, beatLen, meter } = mono;
  const voices = new Set(raw.map((n) => n.voice));
  if (voices.size < cfg.minVoices) return null;
  if (raw.some((n) => n.dur * 1 < MIN_DUR_QUARTERS * TPQ - 1e-9)) return null;
  const midis = raw.map((n) => n.midi);
  if (Math.max(...midis) - Math.min(...midis) > cfg.maxAmbitus) return null;
  // simultaneity: how many notes share an onset; and never a beat of silence
  const byOnset = new Map();
  for (const n of raw) byOnset.set(n.ticks, (byOnset.get(n.ticks) || 0) + 1);
  if (Math.max(...byOnset.values()) > cfg.maxSimul) return null;
  if (kind !== 'duo' && Math.max(...byOnset.values()) < 2) return null; // nothing vertical: that's the melody
  let maxEnd = from;
  for (const n of raw) {
    if (n.ticks - maxEnd >= REST_BREAK_BEATS * beatTicks) return null;
    maxEnd = Math.max(maxEnd, n.ticks + n.dur);
  }
  if (raw[0].ticks !== from) return null; // the window must start with an attack
  // pivot: the highest note of the first onset
  let pivot = 0;
  for (let i = 1; i < raw.length && raw[i].ticks === raw[0].ticks; i += 1) if (raw[i].midi > raw[pivot].midi) pivot = i;
  const barTicks = meter * beatTicks;
  const bar = barAt(mono.bars, from);
  return {
    ...source,
    kind,
    key: mono.key,
    bar: bar ? bar.n : mono.bar,
    meter,
    beatLen,
    pickup: bar ? ((from - bar.ticks) % barTicks) / beatTicks : 0,
    voices: voices.size,
    pivot,
    notes: raw.map((n) => [n.midi, (n.ticks - from) / beatTicks, n.dur / beatTicks, n.voice]),
  };
}

const out = [];
const polyOut = [];
for (const dir of process.argv.slice(2)) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.krn')).sort();
  const collection = basename(dir.replace(/\/kern\/?$/, ''));
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    let composer = (meta(text, 'COM') || 'Unknown').split(',')[0].trim();
    composer = COMPOSER_FIX[composer] || composer;
    const title = meta(text, 'OTL@EN') || meta(text, 'OTL') || basename(f, '.krn');
    const catalog = meta(text, 'SCT') || meta(text, 'SCT1') || '';
    const movement = meta(text, 'OMV');
    const source = { collection, composer, title: movement ? `${title}, mvt ${movement}` : title, catalog, file: basename(f) };
    const melody = extractMelody(text);
    const mono = segment(melody, source);
    for (const p of mono) { p.bars = melody.bars; out.push(p); }
    for (const p of polyPhrases(mono, extractPoly(text), melody.bars, source)) polyOut.push(p);
  }
}
for (const p of out) {
  p.id = createHash('sha1').update(`${p.file}|${p.at}|${JSON.stringify(p.notes)}`).digest('hex').slice(0, 12);
  delete p.at;
  delete p.spanTicks;
  delete p.beatTicks;
  delete p.bars;
}
mkdirSync('corpus', { recursive: true });
writeFileSync('corpus/phrases.json', JSON.stringify(out));
writeFileSync('corpus/poly.json', JSON.stringify(polyOut));
const polyBy = {};
for (const p of polyOut) polyBy[p.kind] = (polyBy[p.kind] || 0) + 1;
console.log(`${polyOut.length} polyphonic phrases`, polyBy);
const by = {};
for (const p of out) by[p.composer] = (by[p.composer] || 0) + 1;
const meters = {};
for (const p of out) meters[`${p.meter}x${p.beatLen}`] = (meters[`${p.meter}x${p.beatLen}`] || 0) + 1;
console.log(`${out.length} phrases`, by, meters);
