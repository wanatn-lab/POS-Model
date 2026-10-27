// Kitchen screen LOOK: turns the data from logic.js into HTML. Colors, sizes and
// animations are in kitchen.css. To restyle the screen, change this file + the css only.
import { LEVEL_LABEL, cardTimes, fmtClock, levelAt } from "./logic.js";
import { attachGestures } from "./gestures.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const clockFmt = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false });

function itemRow(item, showNote, revealed) {
  const cancelled = item.st === "c";
  const added = item.isAddOn && !cancelled;
  const tx = revealed === item.lineId ? ' style="transform:translateX(-80px)"' : "";
  const note = showNote && item.orderNote ? `<div class="r-note">โน้ต: ${esc(item.orderNote)}</div>` : "";
  const lead = cancelled
    ? `<button class="undo" data-act="undo" data-line="${esc(item.lineId)}">คืน</button>`
    : `<button class="check ${item.st === "d" ? "is-done" : ""}" data-act="toggle" data-line="${esc(item.lineId)}" aria-label="เสร็จ">${item.st === "d" ? "✓" : ""}</button>`;
  return `<div class="row">
    ${cancelled ? "" : `<button class="cancelbtn" data-act="cancel" data-line="${esc(item.lineId)}">ยกเลิก</button>`}
    <div class="swipe ${added ? "is-added" : ""} st-${item.st}" ${cancelled ? "" : `data-swipe data-line="${esc(item.lineId)}"`}${tx}>
      ${lead}
      <div class="r-qty">${esc(item.qty)}×</div>
      <div class="r-main"><div class="r-name">${esc(item.name)}</div>${note}</div>
      ${added ? '<div class="tag-add">+ สั่งเพิ่ม</div>' : ""}
      ${cancelled ? '<div class="tag-cancel">ยกเลิกแล้ว</div>' : ""}
    </div>
  </div>`;
}

function ticketHtml(t, nowMs, cfg, revealed) {
  const card = t.card;
  const times = cardTimes(card);
  const level = levelAt(times, nowMs, cfg);
  const pending = t.items.filter((i) => i.st === "p");
  const seen = new Set();
  const rows = t.items
    .map((item) => {
      const first = !seen.has(item.orderId);
      seen.add(item.orderId);
      return itemRow(item, first, revealed);
    })
    .join("");
  return `<article class="ticket lv-${level}" data-ticket data-card-key="${esc(card.key)}" data-created="${times.createdMs}" data-added="${times.lastAddMs ?? ""}">
    ${card.rush ? '<div class="rushbar">ด่วน · ทำก่อน</div>' : ""}
    <header class="thead">
      <button class="grip" data-grip aria-label="ลากเพื่อย้ายคิว">⋮⋮</button>
      <div class="tid">
        <div class="t-table">โต๊ะ ${esc(card.table)}</div>
        <div class="t-meta"><span>#${esc(card.billNo ?? "----")} · เสร็จ ${card.doneCount}/${card.total}</span>
          ${t.items.some((i) => i.isAddOn && i.st !== "c") ? '<span class="tag-add">+ สั่งเพิ่ม</span>' : ""}</div>
      </div>
      ${t.parts > 1 ? `<div class="part">ใบ ${t.part}/${t.parts}</div>` : ""}
      <div class="grow"></div>
      <div class="tright"><div class="t-time">${fmtClock((nowMs - times.createdMs) / 1000)}</div><div class="t-badge">${LEVEL_LABEL[level]}</div></div>
    </header>
    <div class="titems">${rows}</div>
    <footer class="tfoot">
      <button class="btn-rush ${card.rush ? "is-on" : ""}" data-act="rush" data-card-key="${esc(card.key)}" data-rush="${card.rush ? "0" : "1"}">${card.rush ? "เลิกด่วน" : "ด่วน"}</button>
      ${pending.length > 1 ? `<button class="btn-all" data-act="finish" data-lines="${esc(pending.map((i) => i.lineId).join(","))}">เสร็จทั้งใบ (${pending.length})</button>` : ""}
    </footer>
  </article>`;
}

function doneHtml(card) {
  const items = card.items
    .map(
      (i) => `<div class="d-item ${i.st === "c" ? "is-cancel" : ""}"><b>${esc(i.qty)}×</b><span>${esc(i.name)}${i.st === "c" ? " (ยกเลิก)" : ""}</span></div>`,
    )
    .join("");
  return `<div class="dcard">
    <div class="d-head"><div class="d-table">โต๊ะ ${esc(card.table)}</div><div class="d-bill">#${esc(card.billNo ?? "----")}</div><div class="d-time">${fmtClock(card.elapsedSec ?? 0)}</div></div>
    ${items}
    <button class="btn-back" data-act="undo-done" data-card-key="${esc(card.key)}">ย้ายกลับ</button>
  </div>`;
}

export function createView(doc, dispatch) {
  const $ = (id) => doc.getElementById(id);
  const grid = $("grid");
  const doneList = $("done-list");
  let revealed = null;
  let lastModel = null;
  let deferred = false;
  let toastTimer = null;

  const gestures = attachGestures(doc.getElementById("app"), {
    getRevealed: () => revealed,
    onReveal: (id) => {
      if (revealed && revealed !== id) {
        const prev = doc.querySelector(`[data-swipe][data-line="${CSS.escape(revealed)}"]`);
        if (prev) prev.style.transform = "";
      }
      revealed = id;
    },
    onReorder: (moved, target) => dispatch({ type: "reorder", moved, target }),
    onIdle: () => {
      if (deferred && lastModel) render(lastModel);
    },
  });

  doc.getElementById("app").addEventListener("click", (e) => {
    if (gestures.consumeClick()) return;
    const btn = e.target.closest("[data-act]");
    if (!btn) {
      if (revealed) { revealed = null; if (lastModel) render(lastModel, true); }
      return;
    }
    const act = btn.dataset.act;
    revealed = null;
    if (act === "toggle") dispatch({ type: "toggle", lineId: btn.dataset.line });
    else if (act === "cancel") dispatch({ type: "cancel", lineId: btn.dataset.line });
    else if (act === "undo") dispatch({ type: "undo", lineId: btn.dataset.line });
    else if (act === "finish") dispatch({ type: "finish", lineIds: btn.dataset.lines.split(",") });
    else if (act === "rush") dispatch({ type: "rush", cardKey: btn.dataset.cardKey, rush: btn.dataset.rush === "1" });
    else if (act === "undo-done") dispatch({ type: "undo-done", cardKey: btn.dataset.cardKey });
  });

  function render(model, force) {
    lastModel = model;
    if (gestures.active() && !force) { deferred = true; return; }
    deferred = false;
    const gridTop = grid.scrollTop;
    const doneTop = doneList.scrollTop;
    grid.innerHTML = model.tickets.map((t) => ticketHtml(t, model.nowMs, model.config, revealed)).join("");
    doneList.innerHTML = model.done.length
      ? model.done.map(doneHtml).join("")
      : '<div class="empty-small">ยังไม่มีที่เสร็จ</div>';
    grid.scrollTop = gridTop;
    doneList.scrollTop = doneTop;
    $("count-tables").textContent = model.tableCount;
    $("count-tickets").textContent = model.tickets.length;
    $("empty-pending").hidden = !(model.loaded && model.tickets.length === 0);
    $("loading").hidden = model.loaded;
    renderStatus(model);
  }

  function renderStatus(model) {
    $("offline").hidden = model.online;
    $("app").classList.toggle("is-offline", !model.online);
    $("app").dataset.loaded = model.loaded ? "1" : "0";
  }

  // once a second: waiting time, colours and clock (no re-draw, so swipes/drags are never interrupted)
  function tick(model) {
    lastModel = model;
    doc.querySelectorAll("[data-ticket]").forEach((el) => {
      const created = Number(el.dataset.created);
      const times = { createdMs: created, lastAddMs: el.dataset.added ? Number(el.dataset.added) : null };
      const level = levelAt(times, model.nowMs, model.config);
      const cls = `lv-${level}`;
      if (!el.classList.contains(cls)) {
        el.classList.remove("lv-ok", "lv-warn", "lv-late", "lv-new");
        el.classList.add(cls);
        el.querySelector(".t-badge").textContent = LEVEL_LABEL[level];
      }
      el.querySelector(".t-time").textContent = fmtClock((model.nowMs - created) / 1000);
    });
    $("clock").textContent = clockFmt.format(new Date(model.nowMs));
    renderStatus(model);
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2500);
  }

  function setWakeState(state) {
    // state: "on" | "off" | "unsupported"
    const el = $("wake");
    el.hidden = state === "on";
    el.textContent = state === "unsupported" ? "จอนี้อาจดับเอง (เบราว์เซอร์ไม่รองรับ)" : "จอยังไม่ค้าง · แตะที่นี่";
  }

  return { render, tick, toast, setWakeState };
}
