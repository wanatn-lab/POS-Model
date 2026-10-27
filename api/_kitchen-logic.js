// Pure logic for the kitchen screen (/kitchen). No I/O here, so it is easy to test
// and so the screen's look can change without touching any of this.
//
// Terms
//  - "session": all of one table's orders since that table was last cleared
//    (tableClears) today. One session = one kitchen card group ("ทั้งโต๊ะ").
//  - "line": one item row of an order. Identified by a stable lineId.
//
// Kitchen state lives OUTSIDE the `orders` array (in small per-day Redis hashes)
// so that kitchen taps can never overwrite a customer order arriving at the same time.

export const DEFAULT_CONFIG = {
  hiddenCategories: ["เครื่องดื่ม"], // never shown on the kitchen screen
  warnMin: 15, // >= 15:00 = ช้า (เหลือง)
  lateMin: 25, // >= 25:00 = ช้ามาก! (แดง กะพริบ)
  newSec: 90, // "ใหม่" (ฟ้า) for 90s after an order / add-on arrives
  perTicket: 6, // items per printed card (ใบ 1/2 ...)
  pollMs: 3000, // how often the screen asks for fresh data
};

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

export function mergeConfig(stored) {
  const cfg = { ...DEFAULT_CONFIG };
  if (stored && typeof stored === "object") {
    for (const key of CONFIG_KEYS) {
      if (stored[key] === undefined) continue;
      if (key === "hiddenCategories") {
        if (Array.isArray(stored[key])) {
          cfg[key] = stored[key].map((c) => String(c).trim()).filter(Boolean);
        }
      } else if (Number.isFinite(Number(stored[key])) && Number(stored[key]) > 0) {
        cfg[key] = Number(stored[key]);
      }
    }
  }
  return cfg;
}

export function pickConfigPatch(body) {
  const patch = {};
  for (const key of CONFIG_KEYS) if (body && body[key] !== undefined) patch[key] = body[key];
  return patch;
}

const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function bangkokDay(date) {
  return DAY_FMT.format(date);
}

export const STATUSES = ["p", "d", "c"]; // pending, done, cancelled

// Stable id of one item line. New-style orders may carry their own `lineId`; existing
// orders do not, so we build one from order id + position + a short fingerprint of the
// item. If admin removes a line (positions shift), the fingerprint no longer matches, so a
// tick can never land on the WRONG dish (worst case that one line shows as pending again).
function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function lineIdOf(order, index) {
  const item = order.items[index];
  if (item && item.lineId) return String(item.lineId);
  return `${order.id}#${index}~${fingerprint(`${item && item.name}|${item && item.qty}`)}`;
}

export function sessionKeyOf(table, clearedAt) {
  return `${table}|${clearedAt || 0}`;
}

function padQueue(n) {
  return Number.isFinite(Number(n)) ? String(Number(n)).padStart(4, "0") : null;
}

/**
 * Build everything the kitchen screen needs.
 * @param {object} args
 *  orders      raw `orders` array
 *  clears      `tableClears` map  { [table]: ISO }
 *  itemState   { [lineId]: { st, at } }   (missing = pending)
 *  rush        { [sessionKey]: true }
 *  rank        { [sessionKey]: number }
 *  config      merged config
 *  now         Date (server time)
 */
export function buildBoard({ orders, clears, itemState, rush, rank, config, now }) {
  const today = bangkokDay(now);
  const hidden = new Set(config.hiddenCategories.map((c) => c.trim()));

  // Today's orders in arrival order. Nothing about order creation had to change:
  //  - "add-on" = any order that arrives while its table is already open (not the first one
  //    since the table was last cleared)
  //  - the "#" number = position of the table's first order among all of today's orders
  const todays = (Array.isArray(orders) ? orders : [])
    .map((order, position) => ({ order, position }))
    .filter(({ order }) => order && order.id && Array.isArray(order.items))
    .filter(({ order }) => {
      const created = new Date(order.createdAt);
      return !Number.isNaN(created.getTime()) && bangkokDay(created) === today;
    })
    .sort(
      (a, b) =>
        new Date(a.order.createdAt).getTime() - new Date(b.order.createdAt).getTime() ||
        a.position - b.position,
    );
  const ordinal = new Map(todays.map(({ order }, i) => [order.id, i + 1]));

  const sessions = new Map();
  for (const { order } of todays) {
    const created = new Date(order.createdAt);
    const clearedAt = clears && clears[order.table] ? clears[order.table] : null;
    if (clearedAt && created.getTime() <= new Date(clearedAt).getTime()) continue;

    const key = sessionKeyOf(order.table, clearedAt);
    let s = sessions.get(key);
    const isFirst = !s;
    if (!s) {
      s = { key, table: order.table, createdAt: order.createdAt, queueNo: order.queueNo ?? ordinal.get(order.id), items: [] };
      sessions.set(key, s);
    }
    const addOn = !isFirst || order.isAddOn === true;

    order.items.forEach((item, index) => {
      // Category filter happens here, on the server, with the original category field.
      if (hidden.has(String(item.category || "").trim())) return;
      const lineId = lineIdOf(order, index);
      const state = itemState && itemState[lineId];
      const st = state && STATUSES.includes(state.st) ? state.st : "p";
      s.items.push({
        lineId,
        orderId: order.id,
        name: item.name,
        qty: item.qty,
        category: item.category || "",
        orderNote: order.note || "",
        st,
        doneAt: st === "d" && state ? state.at : null,
        isAddOn: addOn,
        addedAt: addOn ? item.addedAt || order.createdAt : null,
        createdAt: order.createdAt,
      });
    });
  }

  const cards = [];
  const done = [];
  for (const s of sessions.values()) {
    if (!s.items.length) continue; // e.g. a drinks-only table: not shown at all
    const out = {
      key: s.key,
      table: s.table,
      billNo: padQueue(s.queueNo),
      createdAt: s.createdAt,
      rush: !!(rush && rush[s.key]),
      rank: rank && Number.isFinite(Number(rank[s.key])) ? Number(rank[s.key]) : null,
      total: s.items.length,
      doneCount: s.items.filter((i) => i.st === "d").length,
      items: s.items,
    };
    if (s.items.some((i) => i.st === "p")) {
      cards.push(out);
    } else {
      const doneTimes = s.items.filter((i) => i.doneAt).map((i) => new Date(i.doneAt).getTime());
      const finishedAt = doneTimes.length ? Math.max(...doneTimes) : null;
      done.push({
        ...out,
        finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
        elapsedSec: finishedAt
          ? Math.max(0, Math.round((finishedAt - new Date(s.createdAt).getTime()) / 1000))
          : null,
      });
    }
  }

  // Order: rush first -> dragged rank -> longest wait. Rank always beats wait time;
  // cards never dragged (rank null) sit after the ranked ones, oldest first.
  cards.sort(
    (a, b) =>
      (b.rush ? 1 : 0) - (a.rush ? 1 : 0) ||
      (a.rank === b.rank ? 0 : a.rank == null ? 1 : b.rank == null ? -1 : a.rank - b.rank) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  done.sort((a, b) => new Date(b.finishedAt || 0).getTime() - new Date(a.finishedAt || 0).getTime());

  return { cards, done };
}
