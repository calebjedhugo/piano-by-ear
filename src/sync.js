// THE PI IS THE SOURCE OF TRUTH, and the local copy is what plays when it is
// not there. A sync is a MERGE in both directions, never a file overwrite:
// pull the Pi's copy of this profile, fold its rows into ours (src/db.js
// mergeFrom), push the union back. Two computers and a laptop that played a
// week with no network all converge on the same history, in any order.
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
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CONNECT_S = 3;
const OP_MS = 20000;
const LOCK_STALE_MS = 120000;

const DEFAULTS = { enabled: true, host: 'chugo@hugopi', dir: 'piano-by-ear' };

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

  ssh(command, { timeout = OP_MS } = {}) {
    return execFileSync('ssh', ['-o', `ConnectTimeout=${CONNECT_S}`, '-o', 'BatchMode=yes', this.cfg.host, command], {
      timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  scp(from, to) {
    execFileSync('scp', ['-q', '-o', `ConnectTimeout=${CONNECT_S}`, '-o', 'BatchMode=yes', from, to], {
      timeout: OP_MS, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /**
   * Take the profile's lock on the Pi. mkdir is atomic, so two machines cannot
   * both hold it; a lock older than LOCK_STALE_MS is a crashed sync and is
   * broken rather than waited on.
   */
  lock(name) {
    const dir = q(`${this.locks}/${safe(name)}`);
    const out = this.ssh(
      `mkdir -p ${q(this.locks)} 2>/dev/null; ` +
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
    const pulled = join(this.tmpDir, `${name}.pull.db`);
    const pushed = join(this.tmpDir, `${name}.push.db`);
    const started = Date.now();
    let held = false;
    try {
      held = this.lock(name);
      if (!held) return { ok: false, reason: 'another machine is syncing this profile' };
      // scp on macOS speaks SFTP and does NOT run a remote shell, so its paths
      // are taken literally and must NOT be quoted; ssh runs a shell and its
      // paths must be. Mixing the two puts a file called 'Caleb'.db on the pi.
      const remote = `${this.profiles}/${safe(name)}.db`;
      const exists = this.ssh(`test -f ${q(remote)} && echo yes || echo no`).trim() === 'yes';
      let counts = null;
      if (exists) {
        rmSync(pulled, { force: true });
        this.scp(`${this.cfg.host}:${remote}`, pulled);
        counts = db.mergeFrom(pulled, { log: this.log });
      }
      db.snapshot(pushed);
      this.ssh(`mkdir -p ${q(this.profiles)}`);
      this.scp(pushed, `${this.cfg.host}:${remote}.new`);
      this.ssh(`mv ${q(`${remote}.new`)} ${q(remote)}`);
      const moved = counts ? Object.entries(counts).filter(([k, v]) => k !== 'kv' && v > 0).map(([k, v]) => `${v} ${k}`).join(', ') : '';
      this.log(
        `  sync${reason ? ` (${reason})` : ''}: ${exists ? (moved ? `pulled ${moved}` : 'nothing new to pull') : 'first copy on the pi'}` +
        `${stamped ? `, ${stamped} rows claimed` : ''}, pushed (${Date.now() - started}ms)`,
      );
      return { ok: true, counts };
    } catch (err) {
      const why = short(err);
      this.log(`  sync${reason ? ` (${reason})` : ''}: skipped -- ${why} (playing on the local copy)`);
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
  return /Connection|timed out|ETIMEDOUT|Could not resolve|No route|refused/i.test(msg) ? 'the pi is not reachable' : msg.split('\n')[0];
}

/** Profile names come from roster.js and are already tame; belt and braces. */
function safe(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _#-]{0,63}$/.test(name)) throw new Error(`unsafe profile name: ${name}`);
  return name;
}

/** Shell quoting, for the ssh side only. */
const q = (path) => `'${path}'`;
