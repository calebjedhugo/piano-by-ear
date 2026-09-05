// MIDI input: opens the first port matching `match` (substring, case-
// insensitive) or the first port at all, re-polls for hot-plug, and emits
// note-ons timestamped with performance.now() so the drill can place them on
// the audio clock. Note-on velocity 0 is treated as note-off and dropped.
import { Input } from '@julusian/midi';

const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const PROGRAM_CHANGE = 0xc0;

export class Midi {
  /**
   * @param {object} opts
   * @param {string} [opts.match]
   * @param {(e: {note: number, velocity: number, at: number}) => void} opts.onNoteOn
   * @param {(e: {type: 'cc'|'pc', number: number, value: number}) => void} [opts.onControl]
   * @param {(name: string|null) => void} [opts.onPort]
   */
  constructor({ match, onNoteOn, onControl, onPort }) {
    this.match = match?.toLowerCase();
    this.onNoteOn = onNoteOn;
    this.onControl = onControl;
    this.onPort = onPort;
    this.input = null;
    this.portName = null;
    this.debug = false;
  }

  start(pollMs = 2000) {
    this.tryOpen();
    this.poller = setInterval(() => this.tryOpen(), pollMs);
    this.poller.unref();
  }

  listPorts() {
    const probe = new Input();
    const names = [];
    for (let i = 0; i < probe.getPortCount(); i += 1) names.push(probe.getPortName(i));
    probe.destroy();
    return names;
  }

  tryOpen() {
    const names = this.listPorts();
    if (this.input) {
      if (names.includes(this.portName)) return; // still there
      this.input.closePort();
      this.input.destroy();
      this.input = null;
      this.portName = null;
      this.onPort?.(null);
    }
    let index = -1;
    if (this.match) index = names.findIndex((n) => n.toLowerCase().includes(this.match));
    else if (names.length > 0) index = 0;
    if (index < 0) return;

    const input = new Input();
    input.ignoreTypes(true, true, true);
    input.on('message', (_delta, data) => this.handle(data));
    input.openPort(index);
    this.input = input;
    this.portName = names[index];
    this.onPort?.(this.portName);
  }

  handle(data) {
    const at = performance.now();
    if (this.debug) console.log('MIDI', data.join(' '));
    const type = data[0] & 0xf0;
    if (type === NOTE_ON) {
      if (data[2] === 0) return;
      this.onNoteOn({ note: data[1], velocity: data[2], at });
    } else if (type === CONTROL_CHANGE) {
      this.onControl?.({ type: 'cc', number: data[1], value: data[2] });
    } else if (type === PROGRAM_CHANGE) {
      this.onControl?.({ type: 'pc', number: data[1], value: 127 });
    }
  }

  stop() {
    clearInterval(this.poller);
    if (this.input) {
      this.input.closePort();
      this.input.destroy();
      this.input = null;
    }
  }
}
