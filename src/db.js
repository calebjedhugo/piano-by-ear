// SQLite history + kv persistence (node:sqlite, Node 22.5+).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
};
const SESSION_COLUMNS = { passages: 'INTEGER NOT NULL DEFAULT 0' };

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
    `);
    this.migrate('attempts', ATTEMPT_COLUMNS);
    this.migrate('sessions', SESSION_COLUMNS);
    this.stmts = {
      getKv: this.db.prepare('SELECT value FROM kv WHERE key = ?'),
      setKv: this.db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
      newSession: this.db.prepare('INSERT INTO sessions (started_at, bpm, anchor) VALUES (?, ?, ?) RETURNING id'),
      endSession: this.db.prepare('UPDATE sessions SET ended_at = ?, questions = ?, passages = ? WHERE id = ?'),
      lastBpm: this.db.prepare('SELECT bpm FROM sessions ORDER BY id DESC LIMIT 1'),
      recentGraded: this.db.prepare(
        'SELECT correct, in_time FROM attempts WHERE graded = 1 AND first_attempt = 1 ORDER BY id DESC LIMIT ?',
      ),
      attempt: this.db.prepare(`
        INSERT INTO attempts (session_id, ts, anchor, target, played, velocity, correct, first_attempt, onset_ms,
                              question, kind, phrase_id, position, graded, in_time, beat_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
      updateHeld: this.db.prepare('UPDATE attempts SET held_ms = ?, dur_ok = ? WHERE id = ?'),
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

  engineStore() {
    return this.kv('engine');
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

  /** Recent graded first attempts, newest first: [{correct, in_time}]. */
  recentGraded(limit = 40) {
    return this.stmts.recentGraded.all(limit);
  }

  attempt(a) {
    return this.stmts.attempt.get(
      a.sessionId, Date.now(), a.anchor, a.target, a.played, a.velocity,
      a.correct ? 1 : 0, a.firstAttempt ? 1 : 0, a.onsetMs ?? null,
      a.question ?? null, a.kind ?? null, a.phraseId ?? null, a.position ?? null,
      a.graded ? 1 : 0, a.inTime === undefined || a.inTime === null ? null : a.inTime ? 1 : 0, a.beatMs ?? null,
    ).id;
  }

  updateHeld(id, heldMs, durOk) {
    this.stmts.updateHeld.run(heldMs, durOk === null ? null : durOk ? 1 : 0, id);
  }

  close() {
    this.db.close();
  }
}
