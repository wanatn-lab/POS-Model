import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://example.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";

const { createShopStatusHandler, bangkokDate } = await import("../api/shop-status.js");

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: undefined };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = (body) => { res.body = body; return res; };
  return res;
}

function fakeRedis() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    get: async (key) => { calls.push(["get", key]); return store.has(key) ? store.get(key) : null; },
    set: async (key, value, options) => { calls.push(["set", key, options]); store.set(key, value); },
    del: async (key) => { calls.push(["del", key]); store.delete(key); },
  };
}

// 2026-10-12 is a Monday. 23:30 UTC on Sunday is already Monday 06:30 in Bangkok.
const monday = () => new Date("2026-10-11T23:30:00Z");

test("bangkokDate uses the Bangkok calendar day", () => {
  assert.equal(bangkokDate(new Date("2026-10-11T23:30:00Z")), "2026-10-12");
  assert.equal(bangkokDate(new Date("2026-10-12T16:59:00Z")), "2026-10-12");
  assert.equal(bangkokDate(new Date("2026-10-12T17:00:00Z")), "2026-10-13");
});

test("GET is one Redis command and reports no special opening by default", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: monday });
  const res = fakeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, today: "2026-10-12", specialOpenDate: null });
  assert.equal(redis.calls.length, 1);
});

test("open stores today's date (with an expiry) and cancel removes it", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: monday });

  let res = fakeRes();
  await handler({ method: "POST", body: { action: "open" } }, res);
  assert.equal(res.body.specialOpenDate, "2026-10-12");
  assert.equal(redis.store.get("shopSpecialOpen"), "2026-10-12");
  assert.ok(redis.calls.find((c) => c[0] === "set")[2].ex > 0);

  res = fakeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.body.specialOpenDate, "2026-10-12");

  res = fakeRes();
  await handler({ method: "POST", body: { action: "cancel" } }, res);
  assert.equal(res.body.specialOpenDate, null);
  assert.equal(redis.store.has("shopSpecialOpen"), false);
});

test("unknown action is rejected without touching Redis", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: monday });
  const res = fakeRes();
  await handler({ method: "POST", body: { action: "nope" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(redis.calls.length, 0);
});
