import { redis } from "./_redis.js";
import { ringBell } from "./_bell.js";

// "5", " 5", "05" and 5 are the same table.
function tableKey(value) {
  const text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Price and validate an order from the server's own menu. The client only says WHAT it wants
// (menu id, chosen option ids, qty); names and prices always come from the saved menu.
// Returns { items } or { error }.
export function priceItems(rawItems, menu) {
  const byId = new Map((Array.isArray(menu) ? menu : []).map((m) => [String(m.id), m]));
  const items = [];
  for (const raw of rawItems) {
    const id = String(raw && (raw.menuId != null ? raw.menuId : raw.id));
    const m = byId.get(id);
    const qty = Number(raw && raw.qty);
    if (!m) return { error: "unknown menu item" };
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { error: "invalid qty" };
    if (m.available === false) return { error: "item sold out", menuId: id };
    const groups = Array.isArray(m.optionGroups) ? m.optionGroups : [];
    const picked = Array.isArray(raw.optionIds) ? raw.optionIds.map(String) : [];
    if (new Set(picked).size !== picked.length) return { error: "duplicate option" };
    const chosen = [];
    for (const g of groups) {
      const hits = (g.options || []).filter((o) => picked.includes(String(o.id)));
      if (g.required && !hits.length) return { error: "option group required", menuId: id, group: g.id };
      if (g.type === "single" && hits.length > 1) return { error: "too many options", menuId: id, group: g.id };
      chosen.push(...hits);
    }
    if (chosen.length !== picked.length) return { error: "unknown option", menuId: id };
    const delta = chosen.reduce((sum, o) => sum + (Number(o.priceDelta) || 0), 0);
    const item = {
      id: m.id,
      // `name` carries the chosen options so the kitchen, printed slips, table board and bills all
      // show them without any change; `baseName` and `options` keep the structured data.
      name: chosen.length ? `${m.name} (${chosen.map((o) => o.name).join(", ")})` : m.name,
      baseName: m.name,
      price: Number(m.price) + delta,
      category: m.category || "",
      qty,
    };
    if (chosen.length) {
      item.options = chosen.map((o) => ({ id: o.id, name: o.name, priceDelta: Number(o.priceDelta) || 0 }));
    }
    items.push(item);
  }
  return { items };
}

export function createOrdersHandler({ redis: redisClient = redis, bell = ringBell } = {}) {
  return async function handler(req, res) {
  if (req.method === "GET") {
    const orders = (await redisClient.get("orders")) || [];
    // Only hand back the last 24h — the print agent polls this constantly
    // and the admin/customer history views only need recent activity.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let recent = orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
    // A table-scoped customer (req.auth is set by src/api-router.js when access control is
    // enforced) only ever receives their own table, and only what was ordered since staff last
    // cleared that table, so the next customer never sees the previous customer's order.
    if (req.auth && req.auth.role === "customer") {
      const mine = tableKey(req.auth.table);
      const clears = (await redisClient.get("tableClears")) || {};
      let clearedAt = 0;
      for (const [table, at] of Object.entries(clears)) {
        if (tableKey(table) === mine) clearedAt = Math.max(clearedAt, new Date(at).getTime() || 0);
      }
      recent = recent.filter((o) => tableKey(o.table) === mine && new Date(o.createdAt).getTime() > clearedAt);
    }
    return res.status(200).json(recent);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const orders = (await redisClient.get("orders")) || [];

    // Mark an existing order done (used once the kitchen has served it).
    if (body.action === "done" && body.id) {
      const updated = orders.map((o) => (o.id === body.id ? { ...o, status: "done" } : o));
      await redisClient.set("orders", updated.slice(-1000));
      return res.status(200).json({ ok: true });
    }

    // New order from a customer.
    if (!body.table || !Array.isArray(body.items) || !body.items.length) {
      return res.status(400).json({ ok: false, error: "missing table or items" });
    }
    // Each item starts life "cooking" for the table-status board; harmless
    // for any caller that doesn't look at kitchenStatus.
    const menu = (await redisClient.get("menu")) || [];
    const priced = priceItems(body.items, menu);
    if (priced.error) return res.status(400).json({ ok: false, error: priced.error });
    // The same idempotencyKey (a network retry) returns the order that already exists.
    const idemKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 64) : "";
    if (idemKey) {
      const seen = orders.find((o) => o.idempotencyKey === idemKey && tableKey(o.table) === tableKey(body.table));
      if (seen) return res.status(200).json({ ok: true, order: seen, duplicate: true });
    }
    const items = priced.items.map((it) => ({ ...it, kitchenStatus: "cooking" }));
    const order = {
      ...(idemKey ? { idempotencyKey: idemKey } : {}),
      id: genId(),
      table: body.table,
      items,
      note: body.note || "",
      status: "new",
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    await redisClient.set("orders", orders.slice(-1000));
    // Wake the print bridge only after the order is safely stored. The bell
    // never throws and gives up after 1.5s, so it cannot fail the order.
    await bell("print");
    return res.status(200).json({ ok: true, order });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
  };
}

export default createOrdersHandler();
