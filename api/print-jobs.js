import { redis } from "./_redis.js";

const CLAIM_TTL_MS = 2 * 60 * 1000;
// A ticket is useful only while it still reflects a live order. This is separate
// from the two-minute device lease above: a printer returning after an outage
// must not print old kitchen/void tickets by itself.
export const STALE_TICKET_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const MAX_JOBS = 300;
const STATIONS = new Set(["counter", "kitchen"]);

function readJobs(value) {
  return Array.isArray(value) ? value.filter((job) => job && job.id) : [];
}

function validDeviceId(value) {
  return typeof value === "string" && value.trim().length >= 8;
}

function isLeaseExpired(job, now) {
  return ["claimed", "printing"].includes(job.status) && (!job.claimedAt || new Date(job.claimedAt).getTime() <= now - CLAIM_TTL_MS);
}

// A job that returns to the queue after the printer may already have printed it is a reprint.
// The Bridge must print `reprintLabel` on it so the kitchen/cashier can tell it from a new job.
function markReprint(job, wasPrinting) {
  if (wasPrinting || job.printingAt) {
    job.reprint = true;
    job.reprintLabel = "*** พิมพ์ซ้ำ ***";
  }
}

function releaseExpired(jobs, station, now) {
  let changed = false;
  for (const job of jobs) {
    if (job.station !== station || !isLeaseExpired(job, now)) continue;
    markReprint(job, job.status === "printing");
    job.retryCount = (Number(job.retryCount) || 0) + 1;
    job.status = job.retryCount > MAX_RETRIES ? "failed" : "queued";
    job.lastError = "lease_expired";
    job.lastFailedAt = new Date(now).toISOString();
    delete job.claimedBy;
    delete job.claimedAt;
    changed = true;
  }
  return changed;
}

function ticketQueuedAt(job) {
  const timestamp = new Date(job.queuedAt || job.createdAt || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function isStaleTicket(job, now) {
  // Older order jobs did not have `kind`; they are order tickets for the
  // purpose of this safety limit. Receipts are intentionally never stale.
  if (job.type !== "kitchen" || !["order", "void"].includes(job.kind || "order")) return false;
  if (!["queued", "failed"].includes(job.status)) return false;
  const queuedAt = ticketQueuedAt(job);
  return queuedAt != null && now - queuedAt > STALE_TICKET_MS;
}

function expireStaleTickets(jobs, station, now) {
  let changed = false;
  for (const job of jobs) {
    if (job.station !== station || !isStaleTicket(job, now)) continue;
    job.status = "expired";
    job.lastError = "expired_stale";
    job.expiredAt = new Date(now).toISOString();
    delete job.claimedBy;
    delete job.claimedAt;
    changed = true;
  }
  return changed;
}

function jobsForStation(jobs, station) {
  return jobs.filter((job) => job.station === station && !["printed", "cancelled", "expired"].includes(job.status));
}

function batchSet(client, entries) {
  if (typeof client.batchSet === "function") return client.batchSet(entries);
  return Promise.all(entries.map(([key, value]) => client.set(key, value)));
}

export function createPrintJobsHandler(redisClient = redis, { now: clock = () => Date.now() } = {}) {
  return async function handler(req, res) {
    // `station` is injected from the authenticated device by api-router. The
    // fallback keeps the isolated handler usable in migration/unit tooling;
    // it is never reachable in enforced Worker traffic without device auth.
    const station = req.auth && req.auth.deviceStation || req.body && req.body.station || "counter";
    if (!STATIONS.has(station)) return res.status(403).json({ ok: false, error: "device station is not configured" });
    const now = clock();
    const jobs = readJobs(await redisClient.get("printJobs"));
    const releasedExpired = releaseExpired(jobs, station, now);
    const expiredStale = expireStaleTickets(jobs, station, now);

    if (req.method === "GET") {
      if (releasedExpired || expiredStale) await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
      return res.status(200).json({
        station,
        leaseMs: CLAIM_TTL_MS,
        jobs: jobsForStation(jobs, station),
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).end("Method not allowed");
    }

    const body = req.body || {};
    if (body.action === "clear") {
      // Owner-only (src/auth.js). Cancels every ticket that has not been printed so
      // stale tickets cannot come out later. A ticket a device is printing right now
      // (lease still valid) is left alone; printed tickets are never touched.
      const clearedAt = new Date(now).toISOString();
      const byStatus = { queued: 0, failed: 0, claimed: 0, printing: 0, expired: 0 };
      let skippedActive = 0;
      for (const job of jobs) {
        if (!job || ["printed", "cancelled"].includes(job.status)) continue;
        if (["claimed", "printing"].includes(job.status) && !isLeaseExpired(job, now)) {
          skippedActive += 1;
          continue;
        }
        if (job.status in byStatus) byStatus[job.status] += 1;
        job.status = "cancelled";
        job.cancelledAt = clearedAt;
        job.lastError = "cleared_by_owner";
      }
      const cleared = byStatus.queued + byStatus.failed + byStatus.claimed + byStatus.printing + byStatus.expired;
      if (cleared) await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
      return res.status(200).json({ ok: true, cleared, byStatus, skippedActive });
    }
    if (body.action === "retry") {
      const job = jobs.find((entry) => entry.id === body.id && entry.station === body.station);
      if (!job) return res.status(404).json({ ok: false, error: "print job not found" });
      if (!["failed", "queued", "expired"].includes(job.status)) return res.status(409).json({ ok: false, error: "print job is not retryable" });
      markReprint(job, true);
      job.status = "queued";
      job.manualRetryAt = new Date(now).toISOString();
      // Manual retry is an intentional reprint, so start a fresh stale-ticket
      // window even when the original createdAt is much older.
      job.queuedAt = job.manualRetryAt;
      await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
      return res.status(200).json({ ok: true, job });
    }

    const { action, id, deviceId } = body;
    if (!id || !validDeviceId(deviceId)) return res.status(400).json({ ok: false, error: "missing id or deviceId" });
    const job = jobs.find((entry) => entry.id === id && entry.station === station);
    if (!job) return res.status(404).json({ ok: false, error: "print job not found" });
    if (job.status === "cancelled") return res.status(409).json({ ok: false, error: "print job cancelled" });

    const ownedByOtherDevice = job.claimedBy && job.claimedBy !== deviceId && !isLeaseExpired(job, now);
    if (ownedByOtherDevice) return res.status(409).json({ ok: false, error: "print job belongs to another device" });

    if (action === "claim") {
      if (job.status === "printed") return res.status(409).json({ ok: false, error: "print job already completed" });
      if (job.status === "failed") return res.status(409).json({ ok: false, error: "print job needs manual retry" });
      job.status = "claimed";
      job.claimedBy = deviceId;
      job.claimedAt = new Date(now).toISOString();
      await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
      return res.status(200).json({ ok: true, job });
    }

    if (action === "printing") {
      if (!["claimed", "printing"].includes(job.status)) return res.status(409).json({ ok: false, error: "print job is not claimed" });
      job.status = "printing";
      job.printingAt = new Date(now).toISOString();
      await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
      return res.status(200).json({ ok: true, job });
    }

    if (action === "complete") {
      if (job.status === "printed") return res.status(200).json({ ok: true, job });
      if (!["claimed", "printing"].includes(job.status)) return res.status(409).json({ ok: false, error: "print job is not claimed" });
      job.status = "printed";
      job.printedAt = new Date(now).toISOString();
      job.claimedBy = deviceId;
      await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
      return res.status(200).json({ ok: true, job });
    }

    if (action === "release") {
      if (job.status === "printed") return res.status(200).json({ ok: true, job });
      markReprint(job, job.status === "printing");
      job.retryCount = (Number(job.retryCount) || 0) + 1;
      job.status = job.retryCount > MAX_RETRIES ? "failed" : "queued";
      job.lastError = typeof body.error === "string" ? body.error.slice(0, 200) : "print_failed";
      job.lastFailedAt = new Date(now).toISOString();
      delete job.claimedBy;
      delete job.claimedAt;
      await redisClient.set("printJobs", jobs.slice(-MAX_JOBS));
      return res.status(200).json({ ok: true, job });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  };
}

export default createPrintJobsHandler();
