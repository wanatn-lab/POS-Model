import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/order.html", import.meta.url), "utf8");

test("showPrices only turns on for an explicit true from settings", () => {
  assert.match(html, /showPrices = settings\.showPrices === true;/);
  assert.match(html, /let showPrices = false;/);
});

test("prices in cart bar, review and history are hidden unless showPrices", () => {
  assert.match(html, /\$\{showPrices \? ` · ฿\$\{total\}` : ''\}/);
  assert.match(html, /showPrices \? `฿\$\{it\.price \* it\.qty\}` : ''/);
  assert.match(html, /\$\{showPrices \? `<span>฿\$\{escAttr\(it\.price \* it\.qty\)\}<\/span>` : ''\}/);
  assert.match(html, /reviewTotalRow'\)\.style\.display = showPrices \? 'flex' : 'none'/);
});

test("client sends only id, qty and optionIds; never price or name", () => {
  assert.match(html, /cartItems\(\)\.map\(\(\{ id, qty, optionIds \}\) => \(\{ id, qty, optionIds \}\)\)/);
  assert.match(html, /idempotencyKey: idempotencyKey\(\)/);
  assert.match(html, /pendingIdempotencyKey = null;/);
});

test("shop_closed from the server shows the banner instead of a generic error", () => {
  assert.match(html, /data\.error === 'shop_closed'/);
  assert.match(html, /shopClosedFail/);
});

test("success screen follows real order status and stops polling when closed", () => {
  assert.match(html, /order\.status === 'done'\) return 2/);
  assert.match(html, /order\.status === 'new'\) return 1/);
  assert.match(html, /order\.status === 'void'/);
  assert.match(html, /setInterval\(refreshOrderStatus, 12000\)/);
  assert.match(html, /function stopStatusPolling\(\)/);
  assert.match(html, /function closeSuccess\(\) \{\s*stopStatusPolling\(\)/);
});

test("history labels pending, cooking, served and cancelled orders separately", () => {
  for (const k of ["statusDone", "statusCooking", "statusPending", "statusVoid"]) {
    assert.match(html, new RegExp(k));
  }
  assert.match(html, /ออเดอร์ของวันนี้/);
  assert.doesNotMatch(html, /24 ชั่วโมง/);
});

test("menu text and notes are escaped; only https or /assets images load", () => {
  assert.match(html, /escAttr\(itemName\(item\)\)/);
  assert.match(html, /textContent = itemName\(item\)/);
  assert.match(html, /\$\{escAttr\(o\.note\)\}/);
  assert.match(html, /\/\^\\\/assets\\\//);
});

test("page keeps the staff hint and the pay-at-table note", () => {
  assert.match(html, /แก้ไขหรือยกเลิกรายการ แจ้งพนักงานได้ที่โต๊ะ/);
  assert.match(html, /ร้านจะคิดเงินที่โต๊ะ/);
});
