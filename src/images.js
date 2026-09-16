/** Load only nearby images, with a shared limit on concurrent blob reads. */
const queue = new Set();
let active = 0;
const LIMIT = 4;

function pump() {
  while (active < LIMIT && queue.size) {
    const job = queue.values().next().value;
    queue.delete(job);
    active++;
    Promise.resolve().then(job).catch((err) => {
      console.error('TabLanes: could not load image', err);
    }).finally(() => {
      active--;
      pump();
    });
  }
}

export function imageScope(getBlob) {
  const entries = new Map();
  let disposed = false;
  const release = (entry) => {
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
    entry.img.removeAttribute('src');
  };
  const observer = new IntersectionObserver((changes) => {
    for (const change of changes) {
      const entry = entries.get(change.target);
      if (!entry) continue;
      entry.visible = change.isIntersecting;
      if (entry.visible && !entry.url && !entry.pending) queue.add(entry.load);
      if (!entry.visible) {
        queue.delete(entry.load);
        release(entry);
      }
    }
    pump();
  }, { rootMargin: '200px' });

  return {
    observe(img, id) {
      const entry = { img, visible: false, pending: false, url: null };
      entry.load = async () => {
        if (disposed || !entry.visible) return;
        entry.pending = true;
        try {
          const blob = await getBlob(id);
          if (disposed || !entry.visible || !img.isConnected || !blob) return;
          entry.url = URL.createObjectURL(blob);
          img.src = entry.url;
        } finally {
          entry.pending = false;
        }
      };
      entries.set(img, entry);
      observer.observe(img);
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      for (const entry of entries.values()) {
        queue.delete(entry.load);
        release(entry);
      }
      entries.clear();
    },
  };
}
