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
    const lane = store.getBoard()[0];
    const card = store.createCard(lane.id, 'Performance regression');
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], 'test.svg', { type: 'image/svg+xml' });
    const attachment = await store.addAttachment(card, file);
    const attachment2 = await store.addAttachment(card, file);
    run('UPDATE attachments SET position = 1 WHERE card_id = ?', [card]);
    assert(store.getBoard()[0].cards[0].coverId === [attachment, attachment2].sort()[0], 'stable cover on tied positions');
    const snapshot = store.deleteLane(lane.id);
    assert(snapshot.attachments.length === 2 && snapshot.cards.length === 1, 'joined deletion snapshot');
    store.restore(snapshot);
    assert(store.getCard(card).attachments.length === 2, 'undo restores attachments');
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
    openCard(card, { onChange() {}, onDelete() {} });
    await pause(150);
    document.getElementById('card-dialog').close();
    await pause();
    assert(delayed.length > 0, 'dialog image reads started');
    delayed.forEach((resolve) => resolve(file));
    await pause();
    assert(urls.size === 0, 'closed dialog must not retain image URLs');
    assert(!document.getElementById('card-dialog').childNodes.length, 'closed dialog DOM released');
    idb.get = originalGet;
    openCard(card, { onChange() {}, onDelete() {} });
    await pause(150);
    assert(urls.size > 0, 'visible images load');
    const title = document.querySelector('.dialog-title');
    title.value = 'Saved before refresh';
    title.dispatchEvent(new Event('input'));
    document.querySelector('[aria-label="Link URL"]').value = 'example.com';
    document.querySelector('.link-form .btn').click();
    assert(store.getCard(card).title === 'Saved before refresh', 'refresh preserves pending edits');
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


    await pause(500);
    const originalPut = idb.put;
    const writes = [];
    idb.put = (name, key, value) => name === 'kv' ? new Promise((resolve) => writes.push({ value, resolve })) : originalPut(name, key, value);
    for (let i = 0; i < 4; i++) {
      store.updateCard(card, { title: 'write ' + i });
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
} finally {
  ws.close();
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill();
  await exited;
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
