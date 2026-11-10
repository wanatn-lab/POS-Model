import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createOrdersHandler } = await import("../api/orders.js");
const { defaultSchedule } = await import("../api/_shop-hours.js");

const MENU = [{ id: "m1", name: "ข้าวหมูแดง", price: 40, category: "ข้าว", printer: "kitchen", available: true }];
const bkk = (iso) => new Date(`${iso}+07:00`).getTime();
const NOON = bkk("2026-10-13T12:00:00"); // inside 06:00-18:00
const NIGHT = bkk("2026-10-13T21:00:00"); // after closing

function fakeRedis(initial = {}) {
  const store = new Map(Object.entries({ menu: MENU, orders: [], printJobs: [], ...initial }));
  const writes = [];
  return {
    store,
    writes,
    async get(key) { return store.has(key) ? structuredClone(store.get(key)) : null; },
    async set(key, value) { writes.push(key); store.set(key, structuredClone(value)); },
  };
}

function place(handler, { role = "public", table = "T3", key } = {}) {
  return new Promise((resolve) => {
    const res = {
      status(code) { this.code = code; return this; },
      json(body) { resolve({ code: this.code, body }); },
      end() { resolve({ code: this.code }); },
      setHeader() {},
    };
    handler({
      method: "POST",
      auth: role ? { role, table: role === "customer" ? table : undefined, staffId: role === "staff" ? "somchai" : undefined } : undefined,
      body: { table, items: [{ id: "m1", qty: 1 }], idempotencyKey: key },
    }, res);
  });
}

function setup(initial, nowMs) {
  const redis = fakeRedis(initial);
  const rings = [];
  const handler = createOrdersHandler({ redis, bell: async (reason) => { rings.push(reason); }, now: () => nowMs });
  return { redis, rings, handler };
}

test("a shop that never saved hours is not restricted", async () => {
  const { handler, redis } = setup({}, NIGHT);
  const result = await place(handler);
  assert.equal(result.code, 200);
  assert.equal(redis.store.get("orders").length, 1);
});

test("while the shop is open a walk-in customer can order", async () => {
  const { handler } = setup({ shopSchedule: defaultSchedule() }, NOON);
  const result = await place(handler);
  assert.equal(result.code, 200);
  assert.equal(result.body.order.source, "customer");
});

test("while the shop is closed a walk-in customer is refused and nothing is saved or printed", async () => {
  const { handler, redis, rings } = setup({ shopSchedule: defaultSchedule() }, NIGHT);
  const result = await place(handler);
  assert.equal(result.code, 409);
  assert.equal(result.body.error, "shop_closed");
  assert.equal(result.body.opensAt, "2026-10-13T23:00:00.000Z"); // 06:00 next morning in Bangkok
  assert.deepEqual(redis.writes, []);
  assert.deepEqual(rings, []);
});

test("an unauthenticated caller counts as a customer", async () => {
  const { handler } = setup({ shopSchedule: defaultSchedule() }, NIGHT);
  const result = await place(handler, { role: null });
  assert.equal(result.code, 409);
});

test("staff and owner can always order, even when closed", async () => {
  for (const role of ["staff", "owner"]) {
    const { handler, redis } = setup({ shopSchedule: defaultSchedule() }, NIGHT);
    const result = await place(handler, { role });
    assert.equal(result.code, 200, role);
    assert.equal(result.body.order.source, "staff");
    assert.equal(redis.store.get("orders").length, 1);
  }
});

test("a customer who already holds a table pass can keep ordering after closing time", async () => {
  const { handler } = setup({ shopSchedule: defaultSchedule() }, NIGHT);
  const result = await place(handler, { role: "customer" });
  assert.equal(result.code, 200);
});

test("a manual 'open' lets customers in outside the schedule, and expires by itself", async () => {
  const override = { mode: "open", expiresAt: new Date(NIGHT + 2 * 3600 * 1000).toISOString() };
  const open = setup({ shopSchedule: defaultSchedule(), shopOverride: override }, NIGHT);
  assert.equal((await place(open.handler)).code, 200);

  const expired = setup({ shopSchedule: defaultSchedule(), shopOverride: override }, NIGHT + 3 * 3600 * 1000);
  assert.equal((await place(expired.handler)).code, 409);
});

test("a manual 'close' stops walk-ins during opening hours, staff still allowed", async () => {
  const override = { mode: "closed", expiresAt: new Date(NOON + 3600 * 1000).toISOString() };
  const closed = setup({ shopSchedule: defaultSchedule(), shopOverride: override }, NOON);
  assert.equal((await place(closed.handler)).code, 409);
  assert.equal((await place(closed.handler, { role: "staff" })).code, 200);

  const after = setup({ shopSchedule: defaultSchedule(), shopOverride: override }, NOON + 2 * 3600 * 1000);
  assert.equal((await place(after.handler)).code, 200);
});

test("a retry of an order that was accepted before closing still gets its answer", async () => {
  const redis = fakeRedis({ shopSchedule: defaultSchedule() });
  const key = "retry-key-0123456789";
  const before = createOrdersHandler({ redis, bell: async () => {}, now: () => NOON });
  const first = await place(before, { key });
  assert.equal(first.code, 200);

  const after = createOrdersHandler({ redis, bell: async () => {}, now: () => NIGHT });
  const replay = await place(after, { key });
  assert.equal(replay.code, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.order.id, first.body.order.id);
  assert.equal(redis.store.get("orders").length, 1);
});

test("a malformed saved schedule fails open to the default hours instead of blocking everyone", async () => {
  const { handler } = setup({ shopSchedule: { mon: "bad" } }, NOON);
  assert.equal((await place(handler)).code, 200);
});
