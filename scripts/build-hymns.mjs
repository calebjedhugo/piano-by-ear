#!/usr/bin/env node
// Build corpus/hymns.json (a melodic phrase bank of hymn tunes) from the
// singHarmony2 song JSON files, in the SAME schema as corpus/phrases.json
// (see scripts/build-corpus.mjs).
//
//   node scripts/build-hymns.mjs
//
// SOURCE (read-only): ../singHarmony2/public/songs/*.json. Each file has
// {title, slug, timeSignature:[num,den], keySignature, pickupBeats,
// voices:[{id, notes:[{length, dotted?, pitch?, tie?}]}]}. Only the
// "soprano" voice (the melody) is used. Notes carry NO explicit rest flag:
// a note object with no `pitch` is a rest. Ties are `tie: "start" |
// "continue" | "stop"` across consecutive same-pitch notes and are merged
// into one sounding event. All timing is in NOTATED QUARTER-NOTE beats
// (length "1/4" = 1 quarter, "1/8" = half a quarter, dotted = x1.5); this
// is unrelated to the FELT beat computed below for x/8 meters.
//
// TIME: integer ticks, TPQ (ticks per quarter) = 16 -- exact for the
// sixteenth notes and dotted values actually used in this corpus (no
// triplets are present). Output offsets/durations are in FELT BEATS of the
// song's meter, exactly like build-corpus.mjs: quarter in x/4, the eighth
// or dotted-quarter in x/8 (`beatUnit`), half in x/2. `beatLen` gives that
// felt beat in quarters; `meter` is felt beats per bar.
//
// PHRASES: walk the soprano line; a phrase ends at the last bar line before
// it would exceed MAX_NOTES, at >=1 felt beat of rest, or right after a
// long note (>=2 felt beats) that closes a musical line (hymn tunes have no
// fermata markings, so a long note stands in for one) -- but only once the
// phrase already has MIN_NOTES, since hymn melodies routinely hold a half
// note on a strong beat mid-line and cutting there unconditionally shreds
// the tune into unusable 1-2 note scraps. Phrases under MIN_NOTES are
// dropped; phrases with an internal rest >= 1 felt beat are also dropped
// (PhraseBank would filter them anyway).

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SONGS_DIR = join(__dirname, '..', '..', 'singHarmony2', 'public', 'songs');

const TPQ = 16; // ticks per quarter note
const MIN_NOTES = 3;
const MAX_NOTES = 12;
const REST_BREAK_BEATS = 1; // felt beats of silence that end a phrase
const LONG_NOTE_BEATS = 2; // felt beats: a note this long closes a phrase

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Felt beat for a time signature: [beatLen in quarters, beats per bar]. (Same convention as build-corpus.mjs.) */
function beatUnit(num, den) {
  if (den === 8 && num % 3 === 0 && num > 3) return [1.5, num / 3];
  if (den === 8) return [0.5, num];
  if (den === 16) return [0.25, num];
  if (den === 2) return [2, num];
  if (den === 1) return [4, num];
  return [1, num];
}

/** "C" -> "C", "Bb" -> "B-", "F#" -> "F#" (build-corpus's key spelling: flats as "-"). */
function convertKey(key) {
  if (!key) return null;
  const m = key.match(/^([A-G])(#|b)?$/);
  if (!m) return key;
  const [, letter, acc] = m;
  if (acc === 'b') return `${letter}-`;
  return `${letter}${acc || ''}`;
}

/** "F#4" / "Bb2" / "C4" -> MIDI note number (C4 = 60). */
function parsePitch(pitch) {
  const m = pitch.match(/^([A-G])(#|b)?(-?\d+)$/);
  if (!m) return null;
  const [, letter, acc, oct] = m;
  let midi = 12 * (Number(oct) + 1) + STEP[letter];
  if (acc === '#') midi += 1;
  else if (acc === 'b') midi -= 1;
  return midi;
}

/** {length:"1/4", dotted?} -> ticks (integer; TPQ=16 is exact for every length/dotted combo seen). */
function lengthTicks(note) {
  const m = note.length.match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  let ticks = (4 * TPQ * num) / den;
  if (note.dotted) ticks *= 1.5;
  return Math.round(ticks);
}

/**
 * Soprano notes -> a flat list of sounding/rest events with absolute start
 * ticks, ties merged into single events (a "start" event absorbs the
 * duration of every following "continue"/"stop" of the same pitch).
 */
function extractEvents(voice, file) {
  const events = [];
  let pos = 0;
  let open = null;
  for (const n of voice.notes) {
    const ticks = lengthTicks(n);
    if (ticks === null) throw new Error(`${file}: unparseable length ${JSON.stringify(n)}`);
    if (n.pitch == null) {
      events.push({ rest: true, ticks, pos, midi: null });
      pos += ticks;
      open = null;
      continue;
    }
    const midi = parsePitch(n.pitch);
    if (midi === null) throw new Error(`${file}: unparseable pitch ${JSON.stringify(n)}`);
    if ((n.tie === 'continue' || n.tie === 'stop') && open && open.midi === midi) {
      open.ticks += ticks;
      pos += ticks;
      if (n.tie === 'stop') open = null;
      continue;
    }
    const ev = { rest: false, ticks, pos, midi };
    events.push(ev);
    pos += ticks;
    open = n.tie === 'start' ? ev : null;
  }
  return events;
}

/** 1-based bars: bar 1 is the (possibly short) pickup measure if pickupTicks > 0, else the first full bar. */
function buildBars(pickupTicks, barTicks, totalTicks) {
  const bars = [];
  let n = 1;
  let t = 0;
  if (pickupTicks > 0) {
    bars.push({ n, ticks: 0 });
    n += 1;
    t = pickupTicks;
  }
  while (t <= totalTicks) {
    bars.push({ n, ticks: t });
    n += 1;
    t += barTicks;
  }
  return bars;
}

function barAt(bars, ticks) {
  let at = null;
  for (const b of bars) {
    if (b.ticks <= ticks) at = b;
    else break;
  }
  return at || bars[0];
}
function barAfter(bars, ticks) {
  return bars.find((b) => b.ticks > ticks) || null;
}

function segmentSong(events, bars, beatLen, meter, source) {
  const beatTicks = beatLen * TPQ;
  const barTicks = meter * beatTicks;
  const phrases = [];
  let cur = [];
  let restRun = 0;

  const emit = (group) => {
    if (group.length < MIN_NOTES) return;
    // Safety net: no internal gap >= 1 felt beat (shouldn't occur by
    // construction -- REST_BREAK_BEATS already flushes before this -- but
    // PhraseBank would drop such a phrase anyway, so guard explicitly too).
    for (let i = 1; i < group.length; i += 1) {
      const gap = (group[i].pos - (group[i - 1].pos + group[i - 1].ticks)) / beatTicks;
      if (gap >= REST_BREAK_BEATS) return;
    }
    const first = group[0];
    const bar = barAt(bars, first.pos);
    const next = barAfter(bars, first.pos);
    let pickup;
    if (next) pickup = (barTicks - ((next.ticks - first.pos) % barTicks)) % barTicks;
    else pickup = (first.pos - bar.ticks) % barTicks;
    phrases.push({
      collection: 'hymns',
      composer: 'Hymn',
      title: source.title,
      catalog: source.slug,
      file: source.file,
      key: source.key,
      at: first.pos, // temporary, used for id then deleted
      bar: bar.n,
      meter,
      beatLen,
      pickup: pickup / beatTicks,
      notes: group.map((n) => [n.midi, (n.pos - first.pos) / beatTicks, n.ticks / beatTicks]),
    });
  };
  const flush = () => {
    emit(cur);
    cur = [];
  };

  for (const ev of events) {
    if (ev.rest) {
      restRun += ev.ticks / beatTicks;
      if (restRun >= REST_BREAK_BEATS) flush();
      continue;
    }
    restRun = 0;
    cur.push(ev);
    const durFelt = ev.ticks / beatTicks;
    // A long note only reads as ending a musical line if enough of a line
    // has actually accumulated -- hymn melodies routinely hold a half note
    // on a strong beat mid-phrase (e.g. the second syllable of "A-MAZ-ing"),
    // and cutting there unconditionally shreds the tune into unusable
    // 1-2 note scraps. If the group is still short, the long note is kept
    // as part of the phrase and cutting is deferred to the next boundary.
    if (durFelt >= LONG_NOTE_BEATS && cur.length >= MIN_NOTES) {
      flush();
      continue;
    }
    if (cur.length >= MAX_NOTES) {
      let cutAt = -1;
      for (let i = cur.length - 1; i >= MIN_NOTES; i -= 1) {
        if (bars.some((b) => b.ticks === cur[i].pos)) {
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

const out = [];
const failed = [];
const files = readdirSync(SONGS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
for (const f of files) {
  try {
    const song = JSON.parse(readFileSync(join(SONGS_DIR, f), 'utf8'));
    const soprano = song.voices.find((v) => v.id === 'soprano');
    if (!soprano) throw new Error('no soprano voice');
    const [num, den] = song.timeSignature;
    const [beatLen, meter] = beatUnit(num, den);
    const source = { title: song.title, slug: song.slug, file: f, key: convertKey(song.keySignature) };
    const events = extractEvents(soprano, f);
    const totalTicks = events.length ? events[events.length - 1].pos + events[events.length - 1].ticks : 0;
    const pickupTicks = Math.round((song.pickupBeats || 0) * TPQ);
    const barTicks = meter * beatLen * TPQ;
    const bars = buildBars(pickupTicks, barTicks, totalTicks);
    const phrases = segmentSong(events, bars, beatLen, meter, source);
    out.push(...phrases);
  } catch (err) {
    failed.push({ file: f, error: err.message });
  }
}

for (const p of out) {
  p.id = createHash('sha1').update(`${p.file}|${p.at}|${JSON.stringify(p.notes)}`).digest('hex').slice(0, 12);
  delete p.at;
}

mkdirSync(join(__dirname, '..', 'corpus'), { recursive: true });
writeFileSync(join(__dirname, '..', 'corpus', 'hymns.json'), JSON.stringify(out));

console.log(`${files.length} hymn files, ${failed.length} failed`);
if (failed.length) console.log(failed);
const meters = {};
for (const p of out) meters[`${p.meter}x${p.beatLen}`] = (meters[`${p.meter}x${p.beatLen}`] || 0) + 1;
console.log(`${out.length} phrases`, meters);
