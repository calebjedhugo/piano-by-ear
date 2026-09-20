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
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

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

  ssh(command, { timeout = OP_MS } = {}) {
    return execFileSync('ssh', ['-o', `ConnectTimeout=${CONNECT_S}`, '-o', 'BatchMode=yes', ...MUX, this.cfg.host, command], {
      timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    const pulled = join(this.tmpDir, `${name}.pull.db`);
    const pushed = join(this.tmpDir, `${name}.push.db`);
    const started = Date.now();
    let held = false;
    try {
      // THE CHEAP QUESTION FIRST. Neither side moved since our last push --
      // which is the ordinary case, one house, one player at a time -- and
      // there is nothing to do but say so. One round trip instead of two
      // transfers of three megabytes, and it is what makes a login instant.
      const before = this.fingerprint(name);
      const mine = db.localSignature();
      if (before.rev && before.rev === seen.remote && mine === seen.local) {
        this.log(`  sync${reason ? ` (${reason})` : ''}: already in step with the pi (${Date.now() - started}ms)`);
        return { ok: true, counts: null, skipped: true };
      }

      held = this.lock(name);
      if (!held) return { ok: false, reason: 'another machine is syncing this profile' };
      // scp on macOS speaks SFTP and does NOT run a remote shell, so its paths
      // are taken literally and must NOT be quoted; ssh runs a shell and its
      // paths must be. Mixing the two puts a file called 'Caleb'.db on the pi.
      const remote = `${this.profiles}/${safe(name)}.db`;
      let counts = null;
      if (before.exists) {
        rmSync(pulled, { force: true });
        this.scp(`${this.cfg.host}:${remote}`, pulled);
        counts = db.mergeFrom(pulled, { log: this.log });
      }
      const gained = counts ? Object.entries(counts).filter(([k, v]) => k !== 'kv' && v > 0) : [];
      // If we contributed nothing and only took, the pi already holds
      // everything we do: skip the push and half the transfer with it. That is
      // the downstairs machine's ordinary login after a sitting upstairs.
      const contributed = mine !== seen.local || stamped > 0 || !before.exists;
      if (!contributed && before.rev) {
        state.save({ remote: before.rev, local: db.localSignature() });
        this.log(
          `  sync${reason ? ` (${reason})` : ''}: pulled ${gained.map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new'}` +
          `, nothing of ours to send (${Date.now() - started}ms)`,
        );
        return { ok: true, counts };
      }
      db.snapshot(pushed);
      this.scp(pushed, `${this.cfg.host}:${remote}.new`);
      // The lock call already made both directories: scp needs the destination
      // to exist BEFORE it runs, which is why the mkdir cannot live here.
      // The token and the file move together, so the pi never holds a database
      // labelled with the previous push's token.
      const token = randomUUID();
      this.ssh(`mv ${q(`${remote}.new`)} ${q(remote)} && printf %s ${q(token)} > ${q(`${this.profiles}/${safe(name)}.rev`)}`);
      state.save({ remote: token, local: db.localSignature() });
      const moved = gained.map(([k, v]) => `${v} ${k}`).join(', ');
      this.log(
        `  sync${reason ? ` (${reason})` : ''}: ${!before.exists ? 'first copy on the pi' : (moved ? `pulled ${moved}` : 'nothing new to pull')}` +
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
