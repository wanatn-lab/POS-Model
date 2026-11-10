import { redis as defaultRedis } from "./_redis.js";
import {
  bangkokDateString,
  closeNowExpiryMs,
  defaultSchedule,
  openNowExpiryMs,
  shopState,
  usableSchedule,
  validateSchedule,
} from "./_shop-hours.js";

// Shop opening hours and the manual open/close switch.
//
//   GET  /api/shop-status                       public  -> current state + weekly schedule
//   POST {action:"set-schedule", schedule}      owner   -> save the weekly opening hours
//   POST {action:"open-now", hours?}            staff   -> open outside the schedule
//   POST {action:"close-now"}                   staff   -> close early (until the next opening)
//   POST {action:"clear-override"}              staff   -> go back to the weekly schedule
//   POST {action:"open"} / {action:"cancel"}    staff   -> older names for open-now / clear-override
//
// The schedule lives in "shopSchedule". The manual switch lives in "shopOverride" and expires by
// itself (the expiry is checked when it is read), so it can never leave the shop open or closed
// for good. A fresh shop gets a default schedule the first time the status is read.
const SCHEDULE_KEY = "shopSchedule";
const OVERRIDE_KEY = "shopOverride";
const LEGACY_OPEN_HOURS = 3;
const TIME_ZONE = "Asia/Bangkok";

export function bangkokDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function publicStatus(nowMs, schedule, override) {
  const sched = usableSchedule(schedule);
  const state = shopState(nowMs, sched, override);
  const manual = state.reason !== "schedule" ? { mode: override.mode, expiresAt: override.expiresAt } : null;
  return {
    ok: true,
    today: bangkokDateString(nowMs),
    now: new Date(nowMs).toISOString(),
    open: state.open,
    reason: state.reason,
    opensAt: state.opensAt,
    closesAt: state.closesAt,
    changeAt: state.changeAt,
    schedule: sched,
    override: manual,
    // Older pages only knew a "special opening today" date.
    specialOpenDate: state.reason === "manual-open" ? bangkokDateString(nowMs) : null,
  };
}

export function createShopStatusHandler({ redis = defaultRedis, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const nowMs = now().getTime();

    async function load() {
      const [storedSchedule, storedOverride] = await Promise.all([redis.get(SCHEDULE_KEY), redis.get(OVERRIDE_KEY)]);
      return { schedule: storedSchedule, override: storedOverride };
    }

    if (req.method === "GET") {
      let { schedule, override } = await load();
      if (!schedule) {
        schedule = defaultSchedule();
        await redis.set(SCHEDULE_KEY, schedule);
      }
      return res.status(200).json(publicStatus(nowMs, schedule, override));
    }

    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const action = body.action;
      const setBy = String(req.auth && (req.auth.staffId || req.auth.role) || "staff").slice(0, 60);
      let { schedule, override } = await load();

      if (action === "set-schedule") {
        const checked = validateSchedule(body.schedule);
        if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });
        schedule = checked.schedule;
        await redis.set(SCHEDULE_KEY, schedule);
        return res.status(200).json(publicStatus(nowMs, schedule, override));
      }

      if (action === "open-now" || action === "open") {
        const hours = body.hours === undefined || body.hours === null
          ? (action === "open" ? LEGACY_OPEN_HOURS : undefined)
          : body.hours;
        const expiresAtMs = openNowExpiryMs(nowMs, schedule, hours);
        if (expiresAtMs === null) {
          return res.status(400).json({
            ok: false,
            error: "hours_required",
            message: "Past today's closing time or a day off: say how many hours to stay open (1-12).",
          });
        }
        override = { mode: "open", expiresAt: new Date(expiresAtMs).toISOString(), setAt: new Date(nowMs).toISOString(), setBy };
        await redis.set(OVERRIDE_KEY, override);
        return res.status(200).json(publicStatus(nowMs, schedule, override));
      }

      if (action === "close-now") {
        override = {
          mode: "closed",
          expiresAt: new Date(closeNowExpiryMs(nowMs, schedule)).toISOString(),
          setAt: new Date(nowMs).toISOString(),
          setBy,
        };
        await redis.set(OVERRIDE_KEY, override);
        return res.status(200).json(publicStatus(nowMs, schedule, override));
      }

      if (action === "clear-override" || action === "cancel") {
        await redis.del(OVERRIDE_KEY);
        return res.status(200).json(publicStatus(nowMs, schedule, null));
      }

      return res.status(400).json({ ok: false, error: "unknown action" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method not allowed");
  };
}

export default createShopStatusHandler();
