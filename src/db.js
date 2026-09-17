import { idb } from './idb.js';

const DB_KEY = 'sqlite';
const SCHEMA_VERSION = 3;
const DEFAULT_BOARD_COLOR = '#7c81f2';

let db = null;
let saveTimer = null;
let savePromise = null;
let dirty = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  color       TEXT NOT NULL,
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lanes (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_lanes_board ON lanes(board_id, position);
CREATE INDEX IF NOT EXISTS idx_links_card ON links(card_id, position);
CREATE INDEX IF NOT EXISTS idx_attachments_card ON attachments(card_id, position);
`;

export async function initDb() {
  const SQL = await initSqlJs({ locateFile: (file) => `vendor/${file}` });
  const bytes = await idb.get('kv', DB_KEY).catch(() => null);
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON;');
  if (!bytes) {
    db.run(SCHEMA);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    seed();
  } else {
    const current = db.exec('PRAGMA user_version')[0].values[0][0];
    if (current === 1) migrateV1ToV3();
    else if (current === 2) migrateV2ToV3();
    else if (current !== SCHEMA_VERSION) throw new Error(`Unsupported database schema version: ${current}`);
    db.run(SCHEMA);
  }
  return db;
}

function seed() {
  const now = Date.now();
  const boardId = uid();
  run('INSERT INTO boards (id, title, color, position, created_at) VALUES (?, ?, ?, ?, ?)', [
    boardId,
    'My board',
    DEFAULT_BOARD_COLOR,
    1024,
    now,
  ]);
  const lanes = ['To do', 'Doing', 'Done'];
  lanes.forEach((title, i) => {
    run('INSERT INTO lanes (id, board_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)', [
      uid(),
      boardId,
      title,
      (i + 1) * 1024,
      now,
    ]);
  });
  scheduleSave();
}

/** Version 1 had one implicit board. Attach every existing lane to a real board;
 * cards, links and attachments keep their existing foreign-key chain unchanged. */
function migrateV1ToV3() {
  const now = Date.now();
  const boardId = uid();
  db.run('BEGIN');
  try {
    db.run(`
      CREATE TABLE boards (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        color       TEXT NOT NULL,
        position    REAL NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `);
    run('INSERT INTO boards (id, title, color, position, created_at) VALUES (?, ?, ?, ?, ?)', [
      boardId,
      'My board',
      DEFAULT_BOARD_COLOR,
      1024,
      now,
    ]);
    db.run('ALTER TABLE lanes ADD COLUMN board_id TEXT REFERENCES boards(id) ON DELETE CASCADE');
    run('UPDATE lanes SET board_id = ?', [boardId]);
    db.run('CREATE INDEX idx_lanes_board ON lanes(board_id, position)');
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.run('COMMIT');
    scheduleSave();
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/** Version 2 introduced boards without customizable colors. */
function migrateV2ToV3() {
  db.run('BEGIN');
  try {
    db.run(`ALTER TABLE boards ADD COLUMN color TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_COLOR}'`);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.run('COMMIT');
    scheduleSave();
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
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
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    return stmt.step() ? stmt.getAsObject() : null;
  } finally {
    stmt.free();
  }
}

export function transaction(work) {
  db.run('BEGIN');
  try {
    const result = work();
    db.run('COMMIT');
    return result;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/** Persist the database to IndexedDB, coalescing bursts of writes. */
export function scheduleSave() {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 180);
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!db || !dirty || savePromise) return savePromise;
  // Keep at most one exported snapshot alive, even when storage is slow.
  savePromise = Promise.resolve().then(async () => {
    try {
      while (dirty) {
        dirty = false;
        const bytes = db.export();
        await idb.put('kv', DB_KEY, bytes);
      }
    } catch (err) {
      dirty = true;
      console.error('TabLanes: failed to persist database', err);
    } finally {
      savePromise = null;
    }
  });
  return savePromise;
}

// A debounced write can still be in flight when the tab goes away. `visibilitychange`
// fires early enough for the IndexedDB transaction to land; pagehide is the backstop.
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty) flush();
});
addEventListener('pagehide', () => {
  if (dirty) flush();
});
