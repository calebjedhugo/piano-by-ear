// Headless simulation: a scripted player answers the drill, fast, against a
// scratch or copied profile. Never point it at a live profile.
//   node scripts/sim.mjs <db> <player> <questions> [bpm] [nophrases]
// players: perfect | sloppy (20% one-semitone slips) | kid (direction right
// 85%, size random) | liz (half exact, else 1-2 semitones off) | random.
// "nophrases" leaves the passage banks out (the round needs plain questions).
import { Audio } from '../src/audio.js';
import { Db } from '../src/db.js';
import { AdaptiveEngine } from '../src/engine.js';
import { Drill } from '../src/drill.js';
import { PhraseBank, MONO_PATH, HYMNS_PATH, POLY_PATH } from '../src/phrases.js';
import { RangeTracker } from '../src/range.js';

const [dbPath, player = 'perfect', maxQ = '30', bpm = '160', nophrases = ''] = process.argv.slice(2);
const log = (m) => console.log(m);
const db = new Db(dbPath);
db.backfillPassages();
const audio = new Audio();
audio.master.gain.value = 0;
const range = new RangeTracker(db.kv('ranges'));
range.setPort('Keystation Pro 88');
const phrases = new PhraseBank({ store: db.kv('phraseStats'), path: [MONO_PATH, HYMNS_PATH] });
const poly = new PhraseBank({ store: db.kv('polyStats'), path: POLY_PATH });
const drill = new Drill({ audio, db, range, phrases: nophrases ? null : phrases, poly: nophrases ? null : poly, log, bpmOverride: Number(bpm),
  makeEngine: (lo, hi, fluentMs, which) => new AdaptiveEngine({ range: hi - lo, fluentMs, pitchClassOffset: lo % 12, store: db.engineStore(which) }) });

const rnd = (n) => Math.floor(Math.random() * n);
function answerFor(anchor, target) {
  const iv = target - anchor;
  switch (player) {
    case 'perfect': return target;
    case 'sloppy': return Math.random() < 0.2 ? target + (Math.random() < 0.5 ? 1 : -1) : target;
    case 'kid': { const dir = Math.random() < 0.85 ? Math.sign(iv) || 1 : -(Math.sign(iv) || 1); return anchor + dir * (1 + rnd(12)); }
    case 'liz': return Math.random() < 0.5 ? target : target + (Math.random() < 0.5 ? 1 : -2);
    default: return 40 + rnd(50);
  }
}
let stopped = false; // a press scheduled before the run ended must not start a new session
const press = (midi, atAudio) => {
  if (stopped) return;
  drill.onNoteOn({ note: midi, velocity: 90, at: drill.audioToPerf(atAudio), port: 'Keystation Pro 88' });
  setTimeout(() => drill.onNoteOff({ note: midi, at: drill.audioToPerf(audio.now) }), 0.85 * drill.beat * 1000);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

drill.onNoteOn({ note: 62, velocity: 90, at: performance.now(), port: 'Keystation Pro 88' });
setTimeout(() => drill.onNoteOff({ note: 62, at: performance.now() }), 150);
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e.stack); process.exit(1); });
let seen = 0;
let played = null;
while (drill.state === 'QUESTION' && drill.questions <= Number(maxQ)) {
  await sleep(20);
  const q = drill.q;
  if (!q || drill.answered || played === drill.questions) continue;
  if (q.collect) { played = drill.questions; const t = audio.now + 0.2; press(60, t); setTimeout(() => press(64, audio.now), drill.beat * 1000); setTimeout(() => press(62, audio.now), 2 * drill.beat * 1000); continue; }
  played = drill.questions;
  // answer each group one beat behind the call
  const t0 = drill.callT0;
  const beat = drill.beat;
  const groups = drill.groups;
  let prevPlayed = null;
  for (const g of groups) {
    const at = t0 + (g.b + 1) * beat;
    for (const e of g.notes) {
      if (e.free && e.silent) continue;
      const from = e.melodicFrom ?? drill.anchor;
      const m = e.free ? (player === 'sloppy' && Math.random() < Number(process.env.FUMBLE ?? 0.25) ? e.midi + 1 : e.midi) : answerFor(prevPlayed ?? from, e.midi);
      const delay = Math.max(0, (at - audio.now) * 1000);
      setTimeout(() => press(m, at), delay);
      if (!e.free) prevPlayed = m;
    }
  }
  seen += 1;
}
await sleep(500);
stopped = true;
drill.stop({ silent: true });
console.log(`--- ${seen} questions answered, stage ${drill.stage.current}`);
await audio.close();
db.close();
// The audio render thread keeps the loop alive after close(); nothing is
// pending, so leave rather than hang (a chained run would never start).
process.exit(0);
