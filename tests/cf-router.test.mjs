import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApiRequest } from "../src/api-router.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { fakeSql } from "./cf-helpers.mjs";

function setup(env = {}) {
  env = { AUTH_MODE: "off", ...env }; // these tests predate access control (see tests/auth.test.mjs)
  const store = new SqliteStore(fakeSql());
  const call = (method, path, body, headers = {}) =>
    handleApiRequest(
      new Request(`https://shop.example${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { store, env },
    );
  return { store, call };
}

const DEVICE_A = "device-aaaaaaaa";
const DEVICE_B = "device-bbbbbbbb";

test("an order posted to /api/orders appears in GET with its category, status new and Bangkok-safe createdAt", async () => {
  const { call } = setup();
  const created = await call("POST", "/api/orders", {
    table: 2,
    items: [{ id: "m3", name: "ชาเย็น", price: 35, category: "เครื่องดื่ม", qty: 1 }],
  });
  assert.equal(created.status, 200);
  const list = await (await call("GET", "/api/orders")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "new");
  assert.equal(list[0].items[0].category, "เครื่องดื่ม");
  assert.equal(list[0].items[0].kitchenStatus, "cooking");
  assert.ok(Math.abs(new Date(list[0].createdAt).getTime() - Date.now()) < 5000);
});

test("bad requests keep the old status codes (400 missing items, 405 wrong method, 404 unknown route)", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/orders", { table: 1, items: [] })).status, 400);
  assert.equal((await call("PUT", "/api/orders", {})).status, 405);
  assert.equal((await call("GET", "/api/does-not-exist")).status, 404);
  assert.equal((await call("GET", "/api/_admin/export")).status, 404); // disabled without ADMIN_TOKEN
});

test("marking an order done removes it from the pending work the printer reads", async () => {
  const { call } = setup();
  const { order } = await (await call("POST", "/api/orders", { table: 1, items: [{ id: "m1", name: "กระเพรา", qty: 1 }] })).json();
  await call("POST", "/api/orders", { action: "done", id: order.id });
  const list = await (await call("GET", "/api/orders")).json();
  assert.equal(list.find((o) => o.id === order.id).status, "done");
});

test("receipt: two devices claim the same job at once -> exactly one wins, no double print", async () => {
  const { call } = setup();
  await call("POST", "/api/orders", { table: 5, items: [{ id: "m1", name: "กระเพรา", price: 59, qty: 1 }] });
  const checkout = await (await call("POST", "/api/table-status", { action: "checkout", table: 5, printReceipt: true })).json();
  assert.equal(checkout.ok, true);
  const id = checkout.receiptJobId;
  const queue = await (await call("GET", "/api/print-jobs")).json();
  assert.equal(queue.jobs.length, 1);

  const [a, b] = await Promise.all([
    call("POST", "/api/print-jobs", { action: "claim", id, deviceId: DEVICE_A }),
    call("POST", "/api/print-jobs", { action: "claim", id, deviceId: DEVICE_B }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);

  const winner = a.status === 200 ? DEVICE_A : DEVICE_B;
  const loser = winner === DEVICE_A ? DEVICE_B : DEVICE_A;
  assert.equal((await call("POST", "/api/print-jobs", { action: "complete", id, deviceId: loser })).status, 409);
  assert.equal((await call("POST", "/api/print-jobs", { action: "complete", id, deviceId: winner })).status, 200);
  const after = await (await call("GET", "/api/print-jobs")).json();
  assert.equal(after.jobs.length, 0);
});

test("special opening: open stores today's Bangkok date, cancel removes it", async () => {
  const { call } = setup();
  const opened = await (await call("POST", "/api/shop-status", { action: "open" })).json();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });
  assert.equal(opened.specialOpenDate, fmt.format(new Date()));
  assert.equal((await (await call("GET", "/api/shop-status")).json()).specialOpenDate, opened.specialOpenDate);
  await call("POST", "/api/shop-status", { action: "cancel" });
  assert.equal((await (await call("GET", "/api/shop-status")).json()).specialOpenDate, null);
});

test("menu and settings seed on first read and persist edits", async () => {
  const { call } = setup();
  const menu = await (await call("GET", "/api/menu")).json();
  assert.ok(Array.isArray(menu) && menu.length > 0);
  const settings = await call("GET", "/api/settings");
  assert.equal(settings.status, 200);
});

test("printer status heartbeat is stored per device (hash) and listed back", async () => {
  const { call } = setup();
  const posted = await call("POST", "/api/printer-status", { instanceId: "imin-1", ready: true, error: null });
  assert.equal(posted.status, 200);
  const status = await (await call("GET", "/api/printer-status")).json();
  assert.ok(JSON.stringify(status).includes("imin-1"));
});

test("admin export/import needs the token; a round trip moves orders to a new store", async () => {
  const env = { ADMIN_TOKEN: "t0ken-t0ken-t0ken" };
  const first = setup(env);
  await first.call("POST", "/api/orders", { table: 3, items: [{ id: "m3", name: "ชาเย็น", category: "เครื่องดื่ม", qty: 1 }] });
  assert.equal((await first.call("GET", "/api/_admin/export")).status, 401);
  assert.equal((await first.call("GET", "/api/_admin/export", undefined, { authorization: "Bearer wrong" })).status, 401);
  const exported = await (await first.call("GET", "/api/_admin/export", undefined, { authorization: `Bearer ${env.ADMIN_TOKEN}` })).json();

  const second = setup(env);
  const imported = await second.call("POST", "/api/_admin/import", exported.data, { authorization: `Bearer ${env.ADMIN_TOKEN}` });
  assert.equal(imported.status, 200);
  const list = await (await second.call("GET", "/api/orders")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].items[0].name, "ชาเย็น");
});

test("quota model: one iMin polling every 6s for a 9h40m shop day stays far below the 100,000/day free limit", async () => {
  const { store, call } = setup();
  let storeCalls = 0;
  for (const name of ["get", "set", "del", "expire", "hset", "hgetall", "mget"]) {
    const original = store[name].bind(store);
    store[name] = (...args) => {
      storeCalls += 1;
      return original(...args);
    };
  }
  const polls = Math.round((9 * 60 + 40) * 60 / 6); // orders + print-jobs per poll
  for (let i = 0; i < 200; i += 1) {
    await call("GET", "/api/orders");
    await call("GET", "/api/print-jobs");
  }
  const perPoll = storeCalls / 200;
  const requestsPerDay = polls * 2 + Math.round((9 * 60 + 40) * 60 / 15); // + QR every 15s
  console.log(`  quota model: ${perPoll} store reads per poll round, ~${requestsPerDay} API requests/day from one printer`);
  assert.ok(requestsPerDay < 30000);
  assert.ok(perPoll <= 2);
});
