// SQLite history + kv persistence (node:sqlite, Node 22.5+).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
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
  // The player missed this note and then went back and played it right,
  // before the next note was due -- the one re-attack a note gets. The note
  // is still a miss (the passage fails on exact pitch, first try), but the
  // difference between a player who catches his own note and one who never
  // notices is most of what separates a musician from a typist.
  self_corrected: 'INTEGER',
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
      -- HISTORICAL. The judge window was removed on 2026-09-11 (the drill
      -- plays nothing it is not asking for, and a window needs a sound to
      -- open it). Kept so the sessions that used it can still be read.
      CREATE TABLE IF NOT EXISTS judgments (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        question INTEGER,
        ts INTEGER NOT NULL,
        phrase_id TEXT,
        guessed INTEGER NOT NULL,
        hit INTEGER
      );
    `);
    this.migrate('attempts', ATTEMPT_COLUMNS);
    this.migrate('sessions', SESSION_COLUMNS);
    this.migrate('passages', PASSAGE_COLUMNS);
    this.migrate('judgments', JUDGMENT_COLUMNS);
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
                              question, kind, phrase_id, position, graded, in_time, beat_ms, credit, stage, height_err, voice, behind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
      recentIsolated: this.db.prepare(`
        SELECT anchor, target, CASE WHEN velocity > 0 THEN played ELSE NULL END played, stage FROM attempts
        WHERE graded = 1 AND kind IN ('interval', 'discrimination', 'remediation', 'echo') ORDER BY id DESC LIMIT ?`),
      updateHeld: this.db.prepare('UPDATE attempts SET held_ms = ?, dur_ok = ? WHERE id = ?'),
      selfCorrected: this.db.prepare('UPDATE attempts SET self_corrected = 1 WHERE id = ?'),
      passage: this.db.prepare(`
        INSERT INTO passages (session_id, question, ts, phrase_id, kind, qkind, bpm, notes, attempted, exact, clean,
                              intervals, direction, near, exact_interval, first_error, recovered, backfilled, pitch_clean,
                              self_corrected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      passageHistory: this.db.prepare('SELECT * FROM passages WHERE phrase_id = ? ORDER BY ts DESC LIMIT ?'),
      passageCount: this.db.prepare('SELECT COUNT(*) n FROM passages'),
      passageAttempts: this.db.prepare(`
        SELECT a.session_id, a.question, a.ts, a.phrase_id, a.kind, a.beat_ms, a.position, a.target, a.played,
               a.velocity, a.correct, a.in_time
        FROM attempts a WHERE a.phrase_id IS NOT NULL ORDER BY a.id`),
    };
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
    ).id;
  }

  /** The last isolated first attempts, newest first, for the stage (src/stage.js). */
  recentIsolated(limit = 20) {
    return this.stmts.recentIsolated.all(limit);
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

  close() {
    this.db.close();
  }
}
