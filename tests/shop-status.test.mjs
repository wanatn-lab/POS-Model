import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://example.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";

const { createShopStatusHandler, bangkokDate } = await import("../api/shop-status.js");
const { defaultSchedule } = await import("../api/_shop-hours.js");

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: undefined };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = (body) => { res.body = body; return res; };
  return res;
}

function fakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  return {
    store,
    calls,
    get: async (key) => { calls.push(["get", key]); return store.has(key) ? structuredClone(store.get(key)) : null; },
    set: async (key, value, options) => { calls.push(["set", key, options]); store.set(key, structuredClone(value)); },
    del: async (key) => { calls.push(["del", key]); store.delete(key); },
  };
}

const bkk = (iso) => () => new Date(`${iso}+07:00`);
const tuesdayNoon = bkk("2026-10-13T12:00:00");
const tuesdayEarly = bkk("2026-10-13T05:30:00");
const tuesdayLate = bkk("2026-10-13T19:00:00");

async function call(handler, method, body, auth) {
  const res = fakeRes();
  await handler({ method, body, auth }, res);
  return res;
}

test("bangkokDate uses the Bangkok calendar day", () => {
  assert.equal(bangkokDate(new Date("2026-10-11T23:30:00Z")), "2026-10-12");
  assert.equal(bangkokDate(new Date("2026-10-12T16:59:00Z")), "2026-10-12");
  assert.equal(bangkokDate(new Date("2026-10-12T17:00:00Z")), "2026-10-13");
});

test("the first GET saves the default 06:00-18:00 schedule; later GETs only read", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: tuesdayNoon });
  let res = await call(handler, "GET");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.open, true);
  assert.equal(res.body.reason, "schedule");
  assert.equal(res.body.today, "2026-10-13");
  assert.equal(res.body.closesAt, "2026-10-13T11:00:00.000Z");
  assert.equal(res.body.schedule.mon.open, "06:00");
  assert.equal(res.body.override, null);
  assert.equal(res.body.specialOpenDate, null);
  assert.deepEqual(redis.store.get("shopSchedule"), defaultSchedule());
  assert.equal(res.headers["Cache-Control"], "no-store");

  redis.calls.length = 0;
  res = await call(handler, "GET");
  assert.deepEqual(redis.calls, [["get", "shopSchedule"], ["get", "shopOverride"]]);
});

test("owner saves a weekly schedule; a bad one is rejected and nothing is written", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: tuesdayNoon });
  const schedule = defaultSchedule();
  schedule.mon = { closed: true, open: "06:00", close: "18:00" };
  schedule.sat = { closed: false, open: "07:00", close: "20:00" };

  let res = await call(handler, "POST", { action: "set-schedule", schedule });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.schedule.mon.closed, true);
  assert.equal(res.body.schedule.sat.close, "20:00");
  assert.equal(redis.store.get("shopSchedule").sat.open, "07:00");

  const bad = defaultSchedule();
  bad.tue = { closed: false, open: "18:00", close: "06:00" };
  redis.calls.length = 0;
  res = await call(handler, "POST", { action: "set-schedule", schedule: bad });
  assert.equal(res.statusCode, 400);
  assert.equal(redis.calls.some((c) => c[0] === "set"), false);
  assert.equal(redis.store.get("shopSchedule").tue.open, "06:00");

  res = await call(handler, "POST", { action: "set-schedule" });
  assert.equal(res.statusCode, 400);
});

test("open-now before opening time lasts until today's closing, then it expires by itself", async () => {
  const redis = fakeRedis();
  const early = createShopStatusHandler({ redis, now: tuesdayEarly });
  let res = await call(early, "GET");
  assert.equal(res.body.open, false);

  res = await call(early, "POST", { action: "open-now" }, { role: "staff", staffId: "somchai" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.open, true);
  assert.equal(res.body.reason, "manual-open");
  assert.equal(res.body.override.mode, "open");
  assert.equal(res.body.override.expiresAt, "2026-10-13T11:00:00.000Z");
  assert.equal(res.body.specialOpenDate, "2026-10-13");
  assert.equal(redis.store.get("shopOverride").setBy, "somchai");
  assert.equal(res.body.override.setBy, undefined); // who pressed it is not public

  const evening = createShopStatusHandler({ redis, now: tuesdayLate });
  res = await call(evening, "GET");
  assert.equal(res.body.open, false);
  assert.equal(res.body.reason, "schedule");
  assert.equal(res.body.override, null);
});

test("open-now after closing time needs hours; hours are limited to 1-12", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: tuesdayLate });
  let res = await call(handler, "POST", { action: "open-now" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "hours_required");
  assert.equal(redis.store.has("shopOverride"), false);

  for (const hours of [0, -1, 13, "x"]) {
    res = await call(handler, "POST", { action: "open-now", hours });
    assert.equal(res.statusCode, 400, `hours=${hours}`);
  }

  res = await call(handler, "POST", { action: "open-now", hours: 3 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.open, true);
  assert.equal(res.body.override.expiresAt, "2026-10-13T15:00:00.000Z"); // 22:00 Bangkok
});

test("close-now closes until the next opening and clear-override removes it", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: tuesdayNoon });
  let res = await call(handler, "POST", { action: "close-now" });
  assert.equal(res.body.open, false);
  assert.equal(res.body.reason, "manual-closed");
  assert.equal(res.body.opensAt, "2026-10-13T23:00:00.000Z"); // Wednesday 06:00 Bangkok
  assert.equal(res.body.specialOpenDate, null);

  res = await call(handler, "POST", { action: "clear-override" });
  assert.equal(res.body.open, true);
  assert.equal(res.body.override, null);
  assert.equal(redis.store.has("shopOverride"), false);
});

test("the older open / cancel actions still work", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: tuesdayLate });
  let res = await call(handler, "POST", { action: "open" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.open, true);
  assert.equal(res.body.specialOpenDate, "2026-10-13");

  res = await call(handler, "POST", { action: "cancel" });
  assert.equal(res.body.specialOpenDate, null);
  assert.equal(res.body.open, false);
});

test("a manual switch does not change the saved schedule", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: tuesdayEarly });
  await call(handler, "GET");
  const before = JSON.stringify(redis.store.get("shopSchedule"));
  await call(handler, "POST", { action: "open-now" });
  await call(handler, "POST", { action: "close-now" });
  await call(handler, "POST", { action: "clear-override" });
  assert.equal(JSON.stringify(redis.store.get("shopSchedule")), before);
});

test("unknown action and wrong method are rejected without writing", async () => {
  const redis = fakeRedis();
  const handler = createShopStatusHandler({ redis, now: tuesdayNoon });
  let res = await call(handler, "POST", { action: "explode" });
  assert.equal(res.statusCode, 400);
  res = await call(handler, "POST", undefined);
  assert.equal(res.statusCode, 400);
  assert.equal(redis.calls.some((c) => c[0] === "set" || c[0] === "del"), false);
  res = await call(handler, "DELETE");
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET, POST");
});
