// Print the names of the MIDI input ports present right now, one per line
// (virtual test ports named PBE* excluded). Used by the launcher to decide
// whether to offer the computer keyboard.
import { Input } from '@julusian/midi';
const inp = new Input();
for (let i = 0; i < inp.getPortCount(); i += 1) {
  const n = inp.getPortName(i);
  if (!/^PBE /.test(n)) console.log(n);
}
inp.destroy?.();
process.exit(0);
