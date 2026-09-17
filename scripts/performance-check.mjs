/** Run isolated Chromium regression checks: node scripts/performance-check.mjs */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8180;
const DEBUG_PORT = 9445;
const WIDTH = 1280;
const HEIGHT = 800;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = join('/tmp', `tablanes-performance-${process.pid}`);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path === '/' ? 'newtab.html' : path);
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    // Match the manifest exactly, so anything the real CSP would block breaks here too.
    res.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

await rm(profile, { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${WIDTH},${HEIGHT}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let target;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const pages = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
    target = pages.find((p) => p.type === 'page');
  } catch {}
  if (!target) await sleep(250);
}
if (!target) throw new Error('Chrome never exposed a DevTools target');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const resolve = pending.get(msg.id);
  pending.delete(msg.id);
  resolve?.(msg);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.value;
};

const waitFor = async (expression, label) => {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await waitFor("document.querySelectorAll('.lane').length === 3", 'database');
  const results = await evaluate(`(${async function () {
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
    const store = await import('/src/store.js');
    const { idb } = await import('/src/idb.js');
    const { imageScope } = await import('/src/images.js');
    const { openCard } = await import('/src/modal.js');
    const { menu } = await import('/src/ui.js');
    const { run, scheduleSave } = await import('/src/db.js');
    const results = [];
    const boards = store.getBoards();
    assert(boards.length === 1, 'fresh database has one board');
    assert(boards[0].color === store.DEFAULT_BOARD_COLOR, 'fresh board has a default color');
    const boardId = boards[0].id;
    assert(store.getBoard(boardId).map((lane) => lane.title).join('|') === 'To do|Doing|Done', 'fresh board has seeded lanes');
    assert(document.querySelectorAll('.board-tab').length === 1 && document.querySelector('.board-tab-menu') && document.getElementById('add-board'), 'single-board navigation shows its tab menu and add button');
    assert(!document.getElementById('edit-board'), 'header has no standalone board edit button');
    results.push('Fresh database board and tab navigation');

    const lane = store.getBoard(boardId)[0];
    const card = store.createCard(boardId, lane.id, 'Performance regression');
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], 'test.svg', { type: 'image/svg+xml' });
    const attachment = await store.addAttachment(boardId, card, file);
    const attachment2 = await store.addAttachment(boardId, card, file);
    run('UPDATE attachments SET position = 1 WHERE card_id = ?', [card]);
    assert(store.getBoard(boardId)[0].cards[0].coverId === [attachment, attachment2].sort()[0], 'stable cover on tied positions');
    const snapshot = store.deleteLane(boardId, lane.id);
    assert(snapshot.attachments.length === 2 && snapshot.cards.length === 1, 'joined deletion snapshot');
    store.restore(snapshot);
    assert(store.getCard(boardId, card).attachments.length === 2, 'undo restores attachments');
    results.push('SQLite cover selection and lane delete/undo');

    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const urls = new Set();
    URL.createObjectURL = (blob) => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = (url) => { urls.delete(url); revoke(url); };
    let reads = 0;
    const pending = [];
    const scope = imageScope(() => { reads++; return new Promise((resolve) => pending.push(resolve)); });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:9999';
    document.body.append(host);
    for (let i = 0; i < 20; i++) {
      const img = document.createElement('img');
      img.style.cssText = 'width:10px;height:10px';
      host.append(img);
      scope.observe(img, i);
    }
    await pause(150);
    assert(reads === 4, 'blob reads must be limited to four');
    scope.dispose();
    host.remove();
    pending.forEach((resolve) => resolve(file));
    await pause();
    assert(reads === 4 && urls.size === 0, 'disposed image reads must not create URLs or drain stale queue');
    results.push('Image concurrency cap and pending-read disposal');

    const originalGet = idb.get;
    const delayed = [];
    idb.get = (name, key) => name === 'blobs' ? new Promise((resolve) => delayed.push(resolve)) : originalGet(name, key);
    openCard(boardId, card, { onChange() {}, onDelete() {} });
    await pause(150);
    document.getElementById('card-dialog').close();
    await pause();
    assert(delayed.length > 0, 'dialog image reads started');
    delayed.forEach((resolve) => resolve(file));
    await pause();
    assert(urls.size === 0, 'closed dialog must not retain image URLs');
    assert(!document.getElementById('card-dialog').childNodes.length, 'closed dialog DOM released');
    idb.get = originalGet;
    openCard(boardId, card, { onChange() {}, onDelete() {} });
    await pause(150);
    assert(urls.size > 0, 'visible images load');
    const title = document.querySelector('.dialog-title');
    title.value = 'Saved before refresh';
    title.dispatchEvent(new Event('input'));
    document.querySelector('[aria-label="Link URL"]').value = 'example.com';
    document.querySelector('.link-form .btn').click();
    assert(store.getCard(boardId, card).title === 'Saved before refresh', 'refresh preserves pending edits');
    document.getElementById('card-dialog').close();
    await pause();
    assert(urls.size === 0, 'loaded dialog URLs revoked');
    results.push('Dialog close races, URL cleanup and pending edits');

    let keys = 0;
    const originalAdd = window.addEventListener;
    const originalRemove = window.removeEventListener;
    window.addEventListener = function (type, ...args) { if (type === 'keydown') keys++; return originalAdd.call(this, type, ...args); };
    window.removeEventListener = function (type, ...args) { if (type === 'keydown') keys--; return originalRemove.call(this, type, ...args); };
    for (let i = 0; i < 5; i++) {
      menu(document.getElementById('search'), [{ label: 'Test', icon: 'plus', run() {} }]);
      await pause(10);
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    assert(keys === 0 && !document.querySelector('.menu'), 'replaced menus release global listeners');
    window.addEventListener = originalAdd;
    window.removeEventListener = originalRemove;
    results.push('Menu listener cleanup');

    const { initDnd } = await import('/src/dnd.js');
    const fixture = document.createElement('div');
    fixture.innerHTML = '<section class="lane" data-id="test"><div class="lane-cards"><article class="card" data-id="test-card">Drag</article></div></section>';
    document.body.append(fixture);
    fixture.setPointerCapture = () => {};
    fixture.hasPointerCapture = () => false;
    initDnd({ board: fixture, onCardMove() {}, onLaneMove() {} });
    const dragCard = fixture.querySelector('.card');
    const down = () => dragCard.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 }));
    down();
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    down();
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 30, clientY: 30 }));
    assert(document.querySelector('.drag-ghost'), 'drag can start after release outside board');
    window.dispatchEvent(new Event('blur'));
    await pause();
    assert(!document.querySelector('.drag-ghost') && !document.body.classList.contains('is-dragging'), 'blur cancels drag');
    fixture.remove();
    results.push('Drag release outside board and blur cleanup');

    // Refresh through an app action after the direct store mutations above.
    document.querySelector('.lane-composer button').click();
    document.querySelector('.lane-title-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    let renders = 0;
    const board = document.getElementById('board');
    const observer = new MutationObserver(() => renders++);
    observer.observe(board, { childList: true });
    const search = document.getElementById('search');
    for (let i = 0; i < 10; i++) {
      search.value = 'Saved';
      search.dispatchEvent(new Event('input'));
    }
    await pause(200);
    observer.disconnect();
    assert(renders === 1 && board.querySelectorAll('.card').length === 1, 'search bursts render once with correct results');
    results.push('Search coalesces input bursts');

    document.getElementById('add-board').click();
    document.getElementById('submit-board').click();
    assert(document.getElementById('board-name-error').textContent, 'empty board name has visible validation');
    assert(store.getBoards().length === 1, 'empty board name is rejected');
    const boardName = document.getElementById('board-name');
    boardName.value = 'Second board';
    document.getElementById('submit-board').click();
    await pause();
    const secondBoardId = store.getBoards()[1].id;
    assert(document.querySelectorAll('.board-tab').length === 2 && document.getElementById('add-board'), 'multi-board navigation shows all tabs and add button');
    assert(document.querySelector('.board-tab[aria-selected="true"]').dataset.id === secondBoardId, 'new board becomes active');
    const inactiveShortTab = document.querySelector(`.board-tab[data-id="${boardId}"] span`);
    assert(inactiveShortTab.textContent === 'My board' && inactiveShortTab.scrollWidth <= inactiveShortTab.clientWidth, 'short inactive board names remain fully visible');
    assert(document.querySelectorAll('#board .lane').length === 0 && !document.getElementById('search').value, 'new board is empty and clears search');

    const secondLane = store.createLane(secondBoardId, 'Private lane');
    const secondCard = store.createCard(secondBoardId, secondLane, 'Only on second');
    assert(!store.getBoard(boardId).some((item) => item.id === secondLane), 'board A excludes board B lanes');
    assert(store.getBoard(secondBoardId)[0].cards.length === 1, 'board B contains its own card');
    assert(store.moveCard(boardId, secondCard, lane.id, null, null) === false, 'cross-board card moves are rejected');
    document.querySelector(`.board-tab[data-id="${boardId}"]`).click();
    await pause();
    search.value = 'Only on second';
    search.dispatchEvent(new Event('input'));
    await pause(200);
    assert(board.querySelectorAll('.card').length === 0 && !document.getElementById('stats'), 'search is scoped to active board without header stats');
    document.querySelector(`.board-tab[data-id="${secondBoardId}"]`).click();
    await pause();
    assert(board.querySelectorAll('.lane').length === 1 && board.querySelectorAll('.card').length === 1, 'tab switch renders selected board');
    const editedColor = store.BOARD_COLORS.at(-1);
    const openBoardMenu = (id) => document.querySelector(`.board-tab-item[data-id="${id}"] .board-tab-menu`).click();
    const chooseBoardMenu = (label) => [...document.querySelectorAll('.menu button')].find((button) => button.textContent === label).click();
    openBoardMenu(secondBoardId);
    assert([...document.querySelectorAll('.menu button')].map((button) => button.textContent).join('|') === 'Edit name|Edit color', 'board tab menu has focused name and color actions');
    chooseBoardMenu('Edit name');
    assert(!document.getElementById('board-name-field').hidden && document.getElementById('board-color-field').hidden, 'edit name opens only the name editor');
    const boundaryBoardName = '1234567890123456789012345';
    document.getElementById('board-name').value = boundaryBoardName;
    document.getElementById('submit-board').click();
    await pause();
    assert(document.querySelector('.board-tab[aria-selected="true"]').textContent === boundaryBoardName, 'board names with exactly 25 characters remain complete');
    openBoardMenu(secondBoardId);
    chooseBoardMenu('Edit name');
    const longBoardName = 'A board name that stays fully visible';
    document.getElementById('board-name').value = longBoardName;
    document.getElementById('submit-board').click();
    await pause();
    openBoardMenu(secondBoardId);
    chooseBoardMenu('Edit color');
    assert(document.getElementById('board-name-field').hidden && !document.getElementById('board-color-field').hidden, 'edit color opens only the color editor');
    document.querySelector(`.color-option[data-color="${editedColor}"]`).click();
    document.getElementById('submit-board').click();
    await pause();
    const editedBoard = store.getBoards().find((item) => item.id === secondBoardId);
    assert(editedBoard.title === longBoardName && editedBoard.color === editedColor, 'board name and color are persisted');
    const activeTab = document.querySelector('.board-tab[aria-selected="true"]');
    assert(activeTab.textContent === `${Array.from(longBoardName).slice(0, 25).join('')}…` && activeTab.title === longBoardName && activeTab.getAttribute('aria-label') === longBoardName, 'board names longer than 25 characters are shortened with the full name available');
    document.querySelector(`.board-tab[data-id="${boardId}"]`).click();
    await pause();
    assert(document.querySelector(`.board-tab[data-id="${secondBoardId}"]`).textContent === `${Array.from(longBoardName).slice(0, 25).join('')}…`, 'long board names stay consistently shortened after switching tabs');
    document.querySelector(`.board-tab[data-id="${secondBoardId}"]`).click();
    await pause();
    assert(getComputedStyle(document.body).getPropertyValue('--board-color').trim() === editedColor, 'active board color themes the board');
    results.push('Board creation, editing, colors, tabs, isolation and board-scoped search');


    await pause(500);
    const originalPut = idb.put;
    const writes = [];
    idb.put = (name, key, value) => name === 'kv' ? new Promise((resolve) => writes.push({ value, resolve })) : originalPut(name, key, value);
    for (let i = 0; i < 4; i++) {
      store.updateCard(boardId, card, { title: 'write ' + i });
      await pause(220);
    }
    assert(writes.length === 1, 'slow persistence must not queue snapshots');
    writes[0].resolve();
    await pause();
    assert(writes.length === 2, 'one latest snapshot follows pending write');
    const SQL = await initSqlJs({ locateFile: (file) => 'vendor/' + file });
    const latest = new SQL.Database(writes[1].value);
    assert(latest.exec('SELECT title FROM cards')[0].values[0][0] === 'write 3', 'latest snapshot contains all edits');
    latest.close();
    writes[1].resolve();
    await pause();
    idb.put = originalPut;
    scheduleSave();
    await pause(250);
    results.push('Slow storage coalesces snapshots and preserves latest edits');
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    return results;
  }} )()`);
  for (const result of results) console.log(`PASS ${result}`);

  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await waitFor("document.querySelectorAll('.board-tab').length === 2 && document.querySelectorAll('.lane').length === 1", 'board reload');
  const reloadOk = await evaluate(`(${async function () {
    const store = await import('/src/store.js');
    const boards = store.getBoards();
    const active = document.querySelector('.board-tab[aria-selected="true"]');
    return boards.length === 2 && active?.textContent === 'A board name that stays f…' &&
      store.getBoard(active.dataset.id)[0]?.cards[0]?.title === 'Only on second';
  }})()`);
  if (!reloadOk) throw new Error('boards and active selection must survive reload');
  console.log('PASS Board data and active selection survive reload');

  await evaluate(`(${async function () {
    const { idb } = await import('/src/idb.js');
    const SQL = await initSqlJs({ locateFile: (file) => 'vendor/' + file });
    const legacy = new SQL.Database();
    legacy.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE lanes (id TEXT PRIMARY KEY, title TEXT NOT NULL, position REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE cards (id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', position REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE links (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', position REAL NOT NULL);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, is_image INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX idx_cards_lane ON cards(lane_id, position);
      CREATE INDEX idx_links_card ON links(card_id, position);
      CREATE INDEX idx_attachments_card ON attachments(card_id, position);
      INSERT INTO lanes VALUES ('legacy-lane', 'Legacy lane', 1024, 1);
      INSERT INTO cards VALUES ('legacy-card', 'legacy-lane', 'Legacy card', 'kept', 1024, 2, 2);
      INSERT INTO links VALUES ('legacy-link', 'legacy-card', 'https://example.com/', 'Example', 1024);
      INSERT INTO attachments VALUES ('legacy-file', 'legacy-card', 'kept.txt', 'text/plain', 4, 0, 1024, 3);
      PRAGMA user_version = 1;
    `);
    await idb.put('kv', 'sqlite', legacy.export());
    legacy.close();
    localStorage.removeItem('tablanes.activeBoardId');
  }})()`);

  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await waitFor("document.querySelectorAll('.lane').length === 1 && document.querySelector('.card-title')?.textContent === 'Legacy card'", 'schema migration');
  const migrationOk = await evaluate(`(${async function () {
    const store = await import('/src/store.js');
    const { all } = await import('/src/db.js');
    const boards = store.getBoards();
    const lanes = store.getBoard(boards[0]?.id);
    const card = store.getCard(boards[0]?.id, 'legacy-card');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return boards.length === 1 && lanes.length === 1 && lanes[0].id === 'legacy-lane' &&
      card?.description === 'kept' && card.links[0]?.id === 'legacy-link' &&
      card.attachments[0]?.id === 'legacy-file' && boards[0].color === store.DEFAULT_BOARD_COLOR &&
      all('PRAGMA user_version')[0].user_version === 3;
  }})()`);
  if (!migrationOk) throw new Error('schema-1 migration must preserve related data');
  console.log('PASS Schema-1 migration preserves lanes, cards, links and attachments');

  await evaluate(`(${async function () {
    const { idb } = await import('/src/idb.js');
    const SQL = await initSqlJs({ locateFile: (file) => 'vendor/' + file });
    const legacy = new SQL.Database();
    legacy.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, position REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE lanes (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, title TEXT NOT NULL, position REAL NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO boards VALUES ('v2-board', 'Version two', 1024, 1);
      INSERT INTO lanes VALUES ('v2-lane', 'v2-board', 'Still here', 1024, 2);
      PRAGMA user_version = 2;
    `);
    await idb.put('kv', 'sqlite', legacy.export());
    legacy.close();
    localStorage.removeItem('tablanes.activeBoardId');
  }})()`);
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await waitFor("document.querySelector('.lane-title')?.textContent === 'Still here'", 'schema-2 migration');
  const v2MigrationOk = await evaluate(`(${async function () {
    const store = await import('/src/store.js');
    const { all } = await import('/src/db.js');
    const board = store.getBoards()[0];
    return board?.id === 'v2-board' && board.color === store.DEFAULT_BOARD_COLOR &&
      store.getBoard(board.id)[0]?.id === 'v2-lane' && all('PRAGMA user_version')[0].user_version === 3;
  }})()`);
  if (!v2MigrationOk) throw new Error('schema-2 migration must add board colors without losing data');
  console.log('PASS Schema-2 migration adds default board colors without data loss');
} finally {
  ws.close();
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill();
  await exited;
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
