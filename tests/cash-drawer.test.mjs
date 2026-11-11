import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createSettingsHandler } = await import("../api/settings.js");
const { createTableStatusHandler } = await import("../api/table-status.js");
const { createBillHistoryHandler } = await import("../api/bill-history.js");

function fakeRedis(seed) {
  const values = new Map(Object.entries(structuredClone(seed)));
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async batchSet(entries) {
      for (const [key, value] of entries) values.set(key, structuredClone(value));
    },
    peek(key) { return structuredClone(values.get(key)); },
  };
}

function fakeRes() {
  const res = { statusCode: 0, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = (body) => { res.body = body; return res; };
  res.setHeader = () => {};
  return res;
}

function checkoutSeed(cashDrawer) {
  return {
    orders: [{
      id: "order-drawer-1", table: "T1", status: "new",
      createdAt: new Date().toISOString(),
      items: [{ name: "ข้าวหมูแดง", qty: 1, price: 60 }],
    }],
    tableClears: {},
    settings: { shopName: "ทองย้อย", cashDrawer },
    printJobs: [],
    billHistory: [],
  };
}

test("checkout queues an openDrawer receipt only when the server-side setting is enabled", async () => {
  const enabled = { enabled: true, openWhen: "before", pulsePin: 1, onTime: 30, offTime: 90 };
  const redis = fakeRedis(checkoutSeed(enabled));
  const handler = createTableStatusHandler({ redis, bell: async () => {} });
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: {
    action: "checkout", table: "T1", printReceipt: true, openDrawer: false,
  } }, res);

  assert.equal(res.statusCode, 200);
  const [job] = redis.peek("printJobs");
  assert.equal(job.openDrawer, true);
  assert.deepEqual(job.cashDrawer, enabled, "the Bridge receives a server-owned checkout snapshot");

  const disabledRedis = fakeRedis(checkoutSeed({ enabled: false, openWhen: "after", pulsePin: 0, onTime: 25, offTime: 125 }));
  const disabledRes = fakeRes();
  await createTableStatusHandler({ redis: disabledRedis, bell: async () => {} })(
    { method: "POST", headers: {}, body: { action: "checkout", table: "T1", printReceipt: true, openDrawer: true } },
    disabledRes,
  );
  assert.equal(disabledRes.statusCode, 200);
  assert.equal(Object.hasOwn(disabledRedis.peek("printJobs")[0], "openDrawer"), false);

  const noReceiptRedis = fakeRedis(checkoutSeed(enabled));
  const noReceiptRes = fakeRes();
  await createTableStatusHandler({ redis: noReceiptRedis, bell: async () => {} })(
    { method: "POST", headers: {}, body: { action: "checkout", table: "T1", printReceipt: false } },
    noReceiptRes,
  );
  assert.equal(noReceiptRes.statusCode, 200);
  const [drawerJob] = noReceiptRedis.peek("printJobs");
  assert.equal(noReceiptRes.body.receiptJobId, null);
  assert.equal(noReceiptRes.body.drawerJobId, drawerJob.id);
  assert.equal(drawerJob.type, "drawer");
  assert.equal(drawerJob.station, "counter");
  assert.equal(drawerJob.id, `drawer-${noReceiptRes.body.bill.billNo}`);
  assert.equal(drawerJob.openDrawer, true);
  assert.equal(Object.hasOwn(drawerJob, "items"), false, "a drawer-only job contains no print data");
});

test("drawer-only checkout is not duplicated by reprint or cancellation", async () => {
  const redis = fakeRedis(checkoutSeed({ enabled: true, openWhen: "after", pulsePin: 0, onTime: 25, offTime: 125 }));
  const checkout = fakeRes();
  await createTableStatusHandler({ redis, bell: async () => {} })(
    { method: "POST", headers: {}, body: { action: "checkout", table: "T1", printReceipt: false } }, checkout,
  );
  const bill = checkout.body.bill;
  assert.equal(Object.hasOwn(bill, "openDrawer"), false, "the paid bill itself cannot trigger a drawer");

  const reprint = fakeRes();
  await createBillHistoryHandler({ redis, bell: async () => {} })(
    { method: "POST", body: { action: "reprint", id: bill.id } }, reprint,
  );
  assert.equal(reprint.statusCode, 200);
  const reprintJob = redis.peek("printJobs").find((job) => job.reprintOf === bill.id);
  assert.ok(reprintJob);
  assert.equal(Object.hasOwn(reprintJob, "openDrawer"), false);
  assert.equal(redis.peek("printJobs").filter((job) => job.type === "drawer").length, 1);

  const idsBeforeCancel = redis.peek("printJobs").map((job) => job.id);
  const cancelled = fakeRes();
  await createBillHistoryHandler({ redis, bell: async () => {} })(
    { method: "POST", body: { action: "cancel", id: bill.id } }, cancelled,
  );
  assert.equal(cancelled.statusCode, 200);
  assert.deepEqual(redis.peek("printJobs").map((job) => job.id), idsBeforeCancel, "cancelling never creates a drawer job");
  assert.ok(redis.peek("printJobs").every((job) => job.status === "cancelled"));
});

test("settings rejects unsafe cash drawer values and supplies standard defaults", async () => {
  const redis = fakeRedis({});
  const handler = createSettingsHandler(redis);
  const initial = fakeRes();
  await handler({ method: "GET", body: {} }, initial);
  assert.deepEqual(initial.body.cashDrawer, {
    enabled: false, openWhen: "after", pulsePin: 0, onTime: 25, offTime: 125,
  });

  const invalid = fakeRes();
  await handler({ method: "POST", body: {
    cashDrawer: { enabled: true, openWhen: "later", pulsePin: 2, onTime: 500, offTime: -1 },
  } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.error, /^cashDrawer /);
  assert.deepEqual(redis.peek("settings").cashDrawer, initial.body.cashDrawer, "invalid values are not saved");
});

test("admin receipt settings expose the cash drawer controls and persist every value", async () => {
  const admin = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  for (const id of [
    "rcCashDrawerEnabled", "rcCashDrawerOpenWhen", "rcCashDrawerPulsePin",
    "rcCashDrawerOnTime", "rcCashDrawerOffTime",
  ]) assert.match(admin, new RegExp(`id=\\"${id}\\"`));
  assert.match(admin, /const cashDrawer\s*=\s*\{/);
  assert.match(admin, /JSON\.stringify\(\{ shopName, paperWidthMm, receipt, kitchen, cashDrawer \}\)/);
});
