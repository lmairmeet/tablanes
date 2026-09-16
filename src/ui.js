const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6"/><path d="M14 11a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7L12.6 18"/>',
  clip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"/>',
  text: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-2 4 4"/>',
  file: '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  download: '<path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 19h14"/>',
  top: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
};

/** Builds an element. Attrs may include text/html/class/dataset/on* handlers. */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [children].flat()) {
    if (child == null || child === false) continue;
    el.append(child);
  }
  return el;
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** Splits text around a search match so it can be highlighted without innerHTML. */
export function highlight(text, query) {
  if (!query) return [text];
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return [text];
  return [
    text.slice(0, index),
    h('mark', { text: text.slice(index, index + query.length) }),
    text.slice(index + query.length),
  ];
}

let toastTimer = null;

export function toast(message, action) {
  const host = document.getElementById('toast-host');
  host.replaceChildren();
  clearTimeout(toastTimer);

  const node = h('div', { class: 'toast' }, [
    h('span', { text: message }),
    action &&
      h('button', {
        text: action.label,
        onclick: () => {
          dismiss();
          action.run();
        },
      }),
  ]);
  host.append(node);

  const dismiss = () => {
    clearTimeout(toastTimer);
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };
  toastTimer = setTimeout(dismiss, action ? 6500 : 3000);
}

let closeMenu = null;

/** Opens a popover menu anchored to an element; closes on outside click, Esc or scroll. */
export function menu(anchor, items) {
  closeMenu?.();
  const rect = anchor.getBoundingClientRect();
  const node = h(
    'div',
    { class: 'menu' },
    items.map((item) =>
      h(
        'button',
        {
          class: item.danger ? 'btn-danger' : '',
          onclick: () => {
            close();
            item.run();
          },
        },
        [icon(item.icon), h('span', { text: item.label })]
      )
    )
  );
  document.body.append(node);

  const width = node.offsetWidth;
  node.style.left = `${Math.min(rect.right - width, innerWidth - width - 8)}px`;
  node.style.top = `${Math.min(rect.bottom + 6, innerHeight - node.offsetHeight - 8)}px`;

  const close = () => {
    clearTimeout(listenerTimer);
    closeMenu = null;
    node.remove();
    removeEventListener('pointerdown', onOutside, true);
    removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', close, true);
  };
  const onOutside = (e) => {
    if (!node.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  closeMenu = close;
  const listenerTimer = setTimeout(() => {
    addEventListener('pointerdown', onOutside, true);
    addEventListener('keydown', onKey, true);
    addEventListener('scroll', close, true);
  });
}

/** Grows a textarea to fit its content. */
export function autosize(textarea) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  textarea.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return resize;
}
