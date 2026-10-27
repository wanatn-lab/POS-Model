import { redis } from "./_redis.js";

// Seed — matches what was already live before this migration.
const SEED_SETTINGS = { tableCount: 20, shopName: "ทองย้อย", paperWidthMm: 80, printers: [] };

// What a customer's phone may read. The receipt design, tax id and printer setup stay private.
const PUBLIC_FIELDS = ["shopName", "tableCount"];
const FULL_ACCESS_ROLES = ["device", "staff", "owner"];

export default async function handler(req, res) {
  if (req.method === "GET") {
    let settings = await redis.get("settings");
    if (!settings) {
      settings = SEED_SETTINGS;
      await redis.set("settings", settings);
    }
    const full = { ...SEED_SETTINGS, ...settings };
    // req.auth is set by src/api-router.js when access control is enforced.
    if (req.auth && !FULL_ACCESS_ROLES.includes(req.auth.role)) {
      return res.status(200).json(Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, full[field]])));
    }
    return res.status(200).json(full);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const current = (await redis.get("settings")) || SEED_SETTINGS;
    const merged = { ...current, ...body };
    await redis.set("settings", merged);
    return res.status(200).json({ ok: true, settings: merged });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
