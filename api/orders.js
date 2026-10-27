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
    const items = body.items.map((it) => ({
      ...it,
      kitchenStatus: it.kitchenStatus || "cooking",
    }));
    const order = {
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
