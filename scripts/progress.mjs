#!/usr/bin/env node
// Read-only progress report over one piano-by-ear profile database.
//
// The research behind this report: in-session gains are performance, not
// learning. Progress is judged only on NEXT-DAY FIRST ATTEMPTS, so every
// section below groups by local calendar day and, where it matters, by the
// first time something was seen that day (or, for isolated intervals, the
// first time in a SITTING -- see buildSittings() below).
//
// Never writes: opens with node:sqlite's `readOnly` option when the
// installed Node supports it, and issues no INSERT/UPDATE/DDL regardless.
//
// Every percentage in this report prints its sample size beside it, either
// as "NN% (n=K)" (pctN) or as an adjoining n/offered column.
//
// Usage: node scripts/progress.mjs [--db <path>] [--days N]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Every percentage prints its own n beside it: "83% (n=12)".
const pctN = (xs) => (xs.length ? `${pct(mean(xs))} (n=${xs.length})` : '-- (n=0)');
// Stage's judgment of a note overrides raw pitch-correctness when present.
const effCorrect = (r) => (r.credit !== null && r.credit !== undefined ? r.credit : r.correct);

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

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

// A SITTING merges sessions whose start falls within 30 minutes of the
// previous session's end (matches src/drill.js kv `carry`, CARRY_MS). Built
// from the DB's full history so a merge chain isn't cut by the report
// window; callers filter the resulting sittings/sittingOf to the window.
const CARRY_MS = 30 * 60 * 1000;
function buildSittings() {
  const sessions = db.prepare('SELECT id, started_at, ended_at FROM sessions ORDER BY started_at ASC').all();
  const sittingOf = new Map(); // session id -> sitting key (its first session's id)
  const sittings = []; // [{ key, sessions: [...] }]
  let current = null;
  let prevEnd = null;
  for (const s of sessions) {
    if (!current || s.started_at - prevEnd > CARRY_MS) {
      current = { key: s.id, sessions: [] };
      sittings.push(current);
    }
    current.sessions.push(s);
    sittingOf.set(s.id, current.key);
    prevEnd = s.ended_at ?? s.started_at;
  }
  return { sittingOf, sittings };
}
const { sittingOf, sittings } = buildSittings();

// phrase_id -> collection, merged from all three corpus files ('other' if
// a phrase_id isn't found in any of them -- e.g. a rebuilt corpus).
function loadCorpusCollectionMap() {
  const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
  const map = new Map();
  for (const file of ['phrases.json', 'hymns.json', 'poly.json']) {
    const p = join(corpusDir, file);
    if (!existsSync(p)) continue;
    try {
      for (const item of JSON.parse(readFileSync(p, 'utf8'))) {
        if (item.id) map.set(item.id, item.collection || 'other');
      }
    } catch {
      // Corrupt/unreadable corpus file: collections from it just fall back to 'other'.
    }
  }
  return map;
}
const collectionOf = (map, phraseId) => map.get(phraseId) || 'other';

// ================= 1. Isolated intervals =================
function section1() {
  console.log('\n=== 1. Isolated intervals (first attempt per sitting per signed interval) ===');
  const rows = db.prepare(`
    SELECT session_id, ts, anchor, target, played, velocity, correct, ${col('attempts', 'credit')}
    FROM attempts
    WHERE kind IN ('interval','discrimination','remediation') AND graded = 1 AND ts >= ?
    ORDER BY ts ASC`).all(cutoff);

  const seen = new Set();
  const firstOfDay = [];
  for (const r of rows) {
    const sitting = sittingOf.get(r.session_id) ?? r.session_id;
    const signedInterval = r.target - r.anchor;
    const key = `${sitting}|${signedInterval}`;
    if (seen.has(key)) continue;
    seen.add(key);
    firstOfDay.push({
      day: localDay(r.ts), signedInterval, correct: effCorrect(r), velocity: r.velocity,
      playedInterval: r.played - r.anchor,
    });
  }

  console.log(`Overall accuracy: ${pctN(firstOfDay.map((r) => r.correct))}`);

  const byInterval = new Map();
  for (const r of firstOfDay) {
    if (!byInterval.has(r.signedInterval)) byInterval.set(r.signedInterval, []);
    byInterval.get(r.signedInterval).push(r);
  }

  // General confusion table: for any asked interval with >=3 misses, whatever was most often played instead.
  const confRows = [];
  // Derived pairs: restrict the "wrong note" to the same sign and within 2
  // semitones of width (e.g. -5 played as -7) -- the specific near-miss
  // pattern the day-by-day table below tracks.
  const derivedPairs = [];
  for (const [interval, list] of [...byInterval.entries()].sort((a, b) => a[0] - b[0])) {
    const misses = list.filter((r) => !r.correct);
    if (misses.length < 3) continue;
    const withNote = misses.filter((m) => m.velocity > 0);
    if (withNote.length) {
      const counts = new Map();
      for (const m of withNote) counts.set(m.playedInterval, (counts.get(m.playedInterval) || 0) + 1);
      const [topInterval, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      confRows.push([signed(interval), misses.length, signed(topInterval), topCount]);

      const near = [...counts.entries()].filter(
        ([played]) => played !== interval && interval !== 0 && Math.sign(played) === Math.sign(interval)
          && Math.abs(Math.abs(played) - Math.abs(interval)) <= 2,
      ).sort((a, b) => b[1] - a[1])[0];
      if (near) derivedPairs.push({ asked: interval, wrong: near[0], misses: near[1] });
    } else {
      confRows.push([signed(interval), misses.length, 'no note played', misses.length]);
    }
  }
  printTable('Paired confusions (asked interval with >=3 misses, any wrong note)', ['interval', 'misses', 'top wrong', 'count'], confRows);

  const topPairs = derivedPairs.sort((a, b) => b.misses - a.misses).slice(0, 6);
  const pairsHeader = topPairs.map((p) => [signed(p.asked), signed(p.wrong), p.misses]);
  printTable('Derived confusion pairs (same sign, width within 2 semitones; top 6 by miss count)', ['asked', 'wrong', 'misses'], pairsHeader);

  const days = [...new Set(firstOfDay.map((r) => r.day))].sort();
  const pairRows = days.map((day) => [
    day,
    ...topPairs.map((p) => pctN(firstOfDay.filter((r) => r.day === day && r.signedInterval === p.asked).map((r) => r.correct))),
  ]);
  const pairCols = ['day', ...topPairs.map((p) => `${signed(p.asked)} (vs ${signed(p.wrong)})`)];
  printTable('Derived pairs, day-by-day first-attempt accuracy on the asked interval', pairCols, pairRows);
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

  const firstPassageOf = new Map(); // phrase_id -> first 'passage' row ever (rows is ts-ascending)
  for (const r of rows) if (!firstPassageOf.has(r.phrase_id)) firstPassageOf.set(r.phrase_id, r);

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
    return [day, list.length, pctN(list.map(pitchClean)), num(mean(list.map(rungScore))), num(mean(list.map((r) => r.notes)), 1)];
  });
  printTable('Passages by day', ['day', 'n', 'pitch-clean', 'mean rung', 'mean len'], rowsOut);

  const savingsDays = [...savingsByDay.keys()].sort();
  const savingsRows = savingsDays.map((day) => [day, num(mean(savingsByDay.get(day))), savingsByDay.get(day).length]);
  printTable('Savings on re-encounter (later-day score - own first-day score)', ['day', 'mean savings', 'n'], savingsRows);

  // Variants: does a passage nailed and then re-shaped (new key/transposition/mode) transfer?
  const variantRows = db.prepare(`
    SELECT ts, phrase_id, notes, exact, ${col('passages', 'pitch_clean')}
    FROM passages WHERE qkind = 'variant' AND ts >= ? ORDER BY ts ASC`).all(cutoff);
  const byDayVariant = groupBy(variantRows, (r) => localDay(r.ts));
  const variantDays = [...byDayVariant.keys()].sort();
  const variantRowsOut = variantDays.map((day) => {
    const list = byDayVariant.get(day);
    const firstPassageClean = list
      .map((r) => firstPassageOf.get(r.phrase_id))
      .filter((r) => r !== undefined)
      .map(pitchClean);
    return [day, list.length, pctN(list.map(pitchClean)), pctN(firstPassageClean)];
  });
  const variantCols = ['day', 'n', 'variant pitch-clean', 'first-asking pitch-clean'];
  printTable('Variants by day (transfer: variant pitch-clean vs. the same phrase\'s first passage-asking)', variantCols, variantRowsOut);

  // Pitch-clean by corpus collection, per day (same population as "Passages by day" above).
  const collectionMap = loadCorpusCollectionMap();
  const collections = [...new Set([...byDay.values()].flat().map((r) => collectionOf(collectionMap, r.phrase_id)))].sort();
  const collRows = days.map((day) => {
    const list = byDay.get(day);
    return [day, ...collections.map((c) => pctN(list.filter((r) => collectionOf(collectionMap, r.phrase_id) === c).map(pitchClean)))];
  });
  printTable('Pitch-clean by collection, by day', ['day', ...collections], collRows);
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

  // HISTORICAL. The judge window was removed on 2026-09-11, when the drill
  // adopted its one rule: no note is played that the player is not being
  // asked to play back, and a window cannot be opened without a sound that
  // opens it. These tables describe sessions recorded before that; they will
  // not grow. See the rule at the top of src/drill.js.
  if (!hasTable('judgments')) return;
  // learning: one of the first judge windows, before the player had ever
  // pressed in one -- not evidence, so it is excluded from the rates below
  // and reported as its own count. Missing column = guarded to 0 (not learning).
  const jrows = db.prepare(`
    SELECT ts, guessed, hit, ${col('judgments', 'passage_clean')}, ${col('judgments', 'learning')}
    FROM judgments WHERE ts >= ? ORDER BY ts ASC`).all(cutoff);
  if (jrows.length === 0) return; // nothing in range: the window is gone

  if (!hasColumn('judgments', 'passage_clean')) {
    const perJDay = groupBy(jrows, (r) => localDay(r.ts));
    const jdays = [...perJDay.keys()].sort();
    const jRowsOut = jdays.map((day) => {
      const list = perJDay.get(day);
      const evidence = list.filter((r) => !r.learning);
      const guessedRows = evidence.filter((r) => r.guessed);
      const learningN = list.filter((r) => r.learning).length;
      return [day, list.length, pctN(evidence.map((r) => r.guessed)), pctN(guessedRows.map((r) => r.hit)), learningN];
    });
    printTable('Judgments by day (after failed passages)', ['day', 'offered', 'guessed rate', 'hit rate', 'learning windows'], jRowsOut);
    console.log('(passage_clean column not present in this database yet -- all judgments assumed to follow failed passages)');
    return;
  }

  // passage_clean is 1 for judgments that followed a clean passage (sampled
  // at 50%); 0 or NULL (legacy rows, pre-dating this column) followed a failed one.
  const failed = jrows.filter((r) => r.passage_clean !== 1);
  const clean = jrows.filter((r) => r.passage_clean === 1);
  const byDayFailed = groupBy(failed, (r) => localDay(r.ts));
  const byDayClean = groupBy(clean, (r) => localDay(r.ts));
  const jdays = [...new Set([...byDayFailed.keys(), ...byDayClean.keys()])].sort();

  const failedRowsOut = jdays.map((day) => {
    const list = byDayFailed.get(day) || [];
    const evidence = list.filter((r) => !r.learning);
    const guessedRows = evidence.filter((r) => r.guessed);
    const learningN = list.filter((r) => r.learning).length;
    return [day, list.length, pctN(evidence.map((r) => r.guessed)), pctN(guessedRows.map((r) => r.hit)), learningN];
  });
  printTable('Judgments after failed passages, by day', ['day', 'offered', 'guessed rate', 'hit rate', 'learning windows'], failedRowsOut);

  const cleanRowsOut = jdays.map((day) => {
    const list = byDayClean.get(day) || [];
    const evidence = list.filter((r) => !r.learning);
    const learningN = list.filter((r) => r.learning).length;
    return [day, list.length, pctN(evidence.map((r) => r.guessed)), pctN(evidence.map((r) => (r.guessed ? 0 : 1))), learningN];
  });
  printTable('Judgments after clean passages, by day', ['day', 'offered', 'false-alarm rate', 'correct-rejection rate', 'learning windows'], cleanRowsOut);
  console.log('(clean passages sampled at 50%)');
}

// ================= 4. Timing =================
function section4() {
  console.log('\n=== 4. Timing ===');
  const rows = db.prepare(`
    SELECT ts, correct, onset_ms, in_time, dur_ok, ${col('attempts', 'credit')}
    FROM attempts WHERE graded = 1 AND ts >= ? ORDER BY ts ASC`).all(cutoff);
  const perDay = groupBy(rows, (r) => localDay(r.ts));
  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    const onsets = list.filter((r) => effCorrect(r) && r.onset_ms !== null).map((r) => r.onset_ms);
    const timed = list.filter((r) => r.in_time !== null);
    const defects = list.filter((r) => r.dur_ok === 0).length;
    return [day, num(median(onsets), 0), pctN(timed.map((r) => r.in_time)), defects];
  });
  printTable('Timing by day', ['day', 'median onset ms', 'in-time rate', 'hold defects'], rowsOut);
}

// ================= 4b. Response-start lag =================
// attempts.behind is the number of beats between the call and the
// response's first note, stored on every attempt row of a question (same
// value for all rows of one question) -- dedupe by (session_id, question).
function sectionResponseLag() {
  console.log('\n=== Response-start lag ===');
  if (!hasColumn('attempts', 'behind')) {
    console.log('(behind column not present in this database yet)');
    return;
  }
  const KIND_GROUPS = {
    interval: ['interval', 'discrimination', 'remediation', 'gesture'],
    passage: ['passage'],
    retry: ['retry'],
    variant: ['variant'],
    round: ['round'],
  };
  const allKinds = [...new Set(Object.values(KIND_GROUPS).flat())];
  const rows = db.prepare(`
    SELECT session_id, question, ts, kind, behind FROM attempts
    WHERE behind IS NOT NULL AND kind IN (${allKinds.map(() => '?').join(',')}) AND ts >= ?
    ORDER BY ts ASC`).all(...allKinds, cutoff);

  const seenQ = new Set();
  const perQuestion = [];
  for (const r of rows) {
    const key = `${r.session_id}|${r.question}`;
    if (seenQ.has(key)) continue;
    seenQ.add(key);
    perQuestion.push(r);
  }

  const groupNames = Object.keys(KIND_GROUPS);
  const byDay = groupBy(perQuestion, (r) => localDay(r.ts));
  const days = [...byDay.keys()].sort();
  const header = ['day', ...groupNames.flatMap((g) => [`${g} median`, `${g} n`])];
  const rowsOut = days.map((day) => {
    const list = byDay.get(day);
    const cells = [day];
    for (const g of groupNames) {
      const sub = list.filter((r) => KIND_GROUPS[g].includes(r.kind)).map((r) => r.behind);
      cells.push(num(median(sub), 1), sub.length);
    }
    return cells;
  });
  printTable('Median response-start lag (beats behind the call), by kind, by day', header, rowsOut);

  // Search time: passages only, median onset_ms of the first graded note
  // per question (position = min position among graded=1 rows).
  const prows = db.prepare(`
    SELECT session_id, question, ts, position, onset_ms FROM attempts
    WHERE kind = 'passage' AND graded = 1 AND onset_ms IS NOT NULL AND ts >= ?
    ORDER BY ts ASC`).all(cutoff);
  const firstNote = new Map(); // session_id|question -> {ts, position, onset_ms}
  for (const r of prows) {
    const key = `${r.session_id}|${r.question}`;
    const cur = firstNote.get(key);
    if (!cur || r.position < cur.position) firstNote.set(key, { ts: r.ts, position: r.position, onset_ms: r.onset_ms });
  }
  const searchByDay = new Map();
  for (const v of firstNote.values()) {
    const day = localDay(v.ts);
    if (!searchByDay.has(day)) searchByDay.set(day, []);
    searchByDay.get(day).push(v.onset_ms);
  }
  const searchDays = [...searchByDay.keys()].sort();
  const searchRows = searchDays.map((day) => [day, num(median(searchByDay.get(day)), 0), searchByDay.get(day).length]);
  printTable('Passage search time (median onset ms of the first graded note), by day', ['day', 'median ms', 'n'], searchRows);
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
  const perDay = groupBy(rows, (r) => localDay(r.ts));
  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    const lastStage = list[list.length - 1].stage;
    const dirRight = list.map((r) => (Math.sign(r.played - r.anchor) === Math.sign(r.target - r.anchor) ? 1 : 0));
    const within2 = list.map((r) => (Math.abs(r.played - r.target) <= 2 ? 1 : 0));
    return [day, lastStage, pctN(dirRight), pctN(within2)];
  });
  printTable('Stage by day', ['day', 'last stage', 'direction-right', 'within 2 semitones'], rowsOut);
}

// ================= 6. Session shape =================
function section6() {
  console.log('\n=== 6. Session shape ===');
  const rows = db.prepare('SELECT started_at, ended_at, questions FROM sessions WHERE started_at >= ? ORDER BY started_at ASC').all(cutoff);
  const perDay = groupBy(rows, (r) => localDay(r.started_at));
  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    const mins = list.filter((r) => r.ended_at).map((r) => (r.ended_at - r.started_at) / 60000);
    const totalMin = mins.reduce((a, b) => a + b, 0);
    return [day, list.length, list.reduce((a, r) => a + (r.questions || 0), 0), num(totalMin, 1), mins.length ? num(Math.max(...mins), 1) : '--'];
  });
  printTable('Sessions by day', ['day', 'sessions', 'questions', 'total min', 'longest min'], rowsOut);

  // Sittings: sessions merged within CARRY_MS of each other (see buildSittings above).
  const sittingsInWindow = sittings.filter((s) => s.sessions[0].started_at >= cutoff);
  const byDaySittings = groupBy(sittingsInWindow, (s) => localDay(s.sessions[0].started_at));
  const sDays = [...byDaySittings.keys()].sort();
  const sittingRowsOut = sDays.map((day) => {
    const list = byDaySittings.get(day);
    const minutesPerSitting = list.map((s) => {
      const durs = s.sessions.filter((x) => x.ended_at).map((x) => (x.ended_at - x.started_at) / 60000);
      return durs.reduce((a, b) => a + b, 0);
    });
    const gaps = [];
    for (const s of list) {
      for (let i = 1; i < s.sessions.length; i += 1) {
        const prevEnd = s.sessions[i - 1].ended_at ?? s.sessions[i - 1].started_at;
        gaps.push((s.sessions[i].started_at - prevEnd) / 60000);
      }
    }
    return [day, list.length, num(median(minutesPerSitting), 1), gaps.length ? num(median(gaps), 1) : '--'];
  });
  const sittingCols = ['day', 'sittings', 'median min/sitting', 'median gap min (bursts)'];
  printTable('Sittings by day (sessions merged within 30 min of the previous one\'s end)', sittingCols, sittingRowsOut);
}

// ================= 7. Compound asks =================
function section7() {
  console.log('\n=== 7. Compound asks (pitch class vs. octave) ===');
  if (!hasColumn('attempts', 'height_err')) {
    console.log('(height_err column not present in this database yet)');
    return;
  }
  const rows = db.prepare('SELECT ts, correct, height_err FROM attempts WHERE height_err IS NOT NULL AND ts >= ? ORDER BY ts ASC').all(cutoff);
  const perDay = groupBy(rows, (r) => localDay(r.ts));
  const days = [...perDay.keys()].sort();
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    const pitchClassRight = list.map((r) => ((r.correct === 1 || r.height_err === 1) ? 1 : 0));
    const octaveRight = list.map((r) => (r.correct === 1 ? 1 : 0));
    return [day, list.length, pctN(pitchClassRight), pctN(octaveRight)];
  });
  printTable('Compound asks by day', ['day', 'n', 'pitch class right', 'octave right'], rowsOut);
}

// ================= 8. Rounds =================
function section8() {
  console.log('\n=== 8. Rounds ===');
  const row = hasTable('kv') ? db.prepare("SELECT value FROM kv WHERE key = 'rounds'").get() : undefined;
  if (!row) {
    console.log('(no rounds data yet -- kv "rounds" key not present)');
    return;
  }
  let rounds;
  try {
    rounds = JSON.parse(row.value);
  } catch {
    rounds = null;
  }
  if (!Array.isArray(rounds)) {
    console.log('(rounds kv value unreadable)');
    return;
  }

  const inWindow = rounds.filter((r) => r.ts >= cutoff);
  const byDay = groupBy(inWindow, (r) => localDay(r.ts));
  const dims = [...new Set(inWindow.map((r) => r.dim))].sort();
  const days = [...byDay.keys()].sort();
  const header = ['day', 'runs', ...dims.flatMap((d) => [`${d} runs`, `${d} mean top`])];
  const rowsOut = days.map((day) => {
    const list = byDay.get(day);
    const cells = [day, list.length];
    for (const d of dims) {
      const dimRows = list.filter((r) => r.dim === d);
      cells.push(dimRows.length, dimRows.length ? num(mean(dimRows.map((r) => r.top)), 1) : '--');
    }
    return cells;
  });
  printTable('Rounds by day', header, rowsOut);
}

// ================= 9. Dyads / chords =================
function section9() {
  console.log('\n=== 9. Dyads / chords ===');
  if (!hasColumn('attempts', 'voice')) {
    console.log('(voice column not present in this database yet)');
    return;
  }
  const kinds = ['dyad', 'chord', 'dyad discrimination', 'dyad remediation'];
  const rows = db.prepare(`
    SELECT ts, voice, correct, ${col('attempts', 'credit')} FROM attempts
    WHERE kind IN (${kinds.map(() => '?').join(',')}) AND graded = 1 AND ts >= ? ORDER BY ts ASC`).all(...kinds, cutoff);
  const perDay = groupBy(rows, (r) => localDay(r.ts));
  const voices = [...new Set(rows.map((r) => r.voice))].filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  const days = [...perDay.keys()].sort();
  const header = ['day', ...voices.map((v) => `voice ${v}`)];
  const rowsOut = days.map((day) => {
    const list = perDay.get(day);
    return [day, ...voices.map((v) => pctN(list.filter((r) => r.voice === v).map(effCorrect)))];
  });
  printTable('Dyad/chord accuracy by voice, by day (voice 0 = bass/free; higher = tones above it)', header, rowsOut);

  // Passage voices: duo/chorale/poly passages (>1 distinct voice within the
  // question) -- shows the high-voice bias (top voice right, bass never
  // played) that a single melody-only accuracy figure hides.
  const passageKinds = ['passage', 'retry', 'variant'];
  const prows = db.prepare(`
    SELECT session_id, question, ts, voice, correct, velocity FROM attempts
    WHERE kind IN (${passageKinds.map(() => '?').join(',')}) AND phrase_id IS NOT NULL AND voice IS NOT NULL
      AND graded = 1 AND ts >= ? ORDER BY ts ASC`).all(...passageKinds, cutoff);

  const byQuestion = groupBy(prows, (r) => `${r.session_id}|${r.question}`);
  const polyRows = [];
  for (const list of byQuestion.values()) {
    if (new Set(list.map((r) => r.voice)).size > 1) polyRows.push(...list);
  }

  if (!polyRows.length) {
    console.log('\n(no duo/chorale/poly passage voice data yet)');
    return;
  }

  const perDayPoly = groupBy(polyRows, (r) => localDay(r.ts));
  const voicesPoly = [...new Set(polyRows.map((r) => r.voice))].sort((a, b) => a - b);
  const daysPoly = [...perDayPoly.keys()].sort();

  const accHeader = ['day', ...voicesPoly.map((v) => `voice ${v} acc`)];
  const accRowsOut = daysPoly.map((day) => {
    const list = perDayPoly.get(day);
    return [day, ...voicesPoly.map((v) => pctN(list.filter((r) => r.voice === v).map((r) => r.correct)))];
  });
  printTable('Passage voices (duo/chorale/poly) accuracy by voice, by day (voice 0 = bass)', accHeader, accRowsOut);

  const neverHeader = ['day', ...voicesPoly.map((v) => `voice ${v} never-played`)];
  const neverRowsOut = daysPoly.map((day) => {
    const list = perDayPoly.get(day);
    return [day, ...voicesPoly.map((v) => {
      const sub = list.filter((r) => r.voice === v);
      return pctN(sub.map((r) => (r.velocity === 0 ? 1 : 0)));
    })];
  });
  printTable('Passage voices (duo/chorale/poly) never-played rate by voice, by day', neverHeader, neverRowsOut);
}

console.log('piano-by-ear progress report');
console.log(`db: ${dbPath}`);
console.log(`window: last ${args.days} day(s), local calendar days`);
section1();
section2();
section3();
section4();
sectionResponseLag();
section5();
section6();
section7();
section8();
section9();
db.close();
