import { idb } from './idb.js';

const DB_KEY = 'sqlite';
const SCHEMA_VERSION = 1;

let db = null;
let saveTimer = null;
let savePromise = Promise.resolve();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lanes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  lane_id     TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id       TEXT PRIMARY KEY,
  card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  url      TEXT NOT NULL,
  label    TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  is_image   INTEGER NOT NULL DEFAULT 0,
  position   REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_lane ON cards(lane_id, position);
CREATE INDEX IF NOT EXISTS idx_links_card ON links(card_id, position);
CREATE INDEX IF NOT EXISTS idx_attachments_card ON attachments(card_id, position);
`;

export async function initDb() {
  const SQL = await initSqlJs({ locateFile: (file) => `vendor/${file}` });
  const bytes = await idb.get('kv', DB_KEY).catch(() => null);
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON;');
  db.run(SCHEMA);
  const current = db.exec('PRAGMA user_version')[0].values[0][0];
  if (current < SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  if (!bytes) seed();
  return db;
}

function seed() {
  const now = Date.now();
  const lanes = ['To do', 'Doing', 'Done'];
  lanes.forEach((title, i) => {
    run('INSERT INTO lanes (id, title, position, created_at) VALUES (?, ?, ?, ?)', [
      uid(),
      title,
      (i + 1) * 1024,
      now,
    ]);
  });
  scheduleSave();
}

export function uid() {
  return crypto.randomUUID();
}

/** Run a statement that returns nothing. */
export function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

/** Run a query, returning an array of row objects. */
export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

export function one(sql, params = []) {
  return all(sql, params)[0] ?? null;
}

/** Persist the database to IndexedDB, coalescing bursts of writes. */
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 180);
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!db) return savePromise;
  const bytes = db.export();
  savePromise = savePromise
    .then(() => idb.put('kv', DB_KEY, bytes))
    .catch((err) => console.error('TabLanes: failed to persist database', err));
  return savePromise;
}

// A debounced write can still be in flight when the tab goes away. `visibilitychange`
// fires early enough for the IndexedDB transaction to land; pagehide is the backstop.
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) flush();
});
addEventListener('pagehide', () => {
  if (saveTimer) flush();
});
