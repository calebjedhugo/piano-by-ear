// One-off: put every live profile on the pi for the first time. After this
// the drill keeps them merged on its own (src/sync.js).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Db } from '../src/db.js';
import { Roster } from '../src/roster.js';
import { Sync, syncConfig } from '../src/sync.js';
import { deviceId } from '../src/device.js';

const DATA = join(homedir(), '.piano-by-ear');
const TMP = join(DATA, 'tmp');
mkdirSync(TMP, { recursive: true });
const log = (m) => console.log(m);
const device = deviceId(join(DATA, 'device-id'));
const roster = new Roster(join(DATA, 'roster.json'));
const sync = new Sync({ config: syncConfig(join(DATA, 'sync.json')), device: device.id, tmpDir: TMP, log });
log(`device ${device.label} (${device.id}) -> ${sync.cfg.host}:${sync.cfg.dir}`);
log(String(JSON.stringify(sync.syncRoster(roster))));
for (const p of roster.live) {
  const path = join(DATA, 'profiles', `${p.name}.db`);
  let db;
  try {
    db = new Db(path);
  } catch (err) {
    log(`${p.name}: no history yet (${err.message})`);
    continue;
  }
  log(`${p.name}: ${db.sessionCount()} sessions locally`);
  sync.run(db, p.name, { reason: 'seeding' });
  db.close();
}
