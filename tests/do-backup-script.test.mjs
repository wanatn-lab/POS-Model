import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const script = await readFile(new URL("../scripts/do-backup.mjs", import.meta.url), "utf8");
const router = await readFile(new URL("../src/api-router.js", import.meta.url), "utf8");

test("backup script's restore action targets the server's import route", () => {
  // The router only knows "export" and "import"; calling /api/_admin/restore answered 405.
  assert.match(router, /name === "import" && request\.method === "POST"/);
  assert.match(script, /action === "restore" \? "import" : action/);
  assert.match(script, /\/api\/_admin\/\$\{route\}/);
  assert.doesNotMatch(script, /\/api\/_admin\/\$\{action\}/);
});
