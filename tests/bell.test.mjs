import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createBell, bellConfig, BELL_TIMEOUT_MS } = await import("../api/_bell.js");
const { createOrdersHandler } = await import("../api/orders.js");
const { createQrPrintJobsHandler } = await import("../api/qr-print-jobs.js");
const { createBillHistoryHandler } = await import("../api/bill-history.js");
const { createTableStatusHandler } = await import("../api/table-status.js");
const { createPrintJobsHandler } = await import("../api/print-jobs.js");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = JSON.stringify({
  client_email: "bell@jinko-pos.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const PROD_ENV = {
  BELL_ENABLED: "true",
  FIREBASE_DATABASE_URL: "https://jinko-pos-default-rtdb.example.firebasedatabase.app/",
  FIREBASE_SERVICE_ACCOUNT_JSON: ACCOUNT,
};
const quietLog = { warn() {} };

function fakeFetch({ tokenStatus = 200, bellStatus = 200, hang = false } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    if (hang) {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/")) {
      return { ok: tokenStatus === 200, status: tokenStatus, json: async () => ({ access_token: "tok-1" }) };
    }
    return { ok: bellStatus === 200, status: bellStatus, json: async () => null };
  };
  impl.calls = calls;
  return impl;
}

function fakeRedis(seed = {}) {
  const values = new Map(Object.entries(structuredClone(seed)));
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async mget(...keys) { return keys.map((key) => structuredClone(values.get(key))); },
    peek(key) { return values.get(key); },
  };
}

function fakeRes() {
  const res = { statusCode: 0, body: undefined, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
}

function spyBell() {
  const rung = [];
  const bell = async (channel) => { rung.push(channel); return true; };
  bell.rung = rung;
  return bell;
}

// ---------- _bell.js ----------

test("bell is off unless BELL_ENABLED=true with a URL and a valid service account", () => {
  assert.equal(bellConfig({}).ready, false);
  assert.equal(bellConfig({ ...PROD_ENV, BELL_ENABLED: "false" }).ready, false);
  assert.equal(bellConfig({ ...PROD_ENV, FIREBASE_SERVICE_ACCOUNT_JSON: "not json" }).ready, false);
  assert.equal(bellConfig({ ...PROD_ENV, FIREBASE_DATABASE_URL: "http://insecure" }).ready, false);
  assert.equal(bellConfig(PROD_ENV).ready, true);
  const base64 = { ...PROD_ENV, FIREBASE_SERVICE_ACCOUNT_JSON: Buffer.from(ACCOUNT).toString("base64") };
  assert.equal(bellConfig(base64).ready, true, "base64 service account is accepted");
});

test("preview never uses production settings and rings a separate path", () => {
  const previewWithProdOnly = { ...PROD_ENV, VERCEL_ENV: "preview" };
  assert.equal(bellConfig(previewWithProdOnly).ready, false);
  const preview = {
    VERCEL_ENV: "preview",
    PREVIEW_BELL_ENABLED: "true",
    PREVIEW_FIREBASE_DATABASE_URL: "https://test-db.example.app",
    PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON: ACCOUNT,
  };
  const config = bellConfig(preview);
  assert.equal(config.ready, true);
  assert.equal(config.rootPath, "bridge-preview");
  assert.equal(bellConfig(PROD_ENV).rootPath, "bridge");
});

test("disabled bell makes no network call", async () => {
  const fetchImpl = fakeFetch();
  const ring = createBell({ env: {}, fetchImpl, log: quietLog });
  assert.equal(await ring("print"), false);
  assert.equal(fetchImpl.calls.length, 0);
});

test("ring signs a JWT, then PATCHes /bridge/ping with {ts, seq}; token is reused", async () => {
  const fetchImpl = fakeFetch();
  const ring = createBell({ env: PROD_ENV, fetchImpl, log: quietLog });
  assert.equal(await ring("print"), true);
  assert.equal(await ring("qr"), true);

  const tokenCalls = fetchImpl.calls.filter((c) => c.url.startsWith("https://oauth2"));
  assert.equal(tokenCalls.length, 1, "one token exchange for two rings");
  const assertion = new URLSearchParams(tokenCalls[0].init.body).get("assertion");
  const [header, claims, signature] = assertion.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${claims}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")), "JWT signature is valid");
  const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.match(decoded.scope, /auth\/firebase\.database/);

  const bellCalls = fetchImpl.calls.filter((c) => !c.url.startsWith("https://oauth2"));
  assert.deepEqual(bellCalls.map((c) => c.url), [
    "https://jinko-pos-default-rtdb.example.firebasedatabase.app/bridge/ping.json?print=silent",
    "https://jinko-pos-default-rtdb.example.firebasedatabase.app/bridge/ping.json?print=silent",
  ]);
  assert.equal(bellCalls[0].init.method, "PATCH");
  assert.equal(bellCalls[0].init.headers.Authorization, "Bearer tok-1");
  const payload = JSON.parse(bellCalls[0].init.body);
  assert.deepEqual(Object.keys(payload).sort(), ["seq", "ts"], "no order data leaves the server");
  assert.deepEqual(payload.ts, { ".sv": "timestamp" });
  assert.deepEqual(payload.seq, { ".sv": { increment: 1 } });
});

test("when the counter is rejected (HTTP 400) it rings again with the timestamp alone", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith("https://oauth2.googleapis.com/")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-1" }) };
    }
    const body = JSON.parse(init.body);
    return body.seq ? { ok: false, status: 400 } : { ok: true, status: 200 };
  };
  const ring = createBell({ env: PROD_ENV, fetchImpl, log: quietLog });
  assert.equal(await ring("print"), true);
  const pings = calls.filter((c) => !c.url.startsWith("https://oauth2"));
  assert.equal(pings.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(pings[1].init.body)), ["ts"]);
});

test("token or write failure resolves false and never throws", async () => {
  for (const options of [{ tokenStatus: 500 }, { bellStatus: 401 }, { bellStatus: 503 }]) {
    const ring = createBell({ env: PROD_ENV, fetchImpl: fakeFetch(options), log: quietLog });
    assert.equal(await ring("print"), false);
  }
  const throwing = createBell({
    env: PROD_ENV,
    fetchImpl: async () => { throw new Error("network down"); },
    log: quietLog,
  });
  assert.equal(await throwing("print"), false);
});

test("a hanging Firebase is abandoned at the timeout", async () => {
  assert.equal(BELL_TIMEOUT_MS, 1500);
  const ring = createBell({ env: PROD_ENV, fetchImpl: fakeFetch({ hang: true }), timeoutMs: 50, log: quietLog });
  const started = Date.now();
  assert.equal(await ring("print"), false);
  assert.ok(Date.now() - started < 1000);
});

// ---------- call sites: ring only where NEW printable work appears ----------

test("new order rings print; marking done does not", async () => {
  const redis = fakeRedis({ orders: [] });
  const bell = spyBell();
  const handler = createOrdersHandler({ redis, bell });
  const res = fakeRes();
  await handler({ method: "POST", body: { table: 3, items: [{ name: "ข้าวซอย", qty: 1 }] } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(bell.rung, ["print"]);

  const id = res.body.order.id;
  await handler({ method: "POST", body: { action: "done", id } }, fakeRes());
  assert.deepEqual(bell.rung, ["print"]);
});

test("invalid order is rejected and does not ring", async () => {
  const bell = spyBell();
  const res = fakeRes();
  await createOrdersHandler({ redis: fakeRedis({ orders: [] }), bell })({ method: "POST", body: { table: 1 } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(bell.rung, []);
});

test("order is still saved and answered 200 when the real bell fails", async () => {
  const redis = fakeRedis({ orders: [] });
  const failingBell = createBell({
    env: PROD_ENV,
    fetchImpl: async () => { throw new Error("firebase down"); },
    log: quietLog,
  });
  const res = fakeRes();
  await createOrdersHandler({ redis, bell: failingBell })(
    { method: "POST", body: { table: 5, items: [{ name: "แคบหมู", qty: 2 }] } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(redis.peek("orders").length, 1);
});

test("QR create rings qr; QR complete does not", async () => {
  const redis = fakeRedis({ qrPrintJobs: [] });
  const bell = spyBell();
  const handler = createQrPrintJobsHandler(redis, { bell });
  const res = fakeRes();
  await handler({ method: "POST", headers: { host: "shop.example" }, body: { action: "create", table: 4 } }, res);
  assert.equal(res.statusCode, 200);
  await handler({ method: "POST", headers: {}, body: { action: "complete", id: res.body.job.id } }, fakeRes());
  assert.deepEqual(bell.rung, ["qr"]);
});

test("bill reprint rings print; cancel and a duplicate reprint do not", async () => {
  const now = new Date().toISOString();
  const bill = { id: "bill-1", items: [{ name: "น้ำ", qty: 1, price: 10 }], total: 10, settledAt: now, createdAt: now };
  const redis = fakeRedis({ billHistory: [bill], printJobs: [] });
  const bell = spyBell();
  const handler = createBillHistoryHandler({ redis, bell });

  const first = fakeRes();
  await handler({ method: "POST", body: { action: "reprint", id: "bill-1" } }, first);
  assert.equal(first.statusCode, 200);
  const again = fakeRes();
  await handler({ method: "POST", body: { action: "reprint", id: "bill-1" } }, again);
  assert.equal(again.body.alreadyQueued, true);
  assert.deepEqual(bell.rung, ["print"]);

  await handler({ method: "POST", body: { action: "cancel", id: "bill-1" } }, fakeRes());
  assert.deepEqual(bell.rung, ["print"]);
});

test("checkout rings only when a new receipt job is queued", async () => {
  const created = new Date(Date.now() - 60 * 1000).toISOString();
  const seed = () => ({
    orders: [{ id: "o1", table: 7, items: [{ name: "ไส้อั่ว", qty: 1, price: 120 }], createdAt: created, status: "new" }],
    tableClears: {},
    settings: {},
    printJobs: [],
    billHistory: [],
  });

  const noPrintBell = spyBell();
  const noPrint = fakeRes();
  await createTableStatusHandler({ redis: fakeRedis(seed()), bell: noPrintBell })(
    { method: "POST", headers: {}, body: { action: "checkout", table: 7, printReceipt: false } },
    noPrint,
  );
  assert.equal(noPrint.statusCode, 200);
  assert.deepEqual(noPrintBell.rung, []);

  const printBell = spyBell();
  const withPrint = fakeRes();
  await createTableStatusHandler({ redis: fakeRedis(seed()), bell: printBell })(
    { method: "POST", headers: {}, body: { action: "checkout", table: 7, printReceipt: true } },
    withPrint,
  );
  assert.equal(withPrint.statusCode, 200);
  assert.ok(withPrint.body.receiptJobId);
  assert.deepEqual(printBell.rung, ["print"]);
});

test("print-job claim/complete/release never ring (the bridge acknowledges its own work)", async () => {
  // print-jobs.js does not import the bell at all; this guards against adding it later.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../api/print-jobs.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /_bell\.js|ringBell/);
  const handler = createPrintJobsHandler(fakeRedis({ printJobs: [{ id: "r1", type: "receipt", status: "queued" }] }));
  const res = fakeRes();
  await handler({ method: "POST", body: { action: "claim", id: "r1", deviceId: "device-123456" } }, res);
  assert.equal(res.statusCode, 200);
});
