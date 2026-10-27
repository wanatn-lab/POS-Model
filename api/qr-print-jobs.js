import { redis } from "./_redis.js";
import { ringBell } from "./_bell.js";

// Queue of "print this table's QR code" jobs for the drink-counter printer.
// Deliberately separate from the "orders" and "printJobs" keys so it can never
// affect kitchen/drink tickets or customer receipts.
//
// Flow: admin page POSTs {action:"create", table} -> the /counter-print page
// (open on the iMin device) polls GET, prints each queued job, then POSTs
// {action:"complete", id}.
const KEY = "qrPrintJobs";
const MAX_JOBS = 50;
// A job nobody picked up for 10 minutes is stale — don't dump old QR codes
// out of the printer when the counter page is opened later.
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_TABLE = 200;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readJobs(value) {
  return Array.isArray(value) ? value.filter((job) => job && job.id) : [];
}

// The QR always points at this site's order page for the table — same rule the
// admin QR grid uses (origin + /order?table=N). Built on the server from the
// request host so a caller can't make the printer output an arbitrary link.
function orderUrl(req, table) {
  const headers = req.headers || {};
  const host = headers["x-forwarded-host"] || headers.host;
  if (!host) return null;
  const proto = headers["x-forwarded-proto"] === "http" ? "http" : "https";
  return `${proto}://${host}/order?table=${table}`;
}

export function createQrPrintJobsHandler(redisClient, { bell = ringBell } = {}) {
  if (
    !redisClient ||
    typeof redisClient.get !== "function" ||
    typeof redisClient.set !== "function"
  ) {
    throw new TypeError("createQrPrintJobsHandler requires a Redis-compatible get/set client");
  }

  return async function handler(req, res) {
    if (req.method === "GET") {
      const jobs = readJobs(await redisClient.get(KEY));
      const cutoff = Date.now() - MAX_AGE_MS;
      return res.status(200).json({
        jobs: jobs.filter(
          (job) =>
            job.status === "queued" && new Date(job.createdAt).getTime() >= cutoff,
        ),
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).end("Method not allowed");
    }

    const body = req.body || {};

    if (body.action === "create") {
      const table = Number(body.table);
      if (!Number.isInteger(table) || table < 1 || table > MAX_TABLE) {
        return res.status(400).json({ ok: false, error: "invalid table" });
      }
      const url = orderUrl(req, table);
      if (!url) return res.status(400).json({ ok: false, error: "cannot determine site url" });

      const jobs = readJobs(await redisClient.get(KEY));
      const job = {
        id: genId(),
        table,
        url,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      // This queue is a single counter-printer command, not a batch queue.
      // Keep printed history, but replace every older queued command so one
      // click always prints only the table the staff selected most recently.
      const nextJobs = jobs.filter((entry) => entry.status !== "queued");
      nextJobs.push(job);
      await redisClient.set(KEY, nextJobs.slice(-MAX_JOBS));
      await bell("qr");
      return res.status(200).json({ ok: true, job });
    }

    if (body.action === "complete") {
      if (!body.id) return res.status(400).json({ ok: false, error: "missing id" });
      const jobs = readJobs(await redisClient.get(KEY));
      const job = jobs.find((entry) => entry.id === body.id);
      if (!job) return res.status(404).json({ ok: false, error: "print job not found" });
      if (job.status !== "printed") {
        job.status = "printed";
        job.printedAt = new Date().toISOString();
        await redisClient.set(KEY, jobs.slice(-MAX_JOBS));
      }
      return res.status(200).json({ ok: true, job });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  };
}

export default createQrPrintJobsHandler(redis);
