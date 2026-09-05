// SQLite history + engine-state persistence (node:sqlite, Node 22.5+).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Db {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
    this.stmts = {
      getKv: this.db.prepare('SELECT value FROM kv WHERE key = ?'),
      setKv: this.db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
      newSession: this.db.prepare(
        'INSERT INTO sessions (started_at, bpm, anchor) VALUES (?, ?, ?) RETURNING id',
      ),
      endSession: this.db.prepare('UPDATE sessions SET ended_at = ?, questions = ? WHERE id = ?'),
      attempt: this.db.prepare(`
        INSERT INTO attempts (session_id, ts, anchor, target, played, velocity, correct, first_attempt, onset_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    };
  }

  /** Persistence adapter for AdaptiveEngine. */
  engineStore() {
    return {
      load: () => {
        const row = this.stmts.getKv.get('engine');
        if (!row) return null;
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      },
      save: (state) => this.stmts.setKv.run('engine', JSON.stringify(state)),
    };
  }

  newSession({ bpm, anchor }) {
    return this.stmts.newSession.get(Date.now(), bpm, anchor).id;
  }

  endSession(id, questions) {
    this.stmts.endSession.run(Date.now(), questions, id);
  }

  attempt({ sessionId, anchor, target, played, velocity, correct, firstAttempt, onsetMs }) {
    this.stmts.attempt.run(
      sessionId, Date.now(), anchor, target, played, velocity,
      correct ? 1 : 0, firstAttempt ? 1 : 0, onsetMs ?? null,
    );
  }
}
