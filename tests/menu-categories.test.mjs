import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, beforeEach } from "node:test";

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://example.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";

const { default: menuHandler } = await import("../api/menu.js");
const { normalizeCategories, orderedCategories, sortMenuByCategories } = await import("../api/_menu-categories.js");
const adminHtml = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = (b) => { res.body = b; return res; };
  return res;
}

let store;
beforeEach(() => {
  store = new Map();
  globalThis.__shopStore = {
    get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : null),
    set: async (k, v) => { store.set(k, structuredClone(v)); },
  };
});

const call = async (method, body, query) => {
  const res = fakeRes();
  await menuHandler({ method, body, query }, res);
  return res;
};

const items = [
  { id: "a", name: "A", category: "ข้าว" },
  { id: "b", name: "B", category: "เครื่องดื่ม" },
  { id: "c", name: "C", category: "ข้าว" },
  { id: "d", name: "D", category: "" },
];

test("normalizeCategories trims, drops empty and duplicate names", () => {
  assert.deepEqual(normalizeCategories([" ข้าว ", "", "ข้าว", "ของหวาน", null]), ["ข้าว", "ของหวาน"]);
  assert.equal(normalizeCategories("x"), null);
});

test("orderedCategories keeps stored order and appends categories used by items", () => {
  assert.deepEqual(orderedCategories(items, ["เครื่องดื่ม", "ว่าง"]), ["เครื่องดื่ม", "ว่าง", "ข้าว"]);
});

test("sortMenuByCategories is stable and puts uncategorised items last", () => {
  const out = sortMenuByCategories(items, ["เครื่องดื่ม", "ข้าว"]).map((i) => i.id);
  assert.deepEqual(out, ["b", "a", "c", "d"]);
});

test("GET without a stored category list returns the menu array unchanged", async () => {
  store.set("menu", items);
  const res = await call("GET", undefined, {});
  assert.deepEqual(res.body.map((i) => i.id), ["a", "b", "c", "d"]);
});

test("POST {menu, categories} saves order, keeps empty categories and sorts items", async () => {
  const res = await call("POST", { menu: items, categories: ["เครื่องดื่ม", "ของหวาน", "ข้าว"] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(store.get("menuCategories"), ["เครื่องดื่ม", "ของหวาน", "ข้าว"]);
  assert.deepEqual(store.get("menu").map((i) => i.id), ["b", "a", "c", "d"]);

  const admin = await call("GET", undefined, { include: "categories" });
  assert.deepEqual(admin.body.categories, ["เครื่องดื่ม", "ของหวาน", "ข้าว"]);
  const customer = await call("GET", undefined, {});
  assert.ok(Array.isArray(customer.body));
  assert.deepEqual(customer.body.map((i) => i.id), ["b", "a", "c", "d"]);
});

test("a category used by an item is never dropped from the saved list", async () => {
  await call("POST", { menu: items, categories: ["เครื่องดื่ม"] });
  assert.deepEqual(store.get("menuCategories"), ["เครื่องดื่ม", "ข้าว"]);
});

test("legacy bare-array POST still works and leaves categories untouched", async () => {
  store.set("menuCategories", ["ข้าว"]);
  const res = await call("POST", items);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(store.get("menuCategories"), ["ข้าว"]);
});

test("POST rejects non-array categories and bad bodies", async () => {
  assert.equal((await call("POST", { menu: items, categories: "x" })).statusCode, 400);
  assert.equal((await call("POST", { foo: 1 })).statusCode, 400);
});

test("admin page wires add, delete, reorder and saves the category list", () => {
  assert.match(adminHtml, /function addCategory\(/);
  assert.match(adminHtml, /function deleteCategory\(/);
  assert.match(adminHtml, /function moveCategory\(/);
  assert.match(adminHtml, /id="newCategoryName"/);
  assert.match(adminHtml, /\/api\/menu\?include=categories/);
  assert.match(adminHtml, /categories: menuCategories\(\)/);
  // deleting a category that still has items asks first, then keeps the items with no category
  assert.match(adminHtml, /count > 0 && !confirm\(/);
  assert.match(adminHtml, /it\.category = ''; delete it\.categoryEn;/);
});

test("customer page keeps items without a category visible under an Other group", async () => {
  const orderHtml = await readFile(new URL("../public/order.html", import.meta.url), "utf8");
  assert.match(orderHtml, /hasUncategorised \? \[\.\.\.cats, ''\] : cats/);
  assert.match(orderHtml, /otherCat: 'อื่น ๆ'/);
  assert.match(orderHtml, /otherCat: 'Other'/);
  assert.match(orderHtml, /t\('otherCat'\)/);
});
