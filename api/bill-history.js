import { redis } from "./_redis.js";
import { ringBell } from "./_bell.js";

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BILLS = 1000;
const MAX_PRINT_JOBS = 300;

function isCancelled(bill) {
  return Boolean(bill && (bill.cancelledAt || bill.status === "cancelled"));
}

function summaryFor(history) {
  const cancelledBills = history.filter(isCancelled);
  const validBills = history.filter((bill) => !isCancelled(bill));
  return {
    allBills: history.length,
    validBills: validBills.length,
    cancelledBills: cancelledBills.length,
    validTotal: validBills.reduce((sum, bill) => sum + (Number(bill.total) || 0), 0),
  };
}

function recentBills(value, now = Date.now()) {
  const earliest = now - HISTORY_WINDOW_MS;
  return (Array.isArray(value) ? value : [])
    .filter((bill) => bill && bill.id && new Date(bill.createdAt).getTime() >= earliest)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_BILLS);
}

function safeItem(item) {
  return {
    name: String(item.name || "รายการ"),
    qty: Math.max(1, Number(item.qty) || 1),
    price: Number(item.price) || 0,
    lineTotal: Number.isFinite(Number(item.lineTotal))
      ? Number(item.lineTotal)
      : (Number(item.price) || 0) * Math.max(1, Number(item.qty) || 1),
  };
}

function safeBill(bill) {
  // `items` holds only the lines still on the bill, so anything reading it
  // (receipts, sales dashboard) automatically ignores cancelled lines.
  const items = Array.isArray(bill.items) ? bill.items.map(safeItem) : [];
  const cancelledItems = Array.isArray(bill.cancelledItems)
    ? bill.cancelledItems.map((item) => ({ ...safeItem(item), cancelledAt: item.cancelledAt || null }))
    : [];
  return {
    id: String(bill.id),
    billNo: String(bill.billNo || bill.id),
    table: String(bill.table || "-"),
    createdAt: bill.createdAt,
    settledAt: bill.settledAt || bill.createdAt,
    shopName: String(bill.shopName || "ทองย้อย"),
    phone: String(bill.phone || "085-529-8799"),
    total: Number(bill.total) || 0,
    cancelled: isCancelled(bill),
    cancelledAt: bill.cancelledAt || null,
    items,
    cancelledItems,
  };
}

export function createBillHistoryHandler({ redis: redisClient = redis, bell = ringBell } = {}) {
  return async function handler(req, res) {
  const now = Date.now();
  const history = recentBills(await redisClient.get("billHistory"), now);

  if (req.method === "GET") {
    return res.status(200).json({
      days: 7,
      bills: history.map(safeBill),
      summary: summaryFor(history),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method not allowed");
  }

  const body = req.body || {};
  if (!body.action || !body.id) {
    return res.status(400).json({ ok: false, error: "unknown action" });
  }

  const bill = history.find((entry) => entry.id === body.id);
  if (!bill) return res.status(404).json({ ok: false, error: "bill not found" });

  if (body.action === "cancel") {
    if (isCancelled(bill)) {
      return res.status(200).json({
        ok: true,
        alreadyCancelled: true,
        bill: safeBill(bill),
        summary: summaryFor(history),
      });
    }

    const cancelledAt = new Date(now).toISOString();
    bill.status = "cancelled";
    bill.cancelledAt = cancelledAt;

    // A queued receipt must not print after its bill was voided. A print that
    // has already completed cannot be physically recalled, but it remains
    // clearly marked cancelled in the bill record for reconciliation.
    const storedJobs = await redisClient.get("printJobs");
    const jobs = Array.isArray(storedJobs) ? storedJobs : [];
    jobs.forEach((job) => {
      const belongsToBill = job && job.type === "receipt" &&
        (job.id === bill.id || job.reprintOf === bill.id);
      if (belongsToBill && job.status !== "printed") {
        job.status = "cancelled";
        job.cancelledAt = cancelledAt;
      }
    });

    await Promise.all([
      redisClient.set("billHistory", recentBills(history, now)),
      redisClient.set("printJobs", jobs.slice(-MAX_PRINT_JOBS)),
    ]);
    return res.status(200).json({
      ok: true,
      bill: safeBill(bill),
      summary: summaryFor(history),
    });
  }

  if (body.action === "cancel-item") {
    if (isCancelled(bill)) {
      return res.status(409).json({ ok: false, error: "bill is cancelled" });
    }
    const index = Number(body.itemIndex);
    const items = Array.isArray(bill.items) ? bill.items : [];
    const target = Number.isInteger(index) ? items[index] : null;
    // Name check guards against a stale screen cancelling the wrong line.
    if (!target || String(target.name || "รายการ") !== String(body.itemName ?? target.name ?? "รายการ")) {
      return res.status(409).json({ ok: false, error: "item not found", bill: safeBill(bill), summary: summaryFor(history) });
    }

    const cancelledAt = new Date(now).toISOString();
    items.splice(index, 1);
    bill.items = items;
    bill.cancelledItems = [
      ...(Array.isArray(bill.cancelledItems) ? bill.cancelledItems : []),
      { ...target, cancelledAt },
    ];
    if (bill.originalTotal === undefined) bill.originalTotal = Number(bill.total) || 0;
    bill.total = items.reduce((sum, item) => sum + safeItem(item).lineTotal, 0);

    let billCancelled = false;
    if (items.length === 0) {
      // Every line is gone: treat it as a fully cancelled bill.
      bill.status = "cancelled";
      bill.cancelledAt = cancelledAt;
      billCancelled = true;
    }

    // Receipts still waiting in the print queue must show the new lines/total.
    const storedJobs = await redisClient.get("printJobs");
    const jobs = Array.isArray(storedJobs) ? storedJobs : [];
    jobs.forEach((job) => {
      const belongsToBill = job && job.type === "receipt" &&
        (job.id === bill.id || job.reprintOf === bill.id);
      if (!belongsToBill || job.status === "printed") return;
      if (billCancelled) {
        job.status = "cancelled";
        job.cancelledAt = cancelledAt;
      } else {
        job.items = items.map((item) => ({ ...item }));
        job.total = bill.total;
      }
    });

    await Promise.all([
      redisClient.set("billHistory", recentBills(history, now)),
      redisClient.set("printJobs", jobs.slice(-MAX_PRINT_JOBS)),
    ]);
    return res.status(200).json({
      ok: true,
      billCancelled,
      bill: safeBill(bill),
      summary: summaryFor(history),
    });
  }

  if (body.action !== "reprint") {
    return res.status(400).json({ ok: false, error: "unknown action" });
  }

  if (isCancelled(bill)) {
    return res.status(409).json({ ok: false, error: "bill is cancelled" });
  }
  if (!Array.isArray(bill.items) || bill.items.length === 0) {
    return res.status(409).json({ ok: false, error: "bill has no items" });
  }

  const storedJobs = await redisClient.get("printJobs");
  const jobs = Array.isArray(storedJobs) ? storedJobs : [];
  const existing = jobs.find((job) =>
    job && job.type === "receipt" && job.reprintOf === bill.id && job.status !== "printed" &&
    new Date(job.queuedAt || job.createdAt).getTime() > now - 2 * 60 * 1000,
  );
  if (existing) {
    return res.status(200).json({ ok: true, receiptJobId: existing.id, alreadyQueued: true });
  }

  const receiptJob = {
    ...bill,
    id: `reprint-${bill.id}-${now}`,
    type: "receipt",
    status: "queued",
    reprintOf: bill.id,
    queuedAt: new Date(now).toISOString(),
  };
  jobs.push(receiptJob);
  await Promise.all([
    redisClient.set("billHistory", history.slice(0, MAX_BILLS)),
    redisClient.set("printJobs", jobs.slice(-MAX_PRINT_JOBS)),
  ]);
  await bell("print");
  return res.status(200).json({ ok: true, receiptJobId: receiptJob.id });
  };
}

export default createBillHistoryHandler();
