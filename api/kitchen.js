import { redis as defaultRedis } from "./_redis.js";
import {
  STATUSES,
  bangkokDay,
  buildBoard,
  mergeConfig,
  pickConfigPatch,
} from "./_kitchen-logic.js";

// Kitchen screen API  (GET /api/kitchen, POST /api/kitchen)
//
// Kitchen state is stored in small per-day Redis hashes, one field per item / card:
//   kitchen:items:YYYY-MM-DD   lineId     -> { st: "p"|"d"|"c", at: ISO }
//   kitchen:rush:YYYY-MM-DD    sessionKey -> true
//   kitchen:rank:YYYY-MM-DD    sessionKey -> number
// Writing one field never touches anything else, so two kitchen tablets (or a
// customer ordering at the same moment) cannot overwrite each other's changes.
// The existing `orders` array is only ever READ here.

const TTL_SECONDS = 3 * 24 * 60 * 60;
const MAX_IDS = 300;

export function createKitchenHandler({ redis = defaultRedis, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    // The screen must always show live data, never a cached copy.
    res.setHeader("Cache-Control", "no-store");
    const current = now();
    const day = bangkokDay(current);
    const itemsKey = `kitchen:items:${day}`;
    const rushKey = `kitchen:rush:${day}`;
    const rankKey = `kitchen:rank:${day}`;

    async function touch(key) {
      await redis.expire(key, TTL_SECONDS);
    }

    if (req.method === "GET") {
      const [orders, clears, storedConfig, itemState, rush, rank] = await Promise.all([
        redis.get("orders"),
        redis.get("tableClears"),
        redis.get("kitchenConfig"),
        redis.hgetall(itemsKey),
        redis.hgetall(rushKey),
        redis.hgetall(rankKey),
      ]);
      const config = mergeConfig(storedConfig);
      const board = buildBoard({
        orders,
        clears: clears || {},
        itemState: itemState || {},
        rush: rush || {},
        rank: rank || {},
        config,
        now: current,
      });
      return res.status(200).json({ serverNow: current.toISOString(), config, ...board });
    }

    if (req.method === "POST") {
      const body = req.body || {};

      // Set one or many items (tick done / cancel / undo / finish whole card).
      if (body.action === "item-set") {
        const ids = Array.isArray(body.lineIds) ? body.lineIds.map(String) : [];
        if (!ids.length || ids.length > MAX_IDS || !STATUSES.includes(body.st)) {
          return res.status(400).json({ ok: false, error: "need lineIds and st (p|d|c)" });
        }
        const at = current.toISOString();
        const fields = {};
        for (const id of ids) fields[id] = { st: body.st, at };
        await redis.hset(itemsKey, fields);
        await touch(itemsKey);
        return res.status(200).json({ ok: true, at });
      }

      // Rush on/off for a whole table card. Turning it on/off drops any dragged rank.
      if (body.action === "rush") {
        const key = String(body.key || "");
        if (!key || typeof body.rush !== "boolean") {
          return res.status(400).json({ ok: false, error: "need key and rush (boolean)" });
        }
        if (body.rush) {
          await redis.hset(rushKey, { [key]: true });
          await touch(rushKey);
        } else {
          await redis.hdel(rushKey, key);
        }
        await redis.hdel(rankKey, key);
        return res.status(200).json({ ok: true });
      }

      // Drag & drop: the screen sends the full new order of card keys (top to bottom).
      // `moved` + `rush` are optional: dropping before a rush card makes the moved card rush too.
      if (body.action === "reorder") {
        const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
        if (!keys.length || keys.length > MAX_IDS) {
          return res.status(400).json({ ok: false, error: "need keys" });
        }
        const ranks = {};
        keys.forEach((key, index) => {
          ranks[key] = index;
        });
        await redis.hset(rankKey, ranks);
        await touch(rankKey);
        if (body.moved && typeof body.rush === "boolean") {
          if (body.rush) {
            await redis.hset(rushKey, { [String(body.moved)]: true });
            await touch(rushKey);
          } else {
            await redis.hdel(rushKey, String(body.moved));
          }
        }
        return res.status(200).json({ ok: true });
      }

      // Thresholds / hidden categories are config, not code.
      if (body.action === "set-config") {
        const patch = pickConfigPatch(body);
        const merged = mergeConfig({ ...((await redis.get("kitchenConfig")) || {}), ...patch });
        await redis.set("kitchenConfig", merged);
        return res.status(200).json({ ok: true, config: merged });
      }

      return res.status(400).json({ ok: false, error: "unknown action" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method not allowed");
  };
}

// The kitchen screen is switched off for now (the code is kept). While KITCHEN_ENABLED is not
// "true", this endpoint answers immediately WITHOUT touching Redis, so any old tablet that is
// still open cannot use up the database quota. To turn the screen back on: set the Vercel
// environment variable KITCHEN_ENABLED=true and restore the /kitchen rewrite in vercel.json.
const kitchenHandler = createKitchenHandler();

export default function kitchenGate(req, res) {
  if ((globalThis.__shopEnv || {}).KITCHEN_ENABLED !== "true") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(410).json({ ok: false, error: "kitchen screen is turned off" });
  }
  return kitchenHandler(req, res);
}
