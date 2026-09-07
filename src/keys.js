// The computer keyboard as a stand-in for the MIDI controller (when none is
// plugged in). Same events as src/midi.js, so the drill and free play treat
// it as just another port. Needs a terminal (raw stdin).
//
// GarageBand / Ableton "musical typing" layout:
//   white keys  A S D F G H J K L ; '   = C D E F G A B C D E F (A = C4)
//   black keys  W E   T Y U   O P       = C# D#  F# G# A#  C# D#
//   Z / X octave down / up, C / V softer / louder, Space = sustain on/off,
//   Q (or Ctrl-C) quits.
// A terminal never reports key release, so a note is held while its key
// autorepeats and released RELEASE_MS after the last repeat (longer than
// macOS's ~250 ms initial autorepeat delay).
export const PORT_NAME = 'Computer keyboard';
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
const RELEASE_MS = 350;
const SUSTAIN_CC = 64;
const CTRL_C = '\u0003';
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
export const LAYOUT = "A S D F G H J K L ; ' = C D E F G A B C D E F, W E T Y U O P = sharps, Z/X octave, C/V velocity, Space sustain, Q quit";

export class Keys {
  /**
   * @param {object} opts  same callbacks as Midi: onNoteOn({note, velocity, at, port}),
   *   onNoteOff({note, at, port}), onControl({type, number, value, port}), onPort(name, connected);
   *   plus onQuit(), echo (print each note name), log.
   */
  constructor({ onNoteOn, onNoteOff, onControl, onPort, onQuit, echo = false, log = console.log }) {
    Object.assign(this, { onNoteOn, onNoteOff, onControl, onPort, onQuit, echo, log });
    this.octave = 4;
    this.velocity = 90;
    this.pedal = false;
    this.timers = new Map(); // note -> release timer
    this.active = false;
    this.onData = (chunk) => this.handle(chunk);
  }

  get portNames() {
    return this.active ? [PORT_NAME] : [];
  }

  /** Take over the terminal. Returns false (and says so) when there is none. */
  start() {
    if (!process.stdin.isTTY) { this.log('computer keyboard needs a terminal; not enabled'); return false; }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this.onData);
    this.active = true;
    this.log(`computer keyboard: ${LAYOUT}`);
    this.onPort?.(PORT_NAME, true);
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    process.stdin.off('data', this.onData);
    try { process.stdin.setRawMode(false); } catch { /* not a tty any more */ }
    process.stdin.pause();
    for (const [note, t] of this.timers) { clearTimeout(t); this.onNoteOff?.({ note, at: performance.now(), port: PORT_NAME }); }
    this.timers.clear();
    this.onPort?.(PORT_NAME, false);
  }

  handle(chunk) {
    for (const ch of chunk) {
      if (ch === CTRL_C || ch === 'q' || ch === 'Q') { this.onQuit?.(); return; }
      const lower = ch.toLowerCase();
      if (lower === 'z') { this.octave = Math.max(0, this.octave - 1); this.log(`octave: A = C${this.octave}`); continue; }
      if (lower === 'x') { this.octave = Math.min(8, this.octave + 1); this.log(`octave: A = C${this.octave}`); continue; }
      if (lower === 'c') { this.velocity = Math.max(20, this.velocity - 10); this.log(`velocity ${this.velocity}`); continue; }
      if (lower === 'v') { this.velocity = Math.min(127, this.velocity + 10); this.log(`velocity ${this.velocity}`); continue; }
      if (ch === ' ') {
        this.pedal = !this.pedal;
        this.onControl?.({ type: 'cc', number: SUSTAIN_CC, value: this.pedal ? 127 : 0, port: PORT_NAME });
        this.log(`sustain ${this.pedal ? 'on' : 'off'}`);
        continue;
      }
      const off = KEYMAP[lower];
      if (off === undefined) continue;
      const note = 12 * (this.octave + 1) + off;
      const at = performance.now();
      if (this.timers.has(note)) clearTimeout(this.timers.get(note)); // autorepeat: still held
      else {
        this.onNoteOn?.({ note, velocity: this.velocity, at, port: PORT_NAME });
        if (this.echo) process.stdout.write(`${noteName(note)} `);
      }
      this.timers.set(note, setTimeout(() => {
        this.timers.delete(note);
        this.onNoteOff?.({ note, at: performance.now(), port: PORT_NAME });
      }, RELEASE_MS));
    }
  }
}
