import { redis } from "./_redis.js";
import { ringBell } from "./_bell.js";

const MAX_ORDERS = 1000;
const MAX_ITEMS_PER_ORDER = 20;
const MAX_QTY_PER_ITEM = 20;
const MAX_TOTAL_QTY = 50;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function tableKey(value) {
  const text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) ? String(Number(text)) : text.toUpperCase();
}

const TAKEAWAY_LANE = /^TA[1-9]\d*$/;
const SUFFIX_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// Every takeaway order is its own bill. The lane (TA1/TA2) is only where the QR sits; the order
// is stored under a unique label such as TA1-K7Q so two customers never end up on one bill.
function takeawayLabel(lane, orders) {
  const used = new Set(orders.map((order) => String(order.table)));
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    const suffix = [...bytes].map((byte) => SUFFIX_CHARS[byte % SUFFIX_CHARS.length]).join("");
    if (!used.has(`${lane}-${suffix}`)) return `${lane}-${suffix}`;
  }
}

function genId() {
  return `ord_${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}

function compactIdempotency(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{16,128}$/.test(key) ? key : null;
}

function cleanOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map((option) => String(option).trim().slice(0, 80)).filter(Boolean);
}

function orderItems(requested, menu) {
  if (!Array.isArray(requested) || !requested.length || requested.length > MAX_ITEMS_PER_ORDER) return null;
  const byId = new Map((Array.isArray(menu) ? menu : []).map((item) => [String(item.id), item]));
  let totalQty = 0;
  const items = [];
  for (const requestedItem of requested) {
    const id = String(requestedItem && requestedItem.id || "").trim();
    const item = byId.get(id);
    const qty = Number(requestedItem && requestedItem.qty);
    if (!item || item.available === false || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) return null;
    totalQty += qty;
    if (totalQty > MAX_TOTAL_QTY) return null;
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 0) return null;
    // Price, Thai kitchen label, category and route are all server-owned values.
    items.push({
      id: String(item.id),
      name: String(item.name || "รายการ").slice(0, 200),
      price,
      category: String(item.category || "").slice(0, 100),
      qty,
      options: cleanOptions(requestedItem.options),
      // Which LAN printer prints this line. Server-owned: copied from the menu, never from the client.
      printer: item.printer === "counter" ? "counter" : "kitchen",
      kitchenStatus: "cooking",
    });
  }
  return items;
}

const PRINT_STATIONS = ["kitchen", "counter"];

function stationOf(item) {
  return item && item.printer === "counter" ? "counter" : "kitchen";
}

// One ticket job per physical printer that has at least one line of this order.
// The kitchen job keeps its original id (`kitchen-<orderId>`) for compatibility.
function ticketJobs(order, kind, queuedAt, idPrefix) {
  const jobs = [];
  for (const station of PRINT_STATIONS) {
    const items = order.items.filter((item) => stationOf(item) === station);
    if (!items.length) continue;
    const id = `${station}-${idPrefix}${order.id}`;
    jobs.push({
      id,
      printId: id,
      type: "kitchen",
      station,
      kind,
      orderId: order.id,
      table: order.table,
      items,
      ...(kind === "order" ? { note: order.note } : {}),
      status: "queued",
      queuedAt,
    });
  }
  return jobs;
}

function recentKeys(value, now) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(Object.entries(source).filter(([, record]) => record && record.at > now - IDEMPOTENCY_TTL_MS));
}

function batchSet(client, entries) {
  if (typeof client.batchSet === "function") return client.batchSet(entries);
  return Promise.all(entries.map(([key, value]) => client.set(key, value)));
}

// Bell is only a wake-up hint. A Firebase outage (or an unexpected adapter
// failure) must never turn a saved order into HTTP 500.
async function ringSafely(bell, reason) {
  try {
    await bell(reason);
  } catch {
    // createBell already catches its own failures; this also protects order
    // creation if a future bell adapter rejects unexpectedly.
  }
}

export function createOrdersHandler({ redis: redisClient = redis, bell = ringBell } = {}) {
  return async function handler(req, res) {
    if (req.method === "GET") {
      const orders = (await redisClient.get("orders")) || [];
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let recent = orders.filter((order) => new Date(order.createdAt).getTime() >= cutoff);
      if (req.auth && req.auth.role === "customer") {
        const mine = tableKey(req.auth.table);
        const clears = (await redisClient.get("tableClears")) || {};
        const clearedAt = new Date(clears[mine] || 0).getTime() || 0;
        recent = recent.filter((order) => tableKey(order.table) === mine && new Date(order.createdAt).getTime() > clearedAt);
      }
      return res.status(200).json(recent);
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).end("Method not allowed");
    }

    const body = req.body || {};
    const orders = (await redisClient.get("orders")) || [];
    if (body.action === "done" && body.id) {
      const updated = orders.map((order) => order.id === body.id ? { ...order, status: "done" } : order);
      await redisClient.set("orders", updated.slice(-MAX_ORDERS));
      return res.status(200).json({ ok: true });
    }

    if (body.action === "void" && body.id) {
      const order = orders.find((entry) => entry.id === body.id);
      if (!order) return res.status(404).json({ ok: false, error: "order not found" });
      if (order.status === "void") return res.status(200).json({ ok: true, alreadyVoided: true, order });
      order.status = "void";
      order.voidedAt = new Date().toISOString();
      order.voidedBy = req.auth && req.auth.staffId || "staff";
      const jobs = (await redisClient.get("printJobs")) || [];
      // Only void on printers that actually printed this order; a ticket never printed needs no void slip.
      const printedStations = new Set(jobs
        .filter((job) => job.orderId === order.id && job.type === "kitchen" && job.kind === "order" && job.status === "printed")
        .map((job) => job.station));
      // A ticket still waiting in a queue must not print for an order that was voided.
      jobs.forEach((job) => {
        if (job.orderId === order.id && job.type === "kitchen" && job.kind === "order" && job.status === "queued") {
          job.status = "cancelled";
          job.cancelledAt = order.voidedAt;
        }
      });
      const voidJobs = ticketJobs(order, "void", order.voidedAt, "void-").filter((job) => printedStations.has(job.station));
      const kitchenPrinted = voidJobs.length > 0;
      jobs.push(...voidJobs);
      await batchSet(redisClient, [["orders", orders.slice(-MAX_ORDERS)], ["printJobs", jobs.slice(-300)]]);
      if (kitchenPrinted) await ringSafely(bell, "print");
      return res.status(200).json({ ok: true, order, kitchenVoidQueued: kitchenPrinted });
    }

    if (!body.table) return res.status(400).json({ ok: false, error: "missing table" });
    const [menu, savedSettings, idempotencyValue, jobsValue] = await Promise.all([
      redisClient.get("menu"),
      redisClient.get("settings"),
      redisClient.get("orderIdempotency"),
      redisClient.get("printJobs"),
    ]);
    const items = orderItems(body.items, menu);
    if (!items) return res.status(400).json({ ok: false, error: "invalid, unavailable, or excessive items" });

    const table = tableKey(body.table);
    const key = compactIdempotency(body.idempotencyKey);
    const now = Date.now();
    const idempotency = recentKeys(idempotencyValue, now);
    const idempotencyId = key ? `${table}:${key}` : null;
    if (idempotencyId && idempotency[idempotencyId]) {
      const existing = orders.find((order) => order.id === idempotency[idempotencyId].orderId);
      if (existing) return res.status(200).json({ ok: true, order: existing, idempotent: true });
    }

    const source = req.auth && (req.auth.role === "staff" || req.auth.role === "owner") ? "staff" : "customer";
    const customerMode = savedSettings && savedSettings.customerOrderMode === "confirm" ? "confirm" : "auto";
    const createdAt = new Date(now).toISOString();
    const takeaway = TAKEAWAY_LANE.test(table);
    const order = {
      id: genId(),
      table: takeaway ? takeawayLabel(table, orders) : table,
      ...(takeaway ? { takeawayLane: table } : {}),
      items,
      note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : "",
      source,
      staffId: source === "staff" ? (req.auth.staffId || req.auth.role) : null,
      status: source === "customer" && customerMode === "confirm" ? "pending_confirmation" : "new",
      createdAt,
    };
    const jobs = Array.isArray(jobsValue) ? jobsValue : [];
    if (order.status === "new") {
      jobs.push(...ticketJobs(order, "order", createdAt, ""));
    }
    orders.push(order);
    if (idempotencyId) idempotency[idempotencyId] = { orderId: order.id, at: now };
    await batchSet(redisClient, [
      ["orders", orders.slice(-MAX_ORDERS)],
      ["printJobs", jobs.slice(-300)],
      ["orderIdempotency", idempotency],
    ]);
    if (order.status === "new") await ringSafely(bell, "print");
    return res.status(200).json({ ok: true, order });
  };
}

export default createOrdersHandler();
