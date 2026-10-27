// Touch / mouse gestures: swipe a row to reveal "ยกเลิก", drag a card by its ⋮⋮ grip.
// Pure behaviour. It only reports what happened through callbacks.

const REVEAL = 80;

export function attachGestures(root, { onReorder, onReveal, getRevealed, onIdle }) {
  let sw = null;
  let dg = null;
  let blockClick = false;

  const active = () => !!((sw && sw.captured) || dg);
  const endBlock = () => setTimeout(() => (blockClick = false), 60);

  root.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-grip]");
    if (grip) {
      const ticket = grip.closest("[data-ticket]");
      if (!ticket) return;
      try { grip.setPointerCapture(e.pointerId); } catch (x) {}
      dg = { grip, ticket, cardKey: ticket.dataset.cardKey, x: e.clientX, y: e.clientY, over: null, id: e.pointerId };
      ticket.classList.add("is-dragging");
      return;
    }
    const row = e.target.closest("[data-swipe]");
    if (row) {
      sw = { row, id: row.dataset.line, x: e.clientX, y: e.clientY, base: getRevealed() === row.dataset.line ? -REVEAL : 0, captured: false, dx: 0 };
    }
  });

  root.addEventListener("pointermove", (e) => {
    if (dg && e.pointerId === dg.id) {
      const dx = e.clientX - dg.x;
      const dy = e.clientY - dg.y;
      dg.ticket.style.transform = `translate(${dx}px,${dy}px) scale(1.03)`;
      let over = null;
      for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
        const t = el.closest && el.closest("[data-ticket]");
        if (t && t.dataset.cardKey !== dg.cardKey) { over = t; break; }
      }
      if (dg.over !== over) {
        if (dg.over) dg.over.classList.remove("is-dropover");
        if (over) over.classList.add("is-dropover");
        dg.over = over;
      }
      return;
    }
    if (!sw) return;
    const dx = e.clientX - sw.x;
    const dy = e.clientY - sw.y;
    if (!sw.captured && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      sw.captured = true;
      try { sw.row.setPointerCapture(e.pointerId); } catch (x) {}
      sw.row.style.transition = "none";
    }
    if (sw.captured) {
      sw.dx = dx;
      sw.row.style.transform = `translateX(${Math.max(-REVEAL, Math.min(0, sw.base + dx))}px)`;
    }
  });

  const finish = (e) => {
    if (dg && e.pointerId === dg.id) {
      const { ticket, over, cardKey } = dg;
      ticket.classList.remove("is-dragging");
      ticket.style.transform = "";
      if (over) over.classList.remove("is-dropover");
      dg = null;
      blockClick = true;
      endBlock();
      if (over) onReorder(cardKey, over.dataset.cardKey);
      onIdle();
      return;
    }
    if (sw) {
      const { row, id, captured, dx, base } = sw;
      sw = null;
      if (captured) {
        blockClick = true;
        endBlock();
        row.style.transition = "";
        let reveal = base !== 0;
        if (dx < -36) reveal = true;
        else if (dx > 36) reveal = false;
        row.style.transform = reveal ? `translateX(${-REVEAL}px)` : "";
        onReveal(reveal ? id : null);
      }
      onIdle();
    }
  };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", finish);

  return {
    active,
    // true once, right after a swipe/drag, so the "click" that follows it is ignored
    consumeClick() {
      if (blockClick) { blockClick = false; return true; }
      return false;
    },
  };
}
