import { redis } from "./_redis.js";
import { ringBell } from "./_bell.js";
import { shopState } from "./_shop-hours.js";

const MAX_ORDERS = 1000;
const MAX_ITEMS_PER_ORDER = 20;
const MAX_QTY_PER_ITEM = 20;
const MAX_TOTAL_QTY = 50;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const BANGKOK_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });
function bangkokDay(date) {
  return Number.isNaN(date.getTime()) ? "" : BANGKOK_DAY.format(date);
}

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

export function priceItems(requested, menu) {
  if (!Array.isArray(requested) || !requested.length || requested.length > MAX_ITEMS_PER_ORDER) return { error: "invalid items" };
  const byId = new Map((Array.isArray(menu) ? menu : []).map((item) => [String(item.id), item]));
  let totalQty = 0;
  const items = [];
  for (const requestedItem of requested) {
    const id = String(requestedItem && (requestedItem.menuId ?? requestedItem.id) || "").trim();
    const item = byId.get(id);
    const qty = Number(requestedItem && requestedItem.qty);
    if (!item || item.available === false || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) return { error: "invalid, unavailable, or excessive items" };
    totalQty += qty;
    if (totalQty > MAX_TOTAL_QTY) return { error: "invalid, unavailable, or excessive items" };
    const basePrice = Number(item.price);
    if (!Number.isFinite(basePrice) || basePrice < 0) return { error: "invalid menu price" };
    const optionIds = Array.isArray(requestedItem.optionIds) ? requestedItem.optionIds.map((value) => String(value)) : [];
    if (optionIds.length > 20 || new Set(optionIds).size !== optionIds.length) return { error: "invalid options" };
    const selected = [];
    for (const group of Array.isArray(item.optionGroups) ? item.optionGroups : []) {
      const hits = (Array.isArray(group.options) ? group.options : []).filter((option) => optionIds.includes(String(option.id)));
      if (group.required === true && !hits.length) return { error: "option group required" };
      if (group.type === "single" && hits.length > 1) return { error: "too many options" };
      selected.push(...hits);
    }
    if (selected.length !== optionIds.length) return { error: "unknown option" };
    const priceDelta = selected.reduce((sum, option) => sum + Number(option.priceDelta), 0);
    if (!Number.isSafeInteger(priceDelta) || priceDelta < 0) return { error: "invalid option price" };
    // Price, Thai kitchen label, category and route are all server-owned values.
    const priced = {
      id: String(item.id),
      name: selected.length
        ? `${String(item.name || "รายการ").slice(0, 160)} (${selected.map((option) => String(option.name).slice(0, 80)).join(", ")})`
        : String(item.name || "รายการ").slice(0, 200),
      ...(selected.length ? { baseName: String(item.name || "รายการ").slice(0, 200) } : {}),
      price: basePrice + priceDelta,
      category: String(item.category || "").slice(0, 100),
      qty,
      options: selected.map((option) => ({ id: String(option.id), name: String(option.name).slice(0, 80), priceDelta: Number(option.priceDelta) })),
      // Which LAN printer prints this line. Server-owned: copied from the menu, never from the client.
      printer: item.printer === "counter" ? "counter" : "kitchen",
      kitchenStatus: "cooking",
    };
    items.push(priced);
  }
  return { items };
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

export function createOrdersHandler({ redis: redisClient = redis, bell = ringBell, now: clock = () => Date.now() } = {}) {
  return async function handler(req, res) {
    if (req.method === "GET") {
      const orders = (await redisClient.get("orders")) || [];
      const cutoff = clock() - 24 * 60 * 60 * 1000;
      let recent = orders.filter((order) => new Date(order.createdAt).getTime() >= cutoff);
      if (req.auth && req.auth.role === "customer") {
        const mine = tableKey(req.auth.table);
        const clears = (await redisClient.get("tableClears")) || {};
        const clearedAt = new Date(clears[mine] || 0).getTime() || 0;
        // A customer only ever sees today's orders (Bangkok calendar day), so an order left open
        // overnight never shows up for the first customer of the next morning.
        const today = bangkokDay(new Date(clock()));
        recent = recent.filter((order) =>
          tableKey(order.table) === mine &&
          new Date(order.createdAt).getTime() > clearedAt &&
          bangkokDay(new Date(order.createdAt)) === today);
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
    const [menu, savedSettings, idempotencyValue, jobsValue, shopSchedule, shopOverride] = await Promise.all([
      redisClient.get("menu"),
      redisClient.get("settings"),
      redisClient.get("orderIdempotency"),
      redisClient.get("printJobs"),
      redisClient.get("shopSchedule"),
      redisClient.get("shopOverride"),
    ]);
    const priced = priceItems(body.items, menu);
    if (priced.error) return res.status(400).json({ ok: false, error: priced.error });
    const items = priced.items;

    const table = tableKey(body.table);
    const key = compactIdempotency(body.idempotencyKey);
    const now = clock();
    const idempotency = recentKeys(idempotencyValue, now);
    const idempotencyId = key ? `${table}:${key}` : null;
    if (idempotencyId && idempotency[idempotencyId]) {
      const existing = orders.find((order) => order.id === idempotency[idempotencyId].orderId);
      if (existing) return res.status(200).json({ ok: true, order: existing, idempotent: true });
    }

    // A new customer cannot start an order while the shop is closed. Staff always can, and so can a
    // customer who already holds a table pass (mid-meal, not a new walk-in). A shop that has never
    // saved opening hours or a manual switch is not restricted. The check runs after the
    // idempotency replay above, so a retry of an order that was accepted still gets its answer.
    const callerRole = req.auth && req.auth.role;
    if (callerRole !== "staff" && callerRole !== "owner" && callerRole !== "customer" && (shopSchedule || shopOverride)) {
      const state = shopState(now, shopSchedule, shopOverride);
      if (!state.open) {
        return res.status(409).json({
          ok: false,
          error: "shop_closed",
          opensAt: state.opensAt,
          message: "ร้านปิดอยู่ ยังรับออเดอร์ไม่ได้",
        });
      }
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
