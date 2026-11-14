#!/usr/bin/env node
// ตรวจว่าไฟล์ที่จะส่งให้ "ร้านใหม่" ไม่มีข้อมูลเฉพาะของร้านเดิมหลงเหลืออยู่
//   node scripts/check-new-shop.mjs                 ตรวจเฉพาะไฟล์แม่แบบ (wrangler.template.jsonc + NEW-SHOP-SETUP.md)
//   node scripts/check-new-shop.mjs --all           ตรวจทั้งโค้ดที่ส่งไปร้านใหม่ (api, src, public, scripts, wrangler, เอกสาร)
//   node scripts/check-new-shop.mjs path1 path2     ตรวจเฉพาะไฟล์/โฟลเดอร์ที่ระบุ
// exit code 0 = ไม่พบ, 1 = พบข้อมูลร้านเดิม  (สคริปต์นี้อ่านอย่างเดียว ไม่แก้ไฟล์ใดๆ)
// ข้อมูลร้านเดิมถูกเขียนแบบแยกส่วน เพื่อไม่ให้สคริปต์นี้ถูกจับเองเมื่อสแกนตัวเอง
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const j = (...p) => p.join("");

export const RULES = [
  { id: "shop-name-th", label: "ชื่อร้านเดิม (ไทย)", re: new RegExp(j("ทอง", "ย้อย")) },
  { id: "shop-name-th-2", label: "ชื่อร้านเดิมอีกชื่อ (ไทย)", re: new RegExp(j("ข้าว", "หมูแดง")) },
  { id: "shop-name-en", label: "ชื่อร้านเดิม (อังกฤษ)", re: new RegExp(j("thong", "yoi"), "i") },
  { id: "worker-name", label: "ชื่อ Worker ของร้านเดิม", re: new RegExp(j("moo", "-daeng"), "i") },
  { id: "old-brand", label: "ชื่อแบรนด์/โครงการเดิม", re: new RegExp(j("jin", "ko"), "i") },
  { id: "old-folder", label: "โฟลเดอร์ Cloudinary ของร้านก่อนหน้า", re: new RegExp(j("menu", "jk")) },
  { id: "old-phone", label: "เบอร์โทรร้านเดิม", re: new RegExp(j("085", "-?529", "-?8799")) },
  { id: "old-host", label: "โฮสต์เซิร์ฟเวอร์เดิม (vercel.app / netlify.app)", re: /[a-z0-9-]+\.(vercel|netlify)\.app/i },
  // account_id ของ Cloudflare = เลขฐานสิบหก 32 ตัว (ใน wrangler หรือเอกสาร)
  { id: "account-id", label: "Cloudflare account_id จริง (hex 32 ตัว)", re: /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i },
];

const TEXT_EXT = /\.(jsonc?|mjs|cjs|js|html|css|md|txt|webmanifest|toml|ya?ml|sh)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "tests"]);

export function scanText(text, file = "<text>") {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push({ file, line: i + 1, rule: rule.id, label: rule.label });
    }
  });
  return findings;
}

function* walk(path) {
  const st = statSync(path);
  if (st.isFile()) { if (TEXT_EXT.test(path)) yield path; return; }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(path, name));
  }
}

export function scanPaths(paths, root = process.cwd()) {
  const findings = [];
  for (const p of paths) {
    const abs = resolve(root, p);
    try { statSync(abs); } catch { findings.push({ file: p, line: 0, rule: "missing", label: "ไม่พบไฟล์ที่ต้องตรวจ" }); continue; }
    for (const file of walk(abs)) {
      findings.push(...scanText(readFileSync(file, "utf8"), relative(root, file)));
    }
  }
  return findings;
}

export const TEMPLATE_FILES = ["wrangler.template.jsonc", "NEW-SHOP-SETUP.md"];
export const ALL_PATHS = ["api", "src", "public", "scripts", "wrangler.template.jsonc", "NEW-SHOP-SETUP.md", "package.json", "README.md", "DEPLOY.md"];

function main() {
  const args = process.argv.slice(2);
  const paths = args.includes("--all") ? ALL_PATHS : args.filter((a) => !a.startsWith("--"));
  const targets = paths.length ? paths : TEMPLATE_FILES;
  const findings = scanPaths(targets);
  if (!findings.length) { console.log(`ผ่าน: ไม่พบข้อมูลร้านเดิมใน ${targets.join(", ")}`); return 0; }
  console.log(`พบข้อมูลร้านเดิม ${findings.length} จุด (แสดงเฉพาะตำแหน่ง ไม่แสดงค่า):`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.rule}] ${f.label}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
