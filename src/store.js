import { all, one, run, uid, scheduleSave, transaction } from './db.js';
import { idb } from './idb.js';

const GAP = 1024;
const MIN_GAP = 0.0001;
const ACTIVE_BOARD_KEY = 'tablanes.activeBoardId';
export const BOARD_COLORS = ['#7c81f2', '#9b6ee8', '#4f8fe8', '#29a6b8', '#46a36f', '#d19a32', '#dc7547', '#d8647b'];
export const DEFAULT_BOARD_COLOR = BOARD_COLORS[0];

function boardColor(color) {
  return BOARD_COLORS.includes(color) ? color : DEFAULT_BOARD_COLOR;
}

/**
 * Fractional positioning: a move rewrites one row instead of renumbering the
 * whole list. Positions are re-spread only when neighbours get too close to
 * split in a float.
 */
function positionBetween(before, after) {
  if (before == null && after == null) return GAP;
  if (before == null) return after - GAP;
  if (after == null) return before + GAP;
  return (before + after) / 2;
}

function needsRespread(before, after) {
  return before != null && after != null && Math.abs(after - before) < MIN_GAP;
}

function respreadLanes(boardId) {
  all('SELECT id FROM lanes WHERE board_id = ? ORDER BY position, created_at', [boardId]).forEach((row, i) =>
    run('UPDATE lanes SET position = ? WHERE id = ?', [(i + 1) * GAP, row.id])
  );
}

function respreadCards(laneId) {
  all('SELECT id FROM cards WHERE lane_id = ? ORDER BY position, created_at', [laneId]).forEach((row, i) =>
    run('UPDATE cards SET position = ? WHERE id = ?', [(i + 1) * GAP, row.id])
  );
}

// ---------------------------------------------------------------- reads

export function getBoards() {
  return all('SELECT * FROM boards ORDER BY position, created_at');
}

export function createBoard(title, color = DEFAULT_BOARD_COLOR) {
  const cleanTitle = title.trim();
  if (!cleanTitle) return null;
  const id = uid();
  const last = one('SELECT MAX(position) AS p FROM boards');
  run('INSERT INTO boards (id, title, color, position, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    cleanTitle,
    boardColor(color),
    positionBetween(last?.p ?? null, null),
    Date.now(),
  ]);
  scheduleSave();
  return id;
}

export function updateBoard(id, { title, color }) {
  const current = one('SELECT title, color FROM boards WHERE id = ?', [id]);
  if (!current) return false;
  const cleanTitle = (title ?? current.title).trim();
  if (!cleanTitle) return false;
  run('UPDATE boards SET title = ?, color = ? WHERE id = ?', [
    cleanTitle,
    color == null ? current.color : boardColor(color),
    id,
  ]);
  scheduleSave();
  return true;
}

/** Deletes a board and its complete foreign-key tree, returning an undo snapshot. */
export function deleteBoard(id) {
  const board = one('SELECT * FROM boards WHERE id = ?', [id]);
  if (!board) return null;
  const lanes = all('SELECT * FROM lanes WHERE board_id = ?', [id]);
  const cards = all(
    'SELECT cards.* FROM cards JOIN lanes ON lanes.id = cards.lane_id WHERE lanes.board_id = ?',
    [id]
  );
  const snapshot = {
    kind: 'board',
    board,
    lanes,
    cards,
    links: all(
      `SELECT links.* FROM links JOIN cards ON cards.id = links.card_id
       JOIN lanes ON lanes.id = cards.lane_id WHERE lanes.board_id = ?`,
      [id]
    ),
    attachments: all(
      `SELECT attachments.* FROM attachments JOIN cards ON cards.id = attachments.card_id
       JOIN lanes ON lanes.id = cards.lane_id WHERE lanes.board_id = ?`,
      [id]
    ),
  };
  transaction(() => {
    run(
      `DELETE FROM attachments WHERE card_id IN (
         SELECT cards.id FROM cards JOIN lanes ON lanes.id = cards.lane_id WHERE lanes.board_id = ?
       )`,
      [id]
    );
    run(
      `DELETE FROM links WHERE card_id IN (
         SELECT cards.id FROM cards JOIN lanes ON lanes.id = cards.lane_id WHERE lanes.board_id = ?
       )`,
      [id]
    );
    run('DELETE FROM cards WHERE lane_id IN (SELECT id FROM lanes WHERE board_id = ?)', [id]);
    run('DELETE FROM lanes WHERE board_id = ?', [id]);
    run('DELETE FROM boards WHERE id = ?', [id]);
  });
  scheduleSave();
  return snapshot;
}

export function getActiveBoardId(boards = getBoards()) {
  let saved = null;
  try {
    saved = localStorage.getItem(ACTIVE_BOARD_KEY);
  } catch {}
  return boards.some((board) => board.id === saved) ? saved : boards[0]?.id ?? null;
}

export function setActiveBoardId(boardId) {
  try {
    if (boardId) localStorage.setItem(ACTIVE_BOARD_KEY, boardId);
    else localStorage.removeItem(ACTIVE_BOARD_KEY);
  } catch {}
}

export function getBoard(boardId) {
  const lanes = all('SELECT * FROM lanes WHERE board_id = ? ORDER BY position, created_at', [boardId]);
  const cards = all(
    `SELECT cards.* FROM cards
     JOIN lanes ON lanes.id = cards.lane_id
     WHERE lanes.board_id = ?
     ORDER BY cards.position, cards.created_at`,
    [boardId]
  );
  const counts = all(
    `SELECT card_id, SUM(kind = 'link') AS links, SUM(kind = 'file') AS files FROM (
        SELECT links.card_id, 'link' AS kind FROM links
        JOIN cards ON cards.id = links.card_id JOIN lanes ON lanes.id = cards.lane_id
        WHERE lanes.board_id = ?
        UNION ALL
        SELECT attachments.card_id, 'file' AS kind FROM attachments
        JOIN cards ON cards.id = attachments.card_id JOIN lanes ON lanes.id = cards.lane_id
        WHERE lanes.board_id = ?
     ) GROUP BY card_id`,
    [boardId, boardId]
  );
  const countBy = new Map(counts.map((c) => [c.card_id, c]));
  const coverBy = new Map(
    all(
      `SELECT card_id, id FROM (
         SELECT attachments.card_id, attachments.id,
           ROW_NUMBER() OVER (PARTITION BY attachments.card_id ORDER BY attachments.position, attachments.id) AS rank
         FROM attachments
         JOIN cards ON cards.id = attachments.card_id
         JOIN lanes ON lanes.id = cards.lane_id
         WHERE attachments.is_image = 1 AND lanes.board_id = ?
       ) WHERE rank = 1`,
      [boardId]
    ).map((r) => [r.card_id, r.id])
  );

  const byLane = new Map(lanes.map((l) => [l.id, { ...l, cards: [] }]));
  for (const card of cards) {
    const lane = byLane.get(card.lane_id);
    if (!lane) continue;
    const c = countBy.get(card.id);
    lane.cards.push({
      ...card,
      linkCount: c ? Number(c.links) : 0,
      fileCount: c ? Number(c.files) : 0,
      coverId: coverBy.get(card.id) ?? null,
    });
  }
  return [...byLane.values()];
}

export function getCard(boardId, id) {
  const card = one(
    `SELECT cards.* FROM cards JOIN lanes ON lanes.id = cards.lane_id
     WHERE cards.id = ? AND lanes.board_id = ?`,
    [id, boardId]
  );
  if (!card) return null;
  card.links = all('SELECT * FROM links WHERE card_id = ? ORDER BY position', [id]);
  card.attachments = all('SELECT * FROM attachments WHERE card_id = ? ORDER BY position', [id]);
  return card;
}

// ---------------------------------------------------------------- lanes

export function createLane(boardId, title) {
  if (!one('SELECT id FROM boards WHERE id = ?', [boardId])) return null;
  const id = uid();
  const last = one('SELECT MAX(position) AS p FROM lanes WHERE board_id = ?', [boardId]);
  run('INSERT INTO lanes (id, board_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    boardId,
    title.trim() || 'Untitled',
    positionBetween(last?.p ?? null, null),
    Date.now(),
  ]);
  scheduleSave();
  return id;
}

export function renameLane(boardId, id, title) {
  run('UPDATE lanes SET title = ? WHERE id = ? AND board_id = ?', [title.trim() || 'Untitled', id, boardId]);
  scheduleSave();
}

/** Placed relative to its dropped neighbours rather than an index, so a filtered
 *  view (where hidden rows sit between the visible ones) still lands correctly. */
export function moveLane(boardId, id, beforeId, afterId) {
  const positionOf = (laneId) =>
    laneId ? one('SELECT position FROM lanes WHERE id = ? AND board_id = ?', [laneId, boardId])?.position ?? null : null;
  const before = positionOf(beforeId);
  const after = positionOf(afterId);
  run('UPDATE lanes SET position = ? WHERE id = ? AND board_id = ?', [positionBetween(before, after), id, boardId]);
  if (needsRespread(before, after)) respreadLanes(boardId);
  scheduleSave();
}

/** Moves a lane (and therefore its full card tree) to the end of another board. */
export function moveLaneToBoard(boardId, id, targetBoardId) {
  if (boardId === targetBoardId) return false;
  const lane = one('SELECT id FROM lanes WHERE id = ? AND board_id = ?', [id, boardId]);
  const target = one('SELECT id FROM boards WHERE id = ?', [targetBoardId]);
  if (!lane || !target) return false;
  const last = one('SELECT MAX(position) AS p FROM lanes WHERE board_id = ?', [targetBoardId]);
  run('UPDATE lanes SET board_id = ?, position = ? WHERE id = ? AND board_id = ?', [
    targetBoardId,
    positionBetween(last?.p ?? null, null),
    id,
    boardId,
  ]);
  scheduleSave();
  return true;
}

/** Deletes a lane and its cards, returning a snapshot that `restore` can replay. */
export function deleteLane(boardId, id) {
  const lane = one('SELECT * FROM lanes WHERE id = ? AND board_id = ?', [id, boardId]);
  if (!lane) return null;
  const cards = all('SELECT * FROM cards WHERE lane_id = ?', [id]);
  const snapshot = {
    kind: 'lane',
    lane,
    cards,
    links: all('SELECT links.* FROM links JOIN cards ON cards.id = links.card_id WHERE cards.lane_id = ?', [id]),
    attachments: all('SELECT attachments.* FROM attachments JOIN cards ON cards.id = attachments.card_id WHERE cards.lane_id = ?', [id]),
  };
  run('DELETE FROM lanes WHERE id = ?', [id]);
  scheduleSave();
  return snapshot;
}

// ---------------------------------------------------------------- cards

export function createCard(boardId, laneId, title, atTop = false) {
  if (!one('SELECT id FROM lanes WHERE id = ? AND board_id = ?', [laneId, boardId])) return null;
  const id = uid();
  const now = Date.now();
  const edge = one(
    `SELECT ${atTop ? 'MIN' : 'MAX'}(position) AS p FROM cards WHERE lane_id = ?`,
    [laneId]
  );
  const position = atTop ? positionBetween(null, edge?.p ?? null) : positionBetween(edge?.p ?? null, null);
  run(
    'INSERT INTO cards (id, lane_id, title, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, laneId, title.trim(), '', position, now, now]
  );
  scheduleSave();
  return id;
}

export function updateCard(boardId, id, fields) {
  const allowed = ['title', 'description'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  run(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
       WHERE id = ? AND lane_id IN (SELECT id FROM lanes WHERE board_id = ?)`, [
    ...keys.map((k) => fields[k]),
    Date.now(),
    id,
    boardId,
  ]);
  scheduleSave();
}

export function moveCard(boardId, id, laneId, beforeId, afterId) {
  const ownsCard = one(
    'SELECT cards.id FROM cards JOIN lanes ON lanes.id = cards.lane_id WHERE cards.id = ? AND lanes.board_id = ?',
    [id, boardId]
  );
  const ownsLane = one('SELECT id FROM lanes WHERE id = ? AND board_id = ?', [laneId, boardId]);
  if (!ownsCard || !ownsLane) return false;
  const positionOf = (cardId) =>
    cardId ? one('SELECT position FROM cards WHERE id = ? AND lane_id = ?', [cardId, laneId])?.position ?? null : null;
  let before = positionOf(beforeId);
  let after = positionOf(afterId);

  // The drop only knows its visible neighbours. Under a search filter, hidden rows
  // can sit just outside them, so anchor to the real adjacent rows in the lane.
  if (before == null) {
    before =
      after == null
        ? one('SELECT MAX(position) AS p FROM cards WHERE lane_id = ? AND id != ?', [laneId, id])?.p ?? null
        : one('SELECT MAX(position) AS p FROM cards WHERE lane_id = ? AND id != ? AND position < ?', [
            laneId,
            id,
            after,
          ])?.p ?? null;
  } else if (after == null) {
    after =
      one('SELECT MIN(position) AS p FROM cards WHERE lane_id = ? AND id != ? AND position > ?', [
        laneId,
        id,
        before,
      ])?.p ?? null;
  }

  run('UPDATE cards SET lane_id = ?, position = ? WHERE id = ?', [laneId, positionBetween(before, after), id]);
  if (needsRespread(before, after)) respreadCards(laneId);
  scheduleSave();
  return true;
}

export function deleteCard(boardId, id) {
  const card = one(
    `SELECT cards.* FROM cards JOIN lanes ON lanes.id = cards.lane_id
     WHERE cards.id = ? AND lanes.board_id = ?`,
    [id, boardId]
  );
  if (!card) return null;
  const snapshot = {
    kind: 'card',
    cards: [card],
    links: all('SELECT * FROM links WHERE card_id = ?', [id]),
    attachments: all('SELECT * FROM attachments WHERE card_id = ?', [id]),
  };
  run('DELETE FROM cards WHERE id = ?', [id]);
  scheduleSave();
  return snapshot;
}

/** Re-inserts rows captured by deleteCard/deleteLane/deleteBoard. Blobs are never deleted eagerly, so files survive. */
export function restore(snapshot) {
  if (!snapshot) return;
  if (snapshot.board) {
    const b = snapshot.board;
    run('INSERT OR REPLACE INTO boards (id, title, color, position, created_at) VALUES (?, ?, ?, ?, ?)', [
      b.id,
      b.title,
      b.color,
      b.position,
      b.created_at,
    ]);
  }
  for (const l of snapshot.lanes ?? []) {
    run('INSERT OR REPLACE INTO lanes (id, board_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)', [
      l.id,
      l.board_id,
      l.title,
      l.position,
      l.created_at,
    ]);
  }
  if (snapshot.lane) {
    const l = snapshot.lane;
    run('INSERT OR REPLACE INTO lanes (id, board_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)', [
      l.id,
      l.board_id,
      l.title,
      l.position,
      l.created_at,
    ]);
  }
  for (const c of snapshot.cards) {
    run(
      'INSERT OR REPLACE INTO cards (id, lane_id, title, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [c.id, c.lane_id, c.title, c.description, c.position, c.created_at, c.updated_at]
    );
  }
  for (const l of snapshot.links) {
    run('INSERT OR REPLACE INTO links (id, card_id, url, label, position) VALUES (?, ?, ?, ?, ?)', [
      l.id,
      l.card_id,
      l.url,
      l.label,
      l.position,
    ]);
  }
  for (const a of snapshot.attachments) {
    run(
      'INSERT OR REPLACE INTO attachments (id, card_id, name, mime, size, is_image, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [a.id, a.card_id, a.name, a.mime, a.size, a.is_image, a.position, a.created_at]
    );
  }
  scheduleSave();
}

// ---------------------------------------------------------------- links

export function addLink(boardId, cardId, url, label) {
  if (!getCard(boardId, cardId)) return null;
  const last = one('SELECT MAX(position) AS p FROM links WHERE card_id = ?', [cardId]);
  run('INSERT INTO links (id, card_id, url, label, position) VALUES (?, ?, ?, ?, ?)', [
    uid(),
    cardId,
    url,
    label,
    positionBetween(last?.p ?? null, null),
  ]);
  scheduleSave();
}

export function deleteLink(boardId, id) {
  run(
    `DELETE FROM links WHERE id = ? AND card_id IN (
       SELECT cards.id FROM cards JOIN lanes ON lanes.id = cards.lane_id WHERE lanes.board_id = ?
     )`,
    [id, boardId]
  );
  scheduleSave();
}

// ---------------------------------------------------------------- attachments

export async function addAttachment(boardId, cardId, file) {
  if (!getCard(boardId, cardId)) return null;
  const id = uid();
  const last = one('SELECT MAX(position) AS p FROM attachments WHERE card_id = ?', [cardId]);
  await idb.put('blobs', id, file);
  run(
    'INSERT INTO attachments (id, card_id, name, mime, size, is_image, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      cardId,
      file.name || 'file',
      file.type || 'application/octet-stream',
      file.size,
      file.type?.startsWith('image/') ? 1 : 0,
      positionBetween(last?.p ?? null, null),
      Date.now(),
    ]
  );
  scheduleSave();
  return id;
}

export function deleteAttachment(boardId, id) {
  run(
    `DELETE FROM attachments WHERE id = ? AND card_id IN (
       SELECT cards.id FROM cards JOIN lanes ON lanes.id = cards.lane_id WHERE lanes.board_id = ?
     )`,
    [id, boardId]
  );
  scheduleSave();
}

export function getBlob(id) {
  return idb.get('blobs', id);
}

/** Drops blobs with no surviving attachment row (deletes and undo windows leave these behind). */
export async function collectGarbage() {
  const live = new Set(all('SELECT id FROM attachments').map((r) => r.id));
  const keys = await idb.keys('blobs');
  const orphans = keys.filter((k) => !live.has(k));
  if (orphans.length) await idb.delMany('blobs', orphans);
}
