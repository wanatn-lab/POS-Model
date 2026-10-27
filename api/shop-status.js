import { redis as defaultRedis } from "./_redis.js";

// "Special opening" switch for days the shop is normally closed (Mondays).
//   GET  /api/shop-status                -> { specialOpenDate, today }
//   POST /api/shop-status {action:"open"}   -> remember today's date as a special opening day
//   POST /api/shop-status {action:"cancel"} -> forget it
// The stored value is a DATE (Bangkok), so it stops counting on its own at midnight and can
// never leave the shop "open" for the following Mondays. Each call is exactly 1 Redis command.
const KEY = "shopSpecialOpen";
const TTL_SECONDS = 3 * 24 * 60 * 60;
const TIME_ZONE = "Asia/Bangkok";

export function bangkokDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function createShopStatusHandler({ redis = defaultRedis, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const today = bangkokDate(now());

    if (req.method === "GET") {
      const stored = await redis.get(KEY);
      return res.status(200).json({ ok: true, today, specialOpenDate: typeof stored === "string" ? stored : null });
    }

    if (req.method === "POST") {
      const action = req.body && req.body.action;
      if (action === "open") {
        await redis.set(KEY, today, { ex: TTL_SECONDS });
        return res.status(200).json({ ok: true, today, specialOpenDate: today });
      }
      if (action === "cancel") {
        await redis.del(KEY);
        return res.status(200).json({ ok: true, today, specialOpenDate: null });
      }
      return res.status(400).json({ ok: false, error: "action must be open or cancel" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method not allowed");
  };
}

export default createShopStatusHandler();
