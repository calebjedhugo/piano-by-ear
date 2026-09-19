// THE DOOR. Before 2026-09-19 the profile was chosen from a menu in the
// launcher and opened at boot; now the keyboard chooses it, because the
// keyboard is the only thing this program has ever let you talk to.
//
//   LOBBY   nothing is open and nothing is graded. Your keys still sound --
//           they are your own hands. The FIRST thing you play is who you are:
//             a CHORD on the roster  -> that profile opens
//             a chord nobody owns    -> a NEW profile, there and then
//             a single note          -> Guest (wiped every time)
//           A chord is a SET, so it may be rolled or spread; it is complete
//           when every key has been up for CHORD_GRACE_MS. Exact MIDI notes,
//           octave included -- the octave is the only thing between C4-E4-G4
//           and C5-E5-G5, and those are two different players.
//   LOADED  the profile is open and the low-high click has said so. Play your
//           anchor and the session starts. Sit still as long as it takes to
//           end a session and the profile closes again -- the next person at
//           the keyboard should have to say who they are.
//
// THE PROFILE CLOSES OUT WITH THE SESSION. Ten seconds of silence ends the
// sitting, and the same silence is the answer to "is anyone still there", so
// making him wait a second ten before the door shuts only meant twenty
// seconds of nothing meant the same thing twice. It closes a beat later, not
// at once: the session-over clicks go out on setTimeout (src/midiout.js), and
// a sync blocks the event loop for seconds, which would swallow them.
// The profile's history is merged with the pi (src/sync.js) as it opens and
// as it closes.
import { rmSync } from 'node:fs';

const MIN_VELOCITY = 20; // the drill's own threshold: a brush is not a login
const CHORD_GRACE_MS = 300; // long enough for a rolled chord and a ragged release
const TICK_MS = 500;
const CLOSE_AFTER_SESSION_MS = 1200; // long enough for audio.sessionOver() to finish sounding

export class Lobby {
  /**
   * @param {object} deps
   * @param {import('./audio.js').Audio} deps.audio
   * @param {import('./roster.js').Roster} deps.roster
   * @param {(name: string, opts: {guest: boolean}) => {db: any, drill: any}} deps.open
   * @param {(name: string) => string} deps.dbPath
   * @param {import('./sync.js').Sync} deps.sync
   * @param {(name: string|null) => void} deps.announce  who is loaded, for the launcher
   * @param {(msg: string) => void} deps.log
   */
  constructor({ audio, roster, open, dbPath, sync, announce, log }) {
    this.audio = audio;
    this.roster = roster;
    this.open = open;
    this.dbPath = dbPath;
    this.sync = sync;
    this.announce = announce;
    this.log = log;
    this.profile = null; // { name, db, drill, guest }
    this.held = new Set();
    this.pending = new Set(); // the chord being played, collected across releases
    this.decideAt = null;
    this.needsSync = false; // a sitting has happened that the pi has not got
    this.closeAt = null; // the session is over and the door is closing
    this.idleSince = performance.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  get loaded() {
    return Boolean(this.profile);
  }

  // --- input ---------------------------------------------------------------

  onNoteOn(e) {
    if (this.loaded) {
      this.idleSince = performance.now();
      this.profile.drill.onNoteOn(e);
      return;
    }
    this.audio.startVoice(e.note, e.velocity);
    if (e.velocity < MIN_VELOCITY) return;
    this.held.add(e.note);
    this.pending.add(e.note);
    this.decideAt = null; // a key is down: the chord is not finished
  }

  onNoteOff(e) {
    if (this.loaded) {
      this.profile.drill.onNoteOff(e);
      return;
    }
    this.audio.stopVoice(e.note);
    this.held.delete(e.note);
    if (this.pending.size && this.held.size === 0) this.decideAt = performance.now() + CHORD_GRACE_MS;
  }

  tick() {
    if (!this.loaded) {
      if (this.decideAt && performance.now() >= this.decideAt) {
        const notes = [...this.pending];
        this.pending.clear();
        this.decideAt = null;
        this.login(notes);
      }
      return;
    }
    // `drill.state` is IDLE between sessions and while waiting for the very
    // first anchor -- the only two places the door can shut.
    if (this.profile.drill.state !== 'IDLE') {
      this.idleSince = performance.now();
      this.closeAt = null;
      return;
    }
    if (this.closeAt) {
      if (performance.now() >= this.closeAt) this.unload('the session ended');
      return;
    }
    // A chord that never became an anchor: somebody logged in and walked away.
    if (performance.now() - this.idleSince > this.profile.drill.stage.timeoutMs) this.unload('nobody there');
  }

  // --- the door ------------------------------------------------------------

  login(notes) {
    if (notes.length === 0) return;
    if (notes.length === 1) return this.load('Guest', { guest: true, why: 'a single note' });
    const known = this.roster.match(notes);
    if (known) return this.load(known.name, { guest: false, why: 'chord' });
    const made = this.roster.create(notes);
    this.log(`new profile: ${made.name} (${made.chord.join(' ')}) -- play that chord again any time to come back`);
    this.load(made.name, { guest: false, why: 'a chord nobody owned' });
  }

  load(name, { guest, why }) {
    this.log(`${guest ? 'guest' : name}: ${why}`);
    if (guest) for (const s of ['', '-wal', '-shm']) rmSync(this.dbPath('Guest') + s, { force: true });
    let opened;
    try {
      opened = this.open(name, { guest });
    } catch (err) {
      this.log(`could not open ${name}: ${err.message}`);
      return;
    }
    this.profile = { name, guest, ...opened };
    // A guest leaves no trace and has nothing to merge.
    if (!guest) this.sync.run(opened.db, name, { reason: 'opening' });
    this.roster.touch(name);
    this.announce(name);
    this.idleSince = performance.now();
    this.audio.ready(); // low-high: the profile is open, play your anchor
  }

  /** A session just ended: close the profile, once it has finished sounding. */
  afterSession() {
    if (!this.profile) return;
    this.closeAt = performance.now() + CLOSE_AFTER_SESSION_MS;
    if (this.profile.guest) return;
    this.roster.touch(this.profile.name);
    this.needsSync = true;
  }

  /**
   * The keyboard vanished. END THE SITTING BUT KEEP THE PROFILE: a bluetooth
   * controller drops for a moment more often than a player leaves, and making
   * him replay his chord for a dropout would be a punishment for the radio.
   * If he really has gone, the LOADED timeout closes it a few seconds later.
   */
  pause(reason) {
    if (!this.profile) return;
    if (this.profile.drill.state !== 'IDLE') this.log(`  ${reason}: ending the sitting`);
    this.profile.drill.stop();
    this.held.clear();
  }

  unload(reason) {
    if (!this.profile) return;
    const { name, db, drill, guest } = this.profile;
    drill.stop({ silent: true });
    // Only if a sitting actually happened: opening a profile and walking away
    // without playing has nothing to send.
    if (!guest && this.needsSync) this.sync.run(db, name, { reason: 'session over' });
    this.needsSync = false;
    this.closeAt = null;
    db.close();
    this.profile = null;
    this.held.clear();
    this.pending.clear();
    this.decideAt = null;
    this.announce(null);
    this.log(`${name} closed (${reason}). Play your chord to come back.`);
  }

  stop() {
    clearInterval(this.timer);
    this.unload('stopping');
  }
}
