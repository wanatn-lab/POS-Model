import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createPrinterStatusHandler } = await import("../api/printer-status.js");

function call(handler, method, body) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {},
      status(code) { this.code = code; return this; },
      json(bodyValue) { resolve({ code: this.code, body: bodyValue }); },
      end() { resolve({ code: this.code }); },
    };
    handler({ method, body }, res);
  });
}

function fakeRedis() {
  const hash = {};
  const commands = [];
  return {
    commands,
    async hset(key, values) { commands.push(["HSET", key]); Object.assign(hash, structuredClone(values)); },
    async hgetall(key) { commands.push(["HGETALL", key]); return structuredClone(hash); },
  };
}

test("printer status stores each agent independently with one Redis command per request", async () => {
  const redis = fakeRedis();
  let tick = 0;
  const handler = createPrinterStatusHandler({
    redis,
    now: () => new Date(`2026-10-10T0${++tick}:00:00.000Z`),
  });
  await call(handler, "POST", { instanceId: "agent-a", hostname: "kitchen-a", printers: [{ ip: "10.0.0.2", ok: true }] });
  await call(handler, "POST", { instanceId: "agent-b", hostname: "kitchen-b", printers: [{ ip: "10.0.0.2", ok: false }] });
  const result = await call(handler, "GET");

  assert.deepEqual(redis.commands.map(([command]) => command), ["HSET", "HSET", "HGETALL"]);
  assert.equal(result.code, 200);
  assert.equal(result.body.agents.length, 2);
  assert.deepEqual(new Set(result.body.agents.map((agent) => agent.hostname)), new Set(["kitchen-a", "kitchen-b"]));
});
