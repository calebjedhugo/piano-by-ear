// THE PI IS THE SOURCE OF TRUTH, and the local copy is what plays when it is
// not there. A sync is a MERGE in both directions, never a file overwrite:
// take the rows the Pi has that we lack and fold them into ours (src/db.js
// mergeFrom), then send the rows we have that it lacks and let the Pi fold
// them into its copy. ROWS, NOT FILES (src/delta.js): each side reports its
// watermarks and only what lies past them travels. Two computers and a
// laptop that played a week with no network all converge on the same
// history, in any order.
//
// It runs at the two moments a profile's history changes hands: when the
// profile is opened (a chord) and when a session ends. Everything here fails
// fast and fails quietly -- no network means you play on the local copy and
// the rows catch up at the next sync. NOTHING here may ever block the drill
// for more than a few seconds.
//
// A per-profile lock on the Pi serialises the read-merge-write, so two
// machines syncing the same profile at the same moment cannot interleave.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { SYNCED_TABLES, LOCAL_KEYS } from './db.js';
import { deltaSql, marksSql, applySql, schemaDdl, parseReport, COLUMNS_SQL, lit } from './delta.js';

const CONNECT_S = 3;
const OP_MS = 20000;
const LOCK_STALE_MS = 120000;

const DEFAULTS = { enabled: true, host: 'chugo@hugopi', dir: 'piano-by-ear' };

// ONE CONNECTION, NOT SIX. A sync used to pay a fresh ssh handshake for the
// lock, the existence test, each transfer, the move and the unlock -- 200-360
// ms apiece here and worse over the downstairs wifi, which was most of the
// wait between a chord and the click. Multiplexed, the first call pays the
// handshake and the rest are ~10 ms.
const MUX = [
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${join(tmpdir(), 'pbe-%r@%h-%p')}`,
  '-o', 'ControlPersist=120',
];

/** Editable at ~/.piano-by-ear/sync.json -- a second machine may point elsewhere. */
export function syncConfig(path) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2));
  }
  return { ...DEFAULTS, ...(raw ?? {}) };
}

export class Sync {
  constructor({ config, device, tmpDir, log = () => {} }) {
    this.cfg = config;
    this.device = device;
    this.tmpDir = tmpDir;
    this.log = log;
    this.profiles = `${this.cfg.dir}/profiles`;
    this.locks = `${this.cfg.dir}/locks`;
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  ssh(command, { timeout = OP_MS, input = null } = {}) {
    return execFileSync('ssh', ['-o', `ConnectTimeout=${CONNECT_S}`, '-o', 'BatchMode=yes', ...MUX, this.cfg.host, command], {
      timeout, encoding: 'utf8', stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === null ? {} : { input }),
    });
  }

  /** Run a SQL script against a database on the pi with its sqlite3 CLI; stops at the first error. */
  sqlite(dbPath, script, { prefix = '' } = {}) {
    return this.ssh(`${prefix}sqlite3 -bail ${q(dbPath)}`, { input: `.timeout 5000\n.mode tabs\n${script}\n` });
  }

  scp(from, to) {
    execFileSync('scp', ['-q', '-o', `ConnectTimeout=${CONNECT_S}`, '-o', 'BatchMode=yes', ...MUX, from, to], {
      timeout: OP_MS, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /**
   * WHICH VERSION of this profile the pi is holding, as a token written beside
   * it by whoever last pushed. NOT mtime and size: `stat` is second-granular,
   * and two pushes of a database that grew by one small session land in the
   * same second at the same rounded size -- which made the fast path below
   * declare "already in step" and silently skip a real merge. A caught that
   * way would have lost B's sitting. A random token per push cannot collide.
   * Returns { rev, exists }; a db with no token reads as changed, which is
   * the safe direction.
   */
  fingerprint(name) {
    const db = q(`${this.profiles}/${safe(name)}.db`);
    const rev = q(`${this.profiles}/${safe(name)}.rev`);
    const out = this.ssh(`test -f ${db} && { cat ${rev} 2>/dev/null || echo unknown; } || echo none`).trim();
    if (out === 'none') return { rev: null, exists: false };
    return { rev: out === 'unknown' ? null : out, exists: true };
  }

  /**
   * Take the profile's lock on the Pi. mkdir is atomic, so two machines cannot
   * both hold it; a lock older than LOCK_STALE_MS is a crashed sync and is
   * broken rather than waited on.
   */
  lock(name) {
    const dir = q(`${this.locks}/${safe(name)}`);
    const out = this.ssh(
      `mkdir -p ${q(this.locks)} ${q(this.profiles)} 2>/dev/null; ` +
      `if mkdir ${dir} 2>/dev/null; then echo got; else ` +
      `age=$(( $(date +%s) - $(stat -c %Y ${dir} 2>/dev/null || date +%s) )); ` +
      `if [ "$age" -gt ${Math.round(LOCK_STALE_MS / 1000)} ]; then echo stale; else echo busy; fi; fi`,
    ).trim();
    if (out === 'stale') this.log(`  sync: broke a stale lock on ${name}`);
    return out === 'got' || out === 'stale';
  }

  unlock(name) {
    try {
      this.ssh(`rmdir ${q(`${this.locks}/${safe(name)}`)} 2>/dev/null || true`, { timeout: 8000 });
    } catch {
      /* the lock goes stale on its own */
    }
  }

  /**
   * Merge this profile with the Pi's copy and leave the union on both.
   * Returns { ok, reason?, counts? }; never throws.
   */
  run(db, name, { reason = '' } = {}) {
    if (!this.enabled) return { ok: false, reason: 'off' };
    const stamped = db.stamp(this.device);
    const state = db.kv('sync');
    const seen = state.load() ?? {};
    const tag = randomUUID();
    const pulled = join(this.tmpDir, `${name}.pull.db`);
    const pushed = join(this.tmpDir, `${name}.push.db`);
    const started = Date.now();
    const label = `  sync${reason ? ` (${reason})` : ''}`;
    let held = false;
    try {
      // THE CHEAP QUESTION FIRST. Neither side moved since our last push --
      // which is the ordinary case, one house, one player at a time -- and
      // there is nothing to do but say so. One round trip, and it is what
      // makes a login instant.
      const before = this.fingerprint(name);
      const mine = db.localSignature();
      if (before.rev && before.rev === seen.remote && mine === seen.local) {
        this.log(`${label}: already in step with the pi (${Date.now() - started}ms)`);
        return { ok: true, counts: null, skipped: true };
      }

      held = this.lock(name);
      if (!held) return { ok: false, reason: 'another machine is syncing this profile' };
      // scp on macOS speaks SFTP and does NOT run a remote shell, so its paths
      // are taken literally and must NOT be quoted; ssh runs a shell and its
      // paths must be. Mixing the two puts a file called 'Caleb'.db on the pi.
      const remote = `${this.profiles}/${safe(name)}.db`;
      const rev = `${this.profiles}/${safe(name)}.rev`;

      // THE FIRST COPY is the one whole-file transfer there will ever be.
      if (!before.exists) {
        db.snapshot(pushed);
        this.scp(pushed, `${this.cfg.host}:${remote}.new`);
        const token = randomUUID();
        this.ssh(`mv ${q(`${remote}.new`)} ${q(remote)} && printf %s ${q(token)} > ${q(rev)}`);
        state.save({ remote: token, local: db.localSignature() });
        this.log(`${label}: first copy on the pi${stamped ? `, ${stamped} rows claimed` : ''} (${Date.now() - started}ms)`);
        return { ok: true, counts: null };
      }

      // WHAT THE PI HOLDS: its columns (so our push can bring its schema up
      // to ours) and its watermarks. And, unless it has not moved since our
      // own last push, the rows past OUR watermarks, built on the pi into a
      // small file we then fetch. Two round trips, since the second needs
      // to know which tables exist.
      const report = parseReport(this.sqlite(remote, COLUMNS_SQL));
      const tables = SYNCED_TABLES.filter((t) => report.cols.has(t));
      const pullNeeded = !(before.rev && before.rev === seen.remote);
      const tmp = `${this.cfg.dir}/tmp`;
      const out = `${tmp}/${safe(name)}.${tag}.pull.db`;
      const script = [
        marksSql(tables),
        ...(pullNeeded ? [`ATTACH ${lit(out)} AS o;`, deltaSql({ marks: db.watermarks(), tables }), 'DETACH o;'] : []),
      ].join('\n');
      // Stale deltas from a sync that died half way are swept on the way in.
      const theirs = parseReport(this.sqlite(remote, script, {
        prefix: `mkdir -p ${q(tmp)} && find ${q(tmp)} -name '*.db' -mmin +10 -delete; `,
      }));
      let counts = null;
      if (pullNeeded) {
        rmSync(pulled, { force: true });
        this.scp(`${this.cfg.host}:${out}`, pulled);
        this.ssh(`rm -f ${q(out)}`);
        counts = db.mergeFrom(pulled, { log: this.log });
      }
      const gained = counts ? Object.entries(counts).filter(([k, v]) => k !== 'kv' && v > 0) : [];
      const took = gained.map(([k, v]) => `${v} ${k}`).join(', ');

      // WHAT WE HOLD THAT THE PI DOES NOT. Nothing -- the downstairs
      // machine's ordinary login after a sitting upstairs -- and there is
      // nothing to send and no new version to announce.
      const sent = db.writeDelta(pushed, theirs.marks);
      const rows = Object.values(sent).reduce((a, b) => a + b, 0);
      if (rows === 0) {
        state.save({ remote: before.rev, local: db.localSignature() });
        this.log(`${label}: ${pullNeeded ? `pulled ${took || 'nothing new'}` : 'the pi had nothing new'}, nothing of ours to send (${Date.now() - started}ms)`);
        return { ok: true, counts };
      }
      const up = `${tmp}/${safe(name)}.${tag}.push.db`;
      this.scp(pushed, `${this.cfg.host}:${up}`);
      // The pi folds it in, in one transaction. THE TOKEN MOVES FIRST: if the
      // connection dies after the rows commit, a stale token would let the
      // other machine's fast path skip them; a new token over unchanged rows
      // only costs it a pull that finds nothing. Wrong in the safe direction.
      const token = randomUUID();
      const apply = [
        `ATTACH ${lit(up)} AS d;`,
        'BEGIN;',
        applySql({
          tables: tables.concat(SYNCED_TABLES.filter((t) => !tables.includes(t))),
          cols: Object.fromEntries(db.syncSchema().map((x) => [x.table, x.cols.map((c) => c.name)])),
          ddl: schemaDdl(db.syncSchema(), report.cols),
          keepKeys: [...LOCAL_KEYS],
        }),
        'COMMIT;',
        'DETACH d;',
      ].join('\n');
      const applied = parseReport(this.ssh(
        `printf %s ${q(token)} > ${q(rev)} && sqlite3 -bail ${q(remote)} && rm -f ${q(up)}`,
        { input: `.timeout 5000\n.mode tabs\n${apply}\n` },
      )).added;
      state.save({ remote: token, local: db.localSignature() });
      const gave = Object.entries(applied).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ');
      this.log(
        `${label}: ${pullNeeded ? `pulled ${took || 'nothing new'}` : 'the pi had nothing new'}` +
        `${stamped ? `, ${stamped} rows claimed` : ''}, sent ${gave || 'nothing new'} (${Date.now() - started}ms)`,
      );
      return { ok: true, counts };
    } catch (err) {
      const why = short(err);
      this.log(`${label}: skipped -- ${why} (playing on the local copy)`);
      return { ok: false, reason: why };
    } finally {
      if (held) this.unlock(name);
      rmSync(pulled, { force: true });
      rmSync(pushed, { force: true });
    }
  }

  /**
   * The roster travels too, and for a sharper reason than convenience: see the
   * header of src/roster.js. Merged entry by entry, newest wins, pushed back.
   */
  syncRoster(roster) {
    if (!this.enabled) return { ok: false, reason: 'off' };
    const remote = `${this.cfg.dir}/roster.json`;
    const pulled = join(this.tmpDir, 'roster.pull.json');
    let held = false;
    try {
      held = this.lock('roster');
      if (!held) return { ok: false, reason: 'busy' };
      let changed = false;
      if (this.ssh(`test -f ${q(remote)} && echo yes || echo no`).trim() === 'yes') {
        rmSync(pulled, { force: true });
        this.scp(`${this.cfg.host}:${remote}`, pulled);
        changed = roster.mergeWith(JSON.parse(readFileSync(pulled, 'utf8')));
      }
      const out = join(this.tmpDir, 'roster.push.json');
      writeFileSync(out, JSON.stringify(roster.toJSON(), null, 2));
      this.ssh(`mkdir -p ${q(this.cfg.dir)}`);
      this.scp(out, `${this.cfg.host}:${remote}.new`);
      this.ssh(`mv ${q(`${remote}.new`)} ${q(remote)}`);
      rmSync(out, { force: true });
      if (changed) this.log('  sync: roster updated from the pi');
      return { ok: true, changed };
    } catch (err) {
      this.log(`  sync: roster not synced -- ${short(err)} (using the local one)`);
      return { ok: false, reason: short(err) };
    } finally {
      if (held) this.unlock('roster');
      rmSync(pulled, { force: true });
    }
  }

  /** Soft delete on the pi as well: the file is moved, never removed. */
  retireRemote(name) {
    if (!this.enabled) return false;
    try {
      const from = `${this.profiles}/${safe(name)}.db`;
      this.ssh(`mkdir -p ${q(`${this.profiles}/retired`)}; test -f ${q(from)} && mv ${q(from)} ${q(`${this.profiles}/retired/${safe(name)}.db`)} || true`);
      return true;
    } catch (err) {
      this.log(`  sync: could not retire ${name} on the pi -- ${short(err)}`);
      return false;
    }
  }
}

/** The first line of an ssh failure, in words that mean something in the log. */
function short(err) {
  const msg = String(err?.message ?? err);
  if (/Connection|timed out|ETIMEDOUT|Could not resolve|No route|refused/i.test(msg)) return 'the pi is not reachable';
  // A remote command that ran and failed: its own words (sqlite3's error,
  // say), not the ssh command line that carried it.
  const said = String(err?.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return said ? `the pi said: ${said}` : msg.split('\n')[0];
}

/** Profile names come from roster.js and are already tame; belt and braces. */
function safe(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _#-]{0,63}$/.test(name)) throw new Error(`unsafe profile name: ${name}`);
  return name;
}

/** Shell quoting, for the ssh side only. */
const q = (path) => `'${path}'`;
