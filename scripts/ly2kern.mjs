#!/usr/bin/env node
// Mutopia LilyPond sources -> three-voice Humdrum **kern, for build-corpus.mjs.
//
//   node scripts/ly2kern.mjs <ly-dir> <kern-out-dir>
//
// THE SHAREABLE TRIO RUNG (2026-10-10). The three-voice excerpts the drill
// had came from a source that may not be redistributed (corpus/local/), so
// nobody else got the rung. These are Bach's three-voice works as typed up at
// the Mutopia Project, every one marked public domain by its typesetter (see
// SOURCES): each keeps its three voices as three separate parts, the
// one-voice-per-spine shape the trio rung needs. Typesetters who wrote the
// voices inside each staff instead (<< { } \\ { } >> as they come and go) are
// left out: there is no continuous voice to follow.
//
// THIS READS THE TEXT; IT NEVER RUNS LILYPOND. A .ly file can carry Scheme
// that executes at compile time, so the notes are parsed here instead, from
// the subset these files use: \relative and absolute pitches (pitched rests
// count as the relative reference, as `d'\rest f,` in BWV 795 shows), Dutch,
// Italian and German note names, durations with dots, ties, chords, rests
// (r, R, \skip), grace notes (dropped, as build-corpus drops kern graces), the
// file's own shorthand definitions (expanded), and layout commands (skipped).
// Anything else stops the conversion loudly rather than guessing. Every file
// is checked note for note against the MIDI Mutopia publishes beside it:
// scripts/check-ly2kern.mjs.
//
// Spines run lowest voice first (by mean pitch), the kern convention
// build-corpus.mjs reads: voice 0 is the bass and the rightmost spine is the
// melody. Notes that cross a bar line are split and tied; durations kern
// cannot write in one token are split and tied too.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const WHOLE = 3840; // ticks per whole note: exact for dotted 64ths
const SEMIS = [0, 2, 4, 5, 7, 9, 11];
const LETTERS = 'cdefgab';

// Which parts are the three voices, per file. A file not listed must use the
// Sinfonias' layout. `movements` splits a multi-movement file into one kern
// file each (suffix -1, -2, ...).
const SINFONIA = { voices: ['melone', 'meltwo', 'melthree'] };
const SOURCES = {
  'bwv848b.ly': { title: 'Das Wohltemperierte Clavier I, Fuga III', catalog: 'BWV 848', voices: ['soprano', 'alto', 'bass'] },
  'bwv853b.ly': { title: 'Das Wohltemperierte Clavier I, Fuga VIII', catalog: 'BWV 853', voices: ['soprano', 'tenor', 'bass'] },
  'wtk2fuga1.ly': { title: 'Das Wohltemperierte Clavier II, Fuga I', catalog: 'BWV 870', voices: ['dux', 'comes', 'bassdux'] },
  'bwv529.ly': {
    title: 'Trio Sonata V', catalog: 'BWV 529',
    movements: [
      { mvt: 1, voices: ['rightOne', 'leftOne', 'pedalOne'] },
      { mvt: 2, voices: ['rightTwo', 'leftTwo', 'pedalTwo'] },
      { mvt: 3, voices: ['rightThree', 'leftThree', 'pedalThree'] },
    ],
  },
};

// ---------- note names ----------
const LANGS = {
  // name -> [step, alter]
  nederlands: () => {
    const m = {};
    for (let s = 0; s < 7; s += 1) {
      const l = LETTERS[s];
      m[l] = [s, 0];
      m[`${l}is`] = [s, 1]; m[`${l}isis`] = [s, 2];
      m[`${l}es`] = [s, -1]; m[`${l}eses`] = [s, -2];
    }
    Object.assign(m, { as: [5, -1], ases: [5, -2], es: [2, -1], eses: [2, -2] });
    return m;
  },
  italiano: () => {
    const m = {};
    ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'].forEach((n, s) => {
      Object.assign(m, { [n]: [s, 0], [`${n}d`]: [s, 1], [`${n}dd`]: [s, 2], [`${n}b`]: [s, -1], [`${n}bb`]: [s, -2] });
    });
    return m;
  },
  deutsch: () => {
    const m = {};
    for (const [l, s] of [['c', 0], ['d', 1], ['e', 2], ['f', 3], ['g', 4], ['a', 5], ['h', 6]]) {
      m[l] = [s, 0]; m[`${l}is`] = [s, 1]; m[`${l}isis`] = [s, 2];
      if (!['e', 'a'].includes(l)) { m[`${l}es`] = [s, -1]; m[`${l}eses`] = [s, -2]; }
    }
    Object.assign(m, { es: [2, -1], eses: [2, -2], as: [5, -1], ases: [5, -2], b: [6, -1], heses: [6, -2] });
    return m;
  },
};

function language(src) {
  const inc = src.match(/\\include\s+"(italiano|deutsch|nederlands)\.ly"/);
  const lang = src.match(/\\language\s+"(italiano|deutsch|nederlands)"/);
  return (inc?.[1] || lang?.[1] || 'nederlands');
}

// ---------- tokens ----------
function stripComments(s) {
  return s.replace(/%\{[\s\S]*?%\}/g, ' ').replace(/%[^\n]*/g, ' ');
}
/** Scheme values (#(...), #'(...), ##t, #"x", #-0.5) become one opaque token. */
function hideScheme(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '#') { out += s[i]; continue; }
    let j = i + 1;
    while (s[j] === ' ' || s[j] === '\t') j += 1; // `# 1` (BWV 796's beam shorthand)
    while (s[j] === '#' || s[j] === "'" || s[j] === '`') j += 1;
    if (s[j] === '(') {
      let depth = 0;
      do { if (s[j] === '(') depth += 1; else if (s[j] === ')') depth -= 1; j += 1; } while (depth > 0 && j < s.length);
    } else if (s[j] === '"') {
      j += 1;
      while (j < s.length && s[j] !== '"') j += 1;
      j += 1;
    } else while (j < s.length && !/[\s{}<>]/.test(s[j])) j += 1;
    out += ' #SCHEME ';
    i = j - 1;
  }
  return out;
}
function tokenize(s) {
  return s.match(/\\[a-zA-Z]+|"[^"]*"|#SCHEME|<<|>>|>\d*\.*|[{}<]|[_^-]?~|[a-zA-Z]+[',]*[!?]*(?:\d+\.*)?(?:\*\d+(?:\/\d+)?)?|\d+\.*|\S/g) || [];
}

/** Top-level `name = ...` definitions: name -> tokens. */
function definitions(src) {
  const defs = {};
  const re = /(^|\n)([A-Za-z]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let body;
    if (src[i] === '{' || src.startsWith('\\relative', i) || src.startsWith('\\context', i)) {
      const open = src.indexOf('{', i);
      let depth = 1;
      let j = open + 1;
      while (depth > 0 && j < src.length) { if (src[j] === '{') depth += 1; else if (src[j] === '}') depth -= 1; j += 1; }
      body = src.slice(i, j);
      i = j;
    } else {
      const end = src.indexOf('\n', i);
      body = src.slice(i, end < 0 ? src.length : end);
    }
    defs[m[2]] = tokenize(body);
  }
  return defs;
}

const SKIP_ARGS = { clef: 1, bar: 1, accidentalStyle: 1, tempo: 0, change: 3, context: 3, new: 1, autoBeamOff: 0, autoBeamOn: 0 };
const NO_ARG = new Set(['stemUp', 'stemDown', 'stemNeutral', 'break', 'pageBreak', 'noBreak', 'fermata', 'prall', 'prallprall',
  'lineprall', 'trill', 'mordent', 'prallmordent', 'turn', 'reverseturn', 'staccato', 'staccatissimo', 'tenuto', 'accent',
  'slurDown', 'slurUp', 'slurNeutral', 'slurDashed', 'slurSolid', 'tieUp', 'tieDown', 'tieNeutral', 'cadenzaOn', 'cadenzaOff',
  'voiceOne', 'voiceTwo', 'voiceThree', 'voiceFour', 'oneVoice', 'once', 'arpeggio', 'upprall', 'downprall', 'shiftOn', 'shiftOff',
  'dynamicUp', 'dynamicDown', 'phrasingSlurUp', 'phrasingSlurDown', 'p', 'f', 'mf', 'mp', 'pp', 'ff', 'cresc', 'decresc', 'dim',
  'stopped', 'flageolet', 'portato', 'marcato', 'segno', 'coda', 'breathe', 'harmonic', 'startTrillSpan', 'stopTrillSpan']);

/**
 * One voice -> { events, end, time, key }. Events are
 * { start, dur, rest, notes: [{ midi, step, octave, alter }], tieOut, fermata }
 * in ticks; ties stay as written (tieOut on the earlier event).
 */
function parseVoice(tokensIn, defs, names, label) {
  const toks = [...tokensIn];
  let relative = null; // { step, octave } while in \relative, else null (absolute)
  let now = 0;
  let dur = WHOLE / 4;
  let time = null;
  let key = null;
  let graceSkip = 0; // 1 while the next music item is a grace note/group
  const events = [];
  const last = () => events[events.length - 1];
  const nameRe = new RegExp(`^(${Object.keys(names).sort((a, b) => b.length - a.length).join('|')})([',]*)([!?]*)(?:(\\d+)(\\.*))?$`);
  const durOf = (digits, dots) => {
    let t = WHOLE / Number(digits);
    let add = t;
    for (let i = 0; i < dots; i += 1) { add /= 2; t += add; }
    if (!Number.isInteger(t)) throw new Error(`${label}: duration ${digits} is not a whole tick`);
    return t;
  };
  const marks = (s) => (s.match(/'/g) || []).length - (s.match(/,/g) || []).length;
  const pitch = (name, octMarks, ref) => {
    const [step, alter] = names[name];
    let octave;
    if (ref) {
      octave = ref.octave;
      let d = step + 7 * octave - (ref.step + 7 * ref.octave);
      while (d > 3) { octave -= 1; d -= 7; }
      while (d < -3) { octave += 1; d += 7; }
      octave += marks(octMarks);
    } else octave = marks(octMarks); // absolute: `c` is C3
    return { step, alter, octave, midi: 48 + 12 * octave + SEMIS[step] + alter };
  };
  // Grace music is skipped whole: one note token, or one { } / < > group.
  const skipItem = (i) => {
    const t = toks[i];
    if (t === '{' || t === '<') {
      const [open, close] = t === '{' ? ['{', '}'] : ['<', '>'];
      let depth = 0;
      let j = i;
      do {
        if (toks[j] === open) depth += 1;
        else if (toks[j] === close || (close === '>' && /^>\d*\.*$/.test(toks[j]))) depth -= 1;
        j += 1;
      } while (depth > 0 && j < toks.length);
      return j - 1;
    }
    return i;
  };
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.startsWith('\\')) {
      const cmd = t.slice(1);
      if (defs[cmd]) { toks.splice(i + 1, 0, ...defs[cmd]); continue; } // the file's own shorthand
      if (cmd === 'relative') {
        const m = toks[i + 1]?.match(nameRe);
        if (!m) throw new Error(`${label}: \\relative without a pitch`);
        relative = pitch(m[1], m[2], null);
        i += 1;
        continue;
      }
      if (cmd === 'rest') {
        const e = last();
        if (!e || e.rest) throw new Error(`${label}: \\rest without a pitched note before it`);
        e.rest = true; // the pitch still served as the relative reference
        continue;
      }
      if (cmd === 'time') { const m = toks[i + 1].match(/^(\d+)\/(\d+)$/) || `${toks[i + 1]}`.match(/^(\d+)$/); time = time || `${toks[i + 1]}${toks[i + 2] === '/' ? `/${toks[i + 3]}` : ''}`; i += toks[i + 2] === '/' ? 3 : 1; continue; }
      if (cmd === 'key') {
        const m = toks[i + 1].match(nameRe);
        if (!m) throw new Error(`${label}: unreadable \\key ${toks[i + 1]}`);
        key = key || { step: names[m[1]][0], alter: names[m[1]][1], mode: toks[i + 2].slice(1) };
        i += 2;
        continue;
      }
      if (cmd === 'override' || cmd === 'set' || cmd === 'revert' || cmd === 'unset') {
        if (cmd === 'revert' || cmd === 'unset') { i += 1; continue; }
        while (i + 1 < toks.length && toks[i + 1] !== '=') i += 1;
        i += 2; // '=' and its value
        continue;
      }
      if (cmd === 'markup') { i = skipItem(i + 1); continue; }
      if (cmd === 'skip') {
        const m = toks[i + 1]?.match(/^(\d+)(\.*)$/);
        if (!m) throw new Error(`${label}: \\skip without a duration`);
        dur = durOf(m[1], m[2].length);
        now += dur;
        i += 1;
        continue;
      }
      if (cmd === 'grace' || cmd === 'appoggiatura' || cmd === 'acciaccatura' || cmd === 'slashedGrace') { i = skipItem(i + 1); continue; }
      if (cmd === 'partial') throw new Error(`${label}: \\partial is not handled`);
      if (cmd in SKIP_ARGS) { i += SKIP_ARGS[cmd]; continue; }
      if (NO_ARG.has(cmd)) { if (cmd === 'fermata' && last()) last().fermata = true; continue; }
      throw new Error(`${label}: unhandled command ${t} (after: ${toks.slice(Math.max(0, i - 6), i).join(' ')})`);
    }
    if (/^[_^-]?~$/.test(t)) {
      const e = last();
      if (!e || e.rest) throw new Error(`${label}: tie after a rest`);
      e.tieOut = true;
      continue;
    }
    if (t === '<<' || t === '>>') throw new Error(`${label}: simultaneous music inside a voice`);
    if (t === '<') {
      // a chord: each note relative to the one before it in the chord; the
      // chord's first note is the reference afterwards.
      const notes = [];
      let ref = relative;
      let j = i + 1;
      for (; j < toks.length && !/^>\d*\.*$/.test(toks[j]); j += 1) {
        if (toks[j].startsWith('\\') || /^[-_^~]/.test(toks[j]) || toks[j] === '#SCHEME') continue;
        const m = toks[j].match(nameRe);
        if (!m) throw new Error(`${label}: cannot read "${toks[j]}" in a chord`);
        const p = pitch(m[1], m[2], ref);
        if (relative) ref = { step: p.step, octave: p.octave };
        notes.push(p);
      }
      const dm = toks[j].match(/^>(\d+)(\.*)$/);
      if (dm) dur = durOf(dm[1], dm[2].length);
      if (relative && notes.length) relative = { step: notes[0].step, octave: notes[0].octave };
      events.push({ start: now, dur, rest: false, notes });
      now += dur;
      i = j;
      continue;
    }
    if (t === '{' || t === '}' || /^[()[\]|^_.\->!]$/.test(t) || t === '#SCHEME' || t.startsWith('"') || t === '\\\\') continue;
    // `ees 4`: a duration standing apart belongs to the note before it,
    // when that note had none of its own (BWV 791 has one).
    const loose = t.match(/^(\d+)(\.*)$/);
    if (loose && i > 0 && last() && !/\d/.test(toks[i - 1]) && (nameRe.test(toks[i - 1]) || /^[rRs]$/.test(toks[i - 1]))) {
      const e = last();
      now -= e.dur;
      dur = durOf(loose[1], loose[2].length);
      e.dur = dur;
      now += dur;
      continue;
    }
    const rest = t.match(/^([rRs])(?:(\d+)(\.*))?(?:\*(\d+)(?:\/(\d+))?)?$/);
    if (rest) {
      if (rest[2]) dur = durOf(rest[2], rest[3].length);
      const mult = rest[4] ? Number(rest[4]) / Number(rest[5] || 1) : 1;
      events.push({ start: now, dur: dur * mult, rest: true });
      now += dur * mult;
      continue;
    }
    const m = t.match(nameRe);
    if (!m) throw new Error(`${label}: cannot read "${t}" (after: ${toks.slice(Math.max(0, i - 6), i).join(' ')})`);
    if (m[4]) dur = durOf(m[4], m[5].length);
    const p = pitch(m[1], m[2], relative);
    if (relative) relative = { step: p.step, octave: p.octave };
    events.push({ start: now, dur, rest: false, notes: [p] });
    now += dur;
  }
  return { events, end: now, time, key };
}

// ---------- kern writing ----------
const RECIPS = [];
for (const n of [1, 2, 4, 8, 16, 32, 64]) {
  for (let dots = 0; dots <= 2; dots += 1) {
    let t = WHOLE / n;
    let add = t;
    for (let i = 0; i < dots; i += 1) { add /= 2; t += add; }
    RECIPS.push({ ticks: t, text: `${n}${'.'.repeat(dots)}` });
  }
}
RECIPS.sort((a, b) => b.ticks - a.ticks);
function recipParts(ticks) {
  const out = [];
  let left = ticks;
  while (left > 0) {
    const r = RECIPS.find((x) => x.ticks <= left);
    if (!r) throw new Error(`cannot write ${ticks} ticks in kern`);
    out.push(r);
    left -= r.ticks;
  }
  return out;
}

function kernPitch(n) {
  const letter = LETTERS[n.step];
  const sci = n.octave + 3; // scientific octave: lily `c` = C3
  const name = sci >= 4 ? letter.repeat(sci - 3) : letter.toUpperCase().repeat(4 - sci);
  return name + (n.alter > 0 ? '#'.repeat(n.alter) : '-'.repeat(-n.alter));
}
function kernKey({ step, alter, mode }) {
  const letter = LETTERS[step];
  const acc = alter > 0 ? '#'.repeat(alter) : '-'.repeat(-alter);
  return `*${mode === 'minor' ? letter : letter.toUpperCase()}${acc}:`;
}

/** A voice's events, gaps filled with rests, cut so nothing crosses a bar line. */
function pieces(events, total, barTicks) {
  const filled = [];
  let at = 0;
  for (const e of events) {
    if (e.start > at) filled.push({ start: at, dur: e.start - at, rest: true });
    filled.push(e);
    at = Math.max(at, e.start + e.dur);
  }
  if (total > at) filled.push({ start: at, dur: total - at, rest: true });
  // A tie only joins the same pitches. BWV 797 bar 62 ties the bass D into a
  // pitched rest; that tie is dropped (the rest is silence).
  const same = (a, b) => a.notes.length === b.notes.length && a.notes.every((n, k) => n.midi === b.notes[k].midi);
  const joins = (a, b) => Boolean(a && b && a.tieOut && !a.rest && !b.rest && same(a, b) && b.start === a.start + a.dur);
  filled.forEach((e, k) => { if (e.tieOut && !joins(e, filled[k + 1])) e.tieOut = false; });
  const out = [];
  for (let k = 0; k < filled.length; k += 1) {
    const e = filled[k];
    const tiedIn = k > 0 && joins(filled[k - 1], e);
    let s = e.start;
    const end = e.start + e.dur;
    const segs = [];
    while (s < end) {
      const segEnd = Math.min(end, (Math.floor(s / barTicks) + 1) * barTicks);
      for (const r of recipParts(segEnd - s)) {
        segs.push({ ...e, start: s, dur: r.ticks, recip: r.text });
        s += r.ticks;
      }
    }
    segs.forEach((seg, j) => {
      if (seg.rest) return;
      const into = j > 0 || tiedIn;
      const onward = j < segs.length - 1 || e.tieOut;
      seg.tie = into && onward ? '_' : into ? ']' : onward ? '[' : '';
      seg.fermata = Boolean(e.fermata) && j === segs.length - 1;
    });
    out.push(...segs);
  }
  return out;
}
function token(seg) {
  if (seg.rest) return `${seg.recip}r`;
  const open = seg.tie === '[' ? '[' : '';
  const close = seg.tie === ']' || seg.tie === '_' ? seg.tie : '';
  return seg.notes.map((n) => `${open}${seg.recip}${kernPitch(n)}${close}${seg.fermata ? ';' : ''}`).join(' ');
}

function writeKern({ voices, time, key, composer, title, catalog, maintainer, licence }) {
  const [num, den] = time.split('/').map(Number);
  const barTicks = (WHOLE * num) / den;
  // lowest voice first, by mean pitch
  const mean = (v) => { const ms = v.events.flatMap((e) => (e.rest ? [] : e.notes.map((n) => n.midi))); return ms.reduce((a, b) => a + b, 0) / ms.length; };
  const ordered = [...voices].sort((a, b) => mean(a) - mean(b));
  const total = Math.max(...ordered.map((v) => v.end));
  const segsBy = ordered.map((v) => pieces(v.events, total, barTicks));
  const starts = [...new Set(segsBy.flatMap((s) => s.map((x) => x.start)))].sort((a, b) => a - b);
  const at = segsBy.map((s) => new Map(s.map((x) => [x.start, x])));
  const all = (t) => [t, t, t].join('\t');
  const parts = composer.split(' ');
  const lines = [
    `!!!COM: ${parts.slice(-1)[0]}, ${parts.slice(0, -1).join(' ')}`,
    `!!!OTL: ${title}`,
    `!!!SCT: ${catalog}`,
    `!!!ONB: Encoded from the Mutopia Project edition typeset by ${maintainer} (${licence}); converted by scripts/ly2kern.mjs.`,
    all('**kern'),
    all(kernKey(key)),
    all(`*M${num}/${den}`),
    all('=1-'),
  ];
  let bar = 1;
  for (const t of starts) {
    while (t >= bar * barTicks && t < total) { bar += 1; lines.push(all(`=${bar}`)); }
    lines.push(at.map((m) => (m.has(t) ? token(m.get(t)) : '.')).join('\t'));
  }
  lines.push(all('=='), all('*-'));
  return { kern: `${lines.join('\n')}\n`, bars: bar, notes: ordered.map((v) => v.events.filter((e) => !e.rest).length) };
}

function convert(file) {
  const raw = readFileSync(file, 'utf8');
  const src = hideScheme(stripComments(raw));
  const name = basename(file);
  const cfg = SOURCES[name] || SINFONIA;
  const names = LANGS[language(src)]();
  const defs = definitions(src);
  const header = (k) => raw.match(new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`))?.[1] ?? '';
  const licence = header('license') || header('copyright');
  if (!/public domain/i.test(licence)) throw new Error(`${name}: licence is "${licence}", not public domain`);
  const scoreTime = src.match(/\\time\s+(\d+\/\d+)/)?.[1];
  const scoreKey = src.match(/\\key\s+([a-z]+)\s*\\(major|minor)/);
  const movements = cfg.movements || [{ voices: cfg.voices }];
  return movements.map((mv) => {
    const voices = mv.voices.map((v) => {
      if (!defs[v]) throw new Error(`${name}: no part named ${v}`);
      return parseVoice(defs[v], defs, names, `${name} ${v}`);
    });
    const time = voices.find((v) => v.time)?.time || scoreTime;
    let key = voices.find((v) => v.key)?.key;
    if (!key && scoreKey) key = { step: names[scoreKey[1]][0], alter: names[scoreKey[1]][1], mode: scoreKey[2] };
    if (!key && !/\\key\b/.test(src)) key = { step: 0, alter: 0, mode: 'major' }; // no \key at all: C major (BWV 870)
    if (!time || !key) throw new Error(`${name}: no \\time or \\key found`);
    const title = cfg.title ? `${cfg.title}${mv.mvt ? `, mvt ${mv.mvt}` : ''}` : header('title');
    const out = writeKern({
      voices, time, key, composer: header('composer'), title, catalog: cfg.catalog || header('opus'),
      maintainer: header('maintainer'), licence,
    });
    return { ...out, file: name.replace(/\.ly$/, mv.mvt ? `-${mv.mvt}.krn` : '.krn') };
  });
}

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error('usage: node scripts/ly2kern.mjs <ly-dir> <kern-out-dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(inDir).filter((x) => x.endsWith('.ly')).sort()) {
  for (const { kern, notes, bars, file } of convert(join(inDir, f))) {
    writeFileSync(join(outDir, file), kern);
    console.log(`${file}: ${bars} bars, notes by voice (low to high) ${notes.join('/')}`);
  }
}
