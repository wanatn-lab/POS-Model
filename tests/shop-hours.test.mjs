import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// Load the browser script in a fake window (no real timers / network).
function loadShopHours() {
  const window = {};
  const fetchCalls = [];
  const sandbox = {
    window,
    document: { dispatchEvent() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Intl,
    Date,
    Number,
    setInterval() {},
    fetch(url) { fetchCalls.push(url); return Promise.resolve({ ok: false }); },
  };
  vm.runInNewContext(readFileSync(new URL("../public/shop-hours.js", import.meta.url), "utf8"), sandbox);
  return { window, fetchCalls };
}

// objects from the vm context have another prototype; compare plain copies
const plain = (value) => JSON.parse(JSON.stringify(value));

// Bangkok is UTC+7. 2026-10-13 is a Tuesday, 2026-10-12 a Monday.
const bkk = (iso) => new Date(iso + "+07:00");

test("open 11:20 up to (not including) 21:00 on a normal day", () => {
  const { window } = loadShopHours();
  assert.equal(window.isShopOpen(bkk("2026-10-13T11:19:00")), false);
  assert.equal(window.isShopOpen(bkk("2026-10-13T11:20:00")), true);
  assert.equal(window.isShopOpen(bkk("2026-10-13T20:59:00")), true);
  assert.equal(window.isShopOpen(bkk("2026-10-13T21:00:00")), false);
  assert.equal(window.isShopOpen(bkk("2026-10-13T03:00:00")), false);
});

test("Monday is closed unless today was switched to a special opening", () => {
  const { window } = loadShopHours();
  assert.equal(window.isShopOpen(bkk("2026-10-12T15:00:00")), false);
  assert.deepEqual(plain(window.shopDayInfo(bkk("2026-10-12T15:00:00"))), { closedDay: true, special: false });

  window.setShopSpecialOpenDate("2026-10-12");
  assert.equal(window.isShopOpen(bkk("2026-10-12T15:00:00")), true);
  assert.equal(window.isShopOpen(bkk("2026-10-12T11:19:00")), false); // hours still apply
  assert.equal(window.isShopOpen(bkk("2026-10-19T15:00:00")), false); // next Monday: not special
  assert.deepEqual(plain(window.shopDayInfo(bkk("2026-10-12T15:00:00"))), { closedDay: true, special: true });

  window.setShopSpecialOpenDate(null);
  assert.equal(window.isShopOpen(bkk("2026-10-12T15:00:00")), false);
});

test("Bangkok weekday is used, not the server's", () => {
  const { window } = loadShopHours();
  // Sunday 23:30 UTC is already Monday 06:30 in Bangkok; Monday 17:30 UTC is Tuesday 00:30.
  assert.equal(window.shopDayInfo(new Date("2026-10-11T23:30:00Z")).closedDay, true);
  assert.equal(window.shopDayInfo(new Date("2026-10-12T17:30:00Z")).closedDay, false);
});

test("closed notice explains why auto refresh is off, and is empty while open", () => {
  const { window } = loadShopHours();
  assert.equal(window.shopClosedNotice(bkk("2026-10-13T14:00:00")), "");
  assert.match(window.shopClosedNotice(bkk("2026-10-13T22:00:00")), /นอกเวลาเปิดร้าน/);
  assert.match(window.shopClosedNotice(bkk("2026-10-12T14:00:00")), /วันจันทร์/);
  window.setShopSpecialOpenDate("2026-10-12");
  assert.equal(window.shopClosedNotice(bkk("2026-10-12T14:00:00")), "");
});
