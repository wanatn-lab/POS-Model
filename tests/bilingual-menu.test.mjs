import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://example.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";

const orderHtml = await readFile(new URL("../public/order.html", import.meta.url), "utf8");
const adminHtml = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");

// ---------- /api/menu keeps the English fields and the old fields ----------
const { default: menuHandler } = await import("../api/menu.js");
const { default: settingsHandler } = await import("../api/settings.js");

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = (b) => { res.body = b; return res; };
  return res;
}

function useFakeStore() {
  const data = new Map();
  globalThis.__shopStore = {
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : null),
    set: async (k, v) => { data.set(k, structuredClone(v)); },
  };
  return data;
}

const MENU = [
  { id: "a1", name: "ข้าวซอย", price: 80, category: "จานเส้น", desc: "น้ำแกงเข้มข้น", image: "https://res.cloudinary.com/thongyoi/image/upload/v1/menu/khao-soi.webp", available: true, mustTry: true,
    nameEn: "Khao Soi", descEn: "Rich curry noodle soup", categoryEn: "Noodles" },
  { id: "a2", name: "ไก่ทอด", price: 90, category: "ของทอด", desc: "กรอบนอกนุ่มใน", image: "", available: true },
];

test("menu API stores and returns English fields without touching the old ones", async () => {
  useFakeStore();
  let res = fakeRes();
  await menuHandler({ method: "POST", body: MENU }, res);
  assert.equal(res.statusCode, 200);
  res = fakeRes();
  await menuHandler({ method: "GET" }, res);
  assert.deepEqual(res.body, MENU);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[1].nameEn, undefined); // item with no English still round-trips
  assert.equal(res.body[0].image, "https://res.cloudinary.com/thongyoi/image/upload/v1/menu/khao-soi.webp");
});

test("sold-out toggle keeps the English fields", async () => {
  useFakeStore();
  await menuHandler({ method: "POST", body: MENU }, fakeRes());
  let res = fakeRes();
  await menuHandler({ method: "POST", body: { action: "set-availability", id: "a1", available: false } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.item.nameEn, "Khao Soi");
  assert.equal(res.body.item.available, false);
  res = fakeRes();
  await menuHandler({ method: "GET" }, res);
  assert.equal(res.body[0].descEn, "Rich curry noodle soup");
  assert.equal(res.body[0].name, "ข้าวซอย");
});

// ---------- customer page: language helpers (run the real code from order.html) ----------
function loadOrderHelpers({ stored, storageThrows = false, language = "th-TH", menu = [] } = {}) {
  const start = orderHtml.indexOf("// ---------- language (TH | EN) ----------");
  const end = orderHtml.indexOf("function applyLang()");
  assert.ok(start > 0 && end > start, "language block not found");
  const sandbox = {
    TABLE: "5",
    MENU: menu,
    navigator: { language },
    localStorage: {
      getItem: () => { if (storageThrows) throw new Error("blocked"); return stored ?? null; },
      setItem: () => { if (storageThrows) throw new Error("blocked"); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    orderHtml.slice(start, end) + "\nfunction applyLang() {}\nthis.api = { t, itemName, itemDesc, catLabel, displayName, detectLang, setLang, lang: () => LANG };",
    sandbox
  );
  return sandbox.api;
}

test("EN mode shows English when present and falls back to Thai when empty", () => {
  const api = loadOrderHelpers({ stored: "en", menu: MENU });
  assert.equal(api.lang(), "en");
  assert.equal(api.itemName(MENU[0]), "Khao Soi");
  assert.equal(api.itemDesc(MENU[0]), "Rich curry noodle soup");
  assert.doesNotMatch(orderHtml, /name-th/); // EN mode shows no Thai sub-line under the English name
  assert.equal(api.itemName(MENU[1]), "ไก่ทอด");
  assert.equal(api.itemDesc(MENU[1]), "กรอบนอกนุ่มใน");
  assert.equal(api.catLabel("จานเส้น"), "Noodles");
  assert.equal(api.catLabel("ของทอด"), "ของทอด");
  assert.equal(api.displayName("a1", "ข้าวซอย"), "Khao Soi");
  assert.equal(api.displayName("gone", "เมนูเก่า"), "เมนูเก่า");
});

test("TH mode never shows English, even when it exists", () => {
  const api = loadOrderHelpers({ stored: "th", menu: MENU });
  assert.equal(api.itemName(MENU[0]), "ข้าวซอย");
  assert.equal(api.itemDesc(MENU[0]), "น้ำแกงเข้มข้น");
  assert.equal(api.catLabel("จานเส้น"), "จานเส้น");
  assert.equal(api.t("submit"), "ส่งออเดอร์เข้าครัว 🍳");
});

test("first visit follows the phone language; blocked storage means Thai", () => {
  assert.equal(loadOrderHelpers({ language: "en-US" }).lang(), "en");
  assert.equal(loadOrderHelpers({ language: "ja-JP" }).lang(), "en");
  assert.equal(loadOrderHelpers({ language: "th-TH" }).lang(), "th");
  assert.equal(loadOrderHelpers({ storageThrows: true, language: "en-US" }).lang(), "th");
  assert.equal(loadOrderHelpers({ stored: "th", language: "en-US" }).lang(), "th"); // saved choice wins
  assert.doesNotThrow(() => loadOrderHelpers({ storageThrows: true }).setLang("en"));
});

test("every UI text exists in both languages", () => {
  const api = loadOrderHelpers({ stored: "th" });
  const keys = [...orderHtml.matchAll(/data-i18n(?:-ph|-aria)?="(\w+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 15);
  for (const key of keys) {
    assert.ok(api.t(key), `th missing: ${key}`);
  }
  const en = loadOrderHelpers({ stored: "en" });
  for (const key of keys) {
    assert.notEqual(en.t(key), api.t(key), `en missing or identical: ${key}`);
  }
});

test("orders keep sending the Thai item name to the kitchen", () => {
  assert.match(orderHtml, /return item \? \{ id, name: item\.name, price: item\.price, category: item\.category \|\| '', qty \} : null;/);
  assert.doesNotMatch(orderHtml, /name: itemName\(/);
});

// ---------- admin page ----------
test("admin form has English fields next to the Thai ones and saves them", () => {
  assert.match(adminHtml, /MENU\[\$\{i\}\]\.nameEn = this\.value/);
  assert.match(adminHtml, /MENU\[\$\{i\}\]\.descEn = this\.value/);
  assert.match(adminHtml, /id="menuEnSummary"/);
  assert.match(adminHtml, /id="categoryManager"/);
  assert.match(adminHtml, /setCategoryEnByName\(this\.dataset\.cat, this\.value\)/);
  assert.match(adminHtml, /onCategoryRename\(this\)/);
  // old fields are still edited exactly as before
  assert.match(adminHtml, /oninput="MENU\[\$\{i\}\]\.name = this\.value"/);
  assert.match(adminHtml, /oninput="MENU\[\$\{i\}\]\.price = Number\(this\.value\)"/);
  // saveMenu still posts the whole item objects (English fields ride along)
  assert.match(adminHtml, /const \{ must_try, \.\.\.normalised \} = item;/);
});

function loadAdminHelpers() {
  const start = adminHtml.indexOf("// ---------- English menu text");
  const end = adminHtml.indexOf("function renderList() {");
  assert.ok(start > 0 && end > start);
  const sandbox = {
    MENU: [],
    adminMenuCategoryFilter: null,
    document: { getElementById: () => null },
    escAttr: (v) => String(v),
    menuCategories: () => [...new Set(sandbox.MENU.map((i) => (i.category || "").trim()).filter(Boolean))],
  };
  vm.createContext(sandbox);
  vm.runInContext(
    adminHtml.slice(start, end) +
      "\nthis.api = { isEnComplete, categoryEnOf, setCategoryEnByName, renameCategory, getFilter: () => adminMenuCategoryFilter };",
    sandbox
  );
  return { sandbox, api: sandbox.api };
}

test("admin completeness rule", () => {
  const { api } = loadAdminHelpers();
  assert.equal(api.isEnComplete({ name: "ก", desc: "ข", nameEn: "A", descEn: "B" }), true);
  assert.equal(api.isEnComplete({ name: "ก", desc: "ข", nameEn: "A" }), false);
  assert.equal(api.isEnComplete({ name: "ก", desc: "", nameEn: "A" }), true); // no Thai description to translate
  assert.equal(api.isEnComplete({ name: "ก", desc: "ข" }), false);
  assert.equal(api.isEnComplete({ name: "ก", desc: "ข", nameEn: "  ", descEn: "B" }), false);
});

test("category manager: English name applies to every item in the category", () => {
  const { sandbox, api } = loadAdminHelpers();
  sandbox.MENU = [{ category: "จานเส้น" }, { category: " จานเส้น " }, { category: "ของทอด" }];
  api.setCategoryEnByName("จานเส้น", "Noodles");
  assert.deepEqual(sandbox.MENU.map((m) => m.categoryEn), ["Noodles", "Noodles", undefined]);
  assert.equal(api.categoryEnOf("จานเส้น"), "Noodles");
  assert.equal(api.categoryEnOf("ของทอด"), "");
});

test("category manager: renaming the Thai name moves every item and keeps English", () => {
  const { sandbox, api } = loadAdminHelpers();
  sandbox.MENU = [
    { category: "ของทอด", categoryEn: "Fried" },
    { category: "ของทอด", categoryEn: "Fried" },
    { category: "เครื่องดื่ม" },
  ];
  sandbox.adminMenuCategoryFilter = "ของทอด";
  const res = api.renameCategory("ของทอด", "  ทอดกรอบ ");
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.deepEqual(sandbox.MENU.map((m) => m.category), ["ทอดกรอบ", "ทอดกรอบ", "เครื่องดื่ม"]);
  assert.equal(api.categoryEnOf("ทอดกรอบ"), "Fried");
  assert.equal(api.getFilter(), "ทอดกรอบ");
  assert.equal(api.renameCategory("ทอดกรอบ", "ทอดกรอบ").changed, false);
  assert.equal(api.renameCategory("ทอดกรอบ", "   ").ok, false);
  assert.equal(api.renameCategory("ทอดกรอบ", "เครื่องดื่ม").reason, "exists");
  assert.deepEqual(sandbox.MENU.map((m) => m.category), ["ทอดกรอบ", "ทอดกรอบ", "เครื่องดื่ม"]);
});

// ---------- shop name in English + existing settings stay intact ----------
test("saving the English shop name keeps every other setting", async () => {
  const data = useFakeStore();
  const existing = {
    tableCount: 12, shopName: "จิ๊นโค", paperWidthMm: 58,
    printers: [{ id: "p1", name: "ครัว" }],
    receipt: { footer: "ขอบคุณครับ" }, kitchen: { groupByCategory: true },
    cloudinary: { cloudName: "demo", uploadPreset: "thongyoi_unsigned", folder: "thongyoi_menu" },
  };
  data.set("settings", structuredClone(existing));
  let res = fakeRes();
  await settingsHandler({ method: "POST", body: { shopNameEn: "Jinko" } }, res);
  assert.equal(res.statusCode, 200);
  res = fakeRes();
  await settingsHandler({ method: "GET" }, res);
  assert.deepEqual(res.body, { ...existing, shopNameEn: "Jinko" });
});

test("receipt settings and menu saves leave the saved Cloudinary config intact", async () => {
  const data = useFakeStore();
  const cloudinary = { cloudName: "demo", uploadPreset: "thongyoi_unsigned", folder: "existing_menu_folder" };
  data.set("settings", {
    tableCount: 12, shopName: "ทองย้อย", paperWidthMm: 80,
    cloudinary, receipt: { logoUrl: "" }, kitchen: {}, cashDrawer: { enabled: false },
  });

  let res = fakeRes();
  await settingsHandler({ method: "POST", body: {
    shopName: "ทองย้อย", paperWidthMm: 58, receipt: { logoUrl: "https://res.cloudinary.com/thongyoi/image/upload/v1/logo.webp" },
    kitchen: { fontSize: "normal" }, cashDrawer: { enabled: false, openWhen: "after", pulsePin: 0, onTime: 25, offTime: 125 },
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.settings.cloudinary, cloudinary);

  res = fakeRes();
  await menuHandler({ method: "POST", body: { menu: MENU, categories: ["จานเส้น", "ของทอด"] } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual((await globalThis.__shopStore.get("settings")).cloudinary, cloudinary);
});

test("saving Cloudinary keeps its connection values and unrelated settings", async () => {
  const data = useFakeStore();
  data.set("settings", {
    tableCount: 16, shopName: "ทองย้อย", paperWidthMm: 80,
    cloudinary: { cloudName: "old-cloud", uploadPreset: "old-preset", folder: "menujk_up" },
    receipt: { footer: "ขอบคุณครับ" }, kitchen: { groupByCategory: true },
  });
  const res = fakeRes();
  await settingsHandler({ method: "POST", body: {
    cloudinary: { cloudName: "thongyoi", uploadPreset: "thongyoi_unsigned", folder: "thongyoi_menu" },
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.settings.cloudinary, {
    cloudName: "thongyoi", uploadPreset: "thongyoi_unsigned", folder: "thongyoi_menu",
  });
  assert.equal(res.body.settings.tableCount, 16);
  assert.deepEqual(res.body.settings.receipt, { footer: "ขอบคุณครับ" });
  assert.deepEqual(res.body.settings.kitchen, { groupByCategory: true });
});

test("order page shows the English shop name only in EN mode, Thai otherwise", () => {
  assert.match(orderHtml, /shopNameEn = settings\.shopNameEn \|\| '';/);
  assert.match(orderHtml, /LANG === 'en' && hasText\(shopNameEn\) \? String\(shopNameEn\)\.trim\(\) : shopName/);
  assert.match(adminHtml, /id="shopNameEn"/);
  assert.match(adminHtml, /shopNameEn: document\.getElementById\('shopNameEn'\)\.value/);
});

test("customer menu renders a Cloudinary image URL without stripping it", () => {
  assert.match(orderHtml, /<img src="\$\{escAttr\(item\.image\)\}"/);
  assert.match(orderHtml, /menuDetailImage\.src = item\.image \|\| '';/);
});
