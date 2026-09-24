// A SYNC SENDS ROWS, NOT FILES (2026-09-23). Every copy of a profile -- each
// machine's and the pi's -- holds, per event table and per device, an unbroken
// run of that device's rows: origin ids are the recording machine's own row
// ids, which only ever grow, rows are never deleted, and every transfer moves
// everything past the receiver's highest id for that device. So "what does the
// other side lack?" is answered by one number per (table, device): its
// WATERMARK. The rows past it are the delta.
//
// It used to copy the whole database both ways on every sync, which grows
// without bound (3.7 MB after 19 days, ~75 MB a year) against a 20 s transfer
// limit, and would have failed SILENTLY on the downstairs machine's wifi within
// months: sessions quietly never reaching the pi. A session is ~1,000 rows, so
// a delta stays ~100 KB however long the history gets.
//
// The pi runs none of this program (its Node is too old for node:sqlite), only
// the sqlite3 CLI, so both directions are plain SQL built here: the pi builds
// the pull delta and applies the push delta; this machine builds the push
// delta with the SAME SQL (Db.writeDelta) and merges the pull delta with
// Db.mergeFrom, which already remaps sessions and decides the kv.

/** A SQL string literal. */
export const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(Math.trunc(v)) : `'${String(v).replace(/'/g, "''")}'`);

/** Table and column names are this program's own; refuse anything else. */
const ident = (s) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

/**
 * SQL that writes, into the database attached as `o`, every row of `tables`
 * past the watermarks `marks` ([{ t, device, mx }]), plus every session those
 * rows hang off (the receiver remaps session ids through them), the kv minus
 * `skipKeys`, and `meta.last_played` -- when this side last played anything,
 * which decides whose kv wins (Db.mergeFrom). `tables` must include
 * 'sessions'; every other table carries a session_id.
 */
export function deltaSql({ marks, tables, skipKeys = [] }) {
  const others = tables.filter((t) => t !== 'sessions').map(ident);
  const beyond = (t) => `x.origin_id > COALESCE((SELECT mx FROM temp.wm WHERE t = ${lit(t)} AND device = x.device), 0)`;
  const lines = [
    'CREATE TEMP TABLE IF NOT EXISTS wm (t TEXT, device TEXT, mx INTEGER);',
    'DELETE FROM temp.wm;',
  ];
  for (const m of marks) lines.push(`INSERT INTO temp.wm VALUES (${lit(m.t)}, ${lit(m.device)}, ${lit(m.mx)});`);
  for (const t of others) lines.push(`CREATE TABLE o.${t} AS SELECT * FROM main.${t} x WHERE ${beyond(t)};`);
  const referenced = others.map((t) => `SELECT session_id FROM o.${t}`).join(' UNION ');
  lines.push(`CREATE TABLE o.sessions AS SELECT * FROM main.sessions x WHERE ${beyond('sessions')}${referenced ? ` OR x.id IN (${referenced})` : ''};`);
  const skip = skipKeys.length ? ` WHERE key NOT IN (${skipKeys.map(lit).join(', ')})` : '';
  lines.push(`CREATE TABLE o.kv AS SELECT key, value FROM main.kv${skip};`);
  lines.push('CREATE TABLE o.meta AS SELECT MAX(COALESCE(ended_at, started_at)) AS last_played FROM main.sessions;');
  return lines.join('\n');
}

/** Watermarks of the tables in `tables`: one row per (table, device). Tab-separated for the CLI. */
export function marksSql(tables) {
  return tables.map(ident).map((t) =>
    `SELECT 'mark', ${lit(t)}, device, MAX(origin_id) FROM main.${t} WHERE device IS NOT NULL GROUP BY device;`).join('\n');
}

/** Every column of every table, tab-separated: what the pi's copy looks like. */
export const COLUMNS_SQL =
  "SELECT 'col', m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table';";

/**
 * SQL that folds the delta attached as `d` into the pi's copy: first the
 * schema catches up (`ddl`, from schemaDdl), then sessions are inserted where
 * missing by (device, origin_id), the delta's own session ids are mapped onto
 * the pi's, and every other row comes in where missing with its session_id
 * mapped. The kv becomes the sender's, all but `keepKeys` -- exactly what the
 * whole-file push did, since the sender already ran the "whoever played last"
 * rule against the pi's kv when it pulled. Prints `n <table> <rows added>`.
 * `cols` = { table: [columns other than id] } as the SENDER has them.
 */
export function applySql({ tables, cols, ddl = [], keepKeys = [] }) {
  const lines = [...ddl];
  const missing = (t) => `NOT EXISTS (SELECT 1 FROM main.${t} y WHERE y.device = x.device AND y.origin_id = x.origin_id)`;
  const sc = cols.sessions.map(ident);
  lines.push(`INSERT INTO main.sessions (${sc.join(', ')}) SELECT ${sc.map((c) => `x.${c}`).join(', ')} FROM d.sessions x WHERE ${missing('sessions')};`);
  lines.push("SELECT 'n', 'sessions', changes();");
  lines.push('DROP TABLE IF EXISTS temp.smap;');
  lines.push('CREATE TEMP TABLE smap AS SELECT x.id AS rid, s.id AS lid FROM d.sessions x JOIN main.sessions s ON s.device = x.device AND s.origin_id = x.origin_id;');
  for (const t of tables.filter((x) => x !== 'sessions').map(ident)) {
    const c = cols[t].map(ident);
    const vals = c.map((col) => (col === 'session_id' ? 'm.lid' : `x.${col}`));
    lines.push(`INSERT INTO main.${t} (${c.join(', ')}) SELECT ${vals.join(', ')} FROM d.${t} x JOIN temp.smap m ON m.rid = x.session_id WHERE ${missing(t)};`);
    lines.push(`SELECT 'n', ${lit(t)}, changes();`);
  }
  const keep = keepKeys.length ? ` WHERE key NOT IN (${keepKeys.map(lit).join(', ')})` : '';
  lines.push(`DELETE FROM main.kv${keep};`);
  lines.push(`INSERT INTO main.kv (key, value) SELECT key, value FROM d.kv${keep};`);
  return lines.join('\n');
}

/**
 * The DDL that brings the pi's copy up to the sender's schema: a table it has
 * never seen is created (with its merge index), a column it lacks is added.
 * Never drops anything. `mine` = [{ table, sql, cols: [{ name, type, dflt }] }];
 * `theirs` = Map(table -> Set(column)).
 */
export function schemaDdl(mine, theirs) {
  const out = [];
  for (const { table, sql, cols } of mine) {
    const t = ident(table);
    if (!theirs.has(t)) {
      out.push(`${sql.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?/i, 'CREATE TABLE IF NOT EXISTS ')};`);
      out.push(`CREATE INDEX IF NOT EXISTS ${t}_origin ON ${t}(device, origin_id);`);
      continue;
    }
    for (const c of cols) {
      if (theirs.get(t).has(c.name)) continue;
      out.push(`ALTER TABLE ${t} ADD COLUMN ${ident(c.name)} ${c.type || ''}${c.dflt !== null && c.dflt !== undefined ? ` DEFAULT ${c.dflt}` : ''};`);
    }
  }
  return out;
}

/** Parse the CLI's tab-separated report lines into marks and columns. */
export function parseReport(text) {
  const marks = [];
  const cols = new Map();
  const added = {};
  let lastPlayed = 0;
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'mark') marks.push({ t: f[1], device: f[2], mx: Number(f[3]) });
    else if (f[0] === 'col') {
      if (!cols.has(f[1])) cols.set(f[1], new Set());
      cols.get(f[1]).add(f[2]);
    } else if (f[0] === 'n') added[f[1]] = Number(f[2]);
    else if (f[0] === 'last') lastPlayed = Number(f[1]) || 0;
  }
  return { marks, cols, added, lastPlayed };
}
