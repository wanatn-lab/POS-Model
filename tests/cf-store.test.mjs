import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteStore } from "../src/sqlite-store.js";
import { fakeSql } from "./cf-helpers.mjs";

function makeStore() {
  const clock = { t: 1_000_000 };
  const store = new SqliteStore(fakeSql(), () => clock.t);
  return { store, clock };
}

test("get returns null for a missing key and round-trips arrays, objects and strings", async () => {
  const { store } = makeStore();
  assert.equal(await store.get("nope"), null);
  await store.set("orders", [{ id: "a", items: [{ name: "ชาเย็น", qty: 1 }] }]);
  await store.set("settings", { receipt: { shop: "จิ๊นโค" } });
  await store.set("shopSpecialOpen", "2026-10-12");
  assert.deepEqual(await store.get("orders"), [{ id: "a", items: [{ name: "ชาเย็น", qty: 1 }] }]);
  assert.deepEqual(await store.get("settings"), { receipt: { shop: "จิ๊นโค" } });
  assert.equal(await store.get("shopSpecialOpen"), "2026-10-12");
});

test("set overwrites, mget returns values in order (spread and array forms)", async () => {
  const { store } = makeStore();
  await store.set("a", 1);
  await store.set("a", 2);
  await store.set("b", { x: 1 });
  assert.deepEqual(await store.mget("a", "b", "c"), [2, { x: 1 }, null]);
  assert.deepEqual(await store.mget(["a", "c"]), [2, null]);
});

test("set with ex expires after the given seconds, and a plain set clears the expiry", async () => {
  const { store, clock } = makeStore();
  await store.set("shopSpecialOpen", "2026-10-12", { ex: 60 });
  clock.t += 59_000;
  assert.equal(await store.get("shopSpecialOpen"), "2026-10-12");
  clock.t += 2_000;
  assert.equal(await store.get("shopSpecialOpen"), null);
  await store.set("k", 1, { ex: 10 });
  await store.set("k", 2);
  clock.t += 3_600_000;
  assert.equal(await store.get("k"), 2);
});

test("del removes a key", async () => {
  const { store } = makeStore();
  await store.set("shopSpecialOpen", "2026-10-12", { ex: 600 });
  await store.del("shopSpecialOpen");
  assert.equal(await store.get("shopSpecialOpen"), null);
});

test("hash: hset merges fields, hgetall returns an object or null when empty", async () => {
  const { store } = makeStore();
  assert.equal(await store.hgetall("kitchen:items:2026-10-12"), null);
  await store.hset("kitchen:items:2026-10-12", { o1: { state: "cooking" } });
  await store.hset("kitchen:items:2026-10-12", { o2: true, o1: { state: "done" } });
  assert.deepEqual(await store.hgetall("kitchen:items:2026-10-12"), { o1: { state: "done" }, o2: true });
});

test("expire works on hashes and plain keys; expired hashes disappear and can be reused", async () => {
  const { store, clock } = makeStore();
  await store.hset("h", { a: 1 });
  assert.equal(await store.expire("h", 30), 1);
  assert.equal(await store.expire("missing", 30), 0);
  clock.t += 31_000;
  assert.equal(await store.hgetall("h"), null);
  await store.hset("h", { b: 2 });
  assert.deepEqual(await store.hgetall("h"), { b: 2 });
  await store.set("p", 1);
  await store.expire("p", 5);
  clock.t += 6_000;
  assert.equal(await store.get("p"), null);
});

test("exportAll then importAll into a fresh store reproduces everything (backup/migration path)", async () => {
  const { store } = makeStore();
  await store.set("orders", [{ id: "x" }]);
  await store.set("shopSpecialOpen", "2026-10-12", { ex: 3600 });
  await store.hset("rank", { a: 1 });
  await store.expire("rank", 3600);
  const { store: fresh } = makeStore();
  await fresh.importAll(store.exportAll());
  assert.deepEqual(await fresh.get("orders"), [{ id: "x" }]);
  assert.equal(await fresh.get("shopSpecialOpen"), "2026-10-12");
  assert.deepEqual(await fresh.hgetall("rank"), { a: 1 });
});
