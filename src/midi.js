// MIDI input: opens EVERY input port (optionally only those whose name
// contains `match`), re-polls for hot-plug, and emits note-ons timestamped
// with performance.now() so the drill can place them on the audio clock.
// Each event carries its port name so the range tracker can key per
// controller. Note-on velocity 0 is treated as note-off and dropped.
//
// CoreMIDI briefly lists a vanishing endpoint with an empty name, and
// opening a port can throw while it is going away, so every open is guarded
// and blank names are ignored.
import { Input } from '@julusian/midi';

const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const PROGRAM_CHANGE = 0xc0;

export class Midi {
  /**
   * @param {object} opts
   * @param {string} [opts.match]
   * @param {(e: {note: number, velocity: number, at: number, port: string}) => void} opts.onNoteOn
   * @param {(e: {type: 'cc'|'pc', number: number, value: number, port: string}) => void} [opts.onControl]
   * @param {(name: string, connected: boolean) => void} [opts.onPort]
   */
  constructor({ match, onNoteOn, onControl, onPort }) {
    this.match = match?.toLowerCase();
    this.onNoteOn = onNoteOn;
    this.onControl = onControl;
    this.onPort = onPort;
    this.inputs = new Map(); // port name -> Input
    this.debug = false;
  }

  start(pollMs = 2000) {
    this.poll();
    this.poller = setInterval(() => this.poll(), pollMs);
    this.poller.unref();
  }

  listPorts() {
    try {
      return Input.getPortNames().filter((n) => n && n.trim() && (!this.match || n.toLowerCase().includes(this.match)));
    } catch {
      return [];
    }
  }

  get portNames() {
    return [...this.inputs.keys()];
  }

  poll() {
    const names = this.listPorts();
    for (const [name, input] of this.inputs) {
      if (names.includes(name)) continue;
      try {
        input.closePort();
        input.destroy();
      } catch {
        /* already gone */
      }
      this.inputs.delete(name);
      this.onPort?.(name, false);
    }
    for (const name of names) {
      if (this.inputs.has(name)) continue;
      const input = new Input();
      try {
        input.ignoreTypes(true, true, true);
        input.on('message', (_delta, data) => this.handle(data, name));
        input.openPortByName(name);
      } catch {
        try {
          input.destroy();
        } catch {
          /* ignore */
        }
        continue; // retry on the next poll
      }
      this.inputs.set(name, input);
      this.onPort?.(name, true);
    }
  }

  handle(data, port) {
    const at = performance.now();
    if (this.debug) console.log('MIDI', port, data.join(' '));
    const type = data[0] & 0xf0;
    if (type === NOTE_ON) {
      if (data[2] === 0) return;
      this.onNoteOn({ note: data[1], velocity: data[2], at, port });
    } else if (type === CONTROL_CHANGE) {
      this.onControl?.({ type: 'cc', number: data[1], value: data[2], port });
    } else if (type === PROGRAM_CHANGE) {
      this.onControl?.({ type: 'pc', number: data[1], value: 127, port });
    }
  }

  stop() {
    clearInterval(this.poller);
    for (const [name, input] of this.inputs) {
      try {
        input.closePort();
        input.destroy();
      } catch {
        /* ignore */
      }
      this.inputs.delete(name);
    }
  }
}
