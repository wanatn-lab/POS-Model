import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// Load the browser script in a fake window (no real timers, scripted network).
function loadShopHours(responses = []) {
  const window = {};
  const requests = [];
  const events = [];
  const queue = [...responses];
  const sandbox = {
    window,
    document: { dispatchEvent(event) { events.push(event.type); } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Intl,
    Date,
    Number,
    JSON,
    Promise,
    setInterval() {},
    fetch(url, options) {
      requests.push({ url, options });
      const next = queue.length ? queue.shift() : { ok: false, status: 500, body: null };
      return Promise.resolve({ ok: next.ok, status: next.status || (next.ok ? 200 : 500), json: () => Promise.resolve(next.body) });
    },
  };
  vm.runInNewContext(readFileSync(new URL("../public/shop-hours.js", import.meta.url), "utf8"), sandbox);
  return { window, requests, events };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const bkk = (iso) => new Date(`${iso}+07:00`);

function status(overrides = {}) {
  return {
    ok: true,
    open: true,
    reason: "schedule",
    opensAt: null,
    closesAt: new Date(bkk("2026-10-13T18:00:00")).toISOString(),
    changeAt: bkk("2026-10-13T18:00:00").getTime(),
    ...overrides,
  };
}

test("the page asks the server once on load, and counts as open until the answer arrives", async () => {
  const { window, requests } = loadShopHours([{ ok: true, body: status({ open: false, closesAt: null, opensAt: new Date(bkk("2026-10-14T06:00:00")).toISOString(), changeAt: bkk("2026-10-14T06:00:00").getTime() }) }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/shop-status");
  assert.equal(window.isShopOpen(bkk("2026-10-13T22:00:00")), true); // nothing known yet
  await settle();
  assert.equal(window.isShopOpen(bkk("2026-10-13T22:00:00")), false);
});

test("the last answer is used until its next change, then the state flips", async () => {
  const { window } = loadShopHours([{ ok: true, body: status() }]);
  await settle();
  assert.equal(window.isShopOpen(bkk("2026-10-13T12:00:00")), true);
  assert.equal(window.isShopOpen(bkk("2026-10-13T17:59:00")), true);
  assert.equal(window.isShopOpen(bkk("2026-10-13T18:00:00")), false); // closing time reached
});

test("a failed request leaves the shop counted as open", async () => {
  const { window } = loadShopHours([{ ok: false }]);
  await settle();
  assert.equal(window.shopStatus(), null);
  assert.equal(window.isShopOpen(bkk("2026-10-13T03:00:00")), true);
});

test("the closed banner names the next opening and is empty while open", async () => {
  const closed = status({ open: false, closesAt: null, opensAt: new Date(bkk("2026-10-14T06:00:00")).toISOString(), changeAt: bkk("2026-10-14T06:00:00").getTime() });
  const { window } = loadShopHours([{ ok: true, body: closed }]);
  await settle();
  const notice = window.shopClosedNotice(bkk("2026-10-13T22:00:00"));
  assert.match(notice, /ร้านปิดอยู่/);
  assert.match(notice, /06:00/);
  assert.match(notice, /หยุดอัปเดตอัตโนมัติ/);

  const open = loadShopHours([{ ok: true, body: status() }]);
  await settle();
  assert.equal(open.window.shopClosedNotice(bkk("2026-10-13T12:00:00")), "");
});

test("manual open and manual close are described differently", async () => {
  const manualOpen = loadShopHours([{ ok: true, body: status({ reason: "manual-open" }) }]);
  await settle();
  assert.match(manualOpen.window.shopStatusText(), /เปิดร้านพิเศษ/);

  const manualClosed = loadShopHours([{ ok: true, body: status({ open: false, reason: "manual-closed", closesAt: null, opensAt: new Date(bkk("2026-10-14T06:00:00")).toISOString(), changeAt: bkk("2026-10-14T06:00:00").getTime() }) }]);
  await settle();
  assert.match(manualClosed.window.shopStatusText(), /ปิดร้านชั่วคราว/);
});

test("open now posts the right action, with hours only when given, and updates the state", async () => {
  const { window, requests, events } = loadShopHours([
    { ok: true, body: status({ open: false, closesAt: null, opensAt: new Date(bkk("2026-10-14T06:00:00")).toISOString(), changeAt: bkk("2026-10-14T06:00:00").getTime() }) },
    { ok: true, body: status({ reason: "manual-open" }) },
    { ok: true, body: status({ reason: "manual-open" }) },
  ]);
  await settle();
  await window.shopOpenNow();
  assert.deepEqual(JSON.parse(requests[1].options.body), { action: "open-now" });
  assert.equal(requests[1].options.method, "POST");
  assert.equal(window.isShopOpen(bkk("2026-10-13T12:00:00")), true);

  await window.shopOpenNow(3);
  assert.deepEqual(JSON.parse(requests[2].options.body), { action: "open-now", hours: 3 });
  assert.ok(events.includes("shop-state-change"));
});

test("close now, clear and save-schedule post their actions", async () => {
  const body = status();
  const { window, requests } = loadShopHours([{ ok: true, body }, { ok: true, body }, { ok: true, body }, { ok: true, body }]);
  await settle();
  await window.shopCloseNow();
  await window.shopClearOverride();
  await window.shopSaveSchedule({ mon: { closed: true } });
  assert.deepEqual(JSON.parse(requests[1].options.body), { action: "close-now" });
  assert.deepEqual(JSON.parse(requests[2].options.body), { action: "clear-override" });
  assert.deepEqual(JSON.parse(requests[3].options.body), { action: "set-schedule", schedule: { mon: { closed: true } } });
});

test("a refused save rejects with the server's message and keeps the old state", async () => {
  const { window } = loadShopHours([
    { ok: true, body: status() },
    { ok: false, status: 400, body: { ok: false, error: "hours_required", message: "Past today's closing time" } },
  ]);
  await settle();
  await assert.rejects(() => window.shopOpenNow(), (error) => error.code === "hours_required" && /closing time/.test(error.message));
  assert.equal(window.shopStatus().open, true);
});
