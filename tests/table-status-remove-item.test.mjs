import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createTableStatusHandler } = await import("../api/table-status.js");

const NOW = new Date("2026-11-10T03:00:00.000Z");

function fakeRedis(seed) {
  const values = new Map(Object.entries(structuredClone(seed)));
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async batchSet(entries) {
      // Match the production all-or-nothing boundary: clone every value before
      // changing the map, so an invalid later entry cannot partially update it.
      const next = entries.map(([key, value]) => [key, structuredClone(value)]);
      for (const [key, value] of next) values.set(key, value);
    },
  };
}

function fakeRes() {
  const res = { statusCode: 0, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = () => res;
  res.end = () => res;
  return res;
}

function line(id, printer = "kitchen") {
  return { id, name: id, price: 40, qty: 1, options: [], printer };
}

function order(items) {
  return { id: "o1", table: "T1", createdAt: NOW.toISOString(), items };
}

function ticket(station, items, status = "queued") {
  return {
    id: `${station}-o1`, printId: `${station}-o1`, type: "kitchen", kind: "order",
    station, orderId: "o1", table: "T1", items, status, queuedAt: NOW.toISOString(),
  };
}

async function remove(seed, { itemIndex = 0, removalId = "remove-test-0001" } = {}) {
  const redis = fakeRedis(seed);
  const rings = [];
  const handler = createTableStatusHandler({ redis, now: () => NOW, bell: async (reason) => rings.push(reason) });
  const res = fakeRes();
  await handler({ method: "POST", body: { action: "remove-item", orderId: "o1", itemIndex, removalId } }, res);
  return { redis, rings, res, handler };
}

test("A1: removing a kitchen line after it printed queues one kitchen void and rings once", async () => {
  const food = line("food");
  const { redis, rings, res } = await remove({ orders: [order([food])], printJobs: [ticket("kitchen", [food], "printed")] });
  assert.equal(res.statusCode, 200);
  const jobs = await redis.get("printJobs");
  const voids = jobs.filter((job) => job.kind === "void");
  assert.equal(voids.length, 1);
  assert.equal(voids[0].station, "kitchen");
  assert.deepEqual(voids[0].items.map((item) => item.id), ["food"]);
  assert.deepEqual(rings, ["print"]);
});

test("A2: a mixed order only voids the printed station of the removed line", async () => {
  const food = line("food", "kitchen");
  const drink = line("drink", "counter");
  const { redis, rings } = await remove({
    orders: [order([food, drink])],
    printJobs: [ticket("kitchen", [food], "printed"), ticket("counter", [drink], "printed")],
  }, { itemIndex: 1 });
  const voids = (await redis.get("printJobs")).filter((job) => job.kind === "void");
  assert.deepEqual(voids.map((job) => job.station), ["counter"]);
  assert.deepEqual(voids[0].items.map((item) => item.id), ["drink"]);
  assert.deepEqual(rings, ["print"]);
});

test("A3: removing one of two queued lines edits the ticket without a void", async () => {
  const first = line("first");
  const second = line("second");
  const { redis, rings } = await remove({ orders: [order([first, second])], printJobs: [ticket("kitchen", [first, second])] });
  const [job] = await redis.get("printJobs");
  assert.equal(job.status, "queued");
  assert.deepEqual(job.items.map((item) => item.id), ["second"]);
  assert.equal((await redis.get("printJobs")).some((entry) => entry.kind === "void"), false);
  assert.deepEqual(rings, []);
});

test("A4: removing the final queued line cancels its ticket", async () => {
  const food = line("food");
  const { redis, rings } = await remove({ orders: [order([food])], printJobs: [ticket("kitchen", [food])] });
  const [job] = await redis.get("printJobs");
  assert.equal(job.status, "cancelled");
  assert.equal(job.items.length, 0);
  assert.ok(job.cancelledAt);
  assert.deepEqual(rings, []);
});

test("A5: a retry with the same removal id never creates a second void", async () => {
  const food = line("food");
  const seed = { orders: [order([food])], printJobs: [ticket("kitchen", [food], "printed")] };
  const { redis, rings, handler } = await remove(seed, { removalId: "remove-retry-0001" });
  const again = fakeRes();
  await handler({ method: "POST", body: { action: "remove-item", orderId: "o1", itemIndex: 0, removalId: "remove-retry-0001" } }, again);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.alreadyRemoved, true);
  assert.equal((await redis.get("printJobs")).filter((job) => job.kind === "void").length, 1);
  assert.deepEqual(rings, ["print"]);
});

test("A6: a station that never printed the removed line gets no void", async () => {
  const food = line("food", "kitchen");
  const drink = line("drink", "counter");
  const { redis, rings } = await remove({
    orders: [order([food, drink])],
    printJobs: [ticket("kitchen", [food], "printed"), ticket("counter", [drink], "queued")],
  }, { itemIndex: 1 });
  const jobs = await redis.get("printJobs");
  assert.equal(jobs.some((job) => job.kind === "void"), false);
  assert.equal(jobs.find((job) => job.station === "counter").status, "cancelled");
  assert.deepEqual(rings, []);
});

test("a second removal that moved into index zero is not mistaken for a retry", async () => {
  const first = line("first");
  const second = line("second");
  const { redis, handler } = await remove({
    orders: [order([first, second])], printJobs: [ticket("kitchen", [first, second])],
  }, { removalId: "remove-first-0001" });
  const secondRemoval = fakeRes();
  await handler({
    method: "POST",
    body: { action: "remove-item", orderId: "o1", itemIndex: 0, removalId: "remove-second-0001" },
  }, secondRemoval);
  assert.equal(secondRemoval.statusCode, 200);
  assert.equal((await redis.get("orders"))[0].items.length, 0);
  assert.equal((await redis.get("printJobs"))[0].status, "cancelled");
});

test("both table-status pages send a removal id", () => {
  for (const page of ["../public/admin.html", "../public/table-status.html"]) {
    const html = readFileSync(new URL(page, import.meta.url), "utf8");
    assert.match(html, /action:"remove-item", orderId:item\.orderId, itemIndex:item\.itemIndex, removalId:item\.removalId/);
  }
});

test("failed and expired tickets drop removed lines before manual retry", async () => {
  for (const status of ["failed", "expired"]) {
    const first = line("first");
    const second = line("second");
    const { redis, rings } = await remove({
      orders: [order([first, second])], printJobs: [ticket("kitchen", [first, second], status)],
    }, { removalId: `remove-${status}-0001` });
    const [job] = await redis.get("printJobs");
    assert.equal(job.status, status);
    assert.deepEqual(job.items.map((item) => item.id), ["second"]);
    assert.deepEqual(rings, []);
  }
});

test("a previously printed add-on does not void a different line still queued", async () => {
  const printed = line("printed");
  const queued = line("queued");
  const { redis, rings } = await remove({
    orders: [order([printed, queued])],
    printJobs: [
      ticket("kitchen", [printed], "printed"),
      ticket("kitchen", [queued], "queued"),
    ],
  }, { itemIndex: 1, removalId: "remove-queued-addon-0001" });
  const jobs = await redis.get("printJobs");
  assert.equal(jobs.some((job) => job.kind === "void"), false);
  assert.equal(jobs.find((job) => job.status === "cancelled").items.length, 0);
  assert.deepEqual(rings, []);
});
