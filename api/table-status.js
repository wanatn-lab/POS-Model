import { redis } from "./_redis.js";
import { ringBell } from "./_bell.js";

// Aggregates recent orders per table for the "สถานะโต๊ะ" dashboard, and lets
// staff advance a menu item's kitchen status (cooking -> ready -> served) or
// clear a table once the bill is settled.
//
// "Clearing" a table does not delete order history — it just records a
// timestamp in "tableClears" so future reads ignore orders placed before it.
// This keeps existing kitchen-printing / order history flows untouched.
//
// The board also resets itself automatically at day's end (Bangkok time),
// even if nobody presses "เคลียร์โต๊ะ" — this handler only ever shows orders
// placed "today", so tomorrow's board always starts fresh. Order history
// itself (used by /api/orders, kitchen printing, etc.) is untouched.

const BANGKOK_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const BANGKOK_PARTS_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const LEGACY_CLIENT_HEADER = "x-jinko-client";
const SPECIAL_OPEN_KEY = "shopSpecialOpen";
const OPEN_MINUTE = 11 * 60 + 20;
const CLOSE_MINUTE = 21 * 60;

function bangkokParts(date) {
  const values = {};
  BANGKOK_PARTS_FMT.formatToParts(date).forEach((part) => { values[part.type] = part.value; });
  return {
    weekday: values.weekday,
    date: `${values.year}-${values.month}-${values.day}`,
    minute: (Number(values.hour) % 24) * 60 + Number(values.minute),
  };
}

function isNewTableStatusClient(req) {
  const headers = req.headers || {};
  return Object.entries(headers).some(([name, value]) =>
    name.toLowerCase() === LEGACY_CLIENT_HEADER && String(value) === "2",
  );
}
function bangkokDay(date) {
  return BANGKOK_DAY_FMT.format(date);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tableValue(value) {
  const text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) ? Number(text) : text;
}

function compareTables(first, second) {
  const firstNumber = typeof first.table === "number";
  const secondNumber = typeof second.table === "number";
  if (firstNumber && secondNumber) return first.table - second.table;
  if (firstNumber) return -1;
  if (secondNumber) return 1;
  return String(first.table).localeCompare(String(second.table), "th");
}

const BILL_HISTORY_MAX = 1000;
const BILL_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function recentBills(value, now) {
  const earliest = now.getTime() - BILL_HISTORY_WINDOW_MS;
  return (Array.isArray(value) ? value : [])
    .filter((bill) => bill && bill.id && new Date(bill.createdAt).getTime() >= earliest)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-BILL_HISTORY_MAX);
}

function billNumber(now, table) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const tablePart = String(table).replace(/\D/g, "").padStart(2, "0").slice(-2) || "00";
  return `#${parts.day || "00"}${parts.month || "00"}${parts.hour || "00"}${parts.minute || "00"}${parts.second || "00"}${tablePart}`;
}

// A receipt must keep the exact design that was active at the time staff pressed
// "คิดเงิน".  The print bridge runs independently from the browser, so it cannot
// safely fetch the current settings later: they may have changed by then.  This
// small, explicit snapshot is also kept in bill history for a faithful reprint.
function receiptConfigForJob(settings) {
  const config = settings && typeof settings.receipt === "object" && settings.receipt
    ? settings.receipt
    : {};
  const text = (value, fallback = "") => typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : fallback;
  const enabledByDefault = (key) => config[key] !== false;

  return {
    logoUrl: text(config.logoUrl),
    shopPhone: text(config.shopPhone),
    shopAddress: text(config.shopAddress),
    taxId: text(config.taxId),
    title: text(config.title, "ใบเสร็จรับเงิน"),
    thanksText: text(config.thanksText),
    apologyText: text(config.apologyText),
    showBillNo: enabledByDefault("showBillNo"),
    showTime: enabledByDefault("showTime"),
    showTable: enabledByDefault("showTable"),
    showQr: config.showQr === true,
    qrUrl: text(config.qrUrl),
  };
}

function receiptForTable(orders, clearMap, table, settings, now) {
  const previousClear = clearMap[table] ? new Date(clearMap[table]).getTime() : 0;
  const today = bangkokDay(now);
  const sourceOrders = orders.filter((order) =>
    String(order.table) === String(table) &&
    bangkokDay(new Date(order.createdAt)) === today &&
    new Date(order.createdAt).getTime() > previousClear,
  );
  const items = [];
  for (const order of sourceOrders) {
    for (const item of order.items || []) {
      const qty = Math.max(1, Math.floor(number(item.qty, 1)));
      const price = number(item.price, 0);
      items.push({
        name: String(item.name || "รายการ"),
        qty,
        price,
        lineTotal: price * qty,
      });
    }
  }
  const orderIds = sourceOrders.map((order) => String(order.id)).sort();
  const receiptConfig = receiptConfigForJob(settings);
  return {
    id: `receipt-${String(table)}-${orderIds.join("-")}`,
    type: "receipt",
    status: "queued",
    shopName: (settings && settings.shopName) || "ทองย้อย",
    // Kept at the top level for old bridge versions, while the complete nested
    // object lets newer versions reproduce every option from the Admin screen.
    phone: receiptConfig.shopPhone,
    receiptConfig,
    table: String(table),
    createdAt: now.toISOString(),
    sourceOrderIds: orderIds,
    items,
    total: items.reduce((sum, item) => sum + item.lineTotal, 0),
  };
}

// Kept separate from the storage read so tests can compare the former three
// GET values with the single MGET values byte-for-byte at the response level.
export function tableStatusPayload(orders, clears, settings, now) {
  const allOrders = Array.isArray(orders) ? orders : [];
  const clearMap = clears || {};
  const tableCount = (settings && settings.tableCount) || 20;

  // Only orders placed on today's calendar date (Bangkok time) — this is
  // what makes the board auto-reset overnight without a manual clear.
  const today = bangkokDay(now);
  const recent = allOrders.filter((o) => bangkokDay(new Date(o.createdAt)) === today);

  const tables = Object.create(null);
  for (let t = 1; t <= tableCount; t++) {
    tables[t] = { table: t, openedAt: null, items: [] };
  }

  for (const order of recent) {
    const tableKey = String(order.table == null ? "" : order.table).trim();
    const clearedAt = clearMap[tableKey] ? new Date(clearMap[tableKey]).getTime() : 0;
    if (new Date(order.createdAt).getTime() <= clearedAt) continue; // cleared already, skip

    if (!tables[tableKey]) {
      tables[tableKey] = { table: tableValue(tableKey), openedAt: null, items: [] };
    }
    const bucket = tables[tableKey];
    if (!bucket.openedAt || new Date(order.createdAt) < new Date(bucket.openedAt)) {
      bucket.openedAt = order.createdAt;
    }
    (order.items || []).forEach((item, itemIndex) => {
      bucket.items.push({
        orderId: order.id,
        itemIndex,
        name: item.name,
        price: item.price,
        qty: item.qty,
        category: item.category || "",
        status: item.kitchenStatus || "cooking",
      });
    });
  }

  const list = Object.values(tables).sort(compareTables);
  return { tableCount, tables: list };
}

export function createTableStatusHandler({ redis: redisClient = redis, now = () => new Date(), bell = ringBell } = {}) {
  return async function handler(req, res) {
  if (req.method === "GET") {
    // Old table-status pages predate shop hours and poll all night. Only this
    // read endpoint receives the compatibility guard: customer ordering and
    // every POST intentionally remain unchanged.
    if (!isNewTableStatusClient(req)) {
      const current = now();
      const local = bangkokParts(current);
      if (local.minute < OPEN_MINUTE || local.minute >= CLOSE_MINUTE) {
        return res.status(200).json({
          ok: false,
          closed: true,
          error: "outdated page - please reload",
          tableCount: 0,
          tables: [],
        });
      }
      if (local.weekday === "Mon") {
        // The special-open value is the sole Redis read added by this guard,
        // and is needed only during Monday's otherwise-open time window.
        const specialOpenDate = await redisClient.get(SPECIAL_OPEN_KEY);
        if (specialOpenDate !== local.date) {
          return res.status(200).json({
            ok: false,
            closed: true,
            error: "outdated page - please reload",
            tableCount: 0,
            tables: [],
          });
        }
      }
    }
    const [orders, clears, settings] = await redisClient.mget(
      "orders",
      "tableClears",
      "settings",
    );
    return res.status(200).json(tableStatusPayload(orders, clears, settings, now()));
  }

  if (req.method === "POST") {
    const body = req.body || {};

    // Checkout is deliberately a single server-side operation.  When staff selects
    // "พิมพ์ใบเสร็จ", the exact table snapshot is queued before the table is cleared,
    // so the Android print bridge can print it later even if the web page is closed.
    if (body.action === "checkout") {
      const { table, printReceipt } = body;
      if (table == null || String(table).trim() === "") {
        return res.status(400).json({ ok: false, error: "missing table" });
      }

      const now = new Date();
      const [ordersValue, clearsValue, settingsValue, jobsValue, billHistoryValue] = await Promise.all([
        redisClient.get("orders"),
        redisClient.get("tableClears"),
        redisClient.get("settings"),
        redisClient.get("printJobs"),
        redisClient.get("billHistory"),
      ]);
      const orders = Array.isArray(ordersValue) ? ordersValue : [];
      const clears = clearsValue || {};
      const receipt = receiptForTable(orders, clears, table, settingsValue || {}, now);
      if (!receipt.items.length) {
        return res.status(409).json({ ok: false, error: "table has no billable items" });
      }

      const history = recentBills(billHistoryValue, now);
      const existingBill = history.find((bill) => bill.id === receipt.id);
      const bill = existingBill || {
        ...receipt,
        billNo: billNumber(now, table),
        settledAt: now.toISOString(),
      };
      if (!existingBill) history.push(bill);

      let receiptJobId = null;
      let jobsToSave = null;
      if (printReceipt === true) {
        const jobs = Array.isArray(jobsValue) ? jobsValue : [];
        const existing = jobs.find((job) => job && job.id === receipt.id);
        if (!existing) {
          jobs.push({ ...receipt, billNo: bill.billNo });
          // Keep recent completed jobs for audit/retry recovery, without letting the
          // small restaurant queue grow forever.
          jobsToSave = jobs.slice(-300);
        }
        receiptJobId = receipt.id;
      }

      clears[table] = now.toISOString();
      await Promise.all([
        redisClient.set("tableClears", clears),
        redisClient.set("billHistory", recentBills(history, now)),
        jobsToSave ? redisClient.set("printJobs", jobsToSave) : Promise.resolve(),
      ]);
      // Ring only when a new receipt was actually queued.
      if (jobsToSave) await bell("print");
      return res.status(200).json({ ok: true, receiptJobId, bill });
    }

    // Advance one menu item's kitchen status inside a specific order.
    if (body.action === "item-status") {
      const { orderId, itemIndex, status } = body;
      if (!orderId || itemIndex == null || !status) {
        return res.status(400).json({ ok: false, error: "missing orderId/itemIndex/status" });
      }
      const orders = (await redisClient.get("orders")) || [];
      const order = orders.find((o) => o.id === orderId);
      if (!order || !order.items || !order.items[itemIndex]) {
        return res.status(404).json({ ok: false, error: "order or item not found" });
      }
      order.items[itemIndex].kitchenStatus = status;
      await redisClient.set("orders", orders);
      return res.status(200).json({ ok: true });
    }

    // Clear a table: everything ordered up to now stops showing on the board.
    // Used both by the plain "เคลียร์โต๊ะ" button and by "คิดเงิน" checkout
    // (checkout is just a clear-table after showing/printing a receipt).
    if (body.action === "clear-table") {
      const { table } = body;
      if (!table) return res.status(400).json({ ok: false, error: "missing table" });
      const clears = (await redisClient.get("tableClears")) || {};
      clears[table] = new Date().toISOString();
      await redisClient.set("tableClears", clears);
      return res.status(200).json({ ok: true });
    }

    // Remove a single item from a specific order (staff cancels one line item,
    // e.g. mis-order). Leaves the rest of the order and all order history intact.
    if (body.action === "remove-item") {
      const { orderId, itemIndex } = body;
      if (!orderId || itemIndex == null) {
        return res.status(400).json({ ok: false, error: "missing orderId/itemIndex" });
      }
      const orders = (await redisClient.get("orders")) || [];
      const order = orders.find((o) => o.id === orderId);
      if (!order || !order.items || !order.items[itemIndex]) {
        return res.status(404).json({ ok: false, error: "order or item not found" });
      }
      order.items.splice(itemIndex, 1);
      await redisClient.set("orders", orders);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
  };
}

export default createTableStatusHandler();
