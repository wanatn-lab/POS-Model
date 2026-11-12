import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrdersHandler } from "../api/orders.js";

const MENU = [
  {
    id: "m1", name: "กะเพราหมู", price: 59, category: "จานเดียว",
    optionGroups: [
      { id: "sp", name: "ความเผ็ด", type: "single", required: true, options: [{ id: "s1", name: "เผ็ดน้อย", priceDelta: 0 }, { id: "s2", name: "เผ็ดกลาง", priceDelta: 0 }] },
      { id: "ex", name: "เพิ่มเติม", type: "multi", required: false, options: [{ id: "egg", name: "ไข่ดาว", priceDelta: 10 }, { id: "rice", name: "ข้าวเพิ่ม", priceDelta: 10 }] },
    ],
  },
  { id: "m2", name: "น้ำเปล่า", price: 10 },
  { id: "m3", name: "ชาเย็น", price: 35, available: false },
];

function shop() {
  const values = new Map([["menu", structuredClone(MENU)], ["orders", []]]);
  const redis = { async get(k) { return structuredClone(values.get(k)); }, async set(k, v) { values.set(k, structuredClone(v)); } };
  const handler = createOrdersHandler({ redis, bell: async () => {} });
  const post = async (body) => {
    const res = { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    await handler({ method: "POST", body }, res);
    return res;
  };
  return { post, orders: () => values.get("orders") };
}

test("server prices the order: a price or name sent by the client is ignored", async () => {
  const s = shop();
  const r = await s.post({ table: 3, items: [{ menuId: "m2", qty: 2, price: 1, name: "ฟรี" }] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.order.items[0].price, 10);
  assert.equal(r.body.order.items[0].name, "น้ำเปล่า");
});

test("selected option price is added on the server and snapshotted into the order", async () => {
  const s = shop();
  const r = await s.post({ table: 3, items: [{ menuId: "m1", qty: 1, optionIds: ["s2", "egg"] }] });
  assert.equal(r.statusCode, 200);
  const item = r.body.order.items[0];
  assert.equal(item.price, 69);
  assert.equal(item.name, "กะเพราหมู (เผ็ดกลาง, ไข่ดาว)");
  assert.equal(item.baseName, "กะเพราหมู");
  assert.deepEqual(item.options.map((o) => o.name), ["เผ็ดกลาง", "ไข่ดาว"]);
});

test("rejected: required group missing, two choices in a single group, unknown option, option of another menu", async () => {
  const s = shop();
  for (const [optionIds, why] of [[[], "missing required"], [["s1", "s2"], "two in single"], [["s1", "zzz"], "unknown"], [["s1", "egg", "egg"], "duplicate"]]) {
    const r = await s.post({ table: 3, items: [{ menuId: "m1", qty: 1, optionIds }] });
    assert.equal(r.statusCode, 400, why);
  }
  const other = await s.post({ table: 3, items: [{ menuId: "m2", qty: 1, optionIds: ["egg"] }] });
  assert.equal(other.statusCode, 400);
  assert.equal(s.orders().length, 0);
});

test("rejected: unknown menu id, sold out, bad quantity", async () => {
  const s = shop();
  assert.equal((await s.post({ table: 3, items: [{ menuId: "nope", qty: 1 }] })).statusCode, 400);
  assert.equal((await s.post({ table: 3, items: [{ menuId: "m3", qty: 1 }] })).statusCode, 400);
  for (const qty of [0, -1, 1.5, 100, "x"]) {
    assert.equal((await s.post({ table: 3, items: [{ menuId: "m2", qty }] })).statusCode, 400, String(qty));
  }
});

test("same idempotencyKey twice -> one order; a different table does not collide", async () => {
  const s = shop();
  const body = { table: 3, idempotencyKey: "order-pricing-key-001", items: [{ menuId: "m2", qty: 1 }] };
  const a = await s.post(body);
  const b = await s.post(body);
  assert.equal(b.body.order.id, a.body.order.id);
  assert.equal(b.body.idempotent, true);
  assert.equal(s.orders().length, 1);
  await s.post({ ...body, table: 4 });
  assert.equal(s.orders().length, 2);
});

test("old price edits do not change an order that already exists", async () => {
  const s = shop();
  const a = await s.post({ table: 3, items: [{ menuId: "m1", qty: 1, optionIds: ["s1", "egg"] }] });
  assert.equal(s.orders()[0].items[0].price, 69);
  assert.equal(a.body.order.items[0].options[1].priceDelta, 10);
});

import { optionGroupsError } from "../api/menu.js";

test("menu save refuses broken option groups and accepts good ones", () => {
  assert.equal(optionGroupsError(MENU), "");
  const bad = (mutate) => { const m = structuredClone(MENU); mutate(m[0]); return optionGroupsError(m); };
  assert.ok(bad((i) => { i.optionGroups[0].type = "radio"; }));
  assert.ok(bad((i) => { i.optionGroups[0].name = " "; }));
  assert.ok(bad((i) => { i.optionGroups[0].options = []; }));
  assert.ok(bad((i) => { i.optionGroups[0].options[0].priceDelta = -5; }));
  assert.ok(bad((i) => { i.optionGroups[0].options[0].priceDelta = 1.5; }));
  assert.ok(bad((i) => { i.optionGroups[1].options[0].id = "s1"; })); // duplicated option id across groups
  assert.ok(bad((i) => { i.optionGroups = "x"; }));
});
