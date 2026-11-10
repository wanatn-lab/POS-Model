import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://example.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";

const { createOrdersHandler } = await import("../api/orders.js");

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.setHeader = () => {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = (b) => { res.body = b; return res; };
  return res;
}

function fakeRedis(initial) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : null),
    set: async (k, v) => { store.set(k, structuredClone(v)); },
  };
}

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const customer = (table) => ({ role: "customer", table });

async function customerView(redis, table, now) {
  const res = fakeRes();
  await createOrdersHandler({ redis, ...(now ? { now } : {}) })({ method: "GET", auth: customer(table) }, res);
  return res.body.map((o) => o.id);
}

test("after checkout the customer no longer sees the table's earlier orders", async () => {
  const redis = fakeRedis({
    orders: [
      { id: "old1", table: "T5", createdAt: minutesAgo(120) },
      { id: "old2", table: "T5", createdAt: minutesAgo(60) },
      { id: "other", table: "T6", createdAt: minutesAgo(30) },
    ],
    tableClears: { T5: minutesAgo(10) },
  });
  assert.deepEqual(await customerView(redis, "T5"), []);
  // another table is unaffected by T5 being cleared
  assert.deepEqual(await customerView(redis, "T6"), ["other"]);
});

test("orders placed after checkout are visible again, earlier ones stay hidden", async () => {
  const redis = fakeRedis({
    orders: [
      { id: "before", table: "T5", createdAt: minutesAgo(60) },
      { id: "after", table: "T5", createdAt: minutesAgo(2) },
    ],
    tableClears: { T5: minutesAgo(10) },
  });
  assert.deepEqual(await customerView(redis, "T5"), ["after"]);
});

test("without checkout the customer still sees the table's own orders only", async () => {
  const redis = fakeRedis({
    orders: [
      { id: "mine", table: "T5", createdAt: minutesAgo(20) },
      { id: "theirs", table: "T6", createdAt: minutesAgo(20) },
    ],
  });
  assert.deepEqual(await customerView(redis, "T5"), ["mine"]);
});

test("customers never see yesterday's orders (Bangkok midnight), staff still see the last 24h", async () => {
  // 2026-11-10 00:30 Bangkok = 2026-11-09T17:30:00Z
  const now = () => Date.parse("2026-11-09T17:30:00Z");
  const redis = fakeRedis({
    orders: [
      { id: "yesterday-evening", table: "T5", createdAt: "2026-11-09T15:00:00Z" }, // 22:00 Bangkok on the 9th
      { id: "after-midnight", table: "T5", createdAt: "2026-11-09T17:10:00Z" },    // 00:10 Bangkok on the 10th
    ],
  });
  assert.deepEqual(await customerView(redis, "T5", now), ["after-midnight"]);

  const staff = fakeRes();
  await createOrdersHandler({ redis, now })({ method: "GET", auth: { role: "staff" } }, staff);
  assert.deepEqual(staff.body.map((o) => o.id), ["yesterday-evening", "after-midnight"]);
});
