import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeOverride,
  closeNowExpiryMs,
  defaultSchedule,
  nextOpeningMs,
  openNowExpiryMs,
  shopState,
  validateSchedule,
} from "../api/_shop-hours.js";

// Bangkok is UTC+7 with no daylight saving. 2026-10-13 is a Tuesday.
const bkk = (iso) => new Date(`${iso}+07:00`).getTime();
const hhmm = (ms) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");

test("default schedule is open 06:00 up to (not including) 18:00 every day", () => {
  const schedule = defaultSchedule();
  assert.equal(shopState(bkk("2026-10-13T05:59:00"), schedule).open, false);
  assert.equal(shopState(bkk("2026-10-13T06:00:00"), schedule).open, true);
  assert.equal(shopState(bkk("2026-10-13T17:59:00"), schedule).open, true);
  assert.equal(shopState(bkk("2026-10-13T18:00:00"), schedule).open, false);
  assert.equal(shopState(bkk("2026-10-13T00:00:00"), schedule).open, false);
  assert.equal(shopState(bkk("2026-10-12T12:00:00"), schedule).open, true); // a Monday is no longer special
});

test("state reports the next change", () => {
  const schedule = defaultSchedule();
  const open = shopState(bkk("2026-10-13T10:00:00"), schedule);
  assert.equal(open.changeAt, bkk("2026-10-13T18:00:00"));
  assert.equal(open.closesAt, new Date(bkk("2026-10-13T18:00:00")).toISOString());
  assert.equal(open.opensAt, null);

  const night = shopState(bkk("2026-10-13T22:00:00"), schedule);
  assert.equal(night.changeAt, bkk("2026-10-14T06:00:00"));
  assert.equal(night.opensAt, new Date(bkk("2026-10-14T06:00:00")).toISOString());
});

test("the Bangkok calendar day is used, not the host's", () => {
  const schedule = defaultSchedule();
  // 23:30 UTC on the 12th is already 06:30 on the 13th in Bangkok: open.
  assert.equal(shopState(Date.parse("2026-10-12T23:30:00Z"), schedule).open, true);
  // 11:00 UTC on the 13th is 18:00 in Bangkok: closed.
  assert.equal(shopState(Date.parse("2026-10-13T11:00:00Z"), schedule).open, false);
});

test("a day off is skipped when looking for the next opening", () => {
  const schedule = defaultSchedule();
  schedule.wed = { closed: true, open: "06:00", close: "18:00" };
  const state = shopState(bkk("2026-10-13T19:00:00"), schedule); // Tuesday evening
  assert.equal(state.open, false);
  assert.equal(hhmm(nextOpeningMs(bkk("2026-10-13T19:00:00"), schedule)), "2026-10-15 06:00"); // Thursday
  assert.equal(shopState(bkk("2026-10-14T12:00:00"), schedule).open, false); // Wednesday noon
});

test("per-day hours are honoured", () => {
  const schedule = defaultSchedule();
  schedule.sat = { closed: false, open: "07:30", close: "24:00" };
  assert.equal(shopState(bkk("2026-10-17T07:29:00"), schedule).open, false);
  assert.equal(shopState(bkk("2026-10-17T07:30:00"), schedule).open, true);
  assert.equal(shopState(bkk("2026-10-17T23:59:00"), schedule).open, true);
  assert.equal(shopState(bkk("2026-10-18T00:00:00"), schedule).open, false); // Sunday 00:00, before 06:00
});

test("a manual 'open now' beats the schedule until it expires", () => {
  const schedule = defaultSchedule();
  const early = bkk("2026-10-13T05:30:00");
  const expiresAtMs = openNowExpiryMs(early, schedule); // until today's closing time
  assert.equal(expiresAtMs, bkk("2026-10-13T18:00:00"));
  const override = { mode: "open", expiresAt: new Date(expiresAtMs).toISOString() };
  const state = shopState(early, schedule, override);
  assert.equal(state.open, true);
  assert.equal(state.reason, "manual-open");
  assert.equal(state.changeAt, expiresAtMs);
  // after expiry the schedule applies again
  assert.equal(shopState(bkk("2026-10-13T18:00:00"), schedule, override).open, false);
  assert.equal(shopState(bkk("2026-10-13T18:00:00"), schedule, override).reason, "schedule");
});

test("a manual 'close now' lasts until the next scheduled opening", () => {
  const schedule = defaultSchedule();
  const noon = bkk("2026-10-13T12:00:00");
  const expiresAtMs = closeNowExpiryMs(noon, schedule);
  assert.equal(expiresAtMs, bkk("2026-10-14T06:00:00"));
  const override = { mode: "closed", expiresAt: new Date(expiresAtMs).toISOString() };
  const state = shopState(noon, schedule, override);
  assert.equal(state.open, false);
  assert.equal(state.reason, "manual-closed");
  assert.equal(state.opensAt, new Date(expiresAtMs).toISOString());
  assert.equal(shopState(bkk("2026-10-14T06:00:00"), schedule, override).open, true);
});

test("'open now' needs explicit hours once today's closing time has passed", () => {
  const schedule = defaultSchedule();
  const late = bkk("2026-10-13T19:00:00");
  assert.equal(openNowExpiryMs(late, schedule), null);
  assert.equal(openNowExpiryMs(late, schedule, 2), late + 2 * 3600 * 1000);
  assert.equal(openNowExpiryMs(late, schedule, 0), null);
  assert.equal(openNowExpiryMs(late, schedule, 13), null); // longer than the 12 hour limit
  assert.equal(openNowExpiryMs(late, schedule, "abc"), null);
  const dayOff = defaultSchedule();
  dayOff.tue = { closed: true, open: "06:00", close: "18:00" };
  assert.equal(openNowExpiryMs(bkk("2026-10-13T08:00:00"), dayOff), null);
});

test("an expired or malformed override is ignored", () => {
  const now = bkk("2026-10-13T12:00:00");
  assert.equal(activeOverride(null, now), null);
  assert.equal(activeOverride({ mode: "open", expiresAt: new Date(now - 1).toISOString() }, now), null);
  assert.equal(activeOverride({ mode: "maybe", expiresAt: new Date(now + 1000).toISOString() }, now), null);
  assert.equal(activeOverride({ mode: "open", expiresAt: "not a date" }, now), null);
  assert.equal(shopState(now, defaultSchedule(), { mode: "closed", expiresAt: "garbage" }).open, true);
});

test("an all-closed week never opens and a bad stored schedule falls back to the default", () => {
  const schedule = defaultSchedule();
  for (const key of Object.keys(schedule)) schedule[key].closed = true;
  const state = shopState(bkk("2026-10-13T12:00:00"), schedule);
  assert.equal(state.open, false);
  assert.equal(state.opensAt, null);
  assert.equal(state.changeAt, null);
  assert.equal(closeNowExpiryMs(bkk("2026-10-13T12:00:00"), schedule), bkk("2026-10-14T12:00:00"));
  assert.equal(shopState(bkk("2026-10-13T12:00:00"), { mon: 5 }).open, true); // fell back to 06:00-18:00
});

test("validateSchedule accepts a good week and rejects bad input", () => {
  assert.equal(validateSchedule(defaultSchedule()).ok, true);
  assert.equal(validateSchedule(null).ok, false);
  assert.equal(validateSchedule([]).ok, false);
  assert.equal(validateSchedule({}).ok, false);

  const missingDay = defaultSchedule();
  delete missingDay.fri;
  assert.equal(validateSchedule(missingDay).ok, false);

  const reversed = defaultSchedule();
  reversed.mon = { closed: false, open: "18:00", close: "06:00" };
  assert.match(validateSchedule(reversed).error, /after opening/);

  const equal = defaultSchedule();
  equal.mon = { closed: false, open: "09:00", close: "09:00" };
  assert.equal(validateSchedule(equal).ok, false);

  for (const bad of ["6:00", "25:00", "12:60", "noon", "", 600, null]) {
    const schedule = defaultSchedule();
    schedule.mon = { closed: false, open: bad, close: "18:00" };
    assert.equal(validateSchedule(schedule).ok, false, `open=${String(bad)}`);
  }

  const midnightOpen = defaultSchedule();
  midnightOpen.mon = { closed: false, open: "24:00", close: "24:00" };
  assert.equal(validateSchedule(midnightOpen).ok, false); // 24:00 is only valid as a closing time

  const closedDay = defaultSchedule();
  closedDay.mon = { closed: true };
  const checked = validateSchedule(closedDay);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.schedule.mon, { closed: true, open: "06:00", close: "18:00" });

  const stringClosed = defaultSchedule();
  stringClosed.mon = { closed: "yes", open: "06:00", close: "18:00" };
  assert.equal(validateSchedule(stringClosed).ok, false);
});

test("validateSchedule returns a clean copy without unknown fields", () => {
  const input = defaultSchedule();
  input.mon = { closed: false, open: "07:00", close: "19:00", __proto__: { evil: 1 }, extra: "x" };
  input.extraDay = { closed: false, open: "01:00", close: "02:00" };
  const checked = validateSchedule(input);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.schedule.mon, { closed: false, open: "07:00", close: "19:00" });
  assert.equal(checked.schedule.extraDay, undefined);
});
