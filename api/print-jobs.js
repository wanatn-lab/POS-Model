import { redis } from "./_redis.js";

// A receipt must survive the browser closing and must not be printed by two
// Bridge processes at once.  A short server-side lease, plus the bridge's own
// local print history, gives us both durability and protection during the
// foreground/background hand-off on iMin.
const CLAIM_TTL_MS = 2 * 60 * 1000;
const MAX_JOBS = 300;

function readJobs(value) {
  return Array.isArray(value) ? value.filter((job) => job && job.id) : [];
}

function canClaim(job, now) {
  if (job.status === "printed") return false;
  if (job.status !== "printing") return true;
  return !job.claimedAt || new Date(job.claimedAt).getTime() <= now - CLAIM_TTL_MS;
}

function validDeviceId(value) {
  return typeof value === "string" && value.trim().length >= 8;
}

export function createPrintJobsHandler(redisClient = redis) {
  return async function handler(req, res) {
  if (req.method === "GET") {
    const jobs = readJobs(await redisClient.get("printJobs"));
    // The bridge needs both queued work and its own unfinished lease so it can
    // acknowledge a receipt after a temporary network failure.
    return res.status(200).json({
      jobs: jobs.filter((job) => job.type === "receipt" && job.status !== "printed" && job.status !== "cancelled"),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method not allowed");
  }

  const body = req.body || {};
  const { action, id, deviceId } = body;
  if (!id || !validDeviceId(deviceId)) {
    return res.status(400).json({ ok: false, error: "missing id or deviceId" });
  }

  const jobs = readJobs(await redisClient.get("printJobs"));
  const job = jobs.find((entry) => entry.id === id && entry.type === "receipt");
  if (!job) return res.status(404).json({ ok: false, error: "print job not found" });
  const now = Date.now();

  if (job.status === "cancelled") {
    return res.status(409).json({ ok: false, error: "print job cancelled" });
  }

  if (action === "claim") {
    if (job.status === "printed") {
      return res.status(409).json({ ok: false, error: "print job already completed" });
    }
    const claimedByOtherDevice =
      job.status === "printing" && job.claimedBy && job.claimedBy !== deviceId && !canClaim(job, now);
    if (claimedByOtherDevice) {
      return res.status(409).json({ ok: false, error: "print job is being printed" });
    }
    job.status = "printing";
    job.claimedBy = deviceId;
    job.claimedAt = new Date(now).toISOString();
    await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
    return res.status(200).json({ ok: true, job });
  }

  if (action === "complete") {
    if (job.status === "printed") return res.status(200).json({ ok: true, job });
    if (job.claimedBy && job.claimedBy !== deviceId && !canClaim(job, now)) {
      return res.status(409).json({ ok: false, error: "print job belongs to another device" });
    }
    job.status = "printed";
    job.printedAt = new Date(now).toISOString();
    job.claimedBy = deviceId;
    await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
    return res.status(200).json({ ok: true, job });
  }

  if (action === "release") {
    if (job.status === "printed") return res.status(200).json({ ok: true, job });
    if (job.claimedBy && job.claimedBy !== deviceId && !canClaim(job, now)) {
      return res.status(409).json({ ok: false, error: "print job belongs to another device" });
    }
    job.status = "queued";
    delete job.claimedBy;
    delete job.claimedAt;
    await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
    return res.status(200).json({ ok: true, job });
  }

  return res.status(400).json({ ok: false, error: "unknown action" });
  };
}

export default createPrintJobsHandler();
