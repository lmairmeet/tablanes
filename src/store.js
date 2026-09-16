import { all, one, run, uid, scheduleSave } from './db.js';
import { idb } from './idb.js';

const GAP = 1024;
const MIN_GAP = 0.0001;

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

function respreadLanes() {
  all('SELECT id FROM lanes ORDER BY position, created_at').forEach((row, i) =>
    run('UPDATE lanes SET position = ? WHERE id = ?', [(i + 1) * GAP, row.id])
  );
}

function respreadCards(laneId) {
  all('SELECT id FROM cards WHERE lane_id = ? ORDER BY position, created_at', [laneId]).forEach((row, i) =>
    run('UPDATE cards SET position = ? WHERE id = ?', [(i + 1) * GAP, row.id])
  );
}

// ---------------------------------------------------------------- reads

export function getBoard() {
  const lanes = all('SELECT * FROM lanes ORDER BY position, created_at');
  const cards = all('SELECT * FROM cards ORDER BY position, created_at');
  const counts = all(
    `SELECT card_id, SUM(kind = 'link') AS links, SUM(kind = 'file') AS files FROM (
        SELECT card_id, 'link' AS kind FROM links
        UNION ALL SELECT card_id, 'file' AS kind FROM attachments
     ) GROUP BY card_id`
  );
  const countBy = new Map(counts.map((c) => [c.card_id, c]));
  const coverBy = new Map(
    all(
      `SELECT card_id, id FROM (
         SELECT card_id, id, ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY position, id) AS rank
         FROM attachments WHERE is_image = 1
       ) WHERE rank = 1`
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

export function getCard(id) {
  const card = one('SELECT * FROM cards WHERE id = ?', [id]);
  if (!card) return null;
  card.links = all('SELECT * FROM links WHERE card_id = ? ORDER BY position', [id]);
  card.attachments = all('SELECT * FROM attachments WHERE card_id = ? ORDER BY position', [id]);
  return card;
}

// ---------------------------------------------------------------- lanes

export function createLane(title) {
  const id = uid();
  const last = one('SELECT MAX(position) AS p FROM lanes');
  run('INSERT INTO lanes (id, title, position, created_at) VALUES (?, ?, ?, ?)', [
    id,
    title.trim() || 'Untitled',
    positionBetween(last?.p ?? null, null),
    Date.now(),
  ]);
  scheduleSave();
  return id;
}

export function renameLane(id, title) {
  run('UPDATE lanes SET title = ? WHERE id = ?', [title.trim() || 'Untitled', id]);
  scheduleSave();
}

/** Placed relative to its dropped neighbours rather than an index, so a filtered
 *  view (where hidden rows sit between the visible ones) still lands correctly. */
export function moveLane(id, beforeId, afterId) {
  const before = beforeId ? one('SELECT position FROM lanes WHERE id = ?', [beforeId])?.position ?? null : null;
  const after = afterId ? one('SELECT position FROM lanes WHERE id = ?', [afterId])?.position ?? null : null;
  run('UPDATE lanes SET position = ? WHERE id = ?', [positionBetween(before, after), id]);
  if (needsRespread(before, after)) respreadLanes();
  scheduleSave();
}

/** Deletes a lane and its cards, returning a snapshot that `restore` can replay. */
export function deleteLane(id) {
  const lane = one('SELECT * FROM lanes WHERE id = ?', [id]);
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

export function createCard(laneId, title, atTop = false) {
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

export function updateCard(id, fields) {
  const allowed = ['title', 'description'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  run(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => fields[k]),
    Date.now(),
    id,
  ]);
  scheduleSave();
}

export function moveCard(id, laneId, beforeId, afterId) {
  const positionOf = (cardId) =>
    cardId ? one('SELECT position FROM cards WHERE id = ?', [cardId])?.position ?? null : null;
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
}

export function deleteCard(id) {
  const card = one('SELECT * FROM cards WHERE id = ?', [id]);
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

/** Re-inserts rows captured by deleteCard/deleteLane. Blobs are never deleted eagerly, so files survive. */
export function restore(snapshot) {
  if (!snapshot) return;
  if (snapshot.lane) {
    const l = snapshot.lane;
    run('INSERT OR REPLACE INTO lanes (id, title, position, created_at) VALUES (?, ?, ?, ?)', [
      l.id,
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

export function addLink(cardId, url, label) {
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

export function deleteLink(id) {
  run('DELETE FROM links WHERE id = ?', [id]);
  scheduleSave();
}

// ---------------------------------------------------------------- attachments

export async function addAttachment(cardId, file) {
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

export function deleteAttachment(id) {
  run('DELETE FROM attachments WHERE id = ?', [id]);
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
