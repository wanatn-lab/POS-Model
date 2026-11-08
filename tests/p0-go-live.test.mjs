import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApiRequest } from "../src/api-router.js";
import { tableStatusPayload } from "../api/table-status.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { fakeSql } from "./cf-helpers.mjs";

const ORIGIN = "https://moo-daeng.example";
const ENV = {
  SESSION_SECRET: "session-secret-for-p0-tests-0123456789abcdef",
  OWNER_PASSWORD: "owner-password-p0-123",
  STAFF_PASSWORD: "staff-password-p0-123",
  STAFF_ID: "Somchai",
};

function setup() {
  const store = new SqliteStore(fakeSql());
  store.set("menu", [
    { id: "rice", name: "ข้าวหมูแดง", price: 60, category: "อาหาร", available: true },
    { id: "sold", name: "ของหมด", price: 10, category: "อาหาร", available: false },
  ]);
  const call = (method, path, body, { cookie, bearer } = {}) => handleApiRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(method === "GET" ? {} : { origin: ORIGIN }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { store, env: ENV });
  return { store, call };
}

async function login(call, role) {
  const response = await call("POST", "/api/auth/login", { role, password: ENV[`${role.toUpperCase()}_PASSWORD`] });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie()[0].split(";")[0];
}

test("P0: restaurant tables, server price, idempotency and station queue are enforced", async () => {
  const { call } = setup();
  const owner = await login(call, "owner");
  const staff = await login(call, "staff");
  const device = await (await call("POST", "/api/devices", { action: "create", name: "kitchen bridge", station: "kitchen" }, { cookie: owner })).json();

  const payload = { table: "t3", items: [{ id: "rice", qty: 2, price: 1 }], idempotencyKey: "p0-identical-request-0001" };
  const replies = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/api/orders", payload)));
  assert.deepEqual(replies.map((response) => response.status), [200, 200, 200, 200, 200]);
  const orders = await Promise.all(replies.map((response) => response.json()));
  assert.equal(new Set(orders.map((body) => body.order.id)).size, 1);
  assert.equal(orders[0].order.table, "T3");
  assert.equal(orders[0].order.items[0].price, 60, "client price is ignored");
  assert.equal(orders[0].order.source, "customer");

  const pass = replies[0].headers.getSetCookie()[0].split(";")[0];
  assert.equal((await call("POST", "/api/orders", { ...payload, table: "T4", idempotencyKey: "p0-other-table-0002" }, { cookie: pass })).status, 403);
  assert.equal((await call("POST", "/api/orders", { table: "T3", items: [{ id: "sold", qty: 1 }], idempotencyKey: "p0-sold-out-item-0003" })).status, 400);

  const queue = await (await call("GET", "/api/print-jobs", undefined, { bearer: device.token })).json();
  assert.equal(queue.station, "kitchen");
  assert.equal(queue.jobs.length, 1, "one kitchen job for five duplicate posts");
  const jobId = queue.jobs[0].id;
  for (const action of ["claim", "printing", "complete"]) {
    assert.equal((await call("POST", "/api/print-jobs", { action, id: jobId }, { bearer: device.token })).status, 200);
  }
  const voided = await (await call("POST", "/api/orders", { action: "void", id: orders[0].order.id }, { cookie: staff })).json();
  assert.equal(voided.kitchenVoidQueued, true);
  const voidQueue = await (await call("GET", "/api/print-jobs", undefined, { bearer: device.token })).json();
  assert.deepEqual(voidQueue.jobs.map((job) => job.kind), ["void"]);

  const staffOrder = await (await call("POST", "/api/orders", { table: "T4", items: [{ id: "rice", qty: 1 }], idempotencyKey: "p0-staff-order-0004" }, { cookie: staff })).json();
  assert.equal(staffOrder.order.source, "staff");
  assert.equal(staffOrder.order.staffId, "Somchai");
  const paid = await (await call("POST", "/api/table-status", { action: "checkout", table: "T4", printReceipt: true }, { cookie: staff })).json();
  assert.equal(paid.bill.status, "paid");
  const beforeCancel = await (await call("GET", "/api/bill-history", undefined, { cookie: staff })).json();
  assert.equal(beforeCancel.summary.validTotal, 60);
  assert.equal((await call("POST", "/api/bill-history", { action: "cancel", id: paid.bill.id }, { cookie: staff })).status, 403);
  assert.equal((await call("POST", "/api/bill-history", { action: "cancel", id: paid.bill.id }, { cookie: owner })).status, 200);
  const afterCancel = await (await call("GET", "/api/bill-history", undefined, { cookie: staff })).json();
  assert.equal(afterCancel.summary.validTotal, 0);
});

test("P0: SQLite batch writes roll back and takeaway orders do not get reusable table passes", async () => {
  const { store, call } = setup();
  const circular = {}; circular.self = circular;
  await assert.rejects(store.batchSet([["first", { ok: true }], ["second", circular]]));
  assert.equal(await store.get("first"), null, "failed multi-write rolls back");

  const first = await call("POST", "/api/orders", { table: "TA1", items: [{ id: "rice", qty: 1 }], idempotencyKey: "p0-takeaway-order-0005" });
  const second = await call("POST", "/api/orders", { table: "TA1", items: [{ id: "rice", qty: 1 }], idempotencyKey: "p0-takeaway-order-0006" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.getSetCookie().length, 0);
  assert.equal(second.headers.getSetCookie().length, 0);
  assert.equal((await call("GET", "/api/orders")).status, 401);
});

test("P0-8: two takeaway customers on the same lane get separate bills", async () => {
  const { call } = setup();
  const staff = await login(call, "staff");
  const items = [{ id: "rice", qty: 1 }];
  const first = await (await call("POST", "/api/orders", { table: "TA1", items, idempotencyKey: "ta-lane-order-000001" })).json();
  const second = await (await call("POST", "/api/orders", { table: "TA1", items, idempotencyKey: "ta-lane-order-000002" })).json();
  assert.match(first.order.table, /^TA1-[A-Z0-9]{3}$/);
  assert.match(second.order.table, /^TA1-[A-Z0-9]{3}$/);
  assert.notEqual(first.order.table, second.order.table);
  assert.equal(first.order.takeawayLane, "TA1");
  const billOne = await (await call("POST", "/api/table-status", { action: "checkout", table: first.order.table, printReceipt: true }, { cookie: staff })).json();
  assert.equal(billOne.bill.total, 60, "first bill holds only its own order");
  assert.deepEqual(billOne.bill.sourceOrderIds, [first.order.id]);
  const billTwo = await (await call("POST", "/api/table-status", { action: "checkout", table: second.order.table, printReceipt: true }, { cookie: staff })).json();
  assert.equal(billTwo.bill.total, 60);
  assert.deepEqual(billTwo.bill.sourceOrderIds, [second.order.id]);
});

test("board is seeded from the configured table ids (T1-T14), not numbers 1-16", () => {
  const ids = [...Array.from({ length: 14 }, (_, index) => `T${index + 1}`), "TA1", "TA2"];
  const board = tableStatusPayload([], {}, { tableCount: 16, tableIds: ids }, new Date());
  assert.deepEqual(board.tables.map((table) => table.table), ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14"]);
});

test("a print job that returns to the queue after printing started is marked as a reprint", async () => {
  const { call } = setup();
  const owner = await login(call, "owner");
  const device = await (await call("POST", "/api/devices", { action: "create", name: "kitchen bridge", station: "kitchen" }, { cookie: owner })).json();
  await call("POST", "/api/orders", { table: "T6", items: [{ id: "rice", qty: 1 }], idempotencyKey: "reprint-order-0000001" });
  const queue = await (await call("GET", "/api/print-jobs", undefined, { bearer: device.token })).json();
  const id = queue.jobs[0].id;
  // released straight after claim: nothing was printed, so it is not a reprint
  await call("POST", "/api/print-jobs", { action: "claim", id }, { bearer: device.token });
  await call("POST", "/api/print-jobs", { action: "release", id }, { bearer: device.token });
  let job = (await (await call("GET", "/api/print-jobs", undefined, { bearer: device.token })).json()).jobs[0];
  assert.equal(job.reprint, undefined);
  // released after printing started: the paper may already be out, so mark it
  for (const action of ["claim", "printing", "release"]) {
    await call("POST", "/api/print-jobs", { action, id }, { bearer: device.token });
  }
  job = (await (await call("GET", "/api/print-jobs", undefined, { bearer: device.token })).json()).jobs[0];
  assert.equal(job.reprint, true);
  assert.equal(job.reprintLabel, "*** พิมพ์ซ้ำ ***");
});

test("order rate limit is 3 per minute per table, and a retry of the same order does not count", async () => {
  const { call } = setup();
  const items = [{ id: "rice", qty: 1 }];
  const statuses = [];
  for (let n = 1; n <= 4; n += 1) {
    statuses.push((await call("POST", "/api/orders", { table: "T8", items, idempotencyKey: `rate-limit-order-00000${n}` })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  const retry = await call("POST", "/api/orders", { table: "T8", items, idempotencyKey: "rate-limit-order-000001" });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).idempotent, true);
});

test("per-menu printer: one order splits into kitchen and counter tickets, void follows printed stations", async () => {
  const { store, call } = setup();
  store.set("menu", [
    { id: "rice", name: "ข้าวหมูแดง", price: 60, category: "อาหาร", printer: "kitchen", available: true },
    { id: "tea", name: "ชาเย็น", price: 20, category: "เครื่องดื่ม", printer: "counter", available: true },
    { id: "old", name: "เมนูเก่า", price: 10, category: "อาหาร", available: true },
  ]);
  const owner = await login(call, "owner");
  const staff = await login(call, "staff");
  const kitchen = await (await call("POST", "/api/devices", { action: "create", name: "k", station: "kitchen" }, { cookie: owner })).json();
  const counter = await (await call("POST", "/api/devices", { action: "create", name: "c", station: "counter" }, { cookie: owner })).json();

  const placed = await (await call("POST", "/api/orders", {
    table: "T1",
    items: [{ id: "rice", qty: 1, printer: "counter" }, { id: "tea", qty: 2 }, { id: "old", qty: 1 }],
    idempotencyKey: "split-order-0001-abcdef",
  })).json();
  assert.deepEqual(placed.order.items.map((item) => item.printer), ["kitchen", "counter", "kitchen"], "client printer is ignored; missing = kitchen");

  const kq = await (await call("GET", "/api/print-jobs", undefined, { bearer: kitchen.token })).json();
  const cq = await (await call("GET", "/api/print-jobs", undefined, { bearer: counter.token })).json();
  assert.deepEqual(kq.jobs.map((job) => job.items.map((item) => item.id)), [["rice", "old"]]);
  assert.deepEqual(cq.jobs.map((job) => job.items.map((item) => item.id)), [["tea"]]);
  assert.equal(cq.jobs[0].type, "kitchen");

  // only the kitchen printed; void must go to the kitchen only
  for (const action of ["claim", "printing", "complete"]) {
    assert.equal((await call("POST", "/api/print-jobs", { action, id: kq.jobs[0].id }, { bearer: kitchen.token })).status, 200);
  }
  await call("POST", "/api/orders", { action: "void", id: placed.order.id }, { cookie: staff });
  const kv = await (await call("GET", "/api/print-jobs", undefined, { bearer: kitchen.token })).json();
  assert.deepEqual(kv.jobs.map((job) => job.kind), ["void"]);
  const cv = await (await call("GET", "/api/print-jobs", undefined, { bearer: counter.token })).json();
  assert.deepEqual(cv.jobs, [], "never-printed counter ticket is cancelled and gets no void slip");
});
