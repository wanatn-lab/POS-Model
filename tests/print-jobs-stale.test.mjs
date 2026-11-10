import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createPrintJobsHandler, STALE_TICKET_MS } = await import("../api/print-jobs.js");

const NOW = Date.parse("2026-11-10T03:00:00.000Z");
const DEVICE = "device-kitchen-0001";

function fakeRedis(jobs) {
  const values = new Map([["printJobs", structuredClone(jobs)]]);
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
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

function ticket(id, ageMs, { status = "queued", type = "kitchen", kind = "order", station = "kitchen" } = {}) {
  const queuedAt = new Date(NOW - ageMs).toISOString();
  return { id, station, type, kind, status, createdAt: queuedAt, queuedAt };
}

async function call(handler, method, body = {}, station = "kitchen") {
  const res = fakeRes();
  await handler({ method, body, auth: { role: "device", deviceStation: station } }, res);
  return res;
}

test("B1: a 31-minute queued order ticket expires and is not returned to the bridge", async () => {
  const redis = fakeRedis([ticket("old", STALE_TICKET_MS + 60_000)]);
  const handler = createPrintJobsHandler(redis, { now: () => NOW });
  const result = await call(handler, "GET");
  assert.deepEqual(result.body.jobs, []);
  const [job] = await redis.get("printJobs");
  assert.equal(job.status, "expired");
  assert.equal(job.lastError, "expired_stale");
});

test("B2: a 29-minute queued order ticket remains claimable", async () => {
  const redis = fakeRedis([ticket("fresh", STALE_TICKET_MS - 60_000)]);
  const handler = createPrintJobsHandler(redis, { now: () => NOW });
  const result = await call(handler, "POST", { action: "claim", id: "fresh", deviceId: DEVICE });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.job.status, "claimed");
});

test("B3: an old failed ticket is expired while a new ticket is still delivered", async () => {
  const redis = fakeRedis([
    ticket("failed-old", STALE_TICKET_MS + 60_000, { status: "failed" }),
    ticket("new-order", 1_000),
  ]);
  const handler = createPrintJobsHandler(redis, { now: () => NOW });
  const result = await call(handler, "GET");
  assert.deepEqual(result.body.jobs.map((job) => job.id), ["new-order"]);
  assert.equal((await redis.get("printJobs")).find((job) => job.id === "failed-old").status, "expired");
});

test("B4: an old receipt never expires automatically", async () => {
  const redis = fakeRedis([ticket("receipt-old", STALE_TICKET_MS + 60_000, { type: "receipt", kind: undefined, station: "counter" })]);
  const handler = createPrintJobsHandler(redis, { now: () => NOW });
  const result = await call(handler, "POST", { action: "claim", id: "receipt-old", deviceId: "device-counter-0001" }, "counter");
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.job.status, "claimed");
});

test("B5: manual retry restores an expired ticket with a new 30-minute window", async () => {
  const redis = fakeRedis([ticket("expired", STALE_TICKET_MS + 60_000)]);
  const handler = createPrintJobsHandler(redis, { now: () => NOW });
  const retried = await call(handler, "POST", { action: "retry", id: "expired", station: "kitchen" });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body.job.status, "queued");
  assert.equal(retried.body.job.queuedAt, new Date(NOW).toISOString());
  const claimed = await call(handler, "POST", { action: "claim", id: "expired", deviceId: DEVICE });
  assert.equal(claimed.statusCode, 200);
});

test("B6: clearing an expired ticket is harmless and does not create a void ticket", async () => {
  const redis = fakeRedis([ticket("expired", STALE_TICKET_MS + 60_000)]);
  const handler = createPrintJobsHandler(redis, { now: () => NOW });
  const result = await call(handler, "POST", { action: "clear" });
  assert.equal(result.statusCode, 200);
  const jobs = await redis.get("printJobs");
  assert.equal(jobs[0].status, "cancelled");
  assert.equal(jobs.some((job) => job.kind === "void"), false);
});
