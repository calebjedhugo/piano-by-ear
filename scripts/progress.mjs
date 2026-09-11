#!/usr/bin/env node
// Read-only progress report over one piano-by-ear profile database.
//
// The research behind this report: in-session gains are performance, not
// learning. Progress is judged only on NEXT-DAY FIRST ATTEMPTS, so every
// section below groups by local calendar day and, where it matters, by the
// first time something was seen that day.
//
// Never writes: opens with node:sqlite's `readOnly` option when the
// installed Node supports it, and issues no INSERT/UPDATE/DDL regardless.
//
// Usage: node scripts/progress.mjs [--db <path>] [--days N]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------- args & db path ----------
function parseArgs(argv) {
  const out = { db: null, days: 14 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--days') out.days = Number(argv[++i]);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

function defaultDbPath() {
  const userFile = join(homedir(), '.piano-by-ear', 'current-user');
  let name = 'Caleb';
  if (existsSync(userFile)) {
    const s = readFileSync(userFile, 'utf8').trim();
    if (s) name = s;
  }
  return join(homedir(), '.piano-by-ear', 'profiles', `${name}.db`);
}
const dbPath = args.db || defaultDbPath();

function openReadOnly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    // Older node:sqlite builds may not know the `readOnly` option. Fall
    // back to a plain open -- this script never issues a write regardless.
    if (/unknown option|readonly/i.test(err?.message || '')) return new DatabaseSync(path);
    throw err;
  }
}
const db = openReadOnly(dbPath);

// ---------- schema guards ----------
const tableInfoCache = new Map();
function tableColumns(table) {
  if (!tableInfoCache.has(table)) {
    tableInfoCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)));
  }
  return tableInfoCache.get(table);
}
const hasColumn = (table, name) => tableColumns(table).has(name);
const hasTable = (name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
const col = (table, name) => (hasColumn(table, name) ? name : `NULL AS ${name}`);

// ---------- utilities ----------
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function windowStartMs(days) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const pct = (x) => (x === null || Number.isNaN(x) ? '--' : `${(x * 100).toFixed(0)}%`);
const num = (x, d = 2) => (x === null || Number.isNaN(x) ? '--' : x.toFixed(d));
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
// Stage's judgment of a note overrides raw pitch-correctness when present.
const effCorrect = (r) => (r.credit !== null && r.credit !== undefined ? r.credit : r.correct);

function printTable(title, header, rows) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log('(no data)');
    return;
  }
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

const cutoff = windowStartMs(args.days);

// ================= 1. Isolated intervals =================
function section1() {
  console.log('\n=== 1. Isolated intervals (first attempt of the day per signed interval) ===');
  const rows = db.prepare(`
    SELECT ts, anchor, target, played, velocity, correct, ${col('attempts', 'credit')}
    FROM attempts
    WHERE kind IN ('interval','discrimination','remediation') AND graded = 1 AND ts >= ?
    ORDER BY ts ASC`).all(cutoff);

  const seen = new Set();
  const firstOfDay = [];
  for (const r of rows) {
    const day = localDay(r.ts);
    const signedInterval = r.target - r.anchor;
    const key = `${day}|${signedInterval}`;
    if (seen.has(key)) continue;
    seen.add(key);
    firstOfDay.push({ day, signedInterval, correct: effCorrect(r), velocity: r.velocity, playedInterval: r.played - r.anchor });
  }

  console.log(`Overall accuracy: ${pct(mean(firstOfDay.map((r) => r.correct)))} (n=${firstOfDay.length})`);

  const byInterval = new Map();
  for (const r of firstOfDay) {
    if (!byInterval.has(r.signedInterval)) byInterval.set(r.signedInterval, []);
    byInterval.get(r.signedInterval).push(r);
  }
  const confRows = [];
  for (const [interval, list] of [...byInterval.entries()].sort((a, b) => a[0] - b[0])) {
    const misses = list.filter((r) => !r.correct);
    if (misses.length < 3) continue;
    const withNote = misses.filter((m) => m.velocity > 0);
    if (withNote.length) {
      const counts = new Map();
      for (const m of withNote) counts.set(m.playedInterval, (counts.get(m.playedInterval) || 0) + 1);
      const [topInterval, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      confRows.push([signed(interval), misses.length, signed(topInterval), topCount]);
    } else {
      confRows.push([signed(interval), misses.length, 'no note played', misses.length]);
    }
  }
  printTable('Paired confusions (asked interval with >=3 misses)', ['interval', 'misses', 'top wrong', 'count'], confRows);

  const pairs = [['+5/+7', [5, 7]], ['-5/-7', [-5, -7]], ['+8/+9', [8, 9]], ['-8/-9', [-8, -9]]];
  const days = [...new Set(firstOfDay.map((r) => r.day))].sort();
  const pairRows = days.map((day) => [
    day,
    ...pairs.map(([, set]) => {
      const xs = firstOfDay.filter((r) => r.day === day && set.includes(r.signedInterval)).map((r) => r.correct);
      return xs.length ? pct(mean(xs)) : '--';
    }),
  ]);
  printTable('Known pairs, day-by-day first-attempt accuracy', ['day', ...pairs.map((p) => p[0])], pairRows);
}

// ================= 2. Passages =================
function section2() {
  console.log('\n=== 2. Passages (first encounter of each phrase per day) ===');
  const rows = db.prepare(`
    SELECT ts, phrase_id, notes, exact, intervals, direction, near, ${col('passages', 'pitch_clean')}
    FROM passages WHERE qkind = 'passage' ORDER BY ts ASC`).all();

  const rungScore = (r) => {
    const pitch = r.notes > 0 ? r.exact / r.notes : 0;
    const shape = r.intervals > 0 ? 0.5 * (r.near / r.intervals) + 0.25 * (r.direction / r.intervals) : 0;
    return pitch + shape;
  };
  const pitchClean = (r) => (r.pitch_clean !== null && r.pitch_clean !== undefined ? r.pitch_clean : (r.exact === r.notes ? 1 : 0));

  const perPhraseDay = new Map(); // phrase_id -> Map(day -> first row that day, over ALL history)
  for (const r of rows) {
    const day = localDay(r.ts);
    if (!perPhraseDay.has(r.phrase_id)) perPhraseDay.set(r.phrase_id, new Map());
    const m = perPhraseDay.get(r.phrase_id);
    if (!m.has(day)) m.set(day, r);
  }

  const byDay = new Map();
  const savingsByDay = new Map();
  for (const dayMap of perPhraseDay.values()) {
    const days = [...dayMap.keys()].sort();
    const baseDay = days[0];
    const baseScore = rungScore(dayMap.get(baseDay));
    for (const day of days) {
      const r = dayMap.get(day);
      if (r.ts < cutoff) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
      if (day !== baseDay) {
        if (!savingsByDay.has(day)) savingsByDay.set(day, []);
        savingsByDay.get(day).push(rungScore(r) - baseScore);
      }
    }
  }

  const days = [...byDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = byDay.get(day);
    return [day, list.length, pct(mean(list.map(pitchClean))), num(mean(list.map(rungScore))), num(mean(list.map((r) => r.notes)), 1)];
  });
  printTable('Passages by day', ['day', 'n', 'pitch-clean', 'mean rung', 'mean len'], rowsOut);

  const savingsDays = [...savingsByDay.keys()].sort();
  const savingsRows = savingsDays.map((day) => [day, num(mean(savingsByDay.get(day))), savingsByDay.get(day).length]);
  printTable('Savings on re-encounter (later-day score - own first-day score)', ['day', 'mean savings', 'n'], savingsRows);
}

// ================= 3. Retry loop =================
function section3() {
  console.log('\n=== 3. Retry loop ===');
  const rows = db.prepare(`
    SELECT session_id, phrase_id, ts, clean FROM passages
    WHERE qkind = 'retry' AND ts >= ? ORDER BY ts ASC`).all(cutoff);

  const perDay = new Map();
  const lastOfGroup = new Map(); // session_id|phrase_id -> last retry row (rows arrive in ts order)
  for (const r of rows) {
    const day = localDay(r.ts);
    if (!perDay.has(day)) perDay.set(day, { retries: 0, nailed: 0 });
    const d = perDay.get(day);
    d.retries += 1;
    if (r.clean) d.nailed += 1;
    lastOfGroup.set(`${r.session_id}|${r.phrase_id}`, r);
  }
  const restedByDay = new Map();
  for (const last of lastOfGroup.values()) {
    if (!last.clean) {
      const day = localDay(last.ts);
      restedByDay.set(day, (restedByDay.get(day) || 0) + 1);
    }
  }

  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const d = perDay.get(day);
    return [day, d.retries, d.nailed, restedByDay.get(day) || 0];
  });
  printTable('Retries by day', ['day', 'retries', 'nailed', 'rested'], rowsOut);

  if (!hasTable('judgments')) {
    console.log('\n(judgments table not present yet)');
    return;
  }
  const jrows = db.prepare('SELECT ts, guessed, hit FROM judgments WHERE ts >= ? ORDER BY ts ASC').all(cutoff);
  const perJDay = new Map();
  for (const r of jrows) {
    const day = localDay(r.ts);
    if (!perJDay.has(day)) perJDay.set(day, []);
    perJDay.get(day).push(r);
  }
  const jdays = [...perJDay.keys()].sort();
  const jRowsOut = jdays.map((day) => {
    const list = perJDay.get(day);
    const guessedRows = list.filter((r) => r.guessed);
    return [day, pct(mean(list.map((r) => r.guessed))), guessedRows.length ? pct(mean(guessedRows.map((r) => r.hit))) : '--'];
  });
  printTable('Judgments by day', ['day', 'guessed rate', 'hit rate'], jRowsOut);
}

// ================= 4. Timing =================
function section4() {
  console.log('\n=== 4. Timing ===');
  const rows = db.prepare(`
    SELECT ts, correct, onset_ms, in_time, dur_ok, ${col('attempts', 'credit')}
    FROM attempts WHERE graded = 1 AND ts >= ? ORDER BY ts ASC`).all(cutoff);
  const perDay = new Map();
  for (const r of rows) {
    const day = localDay(r.ts);
    if (!perDay.has(day)) perDay.set(day, []);
    perDay.get(day).push(r);
  }
  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    const onsets = list.filter((r) => effCorrect(r) && r.onset_ms !== null).map((r) => r.onset_ms);
    const timed = list.filter((r) => r.in_time !== null);
    const defects = list.filter((r) => r.dur_ok === 0).length;
    return [day, num(median(onsets), 0), timed.length ? pct(mean(timed.map((r) => r.in_time))) : '--', defects];
  });
  printTable('Timing by day', ['day', 'median onset ms', 'in-time rate', 'hold defects'], rowsOut);
}

// ================= 5. Stage =================
function section5() {
  console.log('\n=== 5. Stage ===');
  if (!hasColumn('attempts', 'stage')) {
    console.log('(stage column not present in this database yet)');
    return;
  }
  const rows = db.prepare(`
    SELECT ts, anchor, target, played, stage FROM attempts
    WHERE graded = 1 AND stage IS NOT NULL AND ts >= ? ORDER BY ts ASC`).all(cutoff);
  const perDay = new Map();
  for (const r of rows) {
    const day = localDay(r.ts);
    if (!perDay.has(day)) perDay.set(day, []);
    perDay.get(day).push(r);
  }
  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    const lastStage = list[list.length - 1].stage;
    const dirRight = mean(list.map((r) => (Math.sign(r.played - r.anchor) === Math.sign(r.target - r.anchor) ? 1 : 0)));
    const within2 = mean(list.map((r) => (Math.abs(r.played - r.target) <= 2 ? 1 : 0)));
    return [day, lastStage, pct(dirRight), pct(within2)];
  });
  printTable('Stage by day', ['day', 'last stage', 'direction-right', 'within 2 semitones'], rowsOut);
}

// ================= 6. Session shape =================
function section6() {
  console.log('\n=== 6. Session shape ===');
  const rows = db.prepare('SELECT started_at, ended_at, questions FROM sessions WHERE started_at >= ? ORDER BY started_at ASC').all(cutoff);
  const perDay = new Map();
  for (const r of rows) {
    const day = localDay(r.started_at);
    if (!perDay.has(day)) perDay.set(day, []);
    perDay.get(day).push(r);
  }
  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    const mins = list.filter((r) => r.ended_at).map((r) => (r.ended_at - r.started_at) / 60000);
    const totalMin = mins.reduce((a, b) => a + b, 0);
    return [day, list.length, list.reduce((a, r) => a + (r.questions || 0), 0), num(totalMin, 1), mins.length ? num(Math.max(...mins), 1) : '--'];
  });
  printTable('Sessions by day', ['day', 'sessions', 'questions', 'total min', 'longest min'], rowsOut);
}

console.log('piano-by-ear progress report');
console.log(`db: ${dbPath}`);
console.log(`window: last ${args.days} day(s), local calendar days`);
section1();
section2();
section3();
section4();
section5();
section6();
db.close();
