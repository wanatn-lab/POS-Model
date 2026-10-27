import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://example.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";

const { default: kitchenGate } = await import("../api/kitchen.js");

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: undefined };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = (body) => { res.body = body; return res; };
  return res;
}

test("kitchen API answers 410 and never reaches Redis while the screen is turned off", async () => {
  delete process.env.KITCHEN_ENABLED;
  const res = fakeRes();
  await kitchenGate({ method: "GET" }, res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.ok, false);
  assert.equal(res.headers["Cache-Control"], "no-store");
});
