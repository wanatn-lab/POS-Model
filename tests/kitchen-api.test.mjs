import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createKitchenHandler } = await import("../api/kitchen.js");

function fakeRedis() {
  const kv = new Map();
  const hashes = new Map();
  const h = (k) => hashes.get(k) || hashes.set(k, {}).get(k);
  return {
    async get(k) { return structuredClone(kv.get(k)); },
    async set(k, v) { kv.set(k, structuredClone(v)); },
    async incr(k) { const n = (kv.get(k) || 0) + 1; kv.set(k, n); return n; },
    async expire() {},
    // minimal emulation of the two Lua scripts used by api/_orders-store.js
    async eval(script, keys, args) {
      const k = keys[0];
      if (script.includes("return 'X'")) { const v = kv.get(k); return v === undefined ? false : "X" + JSON.stringify(v); }
      const cur = kv.get(k);
      const curRaw = cur === undefined ? undefined : JSON.stringify(cur);
      if ((curRaw === undefined && args[0] === "") || curRaw === args[0]) { kv.set(k, JSON.parse(args[1])); return 1; }
      return 0;
    },
    async hgetall(k) { const v = hashes.get(k); return v ? structuredClone(v) : null; },
    async hset(k, o) { Object.assign(h(k), structuredClone(o)); },
    async hdel(k, f) { delete h(k)[f]; },
  };
}
function call(handler, method, body) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b }); },
      end() { resolve({ code: this.code }); },
    };
    handler({ method, body }, res);
  });
}
const NOW = new Date("2026-10-09T05:00:00Z"); // 12:00 Bangkok
const fixed = () => NOW;
function setup() {
  const redis = fakeRedis();
  return {
    redis,
    kitchen: createKitchenHandler({ redis, now: fixed }),
  };
}
const food = { id: "m1", name: "กะเพรา", price: 59, category: "จานหลัก", qty: 1 };
const drink = { id: "m3", name: "ชาเย็น", price: 35, category: "เครื่องดื่ม", qty: 2 };

test("add-on and queue number are derived from existing orders (order creation untouched)", async () => {
  const { kitchen, redis } = setup();
  const t = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  await redis.set("orders", [
    { id: "a", table: 7, createdAt: t(30), items: [food] }, // legacy order, no new fields at all
    { id: "b", table: 8, createdAt: t(20), items: [food] },
    { id: "c", table: 7, createdAt: t(10), items: [{ ...food, name: "ต้มข่า" }] }, // same table again = add-on
  ]);
  const { body } = await call(kitchen, "GET");
  const t7 = body.cards.find((c) => c.table === 7);
  const t8 = body.cards.find((c) => c.table === 8);
  assert.equal(t7.billNo, "0001");
  assert.equal(t8.billNo, "0002");
  assert.deepEqual(t7.items.map((i) => i.isAddOn), [false, true]);
  assert.equal(t7.items[1].addedAt, t(10));
  assert.deepEqual(t8.items.map((i) => i.isAddOn), [false]);
});

test("after the table is cleared, the next order is a fresh table (not an add-on)", async () => {
  const { kitchen, redis } = setup();
  const t = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  await redis.set("orders", [
    { id: "a", table: 7, createdAt: t(30), items: [food] },
    { id: "b", table: 7, createdAt: t(5), items: [food] },
  ]);
  await redis.set("tableClears", { 7: t(10) });
  const { body } = await call(kitchen, "GET");
  assert.equal(body.cards.length, 1);
  assert.equal(body.cards[0].items.length, 1);
  assert.equal(body.cards[0].items[0].isAddOn, false);
});

test("a line removed by admin never re-attaches an old tick to a different dish", async () => {
  const { kitchen, redis } = setup();
  const t = NOW.toISOString();
  const a = { ...food, name: "กะเพรา" };
  const b = { ...food, name: "ผัดไทย" };
  const c = { ...food, name: "ต้มยำ" };
  await redis.set("orders", [{ id: "o1", table: 1, createdAt: t, items: [a, b, c] }]);
  let { body } = await call(kitchen, "GET");
  const ids = body.cards[0].items.map((i) => i.lineId);
  await call(kitchen, "POST", { action: "item-set", lineIds: [ids[2]], st: "d" }); // tick "ต้มยำ"
  await redis.set("orders", [{ id: "o1", table: 1, createdAt: t, items: [a, c] }]); // admin removes "ผัดไทย"
  ({ body } = await call(kitchen, "GET"));
  const states = Object.fromEntries(body.cards[0].items.map((i) => [i.name, i.st]));
  assert.equal(states["กะเพรา"], "p");
  assert.notEqual(states["ต้มยำ"], undefined);
  assert.equal(states["กะเพรา"] === "d", false); // nothing ticked by mistake
});

test("drinks are filtered on the server; drinks-only table is not shown", async () => {
  const { kitchen, redis } = setup();
  const t = NOW.toISOString();
  await redis.set("orders", [
    { id: "o1", table: 1, createdAt: t, queueNo: 1, items: [food, drink] },
    { id: "o2", table: 2, createdAt: t, queueNo: 2, items: [drink] },
  ]);
  const { body } = await call(kitchen, "GET");
  assert.equal(body.cards.length, 1);
  assert.equal(body.cards[0].table, 1);
  assert.equal(body.cards[0].items.length, 1);
  assert.equal(body.cards[0].total, 1);
  assert.equal(body.done.length, 0);
});

test("done count/move only counts shown items; add-on moves card back to pending", async () => {
  const { kitchen, redis } = setup();
  const t = NOW.toISOString();
  await redis.set("orders", [
    { id: "o1", table: 1, createdAt: t, items: [{ ...food, lineId: "o1-0" }, { ...drink, lineId: "o1-1" }] },
  ]);
  await call(kitchen, "POST", { action: "item-set", lineIds: ["o1-0"], st: "d" });
  let { body } = await call(kitchen, "GET");
  assert.equal(body.cards.length, 0); // drink is hidden, food done -> finished
  assert.equal(body.done.length, 1);
  const o = await redis.get("orders");
  o.push({ id: "o9", table: 1, createdAt: t, isAddOn: true, items: [{ ...food, lineId: "o9-0", isAddOn: true, addedAt: t }] });
  await redis.set("orders", o);
  ({ body } = await call(kitchen, "GET"));
  assert.equal(body.cards.length, 1);
  assert.equal(body.done.length, 0);
  assert.equal(body.cards[0].items.find((i) => i.lineId === "o9-0").isAddOn, true);
  assert.equal(body.cards[0].doneCount, 1);
});

test("sort: rush -> dragged rank -> longest wait; rank beats wait", async () => {
  const { kitchen, redis } = setup();
  const at = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  await redis.set("orders", [
    { id: "a", table: 1, createdAt: at(20), items: [food] },
    { id: "b", table: 2, createdAt: at(10), items: [food] },
    { id: "c", table: 3, createdAt: at(5), items: [food] },
    { id: "d", table: 4, createdAt: at(1), items: [food] },
  ]);
  const k = (t) => `${t}|0`;
  let { body } = await call(kitchen, "GET");
  assert.deepEqual(body.cards.map((c) => c.table), [1, 2, 3, 4]);
  // drag table 3 first, table 2 second -> rank wins over wait time
  await call(kitchen, "POST", { action: "reorder", keys: [k(3), k(2)] });
  ({ body } = await call(kitchen, "GET"));
  assert.deepEqual(body.cards.map((c) => c.table), [3, 2, 1, 4]);
  // rush table 4 -> goes first, rank dropped for it
  await call(kitchen, "POST", { action: "rush", key: k(4), rush: true });
  ({ body } = await call(kitchen, "GET"));
  assert.deepEqual(body.cards.map((c) => c.table), [4, 3, 2, 1]);
  assert.equal(body.cards[0].rush, true);
});

test("bad input is rejected", async () => {
  const { kitchen } = setup();
  assert.equal((await call(kitchen, "POST", { action: "item-set", lineIds: [], st: "d" })).code, 400);
  assert.equal((await call(kitchen, "POST", { action: "item-set", lineIds: ["x"], st: "zzz" })).code, 400);
  assert.equal((await call(kitchen, "POST", { action: "nope" })).code, 400);
});
