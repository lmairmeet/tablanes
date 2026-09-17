import { imageScope } from './images.js';
import { initDb } from './db.js';
import * as store from './store.js';
import { initDnd } from './dnd.js';
import { openCard } from './modal.js';
import { h, icon, menu, toast, highlight } from './ui.js';

const board = document.getElementById('board');
const searchInput = document.getElementById('search');
const versionFooter = document.getElementById('version-footer');
const boardTabs = document.getElementById('board-tabs');
const addBoardButton = document.getElementById('add-board');
const boardDialog = document.getElementById('board-dialog');
const boardForm = document.getElementById('board-form');
const boardNameField = document.getElementById('board-name-field');
const boardNameInput = document.getElementById('board-name');
const boardNameError = document.getElementById('board-name-error');
const boardDialogTitle = document.getElementById('board-dialog-title');
const boardColorField = document.getElementById('board-color-field');
const boardColors = document.getElementById('board-colors');
const submitBoardButton = document.getElementById('submit-board');

// Update this value whenever the extension code changes. Keeping it explicit
// means the footer describes the shipped version, rather than page load time.
const VERSION_UPDATED_AT = '2026-09-17T21:54:29+05:30';

versionFooter.textContent = `Version updated on ${new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(VERSION_UPDATED_AT))}`;

let query = '';
let covers = null;
let lanesCache = null;
let searchTimer = null;
let composingIn = null; // lane id with an open card composer
let boardsCache = [];
let activeBoardId = null;
let savingBoard = false;
let editingBoardId = null;
let editingBoardField = null;
let selectedBoardColor = store.DEFAULT_BOARD_COLOR;

// ------------------------------------------------------------------ render

function render(readStore = true) {
  clearTimeout(searchTimer);
  covers?.dispose();
  covers = imageScope(store.getBlob);

  const lanes = readStore || !lanesCache ? (lanesCache = store.getBoard(activeBoardId)) : lanesCache;
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
}

function renderBoardTabs() {
  boardTabs.replaceChildren(
    ...boardsCache.map((item) => {
          const tab = h(
            'button',
            {
              class: `board-tab${item.id === activeBoardId ? ' is-active' : ''}`,
              type: 'button',
              role: 'tab',
              'aria-selected': item.id === activeBoardId ? 'true' : 'false',
              'aria-label': item.title,
              tabindex: item.id === activeBoardId ? '0' : '-1',
              title: item.title,
              dataset: { id: item.id },
              onclick: () => switchBoard(item.id),
            },
            h('span', { text: boardTabTitle(item.title) })
          );
          const options = h(
            'button',
            {
              class: 'board-tab-menu',
              type: 'button',
              'aria-label': `Options for ${item.title}`,
              title: 'Board options',
              onclick: (event) => {
                event.stopPropagation();
                menu(event.currentTarget, [
                  { icon: 'pencil', label: 'Edit name', run: () => openBoardDialog(item, 'name') },
                  { icon: 'palette', label: 'Edit color', run: () => openBoardDialog(item, 'color') },
                ]);
              },
            },
            icon('dots')
          );
          const itemNode = h(
            'div',
            {
              class: `board-tab-item${item.id === activeBoardId ? ' is-active' : ''}`,
              role: 'presentation',
              dataset: { id: item.id },
            },
            [tab, options]
          );
          itemNode.style.setProperty('--tab-color', item.color);
          return itemNode;
        })
  );
  applyBoardTheme();
}

function boardTabTitle(title) {
  const characters = Array.from(title);
  return characters.length > 25 ? `${characters.slice(0, 25).join('')}…` : title;
}

function activeBoard() {
  return boardsCache.find((item) => item.id === activeBoardId) ?? boardsCache[0] ?? null;
}

function applyBoardTheme() {
  const current = activeBoard();
  const color = current?.color ?? store.DEFAULT_BOARD_COLOR;
  document.body.style.setProperty('--board-color', color);
  board.setAttribute('aria-label', current ? `${current.title} board` : 'Board');
}

function switchBoard(boardId) {
  if (boardId === activeBoardId || !boardsCache.some((item) => item.id === boardId)) return;
  const cardDialog = document.getElementById('card-dialog');
  if (cardDialog.open) cardDialog.close();
  activeBoardId = boardId;
  store.setActiveBoardId(boardId);
  query = '';
  searchInput.value = '';
  composingIn = null;
  lanesCache = null;
  board.scrollLeft = 0;
  renderBoardTabs();
  render();
  boardTabs.querySelector(`[data-id="${CSS.escape(boardId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  openCard(activeBoardId, cardId, { onChange: render, onDelete: (snapshot) => undoable('Card deleted', snapshot) });
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
    if (save && input.value.trim() && input.value.trim() !== lane.title) {
      store.renameLane(activeBoardId, lane.id, input.value);
    }
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
        const id = store.createCard(activeBoardId, lane.id, 'New card', true);
        render();
        openCardDialog(id);
      },
    },
    { icon: 'pencil', label: 'Rename lane', run: () => startRename(lane) },
    {
      icon: 'trash',
      label: 'Delete lane',
      danger: true,
      run: () => undoable(`Deleted “${lane.title}”`, store.deleteLane(activeBoardId, lane.id)),
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
    store.createCard(activeBoardId, laneId, value);
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
          const id = store.createLane(activeBoardId, 'New lane');
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

function selectBoardColor(color) {
  selectedBoardColor = store.BOARD_COLORS.includes(color) ? color : store.DEFAULT_BOARD_COLOR;
  for (const option of boardColors.querySelectorAll('.color-option')) {
    const selected = option.dataset.color === selectedBoardColor;
    option.setAttribute('aria-checked', selected ? 'true' : 'false');
    option.tabIndex = selected ? 0 : -1;
  }
}

function openBoardDialog(item = null, field = null) {
  editingBoardId = item?.id ?? null;
  editingBoardField = item ? field : null;
  boardForm.reset();
  boardNameError.textContent = '';
  boardNameInput.removeAttribute('aria-invalid');
  boardNameField.hidden = editingBoardField === 'color';
  boardColorField.hidden = editingBoardField === 'name';
  boardDialogTitle.textContent = editingBoardField === 'name'
    ? 'Edit board name'
    : editingBoardField === 'color'
      ? 'Edit board color'
      : 'Create a board';
  submitBoardButton.textContent = editingBoardField === 'name'
    ? 'Save name'
    : editingBoardField === 'color'
      ? 'Save color'
      : 'Create board';
  boardNameInput.value = item?.title ?? '';
  selectBoardColor(item?.color ?? store.DEFAULT_BOARD_COLOR);
  boardDialog.showModal();
  requestAnimationFrame(() => {
    if (editingBoardField === 'color') {
      boardColors.querySelector('[aria-checked="true"]')?.focus();
    } else {
      boardNameInput.focus();
      if (item) boardNameInput.select();
    }
  });
}

boardColors.replaceChildren(
  ...store.BOARD_COLORS.map((color, index) =>
    h('button', {
      class: 'color-option',
      type: 'button',
      role: 'radio',
      'aria-label': `Color ${index + 1}`,
      'aria-checked': index === 0 ? 'true' : 'false',
      tabindex: index === 0 ? '0' : '-1',
      dataset: { color },
      style: `--choice-color:${color}`,
      onclick: () => selectBoardColor(color),
    })
  )
);

addBoardButton.replaceChildren(icon('plus'));
addBoardButton.addEventListener('click', () => openBoardDialog());

document.getElementById('cancel-board').addEventListener('click', () => boardDialog.close());

boardForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (savingBoard) return;
  const title = boardNameInput.value.trim();
  if (editingBoardField !== 'color' && !title) {
    boardNameError.textContent = 'Enter a board name.';
    boardNameInput.setAttribute('aria-invalid', 'true');
    boardNameInput.focus();
    return;
  }

  savingBoard = true;
  submitBoardButton.disabled = true;
  try {
    if (editingBoardId) {
      store.updateBoard(
        editingBoardId,
        editingBoardField === 'color' ? { color: selectedBoardColor } : { title }
      );
      boardsCache = store.getBoards();
      boardDialog.close();
      renderBoardTabs();
      return;
    }

    const id = store.createBoard(title, selectedBoardColor);
    boardsCache = store.getBoards();
    activeBoardId = id;
    store.setActiveBoardId(id);
    query = '';
    searchInput.value = '';
    composingIn = null;
    lanesCache = null;
    board.scrollLeft = 0;
    boardDialog.close();
    renderBoardTabs();
    render();
  } finally {
    savingBoard = false;
    submitBoardButton.disabled = false;
  }
});

boardNameInput.addEventListener('input', () => {
  if (!boardNameInput.value.trim()) return;
  boardNameError.textContent = '';
  boardNameInput.removeAttribute('aria-invalid');
});

boardTabs.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...boardTabs.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return;
  e.preventDefault();
  const current = tabs.indexOf(document.activeElement);
  let next = current;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else next = (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  switchBoard(tabs[next].dataset.id);
});

boardColors.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const options = [...boardColors.querySelectorAll('.color-option')];
  e.preventDefault();
  const current = Math.max(0, options.indexOf(document.activeElement));
  let next = current;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = options.length - 1;
  else next = (current + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + options.length) % options.length;
  selectBoardColor(options[next].dataset.color);
  options[next].focus();
});

// --------------------------------------------------------------------- boot

initDb()
  .then(() => {
    boardsCache = store.getBoards();
    activeBoardId = store.getActiveBoardId(boardsCache);
    store.setActiveBoardId(activeBoardId);
    renderBoardTabs();
    render();
    initDnd({
      board,
      onCardMove: (cardId, laneId, beforeId, afterId) => {
        store.moveCard(activeBoardId, cardId, laneId, beforeId, afterId);
        render();
      },
      onLaneMove: (laneId, beforeId, afterId) => {
        store.moveLane(activeBoardId, laneId, beforeId, afterId);
        render();
      },
    });
    return store.collectGarbage();
  })
  .catch((err) => {
    console.error('TabLanes failed to start', err);
    board.replaceChildren(h('p', { class: 'empty', text: 'TabLanes could not open its database.' }));
  });
