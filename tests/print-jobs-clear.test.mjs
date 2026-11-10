import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createPrintJobsHandler } = await import("../api/print-jobs.js");
const { OWNER, STAFF, rolesFor } = await import("../src/auth.js");

function fakeRedis(seed) {
  const values = new Map([["printJobs", structuredClone(seed)]]);
  return {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.setHeader = () => res;
  res.end = () => res;
  return res;
}

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const seed = () => [
  { id: "q1", station: "kitchen", status: "queued", createdAt: iso(36e5 * 10) },
  { id: "f1", station: "kitchen", status: "failed", retryCount: 4, createdAt: iso(36e5 * 10) },
  { id: "q2", station: "counter", status: "queued", createdAt: iso(1000) },
  { id: "c-live", station: "kitchen", status: "claimed", claimedBy: "device-live-0001", claimedAt: iso(5000) },
  { id: "c-dead", station: "kitchen", status: "claimed", claimedBy: "device-dead-0001", claimedAt: iso(10 * 60 * 1000) },
  { id: "p1", station: "kitchen", status: "printed", printedAt: iso(1000) },
  { id: "x1", station: "kitchen", status: "cancelled" },
];

async function clear(redis, auth = { role: OWNER }) {
  const handler = createPrintJobsHandler(redis);
  const res = fakeRes();
  await handler({ method: "POST", body: { action: "clear" }, auth }, res);
  return res;
}

test("clear is an owner-only action in the auth matrix", () => {
  assert.deepEqual(rolesFor("print-jobs", "POST", { action: "clear" }), [OWNER]);
  assert.ok(!rolesFor("print-jobs", "POST", { action: "clear" }).includes(STAFF));
  assert.deepEqual(rolesFor("print-jobs", "POST", { action: "retry" }), [STAFF]);
  assert.deepEqual(rolesFor("print-jobs", "POST", { action: "claim" }), ["device"]);
});

test("clear cancels unprinted tickets across stations and spares printed and in-progress ones", async () => {
  const redis = fakeRedis(seed());
  const res = await clear(redis);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.cleared, 4); // q1, f1, q2, c-dead
  assert.equal(res.body.skippedActive, 1); // c-live
  assert.equal(res.body.byStatus.queued, 2);
  assert.equal(res.body.byStatus.failed, 1);
  assert.equal(res.body.byStatus.claimed, 1);

  const stored = new Map((await redis.get("printJobs")).map((job) => [job.id, job]));
  for (const id of ["q1", "f1", "q2", "c-dead"]) {
    assert.equal(stored.get(id).status, "cancelled", id);
    assert.equal(stored.get(id).lastError, "cleared_by_owner", id);
    assert.ok(stored.get(id).cancelledAt, id);
  }
  assert.equal(stored.get("c-live").status, "claimed");
  assert.equal(stored.get("p1").status, "printed");
  assert.equal(stored.get("x1").status, "cancelled");
});

test("cleared tickets disappear from the device list and cannot be claimed", async () => {
  const redis = fakeRedis(seed());
  await clear(redis);
  const handler = createPrintJobsHandler(redis);

  const list = fakeRes();
  await handler({ method: "GET", body: {}, auth: { role: "device", deviceStation: "kitchen" } }, list);
  assert.deepEqual(list.body.jobs.map((job) => job.id), ["c-live"]);

  const claim = fakeRes();
  await handler(
    { method: "POST", body: { action: "claim", id: "q1", deviceId: "device-kitchen-0001", station: "kitchen" }, auth: { role: "device", deviceStation: "kitchen" } },
    claim,
  );
  assert.equal(claim.statusCode, 409);
});

test("clear on an empty or already clean queue is a harmless no-op", async () => {
  const redis = fakeRedis([]);
  const res = await clear(redis);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cleared, 0);
  const again = await clear(fakeRedis([{ id: "p1", station: "kitchen", status: "printed" }]));
  assert.equal(again.body.cleared, 0);
});
