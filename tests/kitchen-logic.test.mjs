import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, cardTimes, createStore, fmtClock, levelAt, sortCards, toTickets } from "../public/kitchen-assets/logic.js";

const cfg = DEFAULT_CONFIG;
const T0 = Date.parse("2026-10-09T05:00:00Z");
const times = (createdMs, lastAddMs = null) => ({ createdMs, lastAddMs });
const at = (sec) => T0 + sec * 1000;

test("wait-time levels: 15 / 25 minute thresholds (no 20)", () => {
  const t = times(T0);
  assert.equal(levelAt(t, at(89), cfg), "new");
  assert.equal(levelAt(t, at(91), cfg), "ok");
  assert.equal(levelAt(t, at(14 * 60 + 59), cfg), "ok");
  assert.equal(levelAt(t, at(15 * 60), cfg), "warn");
  assert.equal(levelAt(t, at(20 * 60), cfg), "warn"); // 20 min is NOT special any more
  assert.equal(levelAt(t, at(24 * 60 + 59), cfg), "warn");
  assert.equal(levelAt(t, at(25 * 60), cfg), "late");
});

test("add-on turns an old card blue for 90s, then back to its waiting-time colour", () => {
  const added = at(26 * 60);
  const t = times(T0, added);
  assert.equal(levelAt(t, added + 30000, cfg), "new");
  assert.equal(levelAt(t, added + 91000, cfg), "late"); // wait time still counts from the first order
});

test("cancelled add-on does not trigger blue", () => {
  const card = { createdAt: new Date(T0).toISOString(), items: [{ isAddOn: true, st: "c", addedAt: new Date(at(1500)).toISOString() }] };
  assert.equal(cardTimes(card).lastAddMs, null);
});

test("clock format and one ticket per card", () => {
  assert.equal(fmtClock(65), "01:05");
  const card = { key: "1|0", items: Array.from({ length: 13 }, (_, i) => ({ lineId: "l" + i })) };
  const tickets = toTickets([card]);
  assert.deepEqual(tickets.map((t) => [t.parts, t.items.length]), [[1, 13]]);
});

test("sort: rush, then rank, then longest wait", () => {
  const c = (key, createdSec, extra = {}) => ({ key, createdAt: new Date(at(createdSec)).toISOString(), ...extra });
  const out = sortCards([c("new", 500), c("old", 0), c("ranked", 300, { rank: 0 }), c("rush", 400, { rush: true })]);
  assert.deepEqual(out.map((x) => x.key), ["rush", "ranked", "old", "new"]);
});

function fakeApi(initial) {
  const calls = [];
  return { calls, failNext: false, async get() { return structuredClone(initial); }, async post(b) { calls.push(b); if (this.failNext) throw new Error("x"); return { ok: true }; } };
}
const mkCard = (key, items) => ({ key, table: 1, billNo: "0001", createdAt: new Date(Date.now() - 60000).toISOString(), rush: false, rank: null, total: items.length, doneCount: 0, items });
const mkItem = (id, st = "p") => ({ lineId: id, orderId: "o", name: id, qty: 1, st, isAddOn: false });

test("store: ticking the last item moves the card to done; undo brings it back", async () => {
  const data = { serverNow: new Date().toISOString(), config: cfg, cards: [mkCard("1|0", [mkItem("a"), mkItem("b")])], done: [] };
  const api = fakeApi(data);
  const store = createStore({ api, onChange() {}, onError() {} });
  store.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.model().tickets.length, 1);
  await store.setItems(["a", "b"], "d");
  assert.equal(store.model().tickets.length, 0);
  assert.equal(store.model().done.length, 1);
  await store.undoDone("1|0");
  assert.equal(store.model().tickets.length, 1);
  assert.deepEqual(api.calls.map((c) => c.st), ["d", "p"]);
  store.stop();
});

test("store: failed save reports an error; offline blocks edits", async () => {
  const data = { serverNow: new Date().toISOString(), config: cfg, cards: [mkCard("1|0", [mkItem("a"), mkItem("b")])], done: [] };
  const api = fakeApi(data);
  const errors = [];
  const store = createStore({ api, onChange() {}, onError: (m) => errors.push(m) });
  store.start();
  await new Promise((r) => setTimeout(r, 20));
  api.failNext = true;
  await store.setItems(["a"], "d");
  assert.equal(errors.length, 1);
  store.markOffline();
  const before = api.calls.length;
  await store.setItems(["b"], "d");
  assert.equal(api.calls.length, before); // nothing sent while offline
  assert.match(errors[1], /ออฟไลน์/);
  store.stop();
});
