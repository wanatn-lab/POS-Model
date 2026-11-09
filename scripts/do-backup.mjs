#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function usage() {
  throw new Error("Usage: ADMIN_TOKEN=... node scripts/do-backup.mjs <export|restore> --url https://worker.example --file /absolute/path.json");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function backupEndpoint(baseUrl, action) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("--url must use https");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/_admin/${action}`;
  return url;
}

function isInsideRepo(path) {
  const rel = relative(repoRoot, path);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
}

const [action, ...args] = process.argv.slice(2);
const baseUrl = option(args, "--url");
const file = option(args, "--file");
const token = process.env.ADMIN_TOKEN;

if ((action !== "export" && action !== "restore") || !baseUrl || !file || !token) usage();
const outputPath = resolve(file);
if (!file.startsWith("/") || isInsideRepo(outputPath)) {
  throw new Error("--file must be an absolute path outside this Git repository");
}

const endpoint = backupEndpoint(baseUrl, action);
const headers = { Authorization: `Bearer ${token}` };
let response;
if (action === "export") {
  response = await fetch(endpoint, { headers });
} else {
  const data = JSON.parse(await readFile(outputPath, "utf8"));
  response = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

if (!response.ok) throw new Error(`${action} failed with HTTP ${response.status}`);
const payload = await response.json();
if (!payload || payload.ok !== true) throw new Error(`${action} returned an invalid response`);

if (action === "export") {
  await writeFile(outputPath, JSON.stringify(payload.data), { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(`Backup written: ${outputPath}`);
} else {
  console.log(`Restore completed: ${payload.imported ?? 0} records imported`);
}
