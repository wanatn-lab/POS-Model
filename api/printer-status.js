import { redis } from "./_redis.js";

// One hash field per running print agent. HSET/HGETALL keep this route at one
// Redis command per request while letting the admin see duplicate agents.
const KEY = "printer-status-agents-v2";

export function createPrinterStatusHandler({ redis: redisClient = redis, now = () => new Date() } = {}) {
  return async function handler(req, res) {
  if (req.method === "POST") {
    const body = req.body || {};
    const instanceId = typeof body.instanceId === "string" && body.instanceId.trim()
      ? body.instanceId.trim()
      : "legacy-agent";
    const payload = {
      updatedAt: now().toISOString(),
      instanceId,
      hostname: typeof body.hostname === "string" ? body.hostname.slice(0, 120) : "unknown host",
      printers: Array.isArray(body.printers) ? body.printers : [],
    };
    await redisClient.hset(KEY, { [instanceId]: payload });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    const stored = (await redisClient.hgetall(KEY)) || {};
    const agents = Object.values(stored)
      .filter((agent) => agent && typeof agent === "object" && agent.updatedAt)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const latest = agents[0] || { updatedAt: null, printers: [] };
    return res.status(200).json({ ...latest, agents });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
  };
}

export default createPrinterStatusHandler();
