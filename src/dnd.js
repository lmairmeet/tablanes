const START_THRESHOLD = 5;
const EDGE = 84;
const EDGE_SPEED = 18;

/**
 * Pointer-driven drag and drop. The dragged node stays in the DOM and acts as
 * its own placeholder, so reordering during a drag is just a DOM move; a
 * cloned "ghost" follows the cursor.
 */
export function initDnd({ board, onCardMove, onLaneMove }) {
  let drag = null;
  let frame = null;
  let scrollFrame = null;
  const pointer = { x: 0, y: 0 };

  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('lostpointercapture', cancel);

  function onPointerDown(e) {
    if (e.button !== 0 || drag) return;
    if (e.target.closest('button, a, input, textarea, .no-drag')) return;

    const laneHandle = e.target.closest('.lane-header');
    const cardEl = e.target.closest('.card');
    const el = cardEl || (laneHandle ? laneHandle.closest('.lane') : null);
    if (!el) return;

    drag = {
      type: cardEl ? 'card' : 'lane',
      el,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: 0,
      offsetY: 0,
      active: false,
      ghost: null,
      origin: { parent: el.parentNode, next: el.nextElementSibling },
      pointerId: e.pointerId,
    };
    pointer.x = e.clientX;
    pointer.y = e.clientY;

    addEventListener('pointermove', onPointerMove);
    addEventListener('pointerup', onPointerUp);
    addEventListener('pointercancel', cancel);
    addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVisibilityChange);
    addEventListener('keydown', onKeyDown, true);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;

    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < START_THRESHOLD) return;
      begin();
    }
    e.preventDefault();
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!drag?.active) return;
      moveGhost();
      reorder();
    });
  }

  function begin() {
    // Captured only once a drag is real: capturing on pointerdown would retarget
    // the click that ends a plain tap, breaking click-to-edit.
    board.setPointerCapture(drag.pointerId);

    const rect = drag.el.getBoundingClientRect();
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;

    const ghost = drag.el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);

    drag.ghost = ghost;
    drag.active = true;
    drag.el.classList.add('drag-source');
    document.body.classList.add('is-dragging', `is-dragging-${drag.type}`);
    moveGhost();
    startAutoScroll();
  }

  function moveGhost() {
    drag.ghost.style.transform = `translate3d(${pointer.x - drag.offsetX}px, ${pointer.y - drag.offsetY}px, 0)`;
  }

  function reorder() {
    if (drag.type === 'card') reorderCard();
    else reorderLane();
  }

  function reorderCard() {
    const lanes = [...board.querySelectorAll('.lane')];
    if (!lanes.length) return;
    const target =
      lanes.find((lane) => {
        const r = lane.getBoundingClientRect();
        return pointer.x >= r.left && pointer.x <= r.right;
      }) ?? nearestByAxis(lanes, pointer.x, 'x');
    const list = target.querySelector('.lane-cards');

    const siblings = [...list.querySelectorAll(':scope > .card')].filter((c) => c !== drag.el);
    const next = siblings.find((c) => {
      const r = c.getBoundingClientRect();
      return pointer.y < r.top + r.height / 2;
    });
    place(list, next ?? null, siblings);
  }

  function reorderLane() {
    const lanes = [...board.querySelectorAll('.lane')].filter((l) => l !== drag.el);
    const next = lanes.find((l) => {
      const r = l.getBoundingClientRect();
      return pointer.x < r.left + r.width / 2;
    });
    place(board, next ?? board.querySelector('.lane-composer'), lanes);
  }

  function place(parent, before, animated) {
    if (drag.el.parentNode === parent && drag.el.nextElementSibling === before) return;
    flip(animated, () => parent.insertBefore(drag.el, before));
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) return cleanup();

    const el = drag.el;
    const type = drag.type;
    const rect = el.getBoundingClientRect();
    const ghost = drag.ghost;

    // Settle the ghost onto the slot before handing the element back.
    ghost.style.transition = 'transform 160ms cubic-bezier(.2,.8,.3,1), opacity 160ms ease';
    ghost.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    ghost.style.opacity = '0';
    setTimeout(() => ghost.remove(), 170);
    drag.ghost = null;

    el.classList.remove('drag-source');
    document.body.classList.remove('is-dragging', 'is-dragging-card', 'is-dragging-lane');
    swallowNextClick();

    const neighbour = (dir, selector) => {
      const sibling = el[dir];
      return sibling?.matches(selector) ? sibling.dataset.id : null;
    };
    cleanup();
    if (type === 'card') {
      const laneId = el.closest('.lane').dataset.id;
      onCardMove(el.dataset.id, laneId, neighbour('previousElementSibling', '.card'), neighbour('nextElementSibling', '.card'));
    } else {
      onLaneMove(el.dataset.id, neighbour('previousElementSibling', '.lane'), neighbour('nextElementSibling', '.lane'));
    }
  }

  function onVisibilityChange() {
    if (document.hidden) cancel();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && drag?.active) {
      e.stopPropagation();
      cancel();
    }
  }

  function cancel() {
    if (!drag) return;
    if (drag.active) {
      if (drag.origin.parent.isConnected) {
        const next = drag.origin.next;
        drag.origin.parent.insertBefore(drag.el, next?.parentNode === drag.origin.parent ? next : null);
      }
      drag.el.classList.remove('drag-source');
      drag.ghost?.remove();
      document.body.classList.remove('is-dragging', 'is-dragging-card', 'is-dragging-lane');
    }
    cleanup();
  }

  function cleanup() {
    if (frame) cancelAnimationFrame(frame);
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    frame = scrollFrame = null;
    removeEventListener('pointermove', onPointerMove);
    removeEventListener('pointerup', onPointerUp);
    removeEventListener('pointercancel', cancel);
    removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    removeEventListener('keydown', onKeyDown, true);
    const pointerId = drag?.pointerId;
    drag = null;
    if (pointerId != null && board.hasPointerCapture?.(pointerId)) board.releasePointerCapture(pointerId);
  }

  function startAutoScroll() {
    const step = () => {
      if (!drag?.active) return;
      scrollBoardEdges();
      scrollFrame = requestAnimationFrame(step);
    };
    scrollFrame = requestAnimationFrame(step);
  }

  function scrollBoardEdges() {
    const r = board.getBoundingClientRect();
    if (pointer.x < r.left + EDGE) board.scrollLeft -= ramp(r.left + EDGE - pointer.x);
    else if (pointer.x > r.right - EDGE) board.scrollLeft += ramp(pointer.x - (r.right - EDGE));

    if (drag.type !== 'card') return;
    const list = drag.el.parentNode;
    if (!list?.classList.contains('lane-cards')) return;
    const lr = list.getBoundingClientRect();
    if (pointer.y < lr.top + EDGE) list.scrollTop -= ramp(lr.top + EDGE - pointer.y);
    else if (pointer.y > lr.bottom - EDGE) list.scrollTop += ramp(pointer.y - (lr.bottom - EDGE));
  }

  const ramp = (distance) => Math.min(EDGE_SPEED, (distance / EDGE) * EDGE_SPEED);
}

/** A drag ends with a click event on the source; suppress it so cards don't open. */
function swallowNextClick() {
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
    done();
  };
  const done = () => {
    removeEventListener('click', swallow, true);
    clearTimeout(timer);
  };
  const timer = setTimeout(done, 350);
  addEventListener('click', swallow, true);
}

function nearestByAxis(elements, value, axis) {
  let best = elements[0];
  let bestDistance = Infinity;
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    const centre = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
    const d = Math.abs(centre - value);
    if (d < bestDistance) {
      bestDistance = d;
      best = el;
    }
  }
  return best;
}

/** First-Last-Invert-Play: animates siblings into their new slots after a DOM move. */
function flip(elements, mutate) {
  const first = new Map(elements.map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  for (const el of elements) {
    const a = first.get(el);
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    el.animate(
      [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.3,1)' }
    );
  }
}
