import { imageScope } from './images.js';
import { initDb } from './db.js';
import * as store from './store.js';
import { initDnd } from './dnd.js';
import { openCard } from './modal.js';
import { h, icon, menu, toast, highlight } from './ui.js';

const board = document.getElementById('board');
const searchInput = document.getElementById('search');
const stats = document.getElementById('stats');
const versionFooter = document.getElementById('version-footer');

// Update this value whenever the extension code changes. Keeping it explicit
// means the footer describes the shipped version, rather than page load time.
const VERSION_UPDATED_AT = '2026-09-16T08:49:48+05:30';

versionFooter.textContent = `Version updated on ${new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(VERSION_UPDATED_AT))}`;

let query = '';
let covers = null;
let lanesCache = null;
let searchTimer = null;
let composingIn = null; // lane id with an open card composer

// ------------------------------------------------------------------ render

function render(readStore = true) {
  clearTimeout(searchTimer);
  covers?.dispose();
  covers = imageScope(store.getBlob);

  const lanes = readStore || !lanesCache ? (lanesCache = store.getBoard()) : lanesCache;
  const scroll = board.scrollLeft;
  const scrollTops = new Map(
    [...board.querySelectorAll('.lane')].map((l) => [l.dataset.id, l.querySelector('.lane-cards').scrollTop])
  );

  board.replaceChildren(
    ...lanes.map((lane) => renderLane(lane, scrollTops.get(lane.id))),
    ...(lanes.length ? [] : [emptyState()]),
    laneComposer()
  );
  board.scrollLeft = scroll;
  renderStats(lanes);
}

function renderStats(lanes) {
  const total = lanes.reduce((n, lane) => n + lane.cards.length, 0);
  if (query) {
    const shown = lanes.reduce((n, lane) => n + lane.cards.filter(matches).length, 0);
    stats.textContent = `${shown} of ${total} ${total === 1 ? 'card' : 'cards'}`;
  } else {
    stats.textContent = total
      ? `${total} ${total === 1 ? 'card' : 'cards'} · ${lanes.length} ${lanes.length === 1 ? 'lane' : 'lanes'}`
      : '';
  }
}

function matches(card) {
  if (!query) return true;
  const q = query.toLowerCase();
  return card.title.toLowerCase().includes(q) || card.description.toLowerCase().includes(q);
}

function emptyState() {
  return h('p', { class: 'empty', text: 'No lanes yet — add one to get started.' });
}

function renderLane(lane, scrollTop) {
  const visible = lane.cards.filter(matches);

  const title = h('h2', {
    class: 'lane-title',
    text: lane.title,
    title: 'Click to rename',
    onclick: () => startRename(lane),
  });

  const list = h(
    'div',
    { class: 'lane-cards' },
    visible.map(renderCard)
  );
  if (scrollTop) requestAnimationFrame(() => (list.scrollTop = scrollTop));

  return h('section', { class: 'lane', dataset: { id: lane.id } }, [
    h('header', { class: 'lane-header' }, [
      title,
      h('span', {
        class: 'lane-count',
        text: query ? `${visible.length}/${lane.cards.length}` : String(lane.cards.length),
      }),
      h(
        'button',
        {
          class: 'icon-btn no-drag',
          title: 'Lane actions',
          onclick: (e) => laneMenu(e.currentTarget, lane),
        },
        icon('dots')
      ),
    ]),
    list,
    composingIn === lane.id ? cardComposer(lane.id) : addCardButton(lane.id),
  ]);
}

function renderCard(card) {
  const node = h('article', { class: 'card', dataset: { id: card.id } }, [
    card.coverId && h('img', { class: 'card-cover', alt: '' }),
    h('p', { class: 'card-title' }, highlight(card.title, query)),
    h('div', { class: 'card-badges' }, [
      card.description.trim() && h('span', { class: 'badge', title: 'Has a description' }, icon('text')),
      card.linkCount > 0 &&
        h('span', { class: 'badge' }, [icon('link'), h('span', { text: String(card.linkCount) })]),
      card.fileCount > 0 &&
        h('span', { class: 'badge' }, [icon('clip'), h('span', { text: String(card.fileCount) })]),
    ]),
  ]);

  if (card.coverId) {
    covers.observe(node.querySelector('.card-cover'), card.coverId);
  }

  node.addEventListener('click', () => openCardDialog(card.id));
  return node;
}

/** Re-renders, then offers the deletion back for one toast's lifetime. */
function undoable(message, snapshot) {
  render();
  toast(message, {
    label: 'Undo',
    run: () => {
      store.restore(snapshot);
      render();
    },
  });
}

function openCardDialog(cardId) {
  openCard(cardId, { onChange: render, onDelete: (snapshot) => undoable('Card deleted', snapshot) });
}

/** Swaps the lane heading for an input so the header itself stays draggable. */
function startRename(lane) {
  const heading = board.querySelector(`.lane[data-id="${lane.id}"] .lane-title`);
  if (!heading) return;

  const input = h('input', { class: 'lane-title lane-title-input no-drag', type: 'text', value: lane.title });
  let settled = false;

  const commit = (save) => {
    if (settled) return;
    settled = true;
    if (save && input.value.trim() && input.value.trim() !== lane.title) store.renameLane(lane.id, input.value);
    render();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));

  heading.replaceWith(input);
  input.focus();
  input.select();
}

function laneMenu(anchor, lane) {
  menu(anchor, [
    {
      icon: 'top',
      label: 'Add card to top',
      run: () => {
        const id = store.createCard(lane.id, 'New card', true);
        render();
        openCardDialog(id);
      },
    },
    { icon: 'pencil', label: 'Rename lane', run: () => startRename(lane) },
    {
      icon: 'trash',
      label: 'Delete lane',
      danger: true,
      run: () => undoable(`Deleted “${lane.title}”`, store.deleteLane(lane.id)),
    },
  ]);
}

// --------------------------------------------------------------- composers

function addCardButton(laneId) {
  return h(
    'button',
    {
      class: 'add-card no-drag',
      onclick: () => {
        composingIn = laneId;
        render();
      },
    },
    [icon('plus'), h('span', { text: 'Add a card' })]
  );
}

function cardComposer(laneId) {
  const input = h('textarea', {
    class: 'no-drag',
    placeholder: 'Card title…',
    rows: 2,
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        composingIn = null;
        render();
      }
    },
  });

  const submit = () => {
    const value = input.value.trim();
    if (!value) return closeComposer();
    store.createCard(laneId, value);
    render();
    const next = board.querySelector(`.lane[data-id="${laneId}"] .composer textarea`);
    next?.focus();
    const list = board.querySelector(`.lane[data-id="${laneId}"] .lane-cards`);
    if (list) list.scrollTop = list.scrollHeight;
  };

  const closeComposer = () => {
    composingIn = null;
    render();
  };

  requestAnimationFrame(() => input.focus());

  return h('div', { class: 'composer no-drag' }, [
    input,
    h('div', { class: 'composer-actions' }, [
      h('button', { class: 'btn', onclick: submit }, 'Add card'),
      h('button', { class: 'btn-ghost', onclick: closeComposer }, 'Cancel'),
    ]),
  ]);
}

function laneComposer() {
  return h('div', { class: 'lane-composer' }, [
    h(
      'button',
      {
        class: 'no-drag',
        onclick: () => {
          const id = store.createLane('New lane');
          render();
          board.scrollLeft = board.scrollWidth;
          startRename({ id, title: 'New lane' });
        },
      },
      [icon('plus'), h('span', { text: 'Add lane' })]
    ),
  ]);
}

// ----------------------------------------------------------------- wiring

searchInput.addEventListener('input', (e) => {
  query = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(false), 120);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.target.value = '';
  query = '';
  e.target.blur();
  render(false);
});

addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.target.matches('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  searchInput.focus();
  searchInput.select();
});

// --------------------------------------------------------------------- boot

initDb()
  .then(() => {
    render();
    initDnd({
      board,
      onCardMove: (cardId, laneId, beforeId, afterId) => {
        store.moveCard(cardId, laneId, beforeId, afterId);
        render();
      },
      onLaneMove: (laneId, beforeId, afterId) => {
        store.moveLane(laneId, beforeId, afterId);
        render();
      },
    });
    return store.collectGarbage();
  })
  .catch((err) => {
    console.error('TabLanes failed to start', err);
    board.replaceChildren(h('p', { class: 'empty', text: 'TabLanes could not open its database.' }));
  });
