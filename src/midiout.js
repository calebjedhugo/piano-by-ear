// MIDI output: the teacher's call played on the instrument's OWN sound engine,
// for a keyboard that makes sound of its own (a digital piano rather than a
// mute controller). Turned on from the launcher ("Use keyboard's own sound"),
// which writes ~/.piano-by-ear/sound; this is not a musical setting, it is
// which box makes the noise.
//
// The call goes out on its own channel, which on this instrument is always the
// grand however the panel is set -- so the player's chosen voice under their
// hands and the grand for the call are two different sounds for free. The
// metronome goes
// out too, on the instrument's own woodblock, so that everything the player
// hears comes from under their hands and headphones on the piano miss
// nothing. The player's keys are never echoed back: the instrument already
// sounds them locally, sooner than any round trip through here could.
//
// Ports come and go exactly as they do in src/midi.js, so every open is
// guarded and blank names are ignored.
import { Output } from '@julusian/midi';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SampledPiano } from './sampler.js';

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CONTROL_CHANGE = 0xb0;
const CC_VOLUME = 7;
const CC_PAN = 10;
const CC_ALL_NOTES_OFF = 123;

// Claimed on every connect. A control change sticks in the instrument until
// something changes it back -- across processes, and across a power cycle on
// some -- so a channel left panned or turned down by anything at all stays
// that way. Centre and full are what the drill wants: both voices in the same
// room as the player, neither of them off in one speaker.
const CENTRE = 64;
const FULL = 127;

// Channel 2, NOT the channel the player's keys speak on. The response is a
// canon, so the call is often still ringing while the answer is played: on one
// shared channel a call's note-off damps the player's own held note of that
// pitch, because one channel is one voice allocator. Its own channel keeps
// the two sets of hands out of each other's way.
//
// No program change is sent, and none would do anything. This channel's voice
// is WIRED TO THE GRAND and cannot be selected over MIDI: programs 0..7 all
// sounded identical, and so did the instrument's own captured voice-select
// bytes (CC 80/81 then a program change, which it transmits on channel 1 when
// a voice is picked at the panel) replayed here -- the effects in that capture
// took, the voice did not.
//
// That turns out to be the feature. The channel does NOT follow the panel:
// with the panel on the electric piano this channel still spoke as the grand.
// So the player picks their own voice at the panel, the call stays the grand
// one channel over, and the two are told apart without either of them being
// chosen here. Do not spend time hunting for a patch to set; there isn't one.
const CALL_CHANNEL = 2;
// The metronome, on the instrument's own click. Channel 10 is the only
// percussion it answers on, and 76/77 (hi/low woodblock) are the only notes
// there that sound -- side stick, cowbell and hi-hat are all silent, as is
// every melodic channel past 3. This is a fixed three-part instrument
// (main / split / layer) plus its own metronome, not a General MIDI module.
const CLICK_CHANNEL = 10;
const CLICK_ACCENT_NOTE = 76;
const CLICK_NOTE = 77;
const CLICK_ACCENT_VEL = 118;
const CLICK_VEL = 88;
const CLICK_MS = 60; // a one-shot; the note-off only tidies up after it
// Sent this many ms before the note is due, to cover the trip out through the
// interface. Measure it from the log's median onset before changing it: a
// constant sign across nearly every note is latency, not the player.
const OUT_LATENCY_MS = 0;

const SOUND_FILE = join(homedir(), '.piano-by-ear', 'sound');

/**
 * True when the instrument makes the sound. ~/.piano-by-ear/sound decides when
 * it exists (the launcher writes it). WITHOUT IT, THE KEYBOARD'S OWN SOUND
 * UNLESS THE PIANOS HAVE BEEN DOWNLOADED (2026-10-10, Caleb: most people who
 * get this have a digital piano; the sampled pianos are opt-in, for silent
 * controllers like his own). Downloading them is the choice of the app's sound.
 */
export function hardwareSound() {
  try {
    return readFileSync(SOUND_FILE, 'utf8').trim() === 'hardware';
  } catch {
    return !SampledPiano.available('grand');
  }
}

const CLICK_VOLUME_FILE = join(homedir(), '.piano-by-ear', 'click-volume');

/**
 * THE KEYBOARD'S METRONOME LEVEL, AS A PERCENT (2026-10-24). Some pianos'
 * woodblock is far louder than their piano (Caleb, away from home: "the
 * metronome on this piano is very loud"). ~/.piano-by-ear/click-volume holds
 * 0-100 and becomes channel 10's volume (CC 7) each time the port is claimed,
 * so only the click moves and the call keeps its level. No file: full, as
 * before. Read at every claim, so a change applies on the next reconnect.
 */
export function clickVolume() {
  try {
    const pct = Number(readFileSync(CLICK_VOLUME_FILE, 'utf8').trim());
    return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 100;
  } catch {
    return 100;
  }
}

const CLICKS_FILE = join(homedir(), '.piano-by-ear', 'clicks');

/**
 * True when the metronome should come from the computer even though the
 * keyboard makes the sound (2026-10-10). The woodblock on channel 10 is a
 * General MIDI drum: Roland and Yamaha's arrangers have it, but every Kawai
 * answers channel 10 with its piano (the click becomes E5/F5, a note nobody
 * asked for) and the drum-less Yamaha/Casio/Korg pianos are undocumented.
 * The launcher's "Metronome from the computer" writes ~/.piano-by-ear/clicks.
 */
export function computerClicks() {
  try {
    return readFileSync(CLICKS_FILE, 'utf8').trim() === 'computer';
  } catch {
    return false;
  }
}

// Outputs that are never the player's instrument. Windows lists its own
// software synth first, so "the first output" was the computer, not the
// keyboard; a Mac's IAC bus and network session go to other programs.
const NOT_AN_INSTRUMENT = /microsoft gs wavetable|^iac driver|network session/i;

export class MidiOut {
  /**
   * @param {object} opts
   * @param {string} [opts.match] only open a port whose name contains this
   * @param {(name: string, connected: boolean) => void} [opts.onPort]
   * @param {() => string[]} [opts.inputs] the MIDI inputs open now: an output
   *   with the same name is the same keyboard, and is preferred
   */
  constructor({ match, onPort, inputs = () => [] } = {}) {
    this.match = match?.toLowerCase();
    this.inputs = inputs;
    this.onPort = onPort;
    this.port = null; // the open Output, once there is one
    this.portName = null;
    this.pending = new Set(); // timers for notes not yet sent or released
    this.sounding = new Set(); // pitches currently down on the instrument
  }

  /** True once a port is open and the instrument can be played. */
  get ready() {
    return this.port !== null;
  }

  start(pollMs = 2000) {
    this.poll();
    this.poller = setInterval(() => this.poll(), pollMs);
    this.poller.unref();
  }

  listPorts() {
    try {
      return Output.getPortNames().filter((n) => n && n.trim() && !NOT_AN_INSTRUMENT.test(n) && (!this.match || n.toLowerCase().includes(this.match)));
    } catch {
      return [];
    }
  }

  poll() {
    const names = this.listPorts();
    if (this.port && !names.includes(this.portName)) {
      const gone = this.portName;
      this.close();
      this.onPort?.(gone, false);
    }
    if (this.port || names.length === 0) return;
    const playing = new Set(this.inputs());
    const name = names.find((n) => playing.has(n)) ?? names[0];
    const out = new Output();
    try {
      out.openPortByName(name);
    } catch {
      try { out.destroy(); } catch { /* ignore */ }
      return; // retry on the next poll
    }
    this.port = out;
    this.portName = name;
    this.claim();
    this.onPort?.(name, true);
  }

  /** Put our channels back where they belong, whatever left them elsewhere. */
  claim() {
    for (const ch of [CALL_CHANNEL, CLICK_CHANNEL]) {
      const level = ch === CLICK_CHANNEL ? Math.round((FULL * clickVolume()) / 100) : FULL;
      this.send([CONTROL_CHANGE | (ch - 1), CC_PAN, CENTRE]);
      this.send([CONTROL_CHANGE | (ch - 1), CC_VOLUME, level]);
    }
  }

  send(bytes) {
    if (!this.port) return false;
    try {
      this.port.sendMessage(bytes);
      return true;
    } catch {
      return false; // port going away; the next poll will notice
    }
  }

  /**
   * Play one call note: down at `delayMs` from now, up `durationS` later.
   * Unlike the sampled pianos this cannot be scheduled on the audio clock, so
   * it rides a timer and carries that timer's jitter.
   */
  play(midi, velocity, delayMs, durationS) {
    if (!this.port) return false;
    const wait = Math.max(0, delayMs - OUT_LATENCY_MS);
    const on = setTimeout(() => {
      this.pending.delete(on);
      if (this.sounding.has(midi)) this.send([NOTE_OFF | (CALL_CHANNEL - 1), midi, 0]);
      if (!this.send([NOTE_ON | (CALL_CHANNEL - 1), midi, velocity])) return;
      this.sounding.add(midi);
      const off = setTimeout(() => {
        this.pending.delete(off);
        this.sounding.delete(midi);
        this.send([NOTE_OFF | (CALL_CHANNEL - 1), midi, 0]);
      }, Math.max(1, durationS * 1000));
      off.unref?.();
      this.pending.add(off);
    }, wait);
    on.unref?.();
    this.pending.add(on);
    return true;
  }

  /**
   * The metronome, on the instrument's own woodblock. The grid is the one
   * thing here the player locks to, so it carries the timer's jitter and the
   * interface's latency straight into their playing: see OUT_LATENCY_MS.
   */
  click(delayMs, accent = false) {
    if (!this.port) return false;
    const ch = CLICK_CHANNEL - 1;
    const note = accent ? CLICK_ACCENT_NOTE : CLICK_NOTE;
    const on = setTimeout(() => {
      this.pending.delete(on);
      if (!this.send([NOTE_ON | ch, note, accent ? CLICK_ACCENT_VEL : CLICK_VEL])) return;
      const off = setTimeout(() => {
        this.pending.delete(off);
        this.send([NOTE_OFF | ch, note, 0]);
      }, CLICK_MS);
      off.unref?.();
      this.pending.add(off);
    }, Math.max(0, delayMs - OUT_LATENCY_MS));
    on.unref?.();
    this.pending.add(on);
    return true;
  }

  /** Drop anything still scheduled and silence whatever we left ringing. */
  silence() {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    for (const midi of this.sounding) this.send([NOTE_OFF | (CALL_CHANNEL - 1), midi, 0]);
    this.sounding.clear();
    this.send([CONTROL_CHANGE | (CALL_CHANNEL - 1), CC_ALL_NOTES_OFF, 0]);
    this.send([CONTROL_CHANGE | (CLICK_CHANNEL - 1), CC_ALL_NOTES_OFF, 0]);
  }

  close() {
    this.silence();
    if (this.port) {
      try { this.port.closePort(); } catch { /* already gone */ }
      try { this.port.destroy(); } catch { /* ignore */ }
    }
    this.port = null;
    this.portName = null;
  }

  stop() {
    clearInterval(this.poller);
    this.close();
  }
}
