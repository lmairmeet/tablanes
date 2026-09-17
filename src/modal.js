import { imageScope } from './images.js';
import * as store from './store.js';
import { h, icon, formatBytes, autosize, toast } from './ui.js';

const dialog = document.getElementById('card-dialog');
let images = null;
let savedTimer = null;
let closeLightbox = null;
let saveTimer = null;
let session = null;

/** Only http(s) links are accepted; anything else could smuggle a javascript: URL. */
function normalizeUrl(input) {
  const raw = input.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

export function openCard(boardId, cardId, { onChange, onDelete }) {
  flushSave();
  session = { boardId, cardId, onChange, onDelete };
  render();
  if (!dialog.open) dialog.showModal();
}

function close() {
  flushSave();
  dialog.close();
}

dialog.addEventListener('close', () => {
  flushSave();
  images?.dispose();
  clearTimeout(savedTimer);
  closeLightbox?.();
  dialog.replaceChildren();
  session = null;
});

// Clicking the backdrop (outside the dialog box) closes it.
dialog.addEventListener('pointerdown', (e) => {
  if (e.target === dialog) close();
});

function scheduleSave(fields) {
  clearTimeout(saveTimer);
  const { boardId, cardId } = session;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    store.updateCard(boardId, cardId, fields);
    session?.onChange();
    markSaved();
  }, 400);
}

function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const title = dialog.querySelector('.dialog-title');
  const description = dialog.querySelector('.description');
  if (title && session) {
    store.updateCard(session.boardId, session.cardId, {
      title: title.value.trim() || 'Untitled',
      description: description.value,
    });
    session.onChange();
  }
}

function markSaved() {
  const label = dialog.querySelector('.saved');
  if (!label) return;
  label.textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (label.textContent = ''), 1600);
}

function refresh() {
  flushSave();
  render();
  session.onChange();
}

function render() {
  const card = store.getCard(session.boardId, session.cardId);
  if (!card) return dialog.close();

  images?.dispose();
  clearTimeout(savedTimer);
  images = imageScope(store.getBlob);

  const title = h('textarea', {
    class: 'dialog-title',
    rows: 1,
    'aria-label': 'Card title',
    oninput: (e) => scheduleSave({ title: e.target.value.trim() || 'Untitled', description: description.value }),
  });
  title.value = card.title;

  const description = h('textarea', {
    class: 'description',
    placeholder: 'Add a more detailed description…',
    oninput: () => scheduleSave({ title: title.value.trim() || 'Untitled', description: description.value }),
  });
  description.value = card.description;

  dialog.replaceChildren(
    h('div', { class: 'dialog-body' }, [
      h('div', { class: 'dialog-head' }, [
        title,
        h('button', { class: 'icon-btn', style: 'opacity:1', title: 'Close', onclick: close }, icon('x')),
      ]),
      h('section', {}, [
        h('div', { class: 'field-label' }, [icon('text'), h('span', { text: 'Description' })]),
        description,
      ]),
      h('section', {}, [
        h('div', { class: 'field-label' }, [icon('link'), h('span', { text: 'Links' })]),
        ...card.links.map(linkRow),
        linkForm(session.boardId, card.id),
      ]),
      h('section', {}, [
        h('div', { class: 'field-label' }, [icon('clip'), h('span', { text: 'Files & images' })]),
        ...card.attachments.map(fileRow),
        dropzone(session.boardId, card.id),
      ]),
      h('div', { class: 'dialog-foot' }, [
        h(
          'button',
          {
            class: 'btn-ghost btn-danger',
            onclick: () => {
              const notify = session.onDelete;
              const snapshot = store.deleteCard(session.boardId, card.id);
              dialog.close();
              notify(snapshot);
            },
          },
          'Delete card'
        ),
        h('span', { class: 'saved' }),
      ]),
    ])
  );

  autosize(title);
}

function linkRow(link) {
  let host = link.url;
  try {
    host = new URL(link.url).hostname.replace(/^www\./, '');
  } catch {}
  return h('div', { class: 'link-row' }, [
    h('span', { class: 'file-thumb doc', style: 'width:28px;height:28px' }, icon('link')),
    h('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer', text: link.label || link.url }),
    h('span', { class: 'host', text: host }),
    h(
      'button',
      {
        class: 'icon-btn',
        style: 'opacity:1',
        title: 'Remove link',
        onclick: () => {
          store.deleteLink(session.boardId, link.id);
          refresh();
        },
      },
      icon('x')
    ),
  ]);
}

function linkForm(boardId, cardId) {
  const url = h('input', { type: 'text', placeholder: 'Paste a URL', 'aria-label': 'Link URL' });
  const label = h('input', { type: 'text', class: 'label-input', placeholder: 'Label (optional)' });

  const submit = () => {
    const parsed = normalizeUrl(url.value);
    if (!parsed) {
      url.focus();
      if (url.value.trim()) toast('That does not look like a web link.');
      return;
    }
    store.addLink(boardId, cardId, parsed.href, label.value.trim());
    refresh();
  };

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };
  url.addEventListener('keydown', onKey);
  label.addEventListener('keydown', onKey);

  return h('div', { class: 'link-form' }, [url, label, h('button', { class: 'btn', onclick: submit }, 'Add')]);
}

function fileRow(file) {
  const thumb = file.is_image
    ? h('img', { class: 'file-thumb', alt: file.name, onclick: () => lightbox(file) })
    : h('span', { class: 'file-thumb doc' }, icon('file'));

  if (file.is_image) {
    images.observe(thumb, file.id);
  }

  return h('div', { class: 'file-row' }, [
    thumb,
    h('div', { class: 'file-meta' }, [
      h('span', { class: 'file-name', text: file.name, title: file.name }),
      h('span', { class: 'file-size', text: formatBytes(file.size) }),
    ]),
    h('button', { class: 'icon-btn', style: 'opacity:1', title: 'Download', onclick: () => download(file) }, icon('download')),
    h(
      'button',
      {
        class: 'icon-btn',
        style: 'opacity:1',
        title: 'Remove file',
        onclick: () => {
          store.deleteAttachment(session.boardId, file.id);
          refresh();
        },
      },
      icon('x')
    ),
  ]);
}

async function download(file) {
  const blob = await store.getBlob(file.id);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function lightbox(file) {
  const owner = session;
  const blob = await store.getBlob(file.id);
  if (!blob || session !== owner || !dialog.open) return;
  closeLightbox?.();
  const url = URL.createObjectURL(blob);
  const box = h('div', { class: 'lightbox' }, h('img', { src: url, alt: file.name }));
  const close = () => {
    closeLightbox = null;
    box.remove();
    URL.revokeObjectURL(url);
    removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  closeLightbox = close;
  box.addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  document.body.append(box);
}

function dropzone(boardId, cardId) {
  const input = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: (e) => add([...e.target.files]),
  });

  const zone = h('div', { class: 'dropzone', onclick: () => input.click() }, [
    icon('clip'),
    h('span', { text: 'Drop files here, or click to choose' }),
    input,
  ]);

  const owner = session;
  const add = async (files) => {
    try {
      for (const file of files) await store.addAttachment(boardId, cardId, file);
      if (session === owner && dialog.open) refresh();
      else owner.onChange();
    } catch (err) {
      console.error('TabLanes: failed to add attachment', err);
      toast('Could not add one or more files.');
    }
  };

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    add([...e.dataTransfer.files]);
  });

  return zone;
}
