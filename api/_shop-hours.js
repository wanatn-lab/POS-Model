// Pure shop-hours logic. No I/O, no globals, so the server and the tests share one definition.
//
// Everything is Asia/Bangkok, which has a fixed UTC+07:00 offset (no daylight saving), so the
// arithmetic below never depends on the host's time zone. All times are epoch milliseconds.
//
// A day is one window [open, close) inside that calendar day. A window that crosses midnight is
// not supported: close must be later than open (use 24:00 for "until midnight").
//
// A manual override ("open now" / "close now") always wins over the weekly schedule until its
// own expiry, then the schedule applies again. Nothing here ever needs a cron job.

export const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Index = day of week of the Bangkok calendar date (0 = Sunday).
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const DEFAULT_OPEN = "06:00";
export const DEFAULT_CLOSE = "18:00";
export const MAX_MANUAL_HOURS = 12;

export function defaultSchedule() {
  return Object.fromEntries(DAY_KEYS.map((key) => [key, { closed: false, open: DEFAULT_OPEN, close: DEFAULT_CLOSE }]));
}

function parseClock(value, allowMidnightEnd) {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours === 24 && minutes === 0 && allowMidnightEnd) return 24 * 60;
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

// Returns { ok: true, schedule } with a clean, complete copy, or { ok: false, error }.
export function validateSchedule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "schedule must be an object with one entry per weekday" };
  }
  const schedule = {};
  for (const key of DAY_KEYS) {
    const day = input[key];
    if (!day || typeof day !== "object") return { ok: false, error: `missing day: ${key}` };
    const closed = day.closed === true;
    if (day.closed !== undefined && typeof day.closed !== "boolean") {
      return { ok: false, error: `${key}.closed must be true or false` };
    }
    if (closed) {
      schedule[key] = { closed: true, open: DEFAULT_OPEN, close: DEFAULT_CLOSE };
      continue;
    }
    const open = parseClock(day.open, false);
    const close = parseClock(day.close, true);
    if (open === null || close === null) return { ok: false, error: `${key}: times must look like HH:MM` };
    if (close <= open) return { ok: false, error: `${key}: closing time must be after opening time` };
    schedule[key] = { closed: false, open: day.open, close: day.close };
  }
  return { ok: true, schedule };
}

// A stored schedule that is somehow malformed falls back to the default instead of throwing.
export function usableSchedule(value) {
  const checked = validateSchedule(value);
  return checked.ok ? checked.schedule : defaultSchedule();
}

function startOfBangkokDay(nowMs) {
  return Math.floor((nowMs + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS;
}

function weekdayIndex(nowMs) {
  return new Date(nowMs + BANGKOK_OFFSET_MS).getUTCDay();
}

export function bangkokDateString(nowMs) {
  return new Date(nowMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

function windowOf(schedule, dayStartMs, offsetDays, dayIndex) {
  const day = schedule[DAY_KEYS[(dayIndex + offsetDays) % 7]];
  if (!day || day.closed) return null;
  const start = dayStartMs + offsetDays * DAY_MS;
  return { openMs: start + parseClock(day.open, false) * MINUTE_MS, closeMs: start + parseClock(day.close, true) * MINUTE_MS };
}

// First scheduled opening strictly after `nowMs` (looks one week ahead), or null if every day is closed.
export function nextOpeningMs(nowMs, schedule) {
  const sched = usableSchedule(schedule);
  const dayStart = startOfBangkokDay(nowMs);
  const dayIndex = weekdayIndex(nowMs);
  for (let offset = 0; offset <= 7; offset += 1) {
    const window = windowOf(sched, dayStart, offset, dayIndex);
    if (window && window.openMs > nowMs) return window.openMs;
  }
  return null;
}

function scheduleState(nowMs, schedule) {
  const dayStart = startOfBangkokDay(nowMs);
  const dayIndex = weekdayIndex(nowMs);
  const today = windowOf(schedule, dayStart, 0, dayIndex);
  if (today && nowMs >= today.openMs && nowMs < today.closeMs) {
    return { open: true, closesAtMs: today.closeMs, opensAtMs: null };
  }
  return { open: false, closesAtMs: null, opensAtMs: nextOpeningMs(nowMs, schedule) };
}

// An override only counts while it is well-formed and not expired.
export function activeOverride(override, nowMs) {
  if (!override || typeof override !== "object") return null;
  if (override.mode !== "open" && override.mode !== "closed") return null;
  const expiresAtMs = Date.parse(override.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
  return { mode: override.mode, expiresAtMs };
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// The single answer every part of the system uses.
//   open      - may customers order / should the pages refresh right now
//   reason    - "schedule" | "manual-open" | "manual-closed"
//   opensAt   - ISO time the shop next opens (only while closed)
//   closesAt  - ISO time the shop next closes (only while open)
//   changeAt  - epoch ms of the next state change (null = never)
export function shopState(nowMs, schedule, override) {
  const sched = usableSchedule(schedule);
  const manual = activeOverride(override, nowMs);
  if (manual) {
    const open = manual.mode === "open";
    return {
      open,
      reason: open ? "manual-open" : "manual-closed",
      opensAt: open ? null : iso(manual.expiresAtMs),
      closesAt: open ? iso(manual.expiresAtMs) : null,
      changeAt: manual.expiresAtMs,
    };
  }
  const base = scheduleState(nowMs, sched);
  return {
    open: base.open,
    reason: "schedule",
    opensAt: iso(base.opensAtMs),
    closesAt: iso(base.closesAtMs),
    changeAt: base.open ? base.closesAtMs : base.opensAtMs,
  };
}

// "Open now" with no hours given means: stay open until today's scheduled closing time.
// Returns the expiry in epoch ms, or null when that is not possible (past closing, or a day off)
// so the caller must ask for an explicit number of hours.
export function openNowExpiryMs(nowMs, schedule, hours) {
  if (hours !== undefined && hours !== null) {
    const count = Number(hours);
    if (!Number.isFinite(count) || count <= 0 || count > MAX_MANUAL_HOURS) return null;
    return nowMs + Math.round(count * 60) * MINUTE_MS;
  }
  const sched = usableSchedule(schedule);
  const today = windowOf(sched, startOfBangkokDay(nowMs), 0, weekdayIndex(nowMs));
  return today && nowMs < today.closeMs ? today.closeMs : null;
}

// "Close now" lasts until the next scheduled opening (or a day, if the week has none).
export function closeNowExpiryMs(nowMs, schedule) {
  return nextOpeningMs(nowMs, schedule) || nowMs + DAY_MS;
}
