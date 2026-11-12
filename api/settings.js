import { redis } from "./_redis.js";

// Safe first-run configuration for the new restaurant. Menu, printer IPs and
// staff display ids are deliberately not seeded with made-up business data.
const TABLE_IDS = [
  ...Array.from({ length: 14 }, (_, index) => `T${index + 1}`),
  "TA1",
  "TA2",
];
// ESC/POS pulse durations are expressed in 2 ms units.  These defaults send
// a 50 ms pulse followed by 250 ms off time, which is a conservative setting
// for the common counter cash drawers used with thermal printers.
export const CASH_DRAWER_DEFAULTS = Object.freeze({
  enabled: false,
  openWhen: "after",
  pulsePin: 0,
  onTime: 25,
  offTime: 125,
});

function invalidCashDrawer(message) {
  return { ok: false, error: `cashDrawer ${message}` };
}

// Keep the accepted shape deliberately small: these values become a snapshot
// on a receipt job and are later sent to a physical ESC/POS printer.
export function validateCashDrawer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidCashDrawer("must be an object");
  }
  const enabled = value.enabled === undefined ? CASH_DRAWER_DEFAULTS.enabled : value.enabled;
  const openWhen = value.openWhen === undefined ? CASH_DRAWER_DEFAULTS.openWhen : value.openWhen;
  const pulsePin = value.pulsePin === undefined ? CASH_DRAWER_DEFAULTS.pulsePin : value.pulsePin;
  const onTime = value.onTime === undefined ? CASH_DRAWER_DEFAULTS.onTime : value.onTime;
  const offTime = value.offTime === undefined ? CASH_DRAWER_DEFAULTS.offTime : value.offTime;
  if (typeof enabled !== "boolean") return invalidCashDrawer("enabled must be boolean");
  if (openWhen !== "before" && openWhen !== "after") return invalidCashDrawer("openWhen must be before or after");
  if (!Number.isInteger(pulsePin) || ![0, 1].includes(pulsePin)) return invalidCashDrawer("pulsePin must be 0 or 1");
  if (!Number.isInteger(onTime) || onTime < 0 || onTime > 255) return invalidCashDrawer("onTime must be an integer from 0 to 255");
  if (!Number.isInteger(offTime) || offTime < 0 || offTime > 255) return invalidCashDrawer("offTime must be an integer from 0 to 255");
  return { ok: true, value: { enabled, openWhen, pulsePin, onTime, offTime } };
}

const SEED_SETTINGS = {
  tableCount: TABLE_IDS.length,
  tableIds: TABLE_IDS,
  shopName: "ร้านข้าวหมูแดง",
  customerOrderMode: "auto",
  showPrices: false,
  paperWidthMm: 80,
  cashDrawer: { ...CASH_DRAWER_DEFAULTS },
  printers: [
    { station: "counter", purpose: "receipt", enabled: true, ip: "", port: 9100, protocol: "tcp" },
    { station: "kitchen", purpose: "order", enabled: true, ip: "", port: 9100, protocol: "tcp" },
  ],
};

// What a customer's phone may read. The receipt design, tax id and printer setup stay private.
const PUBLIC_FIELDS = ["shopName", "tableCount", "tableIds", "showPrices"];
const FULL_ACCESS_ROLES = ["device", "staff", "owner"];

export function createSettingsHandler(redisClient = redis) {
  return async function handler(req, res) {
  if (req.method === "GET") {
    let settings = await redisClient.get("settings");
    if (!settings) {
      settings = SEED_SETTINGS;
      await redisClient.set("settings", settings);
    }
    // Existing shops keep their persisted shape. Defaults are written only on
    // first read, avoiding an accidental migration that adds fields mid-service.
    const full = settings;
    // req.auth is set by src/api-router.js when access control is enforced.
    if (req.auth && !FULL_ACCESS_ROLES.includes(req.auth.role)) {
      return res.status(200).json(Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, field === "showPrices" ? full[field] === true : full[field]])));
    }
    return res.status(200).json(full);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const current = (await redisClient.get("settings")) || SEED_SETTINGS;
    const merged = { ...current, ...body };
    if (body.customerOrderMode !== undefined && body.customerOrderMode !== "auto" && body.customerOrderMode !== "confirm") {
      return res.status(400).json({ ok: false, error: "customerOrderMode must be auto or confirm" });
    }
    if (body.cashDrawer !== undefined) {
      const cashDrawer = validateCashDrawer(body.cashDrawer);
      if (!cashDrawer.ok) return res.status(400).json({ ok: false, error: cashDrawer.error });
      merged.cashDrawer = cashDrawer.value;
    }
    await redisClient.set("settings", merged);
    return res.status(200).json({ ok: true, settings: merged });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
  };
}

export default createSettingsHandler();
