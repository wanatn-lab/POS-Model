// Kitchen screen LOGIC (no HTML, no colors). The look lives in view.js + kitchen.css,
// so the design can change without touching anything here.

export const DEFAULT_CONFIG = {
  hiddenCategories: [],
  warnMin: 15,
  lateMin: 25,
  newSec: 90,
  perTicket: 6,
  pollMs: 3000,
};

const pad = (n) => String(n).padStart(2, "0");

export function fmtClock(secs) {
  const s = Math.max(0, Math.floor(secs));
  return pad(Math.floor(s / 60)) + ":" + pad(s % 60);
}

// ---- time levels -----------------------------------------------------------
// ใหม่ (ฟ้า): 90s after the order arrived OR after the latest add-on was added.
// Otherwise by waiting time: < warnMin ปกติ | warnMin..lateMin ช้า | >= lateMin ช้ามาก!
export function cardTimes(card) {
  const createdMs = Date.parse(card.createdAt);
  let lastAddMs = null;
  for (const item of card.items) {
    if (item.isAddOn && item.st !== "c" && item.addedAt) {
      const t = Date.parse(item.addedAt);
      if (lastAddMs === null || t > lastAddMs) lastAddMs = t;
    }
  }
  return { createdMs, lastAddMs };
}

export function levelAt(times, nowMs, cfg) {
  const elapsedMs = nowMs - times.createdMs;
  const sinceAdd = times.lastAddMs === null ? Infinity : nowMs - times.lastAddMs;
  if (elapsedMs < cfg.newSec * 1000 || sinceAdd < cfg.newSec * 1000) return "new";
  const minutes = elapsedMs / 60000;
  if (minutes >= cfg.lateMin) return "late";
  if (minutes >= cfg.warnMin) return "warn";
  return "ok";
}

export const LEVEL_LABEL = { ok: "ปกติ", warn: "ช้า", late: "ช้ามาก!", new: "ใหม่" };

// ---- ordering: rush -> dragged rank -> longest wait --------------------------
export function sortCards(cards) {
  return [...cards].sort(
    (a, b) =>
      (b.rush ? 1 : 0) - (a.rush ? 1 : 0) ||
      (a.rank === b.rank ? 0 : a.rank == null ? 1 : b.rank == null ? -1 : a.rank - b.rank) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

// One table = one ticket, however long. Long orders scroll inside the card
// (a new card appears only when a new table/session starts).
export function toTickets(cards) {
  return cards.map((card) => ({
    key: `${card.key}#0`,
    cardKey: card.key,
    part: 1,
    parts: 1,
    card,
    items: card.items,
  }));
}

// ---- store: server data + optimistic edits + polling -------------------------
export function createStore({ api, onChange, onError, now = () => Date.now() }) {
  let board = { cards: [], done: [], config: { ...DEFAULT_CONFIG } };
  let skew = 0; // serverTime - deviceTime (waiting time uses SERVER time, not the tablet's clock)
  let online = false;
  let loaded = false;
  let lastOkAt = 0;
  let failures = 0;
  let writes = 0;
  let lastWriteEndAt = 0;
  let timer = null;
  let polling = false;
  let signature = "";
  let stopped = false;

  const serverNow = () => now() + skew;
  const notify = () => onChange && onChange();

  function setOnline(value) {
    if (online !== value) {
      online = value;
      notify();
    }
  }

  function regroup() {
    const all = [...board.cards, ...board.done];
    const cards = [];
    const done = [];
    for (const card of all) {
      card.doneCount = card.items.filter((i) => i.st === "d").length;
      if (card.items.some((i) => i.st === "p")) {
        cards.push(card);
      } else {
        const times = card.items.filter((i) => i.doneAt).map((i) => Date.parse(i.doneAt));
        const finished = times.length ? Math.max(...times) : Date.parse(card.createdAt);
        card.finishedAt = new Date(finished).toISOString();
        card.elapsedSec = Math.max(0, Math.round((finished - Date.parse(card.createdAt)) / 1000));
        done.push(card);
      }
    }
    board.cards = sortCards(cards);
    board.done = done.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    const startedAt = now();
    try {
      const data = await api.get();
      failures = 0;
      lastOkAt = now();
      skew = Date.parse(data.serverNow) - now();
      // Don't let a reply that left BEFORE our latest edit undo that edit on screen.
      if (writes === 0 && startedAt >= lastWriteEndAt) {
        const sig = JSON.stringify([data.cards, data.done, data.config]);
        if (sig !== signature || !loaded) {
          signature = sig;
          board = {
            cards: data.cards,
            done: data.done,
            config: { ...DEFAULT_CONFIG, ...data.config },
          };
          loaded = true;
          online = true;
          notify();
        }
      }
      if (!online) {
        online = true;
        notify();
      }
    } catch (err) {
      failures += 1;
      if (failures >= 2 || (typeof navigator !== "undefined" && navigator.onLine === false)) setOnline(false);
    } finally {
      polling = false;
      schedule();
    }
  }

  function schedule(delay) {
    if (stopped) return;
    clearTimeout(timer);
    const wait = delay ?? (failures ? 2000 : board.config.pollMs);
    timer = setTimeout(poll, wait);
  }

  // Called every second: if no good reply for too long, say so (never show stale data silently).
  function checkFreshness() {
    if (loaded && online && now() - lastOkAt > board.config.pollMs * 3 + 4000) setOnline(false);
  }

  async function mutate(local, request) {
    if (!online) {
      onError && onError("ออฟไลน์ ยังบันทึกไม่ได้");
      return false;
    }
    local();
    regroup();
    signature = "";
    notify();
    writes += 1;
    let ok = true;
    try {
      await request();
    } catch (err) {
      ok = false;
      onError && onError("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      writes -= 1;
      lastWriteEndAt = now();
    }
    schedule(ok ? 400 : 0); // pull the server's truth right after (fixes the screen if a save failed)
    return ok;
  }

  const findLines = (ids) => {
    const set = new Set(ids);
    const hit = [];
    for (const card of [...board.cards, ...board.done]) for (const i of card.items) if (set.has(i.lineId)) hit.push(i);
    return hit;
  };

  return {
    start() {
      stopped = false;
      poll();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    pollNow() {
      schedule(0);
    },
    tick: checkFreshness,
    markOffline() {
      setOnline(false);
    },
    serverNow,

    setItems(lineIds, st) {
      if (!lineIds.length) return Promise.resolve(false);
      return mutate(
        () => {
          const at = new Date(serverNow()).toISOString();
          for (const item of findLines(lineIds)) {
            item.st = st;
            item.doneAt = st === "d" ? at : null;
          }
        },
        () => api.post({ action: "item-set", lineIds, st }),
      );
    },

    setRush(cardKey, rush) {
      return mutate(
        () => {
          const card = board.cards.find((c) => c.key === cardKey);
          if (card) {
            card.rush = rush;
            card.rank = null;
          }
        },
        () => api.post({ action: "rush", key: cardKey, rush }),
      );
    },

    // Drag: put `movedKey` right before `targetKey` (whole table). Rank beats waiting time.
    reorder(movedKey, targetKey) {
      const keys = board.cards.map((c) => c.key).filter((k) => k !== movedKey);
      const at = keys.indexOf(targetKey);
      if (at < 0) return Promise.resolve(false);
      keys.splice(at, 0, movedKey);
      const target = board.cards.find((c) => c.key === targetKey);
      const rush = !!(target && target.rush);
      return mutate(
        () => {
          keys.forEach((k, index) => {
            const c = board.cards.find((x) => x.key === k);
            if (c) c.rank = index;
          });
          const moved = board.cards.find((c) => c.key === movedKey);
          if (moved) moved.rush = rush;
        },
        () => api.post({ action: "reorder", keys, moved: movedKey, rush }),
      );
    },

    // "ย้ายกลับ" from the done column: every line goes back to pending.
    undoDone(cardKey) {
      const card = board.done.find((c) => c.key === cardKey);
      if (!card) return Promise.resolve(false);
      return this.setItems(card.items.map((i) => i.lineId), "p");
    },

    model() {
      const cfg = board.config;
      return {
        online,
        loaded,
        config: cfg,
        tickets: toTickets(board.cards, cfg.perTicket),
        tableCount: board.cards.length,
        done: board.done,
        nowMs: serverNow(),
      };
    },
  };
}
