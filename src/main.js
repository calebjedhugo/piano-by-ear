#!/usr/bin/env node
// piano-by-ear: headless learn-piano-by-ear drill for a MIDI controller.
//
//   node src/main.js [--port <substring>] [--profiles <dir>] [--user <name>]
//                    [--keys <lo..hi>] [--debug-midi]
//
// No musical settings: tempo, question type, passage length and timing
// tolerance are all decided from your history (see src/drill.js).
//
// WHO IS PLAYING IS ALSO DECIDED FROM THE KEYBOARD (src/lobby.js): the drill
// boots with no profile open and the first thing you play says who you are --
// your chord opens your history, an unknown chord starts a new one, a single
// note is a guest. `--user` skips that, for development only.
//
// A profile's history lives on the pi and is MERGED with it, in both
// directions, as the profile opens and every time a session ends
// (src/sync.js). No network means you play on the local copy and it catches
// up later, which is the whole point: the laptop travels.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { Audio } from './audio.js';
import { Db } from './db.js';
import { Midi } from './midi.js';
import { MidiOut, hardwareSound } from './midiout.js';
import { RangeTracker } from './range.js';
import { AdaptiveEngine } from './engine.js';
import { Drill } from './drill.js';
import { Lobby } from './lobby.js';
import { Roster, RETIRE_DAYS } from './roster.js';
import { Sync, syncConfig } from './sync.js';
import { deviceId } from './device.js';
import { PhraseBank, MONO_PATH, HYMNS_PATH, POLY_PATH } from './phrases.js';

const DATA = join(homedir(), '.piano-by-ear');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    profiles: { type: 'string', default: join(DATA, 'profiles') },
    user: { type: 'string' }, // development: open a profile without the chord
    'debug-midi': { type: 'boolean', default: false },
    // A SMALL MACHINE'S LEVER, not a musical setting. The sampled pianos
    // decode every kept layer for these keys into memory at startup: the
    // whole 88 costs ~690MB RSS, a 61-key range ~545MB, a 25-key one ~400MB.
    // Trim it ONLY where one controller is permanently attached: a key
    // outside the decoded range falls back to the synth mid-sitting, silently
    // and audibly, which is exactly what happens on a machine where a second
    // keyboard gets switched on later.
    keys: { type: 'string' },
    // developer overrides, not for normal use
    bpm: { type: 'string' },
    composer: { type: 'string' },
  },
});

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const bpmOverride = args.bpm ? Number(args.bpm) : null;
if (args.bpm && !(bpmOverride > 0)) {
  console.error('--bpm must be a positive number');
  process.exit(1);
}

const keyRange = (() => {
  if (!args.keys) return {}; // the full 88: every controller is covered
  const m = /^(\d+)\.\.(\d+)$/.exec(args.keys);
  if (!m || Number(m[1]) >= Number(m[2])) {
    console.error('--keys must look like 36..96 (MIDI note numbers, low..high)');
    process.exit(1);
  }
  return { lo: Number(m[1]), hi: Number(m[2]) };
})();

const PROFILES = args.profiles;
const TMP = join(DATA, 'tmp');
mkdirSync(PROFILES, { recursive: true });
mkdirSync(TMP, { recursive: true });
const dbPath = (name) => join(PROFILES, `${name}.db`);

const device = deviceId(join(DATA, 'device-id'));
const roster = new Roster(join(DATA, 'roster.json'));
const sync = new Sync({ config: syncConfig(join(DATA, 'sync.json')), device: device.id, tmpDir: TMP, log });
log(`this machine: ${device.label} (${device.id})${sync.enabled ? ` <-> ${sync.cfg.host}:${sync.cfg.dir}` : ' (sync off)'}`);
sync.syncRoster(roster);
reconcileLastPlayed();
retire();

/**
 * The roster's clock only moves when a profile is CLOSED on some machine, so
 * a profile played by an older build -- or by --user, or on a machine whose
 * roster never reached the pi -- can look idle when it is not. Retirement
 * deletes a login, so it reads the local history too and takes the later of
 * the two. It only ever moves the clock forward.
 */
function reconcileLastPlayed() {
  for (const p of roster.live) {
    if (!existsSync(dbPath(p.name))) continue;
    let db = null;
    try {
      db = new Db(dbPath(p.name));
      const last = db.lastSessionAt();
      if (last > (p.lastPlayedAt ?? 0)) {
        p.lastPlayedAt = last;
        roster.save();
      }
    } catch {
      /* a db we cannot read is not evidence of idleness either way */
    } finally {
      db?.close();
    }
  }
}

/**
 * SOFT DELETE, from the shared clock. A profile nobody has played for
 * RETIRE_DAYS stops being a login: its db is moved aside (never deleted) and
 * its chord no longer matches, so playing it again starts a fresh profile.
 * Bringing one back is deliberate -- move the file back and clear `retiredAt`
 * in roster.json.
 */
function retire() {
  const due = roster.dueForRetirement();
  if (!due.length) return;
  const retiredDir = join(PROFILES, 'retired');
  mkdirSync(retiredDir, { recursive: true });
  for (const p of due) {
    roster.retire(p.name);
    for (const suffix of ['', '-wal', '-shm']) {
      const from = dbPath(p.name) + suffix;
      if (existsSync(from)) renameSync(from, join(retiredDir, `${p.name}.db${suffix}`));
    }
    sync.retireRemote(p.name);
    log(`retired ${p.name}: nobody has played it in ${RETIRE_DAYS} days (history kept in profiles/retired)`);
  }
  sync.syncRoster(roster);
}

const hardware = hardwareSound();
const audio = new Audio({ hardware });
const phraseFiles = { mono: [MONO_PATH, HYMNS_PATH], poly: POLY_PATH };
let currentPort = null;

// Parse the corpus NOW, while nobody is waiting. PhraseBank keeps one copy per
// process, so this is the only time anybody pays for it -- otherwise the first
// login of the day pays it, between the chord and the click, which is the one
// moment in the program where a wait is felt.
{
  const t0 = performance.now();
  const store = { load: () => null, save: () => {} };
  const mono = new PhraseBank({ store, composer: args.composer, path: phraseFiles.mono });
  const poly = new PhraseBank({ store, composer: args.composer, path: phraseFiles.poly });
  log(`corpus: ${mono.size} melodic + ${poly.size} polyphonic passages (${Math.round(performance.now() - t0)} ms)`);
}

/** Everything that belongs to one player, built when the chord opens them. */
function openProfile(name) {
  const db = new Db(dbPath(name));
  const backfilled = db.backfillPassages();
  if (backfilled) log(`passages: rung summaries built for ${backfilled} earlier passages`);
  const range = new RangeTracker(db.kv('ranges'));
  if (currentPort) range.setPort(currentPort);
  const phrases = new PhraseBank({ store: db.kv('phraseStats'), composer: args.composer, path: phraseFiles.mono });
  const poly = new PhraseBank({ store: db.kv('polyStats'), composer: args.composer, path: phraseFiles.poly });
  const drill = new Drill({
    audio, db, range, phrases, poly, log, bpmOverride,
    onSessionEnd: () => lobby.afterSession(),
    makeEngine: (lo, hi, fluentMs, which) =>
      new AdaptiveEngine({ range: hi - lo, fluentMs, pitchClassOffset: lo % 12, store: db.engineStore(which) }),
  });
  const { lo, hi } = range.current;
  log(`${name}: range ${lo}..${hi}`);
  return { db, drill };
}

const lobby = new Lobby({
  audio,
  roster,
  sync,
  dbPath,
  open: openProfile,
  announce: (name) => {
    try {
      writeFileSync(join(DATA, 'current-user'), name ?? '');
    } catch {
      /* the launcher will just show nobody */
    }
  },
  log,
});

const midi = new Midi({
  match: args.port,
  onNoteOn: (e) => lobby.onNoteOn(e),
  onNoteOff: (e) => lobby.onNoteOff(e),
  onPort: (portName, connected) => {
    if (connected) {
      currentPort = portName;
      log(`MIDI in: ${portName}`);
      audio.listening();
    } else {
      log(`MIDI disconnected: ${portName}`);
      if (midi.portNames.length === 0) lobby.pause('the keyboard went away');
    }
  },
});
midi.debug = args['debug-midi'];

const out = hardware
  ? new MidiOut({
      match: args.port,
      onPort: (name, connected) => log(connected ? `MIDI out: ${name} (the call plays on your keyboard)` : `MIDI out disconnected: ${name}`),
    })
  : null;
if (out) {
  audio.attach(out);
  out.start();
}

log(`piano-by-ear  profiles: ${roster.live.map((p) => p.name).join(', ') || 'none yet'}`);
audio.load(keyRange).then(({ detail }) => log(`voice: ${detail}${args.keys ? `, keys ${args.keys} only` : ''}`), (err) => log(`voice: synth (samples failed to load: ${err.message})`));
midi.start();
if (midi.portNames.length === 0) log('no MIDI inputs yet; plug in a controller (polling every 2s)');
if (args.user) lobby.load(args.user, { guest: args.user === 'Guest', why: '--user' });
else log('play your chord to open your profile, or a single note to play as a guest');

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  lobby.stop();
  midi.stop();
  out?.stop();
  audio.close().catch(() => {}).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
