// Arrastar e soltar com mouse, caneta ou dedo, como na lista de canais do Discord.
// No mouse começa ao mover alguns pixels; no toque, depois de segurar um pouco,
// para que rolar a lista com o dedo continue funcionando.

const MOVE_PX = 6;
const HOLD_MS = 350;
const EDGE_PX = 40; // perto da borda da lista, ela rola sozinha

// root: onde ficam os itens (e que rola). selector: o que dá para arrastar.
// canDrag(el, event) diz se aquele item pode; onMove(el, x, y) mostra onde vai cair;
// onDrop(el) aplica; onEnd() limpa as marcas (sempre roda, até se cancelar).
export function makeDraggable(root, { selector, canDrag, onMove, onDrop, onEnd }) {
  let pending = null; // apertou, mas ainda não virou arrasto
  let drag = null;

  const begin = () => {
    const { el, x, y } = pending;
    clearTimeout(pending.timer);
    pending = null;
    const box = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: `${box.width}px`, left: `${box.left}px`, top: `${box.top}px` });
    document.body.append(ghost);
    el.classList.add('drag-source');
    document.body.classList.add('is-dragging');
    drag = { el, ghost, dx: x - box.left, dy: y - box.top, x, y, frame: requestAnimationFrame(autoScroll) };
    navigator.vibrate?.(15);
    onMove(el, x, y);
  };

  const finish = (dropped) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
    }
    if (!drag) return;
    const { el, ghost, frame } = drag;
    drag = null;
    cancelAnimationFrame(frame);
    ghost.remove();
    el.classList.remove('drag-source');
    document.body.classList.remove('is-dragging');
    // O clique que vem logo depois de soltar não pode abrir o canal.
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    try {
      if (dropped) onDrop(el);
    } finally {
      onEnd();
    }
  };

  const autoScroll = () => {
    if (!drag) return;
    const box = root.getBoundingClientRect();
    const step = drag.y < box.top + EDGE_PX ? -8 : drag.y > box.bottom - EDGE_PX ? 8 : 0;
    if (step) {
      root.scrollTop += step;
      onMove(drag.el, drag.x, drag.y);
    }
    drag.frame = requestAnimationFrame(autoScroll);
  };

  root.addEventListener('pointerdown', (e) => {
    if (drag || pending || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.target.closest(selector);
    if (!el || !root.contains(el) || !canDrag(el, e)) return;
    pending = { el, id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
    if (pending.touch) pending.timer = setTimeout(begin, HOLD_MS);
  });

  window.addEventListener('pointermove', (e) => {
    if (pending?.id === e.pointerId) {
      const moved = Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > MOVE_PX;
      if (!moved) return;
      // No toque, mexer antes do tempo é rolar a lista.
      if (pending.touch) return finish(false);
      begin();
    }
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    onMove(drag.el, e.clientX, e.clientY);
  });

  window.addEventListener('pointerup', () => finish(true));
  window.addEventListener('pointercancel', () => finish(false));
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') finish(false);
  });
  // Com o dedo segurando um item, o navegador não pode rolar a página nem abrir o menu.
  window.addEventListener('touchmove', (e) => drag && e.preventDefault(), { passive: false });
  root.addEventListener('contextmenu', (e) => {
    if (pending?.touch || drag) e.preventDefault();
  });

  return { get active() { return !!drag; } };
}

function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
}
