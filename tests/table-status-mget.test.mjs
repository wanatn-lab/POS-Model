import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createTableStatusHandler, tableStatusPayload } = await import("../api/table-status.js");

function response(handler, req) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {},
      status(code) { this.code = code; return this; },
      json(body) { resolve({ code: this.code, body }); },
      end() { resolve({ code: this.code }); },
    };
    handler(req, res);
  });
}

function fakeRedis(values) {
  const commands = [];
  return {
    commands,
    async mget(...keys) {
      commands.push({ command: "MGET", keys });
      return keys.map((key) => structuredClone(values[key] ?? null));
    },
    async get(key) {
      commands.push({ command: "GET", key });
      return structuredClone(values[key] ?? null);
    },
    async set(key) { commands.push({ command: "SET", key }); },
  };
}

// This is the pre-MGET read shape. It intentionally uses the same fake Redis
// values as the handler so the test proves MGET preserves null/JSON semantics.
async function legacyGet(redis) {
  const [orders, clears, settings] = await Promise.all([
    redis.get("orders"), redis.get("tableClears"), redis.get("settings"),
  ]);
  return [orders, clears, settings];
}

test("GET table-status uses one MGET and gives the same result as the old three GET values", async () => {
  const current = atBangkok("2026-10-13T15:00:00");
  const createdAt = atBangkok("2026-10-13T14:00:00").toISOString();
  const values = {
    orders: [{ id: "o1", table: 2, createdAt, items: [{ name: "ชา", price: 35, qty: 1 }] }],
    tableClears: { 1: "2026-01-01T00:00:00.000Z" },
    settings: { tableCount: 3 },
  };
  const oldRedis = fakeRedis(values);
  const newRedis = fakeRedis(values);
  const oldValues = await legacyGet(oldRedis);
  const result = await response(createTableStatusHandler({ redis: newRedis, now: () => current }), {
    method: "GET", headers: { "x-jinko-client": "2" },
  });

  assert.deepEqual(newRedis.commands, [{ command: "MGET", keys: ["orders", "tableClears", "settings"] }]);
  assert.deepEqual(oldValues, [values.orders, values.tableClears, values.settings]);
  assert.deepEqual(result.body, tableStatusPayload(...oldValues, current));
  assert.equal(result.code, 200);
  assert.equal(result.body.tableCount, 3);
  assert.equal(result.body.tables[1].items[0].orderId, "o1");
});

test("GET table-status handles missing JSON keys exactly as the old GET values", async () => {
  const current = atBangkok("2026-10-13T15:00:00");
  const values = { orders: null, tableClears: null, settings: null };
  const oldRedis = fakeRedis(values);
  const newRedis = fakeRedis(values);
  const oldValues = await legacyGet(oldRedis);
  assert.deepEqual(oldValues, [null, null, null]);

  const result = await response(createTableStatusHandler({ redis: newRedis, now: () => current }), {
    method: "GET", headers: { "x-jinko-client": "2" },
  });
  assert.deepEqual(newRedis.commands, [{ command: "MGET", keys: ["orders", "tableClears", "settings"] }]);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, tableStatusPayload(...oldValues, current));
  assert.equal(result.body.tableCount, 20);
  assert.equal(result.body.tables.length, 20);
});

test("table-status keeps takeaway labels after tables 1-20 without converting them to NaN", () => {
  const current = atBangkok("2026-10-13T15:00:00");
  const createdAt = atBangkok("2026-10-13T14:00:00").toISOString();
  const payload = tableStatusPayload([
    { id: "t20", table: 20, createdAt, items: [{ name: "ข้าว", qty: 1 }] },
    { id: "home2", table: "กลับบ้าน 2", createdAt, items: [{ name: "ชา", qty: 1 }] },
    { id: "t2", table: 2, createdAt, items: [{ name: "น้ำ", qty: 1 }] },
    { id: "home1", table: "กลับบ้าน 1", createdAt, items: [{ name: "กาแฟ", qty: 1 }] },
  ], {}, { tableCount: 20 }, current);

  assert.deepEqual(payload.tables.slice(0, 20).map((table) => table.table),
    Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(payload.tables.slice(20).map((table) => table.table), ["กลับบ้าน 1", "กลับบ้าน 2"]);
  assert.equal(payload.tables.some((table) => Number.isNaN(table.table)), false);
});

test("POST still uses its existing separate GET/SET path, never MGET", async () => {
  const createdAt = new Date().toISOString();
  const redis = fakeRedis({ orders: [{ id: "o1", createdAt, items: [{}] }] });
  const result = await response(createTableStatusHandler({ redis }), {
    method: "POST", body: { action: "item-status", orderId: "o1", itemIndex: 0, status: "ready" },
  });
  assert.equal(result.code, 200);
  assert.deepEqual(redis.commands, [{ command: "GET", key: "orders" }, { command: "SET", key: "orders" }]);
});

const atBangkok = (value) => new Date(`${value}+07:00`);

const SCHEDULE_AND_OVERRIDE_READS = [
  { command: "GET", key: "shopSchedule" },
  { command: "GET", key: "shopOverride" },
];

test("legacy page outside hours is rejected after reading only the shop hours", async () => {
  const redis = fakeRedis({ orders: [] });
  const handler = createTableStatusHandler({ redis, now: () => atBangkok("2026-10-13T05:59:00") });
  const result = await response(handler, { method: "GET", headers: {} });
  assert.equal(result.code, 200);
  assert.equal(result.body.closed, true);
  assert.deepEqual(redis.commands, SCHEDULE_AND_OVERRIDE_READS);
});

test("new table-status client still works outside hours", async () => {
  const redis = fakeRedis({ orders: [], tableClears: {}, settings: { tableCount: 2 } });
  const handler = createTableStatusHandler({
    redis,
    now: () => atBangkok("2026-10-13T21:00:00"),
  });
  const result = await response(handler, {
    method: "GET",
    headers: { "X-Jinko-Client": "2" },
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.closed, undefined);
  assert.equal(result.body.tableCount, 2);
  assert.deepEqual(redis.commands, [{ command: "MGET", keys: ["orders", "tableClears", "settings"] }]);
});

test("new client and in-hours legacy client both receive normal data", async () => {
  const values = { orders: [], tableClears: {}, settings: { tableCount: 2 } };
  const now = () => atBangkok("2026-10-13T11:20:00"); // inside the default 06:00-18:00 hours
  const newRedis = fakeRedis(values);
  const legacyRedis = fakeRedis(values);
  const newResult = await response(createTableStatusHandler({ redis: newRedis, now }), {
    method: "GET", headers: { "X-Jinko-Client": "2" },
  });
  const legacyResult = await response(createTableStatusHandler({ redis: legacyRedis, now }), { method: "GET", headers: {} });
  assert.deepEqual(newResult.body, legacyResult.body);
  assert.deepEqual(newRedis.commands, [{ command: "MGET", keys: ["orders", "tableClears", "settings"] }]);
  assert.deepEqual(legacyRedis.commands, [
    ...SCHEDULE_AND_OVERRIDE_READS,
    { command: "MGET", keys: ["orders", "tableClears", "settings"] },
  ]);
});

test("legacy page is allowed at 17:59 but rejected at 18:00 (default hours)", async () => {
  const values = { orders: [], tableClears: {}, settings: {} };
  const allowedRedis = fakeRedis(values);
  const allowed = await response(createTableStatusHandler({
    redis: allowedRedis, now: () => atBangkok("2026-10-13T17:59:00"),
  }), { method: "GET", headers: {} });
  assert.equal(allowed.body.closed, undefined);
  assert.deepEqual(allowedRedis.commands, [
    ...SCHEDULE_AND_OVERRIDE_READS,
    { command: "MGET", keys: ["orders", "tableClears", "settings"] },
  ]);

  const blockedRedis = fakeRedis(values);
  const blocked = await response(createTableStatusHandler({
    redis: blockedRedis, now: () => atBangkok("2026-10-13T18:00:00"),
  }), { method: "GET", headers: {} });
  assert.equal(blocked.body.closed, true);
  assert.deepEqual(blockedRedis.commands, SCHEDULE_AND_OVERRIDE_READS);
});

test("legacy page follows the saved schedule and the manual switch", async () => {
  const now = () => atBangkok("2026-10-13T20:00:00"); // a Tuesday evening, after the default close
  const hours = {};
  for (const key of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]) hours[key] = { closed: false, open: "06:00", close: "22:00" };
  const base = { orders: [], tableClears: {}, settings: {} };

  const late = await response(createTableStatusHandler({ redis: fakeRedis({ ...base, shopSchedule: hours }), now }), { method: "GET", headers: {} });
  assert.equal(late.body.closed, undefined); // saved hours run until 22:00

  const forcedOpen = { mode: "open", expiresAt: "2026-10-13T23:00:00+07:00" };
  const open = await response(createTableStatusHandler({ redis: fakeRedis({ ...base, shopOverride: forcedOpen }), now }), { method: "GET", headers: {} });
  assert.equal(open.body.closed, undefined);

  const forcedClosed = { mode: "closed", expiresAt: "2026-10-14T06:00:00+07:00" };
  const closed = await response(createTableStatusHandler({ redis: fakeRedis({ ...base, shopSchedule: hours, shopOverride: forcedClosed }), now }), { method: "GET", headers: {} });
  assert.equal(closed.body.closed, true);
});
