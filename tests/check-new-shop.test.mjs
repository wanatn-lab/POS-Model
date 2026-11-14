import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanPaths, scanText, TEMPLATE_FILES } from "../scripts/check-new-shop.mjs";

const j = (...p) => p.join("");

test("detects old-shop names, host, phone and a 32-hex account id", () => {
  const rules = (text) => scanText(text).map((f) => f.rule);
  assert.deepEqual(rules(j("ร้าน", "ทอง", "ย้อย")), ["shop-name-th"]);
  assert.deepEqual(rules(j("Thong", "yoi")), ["shop-name-en"]);
  assert.deepEqual(rules(j("moo", "-daeng", "-pos")), ["worker-name"]);
  assert.deepEqual(rules(j("https://x.", "vercel", ".app")), ["old-host"]);
  assert.deepEqual(rules(j("085", "-529-", "8799")), ["old-phone"]);
  assert.deepEqual(rules('"account_id": "' + "a1b2c3d4".repeat(4) + '"'), ["account-id"]);
});

test("placeholders and neutral text are not flagged", () => {
  assert.deepEqual(scanText('"account_id": "<ACCOUNT_ID>", "name": "<WORKER_NAME>", "x": "ร้านของฉัน"'), []);
  assert.deepEqual(scanText("sha 0123456789abcdef"), []); // hex สั้นกว่า 32 ไม่ใช่ account id
});

test("findings never echo the matched value", () => {
  const out = JSON.stringify(scanText(j("ทอง", "ย้อย ", "a1b2c3d4".repeat(4))));
  assert.ok(!out.includes(j("ทอง", "ย้อย")) && !out.includes("a1b2c3d4"));
});

test("scanPaths reports file and line, and flags a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "shopcheck-"));
  writeFileSync(join(dir, "a.md"), "ok\n" + j("moo", "-daeng") + "\n");
  const found = scanPaths(["a.md", "nope.md"], dir);
  assert.deepEqual(found.map((f) => [f.file, f.line, f.rule]), [["a.md", 2, "worker-name"], ["nope.md", 0, "missing"]]);
});

test("the shipped template files contain no old-shop data", () => {
  const root = new URL("..", import.meta.url).pathname;
  assert.deepEqual(scanPaths(TEMPLATE_FILES, root), []);
});
