// WHO IS AT THE KEYBOARD, decided from a chord. There is no user list to pick
// from and no name to type: each player has a chord, and playing it opens that
// profile. An unknown chord is a NEW player -- it creates a profile on the
// spot. A single note is a guest.
//
// The chord is matched on EXACT MIDI NOTES, octave included, because the
// octave is the only thing separating two of the family chords (C4-E4-G4 and
// C5-E5-G5). Register is the identity, not the triad.
//
// A profile no one has played for RETIRE_DAYS is SOFT DELETED: its db moves
// to profiles/retired/ and its roster entry is marked. A retired chord no
// longer matches -- playing it starts a fresh profile. Bringing one back is a
// deliberate act (restore()), never something the keyboard can do by accident.
//
// THE ROSTER TRAVELS WITH THE PROFILES (src/sync.js). A chord registered on
// the downstairs computer has to open the same profile upstairs, and -- the
// sharper reason -- retirement is decided from `lastPlayedAt`, which only the
// machine that was played knows. Without a shared roster, a computer that has
// not seen Liz for a month retires her while she is playing daily on the
// other one, and her chord then mints an empty duplicate. Entries merge one
// by one, newest `updatedAt` wins, keyed by the chord itself.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const RETIRE_DAYS = 30;
const NAME_MAX = 40; // comfortably inside the sync's 64-character limit
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "Eb4" | "C#4" | "C4" -> MIDI (C4 = 60, the app's own naming). */
export function parseNote(str) {
  const m = /^([A-Ga-g])([#sb]?)(-?\d+)$/.exec(String(str).trim());
  if (!m) throw new Error(`not a note name: ${str}`);
  const accidental = m[2] === 'b' ? -1 : m[2] ? 1 : 0;
  return (Number(m[3]) + 1) * 12 + STEP[m[1].toUpperCase()] + accidental;
}

export function noteName(midi) {
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** A chord is a SET of notes: order and doubling never matter. */
const keyOf = (notes) => [...new Set(notes)].sort((a, b) => a - b).join(',');

// The family, seeded on first run. After that the file is the truth -- editing
// these does nothing to a roster that already exists.
const SEED = [
  { name: 'Caleb', chord: ['C3', 'G3', 'Eb4', 'Bb4'] },
  { name: 'Liz', chord: ['C#4', 'E4', 'B4'] },
  { name: 'William', chord: ['C4', 'E4', 'G4'] },
  { name: 'Evelyn', chord: ['C5', 'E5', 'G5'] },
];

export class Roster {
  constructor(path) {
    this.path = path;
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      /* no roster yet */
    }
    const now = Date.now();
    // THE SEED MUST LOSE EVERY MERGE. A second machine seeds these four before
    // it has ever spoken to the pi, and an `updatedAt` of now would be NEWER
    // than the real roster -- a blank install would overwrite it and quietly
    // un-retire everyone. `lastPlayedAt` is still now, so a first boot with no
    // network does not read its own seed as a month of silence and retire the
    // family on the spot.
    this.profiles = raw?.profiles ?? SEED.map((p) => ({ ...p, createdAt: now, updatedAt: 0, lastPlayedAt: now, retiredAt: null }));
    if (!raw) this.save();
    for (const p of this.profiles) {
      p.notes = p.chord.map(parseNote);
      p.updatedAt ??= p.createdAt ?? 0;
      p.lastPlayedAt ??= p.createdAt ?? 0;
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const out = this.profiles.map(({ name, chord, createdAt, updatedAt, lastPlayedAt, retiredAt }) => (
      { name, chord, createdAt, updatedAt, lastPlayedAt, retiredAt: retiredAt ?? null }));
    writeFileSync(this.path, JSON.stringify({ version: 1, profiles: out }, null, 2));
  }

  /** Live profiles only: a retired chord is not a login. */
  match(notes) {
    const k = keyOf(notes);
    return this.profiles.find((p) => !p.retiredAt && keyOf(p.notes) === k) ?? null;
  }

  get(name) {
    return this.profiles.find((p) => p.name === name) ?? null;
  }

  get live() {
    return this.profiles.filter((p) => !p.retiredAt);
  }

  /**
   * A chord nobody owns: a new player. Named from the chord itself, because
   * there is no way to type a name from a piano -- rename it by hand in
   * roster.json (and rename the db file to match) whenever you like.
   */
  create(notes) {
    const chord = [...new Set(notes)].sort((a, b) => a - b).map(noteName);
    // THE NAME MUST BE ONE THE SYNC WILL CARRY. src/sync.js refuses a profile
    // name over 64 characters, and a swept forearm is a 21-note "chord" whose
    // spelt-out name is longer than that -- which made a profile that worked
    // locally and could never reach the pi, silently. Long clusters get named
    // for their outer notes and their size instead.
    let name = chord.map((n) => n.replace('#', 's')).join('-');
    if (name.length > NAME_MAX) name = `${chord[0]}-${chord[chord.length - 1]}-${chord.length}notes`.replace(/#/g, 's');
    if (this.get(name)) name = `${name}-${Date.now().toString(36).slice(-4)}`;
    const now = Date.now();
    const p = { name, chord, createdAt: now, updatedAt: now, lastPlayedAt: now, retiredAt: null, notes: chord.map(parseNote) };
    this.profiles.push(p);
    this.save();
    return p;
  }

  retire(name) {
    const p = this.get(name);
    if (!p || p.retiredAt) return null;
    p.retiredAt = p.updatedAt = Date.now();
    this.save();
    return p;
  }

  restore(name) {
    const p = this.get(name);
    if (!p) return null;
    p.retiredAt = null;
    p.updatedAt = p.lastPlayedAt = Date.now();
    this.save();
    return p;
  }

  /** This profile was just played here: the clock that retirement reads. */
  touch(name) {
    const p = this.get(name);
    if (!p) return null;
    p.lastPlayedAt = p.updatedAt = Date.now();
    this.save();
    return p;
  }

  /** Live profiles nobody has played for RETIRE_DAYS, by the SHARED clock. */
  dueForRetirement(now = Date.now()) {
    const cutoff = now - RETIRE_DAYS * 86400000;
    return this.live.filter((p) => (p.lastPlayedAt ?? p.createdAt ?? 0) < cutoff);
  }

  /**
   * Fold another machine's roster into this one. An entry is its CHORD (a
   * renamed profile is still the same player), and the newer `updatedAt`
   * wins -- so a retirement, a restore and a fresh sitting all propagate,
   * whichever computer they happened on.
   */
  mergeWith(remote) {
    let changed = false;
    const byChord = new Map(this.profiles.map((p) => [keyOf(p.notes), p]));
    for (const raw of remote?.profiles ?? []) {
      let notes;
      try {
        notes = raw.chord.map(parseNote);
      } catch {
        continue; // an entry we cannot read is not one we will act on
      }
      const k = keyOf(notes);
      const mine = byChord.get(k);
      const theirs = { ...raw, notes, updatedAt: raw.updatedAt ?? raw.createdAt ?? 0, lastPlayedAt: raw.lastPlayedAt ?? raw.createdAt ?? 0 };
      if (!mine) {
        this.profiles.push(theirs);
        byChord.set(k, theirs);
        changed = true;
      } else if (theirs.updatedAt > mine.updatedAt) {
        Object.assign(mine, theirs);
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  toJSON() {
    return { version: 1, profiles: this.profiles.map(({ name, chord, createdAt, updatedAt, lastPlayedAt, retiredAt }) => (
      { name, chord, createdAt, updatedAt, lastPlayedAt, retiredAt: retiredAt ?? null })) };
  }
}
