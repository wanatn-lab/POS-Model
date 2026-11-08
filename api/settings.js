import { redis } from "./_redis.js";

// Safe first-run configuration for the new restaurant. Menu, printer IPs and
// staff display ids are deliberately not seeded with made-up business data.
const TABLE_IDS = [
  ...Array.from({ length: 14 }, (_, index) => `T${index + 1}`),
  "TA1",
  "TA2",
];
const SEED_SETTINGS = {
  tableCount: TABLE_IDS.length,
  tableIds: TABLE_IDS,
  shopName: "ร้านข้าวหมูแดง",
  customerOrderMode: "auto",
  paperWidthMm: 80,
  printers: [
    { station: "counter", purpose: "receipt", enabled: true, ip: "", port: 9100, protocol: "tcp" },
    { station: "kitchen", purpose: "order", enabled: true, ip: "", port: 9100, protocol: "tcp" },
  ],
};

// What a customer's phone may read. The receipt design, tax id and printer setup stay private.
const PUBLIC_FIELDS = ["shopName", "tableCount", "tableIds"];
const FULL_ACCESS_ROLES = ["device", "staff", "owner"];

export default async function handler(req, res) {
  if (req.method === "GET") {
    let settings = await redis.get("settings");
    if (!settings) {
      settings = SEED_SETTINGS;
      await redis.set("settings", settings);
    }
    // Existing shops keep their persisted shape. Defaults are written only on
    // first read, avoiding an accidental migration that adds fields mid-service.
    const full = settings;
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
    if (body.customerOrderMode !== undefined && body.customerOrderMode !== "auto" && body.customerOrderMode !== "confirm") {
      return res.status(400).json({ ok: false, error: "customerOrderMode must be auto or confirm" });
    }
    await redis.set("settings", merged);
    return res.status(200).json({ ok: true, settings: merged });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
