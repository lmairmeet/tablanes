/**
 * Captures the 1280x800 store screenshots into store/screenshots/.
 *
 * The extension only runs as a page, so this serves the repo under the same CSP
 * the manifest declares, seeds a demo board through the store module, and drives
 * headless Chrome over the DevTools protocol.
 *
 *   node scripts/screenshots.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8179;
const DEBUG_PORT = 9444;
const WIDTH = 1280;
const HEIGHT = 800;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'store/screenshots');
const profile = join(root, '.tmp-screenshot-profile');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

const DEMO = {
  'To do': [
    ['Redesign the onboarding flow', 'Cut the signup steps from five to two.'],
    ['Collect Q3 customer interviews', ''],
    ['Audit keyboard shortcuts', 'Every action needs a reachable key.'],
  ],
  Doing: [
    ['Ship dark mode', 'Tokens are done — the dialog still needs a pass.'],
    ['Write the migration guide', ''],
  ],
  Done: [
    ['Move the board to SQLite', ''],
    ['Drop the legacy uploader', ''],
  ],
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
await new Promise((r) => server.listen(PORT, r));

await mkdir(outDir, { recursive: true });
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
  pending.get(msg.id)?.(msg);
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

const shoot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`store/screenshots/${name}.png`);
};

await send('Page.enable');
await send('Runtime.enable');
// captureScreenshot follows the window, which is smaller than --window-size once
// the browser frame is subtracted; the override pins the exact store dimensions.
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});

await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await waitFor("document.querySelectorAll('.lane').length === 3", 'seeded lanes');

// Fill the demo board through the store itself, then reload so the app renders it.
await evaluate(`(async () => {
  const store = await import('/src/store.js');
  const demo = ${JSON.stringify(DEMO)};
  for (const lane of store.getBoard()) {
    if (lane.cards.length) continue;
    for (const [title, description] of demo[lane.title] ?? []) {
      const id = store.createCard(lane.id, title);
      if (description) store.updateCard(id, { description });
    }
  }
})()`);
await sleep(700);
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await waitFor("document.querySelectorAll('.card').length === 7", 'demo cards');
await sleep(600);
await shoot('01-board');

await evaluate("document.querySelector('.card').click()");
await waitFor("document.querySelector('dialog[open]')", 'card dialog');
await sleep(500);
await shoot('02-card');

await evaluate(`(() => {
  document.querySelector('dialog[open]')?.close();
  const search = document.getElementById('search');
  search.value = 'the';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  search.blur();
})()`);
await sleep(500);
await shoot('03-search');

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await evaluate(`(() => {
  const search = document.getElementById('search');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(600);
await shoot('04-light');

ws.close();
chrome.kill();
server.close();
await rm(profile, { recursive: true, force: true });
