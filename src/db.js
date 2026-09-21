// SQLite history + kv persistence (node:sqlite, Node 22.5+).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { summarizeRungs } from './rungs.js';

const ATTEMPT_COLUMNS = {
  question: 'INTEGER',
  kind: 'TEXT',
  phrase_id: 'TEXT',
  position: 'INTEGER',
  graded: 'INTEGER NOT NULL DEFAULT 0',
  in_time: 'INTEGER',
  beat_ms: 'REAL',
  held_ms: 'REAL',
  dur_ok: 'INTEGER',
  credit: 'INTEGER', // the stage's judgment of the note (src/stage.js); null = same as correct
  stage: 'TEXT',
  height_err: 'INTEGER', // compound ask: pitch class right, octave wrong
  voice: 'INTEGER', // the voice within a chord / polyphonic passage (0 = the bass or the melody)
  behind: 'INTEGER', // beats between the call and the response's first note: the effort signature
  // THE KEY IN FORCE when this note was asked ("D major"; src/keyblock.js
  // keyName, read back by parseKey), or NULL outside a block. Without it a
  // wrong note that is still a degree of the key cannot be told from one
  // outside it -- and that distinction IS the scale-degree question, which is
  // what the passage errors turned out to be (2026-09-12: 72% of passage
  // errors are off by one or two semitones, on notes that were themselves a
  // step away). Recorded on EVERY attempt, keyed question or not; `kind` says
  // whether the question was the key's (drill.js KEYED_KINDS).
  key: 'TEXT',
  // The player missed this note and then went back and played it right,
  // before the next note was due -- the one re-attack a note gets. The note
  // is still a miss (the passage fails on exact pitch, first try), but the
  // difference between a player who catches his own note and one who never
  // notices is most of what separates a musician from a typist.
  self_corrected: 'INTEGER',
  // WHICH RULE THE NOTE WAS MEASURED UNDER (2026-09-20), for the dyad kinds:
  //   'departure'  both notes of the dyad from the anchor being LEFT
  //   'twohand'    each hand from its own anchor (the dyad before it)
  //   'placing'    the other hand's first note, from the anchor
  //   NULL         a legacy dyad row: the bottom note was NAMED and free, and
  //                `anchor` on the upper note's row is the bass, not a note
  //                he departed from. Never re-scored; read the two apart.
  regime: 'TEXT',
  // 1 when this note IS the anchor it was measured from -- the common tone,
  // required and graded as a unison, reported to no engine.
  contains_anchor: 'INTEGER',
};
// passage_clean: the window follows clean passages too (sampled): false alarms vs hits.
// learning: one of the first windows, before the player has ever pressed in one -- not evidence.
const JUDGMENT_COLUMNS = { passage_clean: 'INTEGER', learning: 'INTEGER' };
/** A tri-state boolean for SQLite: undefined/null -> NULL, else 1/0. */
const nb = (v) => (v === undefined || v === null ? null : v ? 1 : 0);
const SESSION_COLUMNS = { passages: 'INTEGER NOT NULL DEFAULT 0' };
// pitch_clean: every graded note exactly right, whatever the timing and holds.
// `clean` keeps its old meaning (pitch AND time) for continuity; the
// controllers read pitch_clean (pitch and rhythm are separable skills:
// Pfordresher 2003; Brown & Penhune 2018).
const PASSAGE_COLUMNS = { pitch_clean: 'INTEGER', self_corrected: 'INTEGER' };

// WHERE A ROW CAME FROM. Two computers (upstairs, downstairs) and a laptop
// that plays with no network all write to the same profile, so a profile's
// history cannot be a file that one machine overwrites with another -- it has
// to MERGE. These two columns are what makes that possible: `device` is the
// machine that recorded the row and `origin_id` is the id it had there, so
// (device, origin_id) names a row globally and a merge is "insert what I am
// missing". Local ids stay local and are remapped on the way in.
// The event tables merge. The kv store CANNOT (engine tiers, stage, the
// passage-length controller and the phrase schedule are running state, not
// events): it is taken whole from whichever side played last, and the other
// side's copy is kept in kv_archive rather than dropped. See src/sync.js.
const SYNC_COLUMNS = { device: 'TEXT', origin_id: 'INTEGER' };
const SYNCED_TABLES = ['sessions', 'attempts', 'passages', 'windows', 'judgments', 'sonorities'];
// kv keys that are about THIS MACHINE and never travel with a profile.
const LOCAL_KEYS = new Set(['device', 'sync']);

export class Db {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        bpm REAL NOT NULL,
        anchor INTEGER NOT NULL,
        questions INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        ts INTEGER NOT NULL,
        anchor INTEGER NOT NULL,
        target INTEGER NOT NULL,
        played INTEGER NOT NULL,
        velocity INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        first_attempt INTEGER NOT NULL,
        onset_ms REAL
      );
      CREATE INDEX IF NOT EXISTS attempts_session ON attempts(session_id);
      CREATE TABLE IF NOT EXISTS passages (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        question INTEGER,
        ts INTEGER NOT NULL,
        phrase_id TEXT NOT NULL,
        kind TEXT,
        qkind TEXT,
        bpm REAL,
        notes INTEGER NOT NULL,
        attempted INTEGER NOT NULL,
        exact INTEGER NOT NULL,
        clean INTEGER NOT NULL,
        intervals INTEGER NOT NULL,
        direction INTEGER NOT NULL,
        near INTEGER NOT NULL,
        exact_interval INTEGER NOT NULL,
        first_error INTEGER,
        recovered INTEGER,
        backfilled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS passages_phrase ON passages(phrase_id);
      -- THE JUDGMENT WINDOW. After every passage the pulse drops for a couple
      -- of seconds and whatever the player does in that silence is his answer
      -- to "which note did you miss?" -- one row per window.
      --   missed   notes he never reached, not counting ones he caught in
      --            flight (those are already measured: attempts.self_corrected)
      --   caught   how many of the passage's misses he had caught in flight
      --   pressed  notes played in the silence
      --   hits     presses naming a note that really did get past him
      --   echoes   presses naming THE WRONG NOTE HE ACTUALLY PLAYED: given
      --            time and silence he still believes it was right, which is
      --            a representation problem, not a fumble
      --   strays   presses naming neither (after a clean passage: a false alarm)
      CREATE TABLE IF NOT EXISTS windows (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        question INTEGER,
        ts INTEGER NOT NULL,
        phrase_id TEXT,
        passage_clean INTEGER,
        missed INTEGER NOT NULL DEFAULT 0,
        caught INTEGER NOT NULL DEFAULT 0,
        pressed INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        echoes INTEGER NOT NULL DEFAULT 0,
        strays INTEGER NOT NULL DEFAULT 0
      );
      -- HISTORICAL. The CUED judge window, removed on 2026-09-11 when the
      -- drill stopped playing anything it was not asking for. Its successor
      -- opens with silence instead of a sound and lives in the windows table
      -- the two are not comparable, so they are not the same table.
      CREATE TABLE IF NOT EXISTS judgments (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        question INTEGER,
        ts INTEGER NOT NULL,
        phrase_id TEXT,
        guessed INTEGER NOT NULL,
        hit INTEGER
      );
      -- A SONORITY: two notes asked at one onset, as a PAIR (2026-09-20). An
      -- attempts row is one note with one reference; the harmonic interval is
      -- a property of the pair and lives here, one row per two-note group in
      -- a dyad, placing or duo passage. The verdict is on the pair he PLAYED:
      -- span_played is the interval between his two notes, whatever was asked
      -- of either. charged says which ear a wrong note was debited to --
      -- 'melodic' or 'harmonic' by whichever predicted it worse, 'progression'
      -- when both predicted it fine (recorded, charged to nothing: the
      -- voice-leading object item 4 will be designed from), NULL when
      -- nothing was wrong or the row is recorded only (passages).
      -- prev_span_*: the sonority before this one (same question, or the
      -- dyad question just before), so a resolution can be read as one.
      CREATE TABLE IF NOT EXISTS sonorities (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        question INTEGER,
        ts INTEGER NOT NULL,
        kind TEXT,
        regime TEXT,
        position INTEGER,
        lo_expected INTEGER NOT NULL,
        hi_expected INTEGER NOT NULL,
        lo_played INTEGER,
        hi_played INTEGER,
        lo_from INTEGER,
        hi_from INTEGER,
        lo_ok INTEGER,
        hi_ok INTEGER,
        span_expected INTEGER NOT NULL,
        span_played INTEGER,
        harmonic_ok INTEGER,
        contains_anchor INTEGER,
        charged TEXT,
        melodic_acc_lo REAL,
        melodic_acc_hi REAL,
        harmonic_acc REAL,
        prev_span_expected INTEGER,
        prev_span_played INTEGER,
        key TEXT
      );
      CREATE INDEX IF NOT EXISTS sonorities_session ON sonorities(session_id);
    `);
    this.migrate('attempts', ATTEMPT_COLUMNS);
    this.migrate('sessions', SESSION_COLUMNS);
    this.migrate('passages', PASSAGE_COLUMNS);
    this.migrate('judgments', JUDGMENT_COLUMNS);
    for (const t of SYNCED_TABLES) this.migrate(t, SYNC_COLUMNS);
    this.db.exec(`
      ${SYNCED_TABLES.map((t) => `CREATE INDEX IF NOT EXISTS ${t}_origin ON ${t}(device, origin_id);`).join('\n      ')}
      -- The kv a merge did not keep. Nothing a player earned is ever deleted;
      -- it is set aside with the machine and moment it came from.
      CREATE TABLE IF NOT EXISTS kv_archive (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, device TEXT, key TEXT NOT NULL, value TEXT NOT NULL
      );`);
    // Windows from before the flag existed were windows before the cue had
    // been explained (the first real session: 18 windows, no presses).
    this.db.exec('UPDATE judgments SET learning = 1 WHERE learning IS NULL AND guessed = 0');
    this.db.exec('UPDATE passages SET pitch_clean = (exact = notes) WHERE pitch_clean IS NULL');
    this.stmts = {
      getKv: this.db.prepare('SELECT value FROM kv WHERE key = ?'),
      setKv: this.db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
      newSession: this.db.prepare('INSERT INTO sessions (started_at, bpm, anchor) VALUES (?, ?, ?) RETURNING id'),
      endSession: this.db.prepare('UPDATE sessions SET ended_at = ?, questions = ?, passages = ? WHERE id = ?'),
      lastBpm: this.db.prepare('SELECT bpm FROM sessions ORDER BY id DESC LIMIT 1'),
      recentPassageNotes: this.db.prepare(`
        SELECT phrase_id, beat_ms, correct, in_time FROM attempts
        WHERE graded = 1 AND first_attempt = 1 AND phrase_id IS NOT NULL AND beat_ms IS NOT NULL
        ORDER BY id DESC LIMIT ?`),
      attempt: this.db.prepare(`
        INSERT INTO attempts (session_id, ts, anchor, target, played, velocity, correct, first_attempt, onset_ms,
                              question, kind, phrase_id, position, graded, in_time, beat_ms, credit, stage, height_err, voice, behind, key,
                              regime, contains_anchor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
      recentIsolated: this.db.prepare(`
        SELECT anchor, target, CASE WHEN velocity > 0 THEN played ELSE NULL END played, stage FROM attempts
        WHERE graded = 1 AND kind IN ('interval', 'discrimination', 'remediation', 'echo') ORDER BY id DESC LIMIT ?`),
      updateHeld: this.db.prepare('UPDATE attempts SET held_ms = ?, dur_ok = ? WHERE id = ?'),
      selfCorrected: this.db.prepare('UPDATE attempts SET self_corrected = 1 WHERE id = ?'),
      window: this.db.prepare(`
        INSERT INTO windows (session_id, question, ts, phrase_id, passage_clean, missed, caught, pressed, hits, echoes, strays)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      passage: this.db.prepare(`
        INSERT INTO passages (session_id, question, ts, phrase_id, kind, qkind, bpm, notes, attempted, exact, clean,
                              intervals, direction, near, exact_interval, first_error, recovered, backfilled, pitch_clean,
                              self_corrected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      sonority: this.db.prepare(`
        INSERT INTO sonorities (session_id, question, ts, kind, regime, position, lo_expected, hi_expected, lo_played, hi_played,
                                lo_from, hi_from, lo_ok, hi_ok, span_expected, span_played, harmonic_ok, contains_anchor, charged,
                                melodic_acc_lo, melodic_acc_hi, harmonic_acc, prev_span_expected, prev_span_played, key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      passageHistory: this.db.prepare('SELECT * FROM passages WHERE phrase_id = ? ORDER BY ts DESC LIMIT ?'),
      passageCount: this.db.prepare('SELECT COUNT(*) n FROM passages'),
      passageAttempts: this.db.prepare(`
        SELECT a.session_id, a.question, a.ts, a.phrase_id, a.kind, a.beat_ms, a.position, a.target, a.played,
               a.velocity, a.correct, a.in_time
        FROM attempts a WHERE a.phrase_id IS NOT NULL ORDER BY a.id`),
    };
    // THE HARMONIC ENGINE STARTS OVER (2026-09-20, once per profile). Its 278
    // trials scored the upper note of a dyad against a NAMED bass -- a melodic
    // interval from a note under the hand, not a sonority -- and its ladder
    // never moved once. The new dyads grade the pair he played; a controller
    // steering on the old state would be steering on the wrong thing. The
    // state is set aside, not deleted, the way a merge sets aside a kv.
    this.runOnce('harmonic-restart-2026-09-20', () => {
      const row = this.db.prepare("SELECT value FROM kv WHERE key = 'engine:harmonic'").get();
      if (!row) return;
      const device = (() => { try { return JSON.parse(this.db.prepare("SELECT value FROM kv WHERE key = 'device'").get()?.value ?? 'null'); } catch { return null; } })();
      this.db.prepare('INSERT INTO kv_archive (ts, device, key, value) VALUES (?, ?, ?, ?)').run(Date.now(), device, 'engine:harmonic', row.value);
      this.db.prepare("DELETE FROM kv WHERE key = 'engine:harmonic'").run();
    });
  }

  /** A one-time migration, remembered in kv so it never runs twice on a profile. */
  runOnce(name, fn) {
    const done = this.kv('migrations').load() || {};
    if (done[name]) return;
    fn();
    done[name] = Date.now();
    this.kv('migrations').save(done);
  }

  migrate(table, columns) {
    const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  /** Guarded JSON {load, save} adapter for one kv key. */
  kv(key) {
    return {
      load: () => {
        const row = this.stmts.getKv.get(key);
        if (!row) return null;
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      },
      save: (value) => this.stmts.setKv.run(key, JSON.stringify(value)),
    };
  }

  /** Persistence for an adaptive engine: 'engine' (melodic) or another name. */
  engineStore(name = 'engine') {
    return this.kv(name === 'engine' ? 'engine' : `engine:${name}`);
  }

  newSession({ bpm, anchor }) {
    return this.stmts.newSession.get(Date.now(), bpm, anchor).id;
  }

  endSession(id, { questions, passages }) {
    this.stmts.endSession.run(Date.now(), questions, passages, id);
  }

  lastBpm() {
    return this.stmts.lastBpm.get()?.bpm ?? null;
  }

  /**
   * Recent graded passage notes, newest first: [{phrase_id, beat_ms, correct,
   * in_time}]. The tempo ceiling needs the phrase to know how fast its notes
   * were, so rows without one are left out (see src/tempo.js).
   */
  recentPassageNotes(limit = 400) {
    return this.stmts.recentPassageNotes.all(limit);
  }

  attempt(a) {
    return this.stmts.attempt.get(
      a.sessionId, Date.now(), a.anchor, a.target, a.played, a.velocity,
      a.correct ? 1 : 0, a.firstAttempt ? 1 : 0, a.onsetMs ?? null,
      a.question ?? null, a.kind ?? null, a.phraseId ?? null, a.position ?? null,
      a.graded ? 1 : 0, nb(a.inTime), a.beatMs ?? null, nb(a.credit), a.stage ?? null, nb(a.heightErr), a.voice ?? null, a.behind ?? null,
      a.key ?? null, a.regime ?? null, nb(a.containsAnchor),
    ).id;
  }

  /** One two-note onset group, judged as a pair (see the table comment). */
  sonority(s) {
    this.stmts.sonority.run(
      s.sessionId, s.question ?? null, Date.now(), s.kind ?? null, s.regime ?? null, s.position ?? null,
      s.loExpected, s.hiExpected, s.loPlayed ?? null, s.hiPlayed ?? null, s.loFrom ?? null, s.hiFrom ?? null,
      nb(s.loOk), nb(s.hiOk), s.spanExpected, s.spanPlayed ?? null, nb(s.harmonicOk), nb(s.containsAnchor), s.charged ?? null,
      s.melodicAccLo ?? null, s.melodicAccHi ?? null, s.harmonicAcc ?? null, s.prevSpanExpected ?? null, s.prevSpanPlayed ?? null,
      s.key ?? null,
    );
  }

  /** The last isolated first attempts, newest first, for the stage (src/stage.js). */
  recentIsolated(limit = 20) {
    return this.stmts.recentIsolated.all(limit);
  }

  /** One judgment window: what he offered in the silence, and what was true. */
  window(w) {
    this.stmts.window.run(w.sessionId, w.question ?? null, Date.now(), w.phraseId ?? null, nb(w.passageClean),
      w.missed, w.caught, w.pressed, w.hits, w.echoes, w.strays);
  }

  /** The player went back and caught his own note before the next one was due. */
  selfCorrected(rowId) {
    this.stmts.selfCorrected.run(rowId);
  }

  updateHeld(id, heldMs, durOk) {
    this.stmts.updateHeld.run(heldMs, durOk === null ? null : durOk ? 1 : 0, id);
  }

  /** One row per passage question: the rung summary from src/rungs.js plus context. */
  passage(p) {
    this.stmts.passage.run(
      p.sessionId, p.question ?? null, p.ts ?? Date.now(), p.phraseId, p.kind ?? null, p.qkind ?? null, p.bpm ?? null,
      p.notes, p.attempted, p.exact, p.clean ? 1 : 0, p.intervals, p.direction, p.near, p.exactInterval,
      p.firstError ?? null, nb(p.recovered), p.backfilled ? 1 : 0,
      p.pitchClean === undefined ? (p.exact === p.notes ? 1 : 0) : p.pitchClean ? 1 : 0,
      p.selfCorrected ?? 0,
    );
  }

  /** Every recorded encounter with a phrase, newest first. */
  passageHistory(phraseId, limit = 20) {
    return this.stmts.passageHistory.all(phraseId, limit);
  }

  /**
   * Build the passages table from the attempts already on record, once, so
   * the rungs have history from day one instead of starting empty. Attempts
   * carry no voice, so contour is computed only where every onset holds one
   * note; polyphonic passages keep exact and recovery and no contour. A
   * played pivot has an attempt row and counts as a note here, where the live
   * path treats it as free context -- a one-note difference, always in the
   * player's favour.
   */
  backfillPassages() {
    if (this.stmts.passageCount.get().n > 0) return 0;
    const questions = new Map();
    for (const a of this.stmts.passageAttempts.all()) {
      const key = `${a.session_id}:${a.question}`;
      if (!questions.has(key)) questions.set(key, []);
      questions.get(key).push(a);
    }
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const rows of questions.values()) {
        const poly = new Set(rows.map((r) => r.position)).size < rows.length;
        const r = summarizeRungs(rows.map((a) => ({ expected: a.target, played: a.velocity > 0 ? a.played : null, b: a.position, voice: 0 })));
        if (poly) Object.assign(r, { intervals: 0, direction: 0, near: 0, exactInterval: 0 });
        const first = rows[0];
        this.passage({
          sessionId: first.session_id, question: first.question, ts: first.ts, phraseId: first.phrase_id,
          kind: null, qkind: first.kind, bpm: first.beat_ms ? 60000 / first.beat_ms : null,
          clean: rows.every((a) => a.correct && a.in_time), backfilled: true, ...r,
        });
        n += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  // --- sync ----------------------------------------------------------------

  /** Columns of a table, minus the rowid: what a merge carries across. */
  columnsOf(table) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name).filter((n) => n !== 'id');
  }

  /**
   * Claim every row this machine has recorded but not yet stamped. Run before
   * a push, so that anything leaving this computer already says where it came
   * from -- an unstamped row has no identity and cannot be merged back.
   */
  stamp(device) {
    this.kv('device').save(device);
    let n = 0;
    for (const t of SYNCED_TABLES) {
      const r = this.db.prepare(`UPDATE ${t} SET device = ?, origin_id = id WHERE device IS NULL`).run(device);
      n += r.changes;
    }
    return n;
  }

  get deviceOfRecord() {
    return this.kv('device').load();
  }

  /**
   * A cheap fingerprint of what this copy holds. Compared against the value
   * recorded at the last successful push to answer "have we written anything
   * the pi has not got?" without opening a connection -- which is what lets a
   * login skip the transfer entirely (src/sync.js).
   */
  localSignature() {
    const a = this.db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id), 0) m FROM sessions').get();
    const b = this.db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id), 0) m FROM attempts').get();
    return `${a.n}:${a.m}:${b.n}:${b.m}`;
  }

  sessionCount() {
    return this.db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  }

  /** When this profile last played anything, by any machine: who wins the kv. */
  lastSessionAt() {
    return this.db.prepare('SELECT MAX(COALESCE(ended_at, started_at)) t FROM sessions').get().t ?? 0;
  }

  /** A consistent single-file copy while the drill is still open on it (no WAL to chase). */
  snapshot(path) {
    rmSync(path, { force: true });
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  /**
   * Fold another copy of this profile into this one. Event rows are inserted
   * where missing, keyed by (device, origin_id), with session ids remapped;
   * the kv is taken whole from whichever side played more recently. Returns
   * what moved. The caller pushes the union back up, so every machine
   * converges on the same history however long it was away.
   */
  mergeFrom(path, { log = () => {} } = {}) {
    const quoted = path.replace(/'/g, "''");
    this.db.exec(`ATTACH DATABASE '${quoted}' AS r`);
    const counts = {};
    try {
      const remoteCols = (table) => new Set(this.db.prepare(`PRAGMA r.table_info(${table})`).all().map((r) => r.name).concat(['device', 'origin_id']));
      const theirDevice = (() => {
        const row = this.db.prepare("SELECT value FROM r.kv WHERE key = 'device'").get();
        try { return JSON.parse(row.value); } catch { return null; }
      })();
      this.db.exec('BEGIN');
      try {
        // Sessions first: everything else hangs off them. `byRemoteId` maps
        // the OTHER machine's local session id onto ours.
        const mine = new Map();
        for (const r of this.db.prepare('SELECT device, origin_id, id FROM sessions WHERE device IS NOT NULL').all()) {
          mine.set(`${r.device}:${r.origin_id}`, r.id);
        }
        const cols = this.columnsOf('sessions');
        const insert = this.db.prepare(
          `INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`,
        );
        const byRemoteId = new Map();
        let added = 0;
        for (const row of this.db.prepare('SELECT * FROM r.sessions').all()) {
          const device = row.device ?? theirDevice;
          const origin = row.origin_id ?? row.id;
          if (!device) continue; // no identity: cannot be merged, only overwritten
          const key = `${device}:${origin}`;
          let id = mine.get(key);
          if (id === undefined) {
            id = insert.get(...cols.map((c) => (c === 'device' ? device : c === 'origin_id' ? origin : row[c] ?? null))).id;
            mine.set(key, id);
            added += 1;
          }
          byRemoteId.set(row.id, id);
        }
        counts.sessions = added;

        // A copy pushed by an older build may not have every table yet: skip
        // what is not there rather than throwing mid-merge (the rows it does
        // hold still come across, and ours push back with the table intact).
        const remoteTables = new Set(this.db.prepare("SELECT name FROM r.sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        for (const table of SYNCED_TABLES.filter((t) => t !== 'sessions' && remoteTables.has(t))) {
          const tcols = this.columnsOf(table).filter((c) => remoteCols(table).has(c));
          const ins = this.db.prepare(`INSERT INTO ${table} (${tcols.join(', ')}) VALUES (${tcols.map(() => '?').join(', ')})`);
          const have = new Set(
            this.db.prepare(`SELECT device, origin_id FROM ${table} WHERE device IS NOT NULL`).all().map((r) => `${r.device}:${r.origin_id}`),
          );
          let n = 0;
          for (const row of this.db.prepare(`SELECT * FROM r.${table}`).all()) {
            const device = row.device ?? theirDevice;
            const origin = row.origin_id ?? row.id;
            if (!device || have.has(`${device}:${origin}`)) continue;
            const session = byRemoteId.get(row.session_id);
            if (session === undefined) continue; // an orphan row: its session did not come across
            ins.run(...tcols.map((c) => {
              if (c === 'device') return device;
              if (c === 'origin_id') return origin;
              if (c === 'session_id') return session;
              return row[c] ?? null;
            }));
            have.add(`${device}:${origin}`);
            n += 1;
          }
          counts[table] = n;
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }

      // The kv is not a log and cannot be merged: the side that played last
      // holds the controller state, and the other side's is archived whole.
      const theirLast = this.db.prepare('SELECT MAX(COALESCE(ended_at, started_at)) t FROM r.sessions').get().t ?? 0;
      const mineLast = this.db.prepare(
        'SELECT MAX(COALESCE(ended_at, started_at)) t FROM sessions WHERE device IS NULL OR device = ?',
      ).get(this.deviceOfRecord)?.t ?? 0;
      counts.kv = 'kept';
      if (theirLast > mineLast) {
        const theirs = this.db.prepare('SELECT key, value FROM r.kv').all().filter((r) => !LOCAL_KEYS.has(r.key));
        const ours = new Map(this.db.prepare('SELECT key, value FROM kv').all().filter((r) => !LOCAL_KEYS.has(r.key)).map((r) => [r.key, r.value]));
        // Adopting state we already hold would archive a fresh copy of it on
        // every sync, so a no-change sync has to be a no-op.
        const differs = theirs.length !== ours.size || theirs.some((r) => ours.get(r.key) !== r.value);
        if (theirs.length && differs) {
          this.db.exec('BEGIN');
          try {
            const arch = this.db.prepare('INSERT INTO kv_archive (ts, device, key, value) VALUES (?, ?, ?, ?)');
            const now = Date.now();
            for (const r of this.db.prepare('SELECT key, value FROM kv').all()) {
              if (!LOCAL_KEYS.has(r.key)) arch.run(now, this.deviceOfRecord ?? null, r.key, r.value);
            }
            for (const r of theirs) this.stmts.setKv.run(r.key, r.value);
            this.db.exec('COMMIT');
          } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
          }
          counts.kv = 'adopted';
          log(`  sync: took the ladder state from the other copy (it played ${new Date(theirLast).toLocaleString()}); ours is archived`);
        }
      }
    } finally {
      this.db.exec('DETACH DATABASE r');
    }
    return counts;
  }

  close() {
    this.db.close();
  }
}
