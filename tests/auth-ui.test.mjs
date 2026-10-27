// Browser-side regression tests. The pages' real scripts (public/auth-gate.js and the inline
// scripts of public/counter-print.html) are executed in a Node vm with a small fake DOM, and
// their fetch() is wired to the real router, so what is tested is the actual page behaviour
// against the actual server rules.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { handleApiRequest } from "../src/api-router.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { fakeSql } from "./cf-helpers.mjs";

const ORIGIN = "https://shop.example";
const ENV = {
  SESSION_SECRET: "session-secret-for-tests-0123456789abcdef",
  OWNER_PASSWORD: "owner-password-123",
  STAFF_PASSWORD: "staff-password-123",
};
const readPublic = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const reply = (status, body = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// fetch() as a browser page would call it: same-origin, relative URLs, cookies from a jar.
// `overrides` lets a test make one endpoint answer something specific ("METHOD /path" -> handler).
function pageFetch({ store, env, jar, overrides, log }) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
    const method = (init.method || "GET").toUpperCase();
    log.push(`${method} ${url.pathname}`);
    const override = overrides[`${method} ${url.pathname}`];
    if (override) return override(init);
    const headers = { "content-type": "application/json", origin: ORIGIN, ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(init.headers || {}) };
    return handleApiRequest(new Request(url, { method, headers, body: init.body }), { store, env });
  };
}

async function newShop({ env = {}, loginAs, seedOrders = [] } = {}) {
  const store = new SqliteStore(fakeSql());
  const fullEnv = { ...ENV, ...env };
  const jar = {};
  if (loginAs) {
    const password = loginAs === "owner" ? ENV.OWNER_PASSWORD : ENV.STAFF_PASSWORD;
    const response = await handleApiRequest(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ role: loginAs, password }),
      }),
      { store, env: fullEnv },
    );
    assert.equal(response.status, 200);
    jar.cookie = response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  }
  for (const order of seedOrders) {
    // seeded with the rules switched off, as an old order that already exists in the shop
    await handleApiRequest(
      new Request(`${ORIGIN}/api/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order) }),
      { store, env: { ...fullEnv, AUTH_MODE: "off" } },
    );
  }
  return { store, env: fullEnv, jar };
}

function makeElement(tag) {
  const element = {
    tag,
    style: {},
    children: [],
    dataset: {},
    listeners: {},
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      element.listeners[type] = fn;
    },
    querySelector: () => makeElement("child"),
    querySelectorAll: () => [],
    setAttribute() {},
    remove() {},
  };
  return element;
}

// ---------------------------------------------------------------------------------------------
// Issue 2: the login gate (admin.html / table-status.html)

const GATE_SOURCE = await readPublic("auth-gate.js");

async function openGate(options = {}) {
  const shop = await newShop(options);
  const log = [];
  const overlays = [];
  const document = { body: { appendChild: (node) => overlays.push(node) }, createElement: makeElement, addEventListener() {} };
  const location = { href: `${ORIGIN}/admin`, origin: ORIGIN, reload() {} };
  const window = { fetch: pageFetch({ ...shop, overrides: options.overrides || {}, log }) };
  vm.runInNewContext(GATE_SOURCE, { window, document, location, URL, Promise, JSON }, { filename: "auth-gate.js" });
  await settle();
  return {
    window,
    log,
    visible: () => overlays.length > 0 && overlays[0].style.display === "flex",
    message: () => overlays[0].children[0].children[1].textContent, // overlay > card > [title, message, ...]
    overlays,
  };
}

test("login gate: AUTH_MODE=off opens the admin pages as before, with no login box", async () => {
  const gate = await openGate({ env: { AUTH_MODE: "off" } });
  assert.ok(gate.log.includes("GET /api/auth/me"));
  assert.equal(gate.overlays.length, 0);
  for (const path of ["/api/table-status", "/api/orders", "/api/bill-history", "/api/settings"]) {
    assert.equal((await gate.window.fetch(path)).status, 200, path);
  }
  assert.equal(gate.overlays.length, 0); // still nothing: no protected request failed
});

test("login gate: AUTH_MODE=log does not force a login box either", async () => {
  const gate = await openGate({ env: { AUTH_MODE: "log" } });
  assert.equal(gate.overlays.length, 0);
  assert.equal((await gate.window.fetch("/api/table-status")).status, 200);
  assert.equal(gate.overlays.length, 0);
});

test("login gate: when enforcement is active a signed-out page asks for a login straight away", async () => {
  for (const env of [{}, { AUTH_MODE: "enforce" }, { AUTH_MODE: "something-unknown" }]) {
    const gate = await openGate({ env });
    assert.equal(gate.visible(), true, JSON.stringify(env));
    assert.match(gate.message(), /กรุณาเข้าสู่ระบบ/);
  }
});

test("login gate: a signed-in staff member is not interrupted, until an owner-only action says 403", async () => {
  const gate = await openGate({ loginAs: "staff" });
  assert.equal(gate.overlays.length, 0);
  assert.equal((await gate.window.fetch("/api/table-status")).status, 200);
  assert.equal(gate.overlays.length, 0);

  const refused = await gate.window.fetch("/api/menu", { method: "POST", body: "[]" });
  assert.equal(refused.status, 403);
  assert.equal(gate.visible(), true);
  assert.match(gate.message(), /เจ้าของ/);
});

test("login gate: even with enforcement off, a protected request that really returns 401 or 403 shows the box", async () => {
  const gate = await openGate({
    env: { AUTH_MODE: "off" },
    overrides: {
      "GET /api/orders": () => reply(401),
      "GET /api/bill-history": () => reply(403),
    },
  });
  assert.equal(gate.overlays.length, 0);
  await gate.window.fetch("/api/orders");
  assert.equal(gate.visible(), true);
  assert.match(gate.message(), /กรุณาเข้าสู่ระบบ/);
  await gate.window.fetch("/api/bill-history");
  assert.match(gate.message(), /เจ้าของ/);
});

test("login gate: failed logins and other sites' URLs never trigger the box", async () => {
  const gate = await openGate({
    env: { AUTH_MODE: "off" },
    overrides: { "POST /api/auth/login": () => reply(401), "GET /api/elsewhere": () => reply(401) },
  });
  await gate.window.fetch("/api/auth/login", { method: "POST", body: "{}" });
  await gate.window.fetch("https://other.example/api/elsewhere");
  assert.equal(gate.overlays.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Issue 3: public/counter-print.html

const COUNTER_PAGE = await readPublic("counter-print.html");
const COUNTER_SCRIPTS = [...COUNTER_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

async function openCounter({ printer = false, ...options } = {}) {
  const shop = await newShop(options);
  const log = [];
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const intervals = [];
  const unrefTimeout = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  };
  const window = { isShopOpen: () => true };
  if (printer) {
    // a printer that always connects and accepts every call
    window.IminPrinter = function IminPrinter() {
      const methods = { connect: () => Promise.resolve(true) };
      return new Proxy(methods, { get: (target, name) => (name === "then" ? undefined : name in target ? target[name] : () => {}) });
    };
  }
  const sandbox = {
    window,
    document: { getElementById: el, createElement: makeElement, querySelector: () => makeElement("q"), querySelectorAll: () => [], body: makeElement("body") },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: pageFetch({ ...shop, overrides: options.overrides || {}, log }),
    console: { log() {}, error() {}, warn() {}, info() {} },
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      if (timer) timer.cleared = true;
    },
    setTimeout: unrefTimeout,
    clearTimeout,
    URL,
  };
  const context = vm.createContext(sandbox);
  COUNTER_SCRIPTS.forEach((code, index) => vm.runInContext(code, context, { filename: `counter-print-${index}.js` }));
  await settle();
  return {
    el,
    log,
    env: shop.env,
    run: (code) => vm.runInContext(code, context),
    running: () => intervals.filter((timer) => !timer.cleared),
    count: (request) => log.filter((line) => line === request).length,
  };
}

function assertStoppedWithThaiMessage(page, status) {
  const banner = page.el("authBanner");
  assert.equal(banner.style.display, "block", "the Thai explanation must be visible");
  assert.match(banner.textContent, /ไม่มีสิทธิ์เข้าถึงข้อมูล/);
  assert.match(banner.textContent, /รหัสประจำเครื่องพิมพ์/);
  assert.ok(banner.textContent.includes(`HTTP ${status}`), banner.textContent);
  assert.match(page.el("lastSync").textContent, /หยุดซิงก์/);
  assert.equal(page.el("loadingNote").style.display, "none");
  assert.equal(page.running().length, 0, "no polling timer may be left running");
}

async function assertNoFurtherRequests(page) {
  const before = page.log.length;
  await page.run("pollOrders()");
  page.run("restartPolling()");
  await page.el("checkQrBtn").listeners.click();
  await settle();
  assert.equal(page.log.length, before, "a blocked page must not call the API again");
  assert.equal(page.running().length, 0);
}

test("counter-print: enforcement on and no credential -> Thai message, polling stopped, no retries", async () => {
  assert.equal(COUNTER_SCRIPTS.length, 2);
  const page = await openCounter(); // default mode is enforce
  assertStoppedWithThaiMessage(page, 401);
  // whichever queue is refused first stops the page; neither is asked more than once
  assert.ok(page.count("GET /api/orders") <= 1);
  assert.ok(page.count("GET /api/qr-print-jobs") <= 1);
  await assertNoFurtherRequests(page);
});

test("counter-print: a 403 on the orders queue is handled the same way", async () => {
  const page = await openCounter({ env: { AUTH_MODE: "off" }, overrides: { "GET /api/orders": () => reply(403) } });
  assertStoppedWithThaiMessage(page, 403);
  await assertNoFurtherRequests(page);
});

test("counter-print: a 401 on the settings request is handled", async () => {
  const page = await openCounter({ env: { AUTH_MODE: "off" }, overrides: { "GET /api/settings": () => reply(401) } });
  assertStoppedWithThaiMessage(page, 401);
  await assertNoFurtherRequests(page);
});

test("counter-print: orders allowed but the QR queue refuses (401) -> still stops cleanly", async () => {
  const page = await openCounter({ env: { AUTH_MODE: "off" }, overrides: { "GET /api/qr-print-jobs": () => reply(401) } });
  assertStoppedWithThaiMessage(page, 401);
  await assertNoFurtherRequests(page);
});

test("counter-print: a QR job printed but not acknowledged (401 on complete) stops cleanly and does not loop", async () => {
  const job = { id: "q1", table: 3, url: `${ORIGIN}/order?table=3` };
  const page = await openCounter({
    printer: true,
    env: { AUTH_MODE: "off" },
    overrides: { "GET /api/qr-print-jobs": () => reply(200, { jobs: [job] }), "POST /api/qr-print-jobs": () => reply(401) },
  });
  assertStoppedWithThaiMessage(page, 401);
  assert.equal(page.count("POST /api/qr-print-jobs"), 1);
  await assertNoFurtherRequests(page);
});

test("counter-print: a signed-in staff browser still can not use it (the QR queue is device-only) and says so", async () => {
  const page = await openCounter({ loginAs: "staff" });
  assertStoppedWithThaiMessage(page, 403);
  await assertNoFurtherRequests(page);
});

test("counter-print: with enforcement off the page works as before (queue shown, polling running, no message)", async () => {
  const drink = { id: "m3", name: "ชาเย็น", price: 35, category: "เครื่องดื่ม", qty: 1 };
  const page = await openCounter({ env: { AUTH_MODE: "off" }, seedOrders: [{ table: 2, items: [drink] }] });
  assert.notEqual(page.el("authBanner").style.display, "block");
  assert.equal(String(page.el("queueCount").textContent), "1");
  assert.match(page.el("lastSync").textContent, /ซิงก์ล่าสุด/);
  assert.equal(page.running().length, 1);
  assert.ok(page.running()[0].ms >= 20_000);
});

test("counter-print: a page that was working and then gets refused (rules switched on while it is open) stops its running timer", async () => {
  const page = await openCounter({ env: { AUTH_MODE: "off" } });
  assert.equal(page.running().length, 1); // healthy: polling every 20 s or more
  assert.notEqual(page.el("authBanner").style.display, "block");

  page.env.AUTH_MODE = "enforce"; // the owner turns enforcement on
  await page.running()[0].fn(); // the next scheduled poll fires
  await settle();
  assertStoppedWithThaiMessage(page, 401);
  await assertNoFurtherRequests(page);
});

test("counter-print: an orders reply that arrives after the page was already refused does not undo the stop message", async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const page = await openCounter({
    env: { AUTH_MODE: "off" },
    overrides: {
      "GET /api/qr-print-jobs": async () => (await wait(120), reply(401)), // refused first ...
      "GET /api/orders": async () => (await wait(300), reply(200, [])), // ... while this one is still in flight
    },
  });
  await wait(450); // let the late orders reply arrive
  assertStoppedWithThaiMessage(page, 401);
  assert.equal(page.count("GET /api/orders"), 1);
});
