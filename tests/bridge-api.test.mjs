import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createPrintJobsHandler } = await import("../api/print-jobs.js");

function fakeRedis(seed = []) {
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

function responseAdapter(response) {
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
    return response;
  };
  return response;
}

async function requestAdapter(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  request.body = body ? JSON.parse(body) : {};
  return request;
}

const redis = fakeRedis([
  {
    id: "receipt-1",
    type: "receipt",
    status: "queued",
    items: [{ name: "น้ำเปล่า", qty: 1 }],
  },
]);
const handler = createPrintJobsHandler(redis);
let server;
let baseUrl;

before(async () => {
  server = createServer(async (request, response) => {
    if (new URL(request.url, "http://localhost").pathname !== "/api/print-jobs") {
      response.writeHead(404).end("Not found");
      return;
    }
    try {
      await handler(await requestAdapter(request), responseAdapter(response));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  // server.close() alone waits for every open socket. fetch() may leave a connection that never
  // sent a request, which close() does not count as idle, so it would wait for the server's
  // header timeout. Close all sockets explicitly so the test process exits at once.
  const closed = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closed;
});

test("Bridge GET /api/print-jobs returns 200 with queued jobs", async () => {
  const response = await fetch(`${baseUrl}/api/print-jobs`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.jobs.map((job) => job.id), ["receipt-1"]);
});

test("Bridge can claim and complete a print job", async () => {
  const deviceId = "imin-test-device";
  for (const action of ["claim", "complete"]) {
    const response = await fetch(`${baseUrl}/api/print-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action, id: "receipt-1", deviceId }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  const response = await fetch(`${baseUrl}/api/print-jobs`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).jobs, []);
});

test("admin heartbeat renders human time and handles missing timestamps", async () => {
  const html = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  const start = html.indexOf("function heartbeatAge(");
  const end = html.indexOf("function statusFor(", start);
  assert.ok(start >= 0 && end > start, "heartbeatAge must exist before statusFor");
  const heartbeatAge = Function(`${html.slice(start, end)}; return heartbeatAge;`)();
  const now = Date.parse("2026-09-02T05:00:00.000Z");
  assert.deepEqual(heartbeatAge(null, now), {
    valid: false,
    ageMs: Infinity,
    label: "ไม่เคยเชื่อมต่อ",
  });
  assert.equal(
    heartbeatAge("2026-08-12T08:54:00.480Z", now).label,
    "ประมาณ 21 วันที่แล้ว",
  );
  assert.match(html, /สัญญาณล่าสุด.*heartbeat\.label/);
  assert.doesNotMatch(html, /Math\.round\(ageMs\s*\/\s*1000\).*วิ/);
});
