import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTES, handleApiRequest } from "../src/api-router.js";
import { RULES, authMode, authorize, quickReject, rolesFor, signToken } from "../src/auth.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { fakeSql } from "./cf-helpers.mjs";

const ORIGIN = "https://shop.example";
const ENV = {
  SESSION_SECRET: "session-secret-for-tests-0123456789abcdef",
  OWNER_PASSWORD: "owner-password-123",
  STAFF_PASSWORD: "staff-password-123",
  BILL_READER_TOKEN: "reader-token-for-tests-0123456789abcdef",
};
const ITEM = { id: "m1", name: "กระเพรา", price: 59, qty: 1, category: "อาหาร" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(env = {}) {
  const store = new SqliteStore(fakeSql());
  const fullEnv = { ...ENV, ...env };
  const call = (method, path, body, { cookie, bearer, origin = ORIGIN, headers = {}, base = ORIGIN } = {}) =>
    handleApiRequest(
      new Request(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(method !== "GET" && origin ? { origin } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { store, env: fullEnv },
    );
  return { store, call, env: fullEnv };
}

const cookieOf = (response) => response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");

async function login(call, role, password) {
  const response = await call("POST", "/api/auth/login", { role, password });
  assert.equal(response.status, 200, `login as ${role}`);
  return cookieOf(response);
}

// A shop with an owner, a staff member, one print device and one customer at table 3.
async function world(env) {
  const shop = setup(env);
  const owner = await login(shop.call, "owner", ENV.OWNER_PASSWORD);
  const staff = await login(shop.call, "staff", ENV.STAFF_PASSWORD);
  const created = await (await shop.call("POST", "/api/devices", { action: "create", name: "counter" }, { cookie: owner })).json();
  const placed = await shop.call("POST", "/api/orders", { table: 3, items: [ITEM] });
  assert.equal(placed.status, 200);
  return {
    ...shop,
    owner,
    staff,
    deviceId: created.device.id,
    deviceToken: created.token,
    creds: {
      public: {},
      customer: { cookie: cookieOf(placed) },
      device: { bearer: created.token },
      reader: { bearer: ENV.BILL_READER_TOKEN },
      staff: { cookie: staff },
      owner: { cookie: owner },
    },
  };
}

async function newDevice(w, name) {
  const created = await (await w.call("POST", "/api/devices", { action: "create", name }, { cookie: w.owner })).json();
  return { id: created.device.id, token: created.token };
}

// ---------------------------------------------------------------------------------------------
// 1. The access matrix: every route x method x role

const EVERYONE = ["public", "customer", "device", "reader", "staff", "owner"];
const STAFF_UP = ["staff", "owner"];
const MATRIX = [
  ["GET menu", "GET", "/api/menu", undefined, EVERYONE],
  ["POST menu (edit)", "POST", "/api/menu", [], ["owner"]],
  ["POST menu (sold out)", "POST", "/api/menu", { action: "set-availability", id: "m1", available: false }, STAFF_UP],
  ["GET settings", "GET", "/api/settings", undefined, EVERYONE],
  ["POST settings", "POST", "/api/settings", { shopName: "x" }, ["owner"]],
  ["GET shop-status", "GET", "/api/shop-status", undefined, EVERYONE],
  ["POST shop-status", "POST", "/api/shop-status", { action: "open" }, ["owner"]],
  ["GET orders", "GET", "/api/orders", undefined, ["customer", "device", "staff", "owner"]],
  ["POST orders (place)", "POST", "/api/orders", { table: 3, items: [ITEM] }, EVERYONE], // table 3 = the customer's own table
  ["POST orders (done)", "POST", "/api/orders", { action: "done", id: "nope" }, STAFF_UP],
  ["GET table-status", "GET", "/api/table-status", undefined, STAFF_UP],
  ["POST table-status", "POST", "/api/table-status", { action: "clear-table", table: 9 }, STAFF_UP],
  ["GET bill-history", "GET", "/api/bill-history", undefined, ["reader", "staff", "owner"]],
  ["POST bill-history", "POST", "/api/bill-history", { action: "reprint", id: "nope" }, STAFF_UP],
  ["GET print-jobs", "GET", "/api/print-jobs", undefined, ["device"]],
  ["POST print-jobs", "POST", "/api/print-jobs", { action: "claim", id: "nope" }, ["device"]],
  ["GET printer-status", "GET", "/api/printer-status", undefined, STAFF_UP],
  ["POST printer-status", "POST", "/api/printer-status", { printers: [] }, ["device"]],
  ["GET qr-print-jobs", "GET", "/api/qr-print-jobs", undefined, ["device"]],
  ["POST qr-print-jobs (create)", "POST", "/api/qr-print-jobs", { action: "create", table: 2 }, STAFF_UP],
  ["POST qr-print-jobs (complete)", "POST", "/api/qr-print-jobs", { action: "complete", id: "nope" }, ["device"]],
  ["GET kitchen", "GET", "/api/kitchen", undefined, STAFF_UP],
  ["POST kitchen", "POST", "/api/kitchen", { action: "rush" }, STAFF_UP],
  ["GET devices", "GET", "/api/devices", undefined, ["owner"]],
  ["POST devices", "POST", "/api/devices", { action: "create", name: "tablet" }, ["owner"]],
];

for (const [label, method, path, body, allowed] of MATRIX) {
  test(`matrix: ${label} -> allowed for ${allowed.join(", ")}`, async () => {
    for (const role of EVERYONE) {
      const w = await world();
      const response = await w.call(method, path, body, w.creds[role]);
      if (allowed.includes(role)) {
        assert.ok(![401, 403].includes(response.status), `${role} should be allowed, got ${response.status}`);
      } else {
        assert.equal(response.status, role === "public" ? 401 : 403, `${role} should be refused`);
      }
    }
  });
}

test("every API handler has an access rule, and nothing unknown is allowed", () => {
  for (const route of ROUTES) {
    assert.ok(RULES[route], `route "${route}" has no entry in RULES`);
    assert.ok(RULES[route].GET || RULES[route].POST, `route "${route}" allows no method`);
  }
  for (const route of Object.keys(RULES)) assert.ok(ROUTES.includes(route) || route === "devices", `RULES has unknown route ${route}`);
  assert.equal(rolesFor("orders", "DELETE", {}), null);
  assert.equal(rolesFor("no-such-route", "GET"), null);
});

test("a route with no rule is refused for everyone, owner included", () => {
  for (const role of ["public", "customer", "device", "reader", "staff", "owner"]) {
    const verdict = authorize("brand-new-route", "GET", {}, { role });
    assert.equal(verdict.ok, false, role);
    assert.equal(verdict.status, 403, role);
  }
});

test("an action name cannot be used to reach inherited object properties", () => {
  assert.deepEqual(rolesFor("qr-print-jobs", "POST", { action: "toString" }), ["device"]);
  assert.deepEqual(rolesFor("orders", "POST", { action: "constructor" }), ["public"]);
  assert.deepEqual(rolesFor("orders", "POST", { action: "__proto__" }), ["public"]);
  assert.deepEqual(rolesFor("orders", "POST", { action: ["done"] }), ["public"]);
});

test("unknown route stays 404 and an unsupported method is 405 even when signed out", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/does-not-exist")).status, 404);
  assert.equal((await call("PUT", "/api/orders", {})).status, 405);
});

// ---------------------------------------------------------------------------------------------
// 2. Customers (table pass)

test("customer: sees only their own table; no pass, no orders", async () => {
  const w = setup();
  const a = cookieOf(await w.call("POST", "/api/orders", { table: 3, items: [ITEM] }));
  const b = cookieOf(await w.call("POST", "/api/orders", { table: 4, items: [ITEM] }));

  assert.equal((await w.call("GET", "/api/orders")).status, 401);
  const seenByA = await (await w.call("GET", "/api/orders", undefined, { cookie: a })).json();
  assert.deepEqual(seenByA.map((order) => String(order.table)), ["3"]);
  const seenByB = await (await w.call("GET", "/api/orders", undefined, { cookie: b })).json();
  assert.deepEqual(seenByB.map((order) => String(order.table)), ["4"]);

  // asking for another table in the URL changes nothing
  const sneaky = await (await w.call("GET", "/api/orders?table=4", undefined, { cookie: a })).json();
  assert.deepEqual(sneaky.map((order) => String(order.table)), ["3"]);
  // a table pass is worth nothing on staff routes
  assert.equal((await w.call("GET", "/api/table-status", undefined, { cookie: a })).status, 403);
});

test("customer: pass cookie is HttpOnly, SameSite=Strict, limited to /api, Secure on https", async () => {
  const w = setup();
  const https = (await w.call("POST", "/api/orders", { table: 3, items: [ITEM] })).headers.getSetCookie()[0];
  assert.match(https, /^jinko_table=/);
  for (const part of ["HttpOnly", "SameSite=Strict", "Path=/api", "Secure"]) assert.ok(https.includes(part), part);
  const http = (await w.call("POST", "/api/orders", { table: 3, items: [ITEM] }, { base: "http://localhost:8787", origin: "http://localhost:8787" })).headers.getSetCookie()[0];
  assert.ok(!http.includes("Secure"));
});

test("customer: a forged or edited pass is refused", async () => {
  const w = setup();
  const pass = cookieOf(await w.call("POST", "/api/orders", { table: 3, items: [ITEM] })).replace("jinko_table=", "");
  const [body, signature] = pass.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ t: "4", v: 0, exp: Date.now() + 1e7 })).toString("base64url");
  assert.equal((await w.call("GET", "/api/orders", undefined, { cookie: `jinko_table=${forgedBody}.${signature}` })).status, 401);
  assert.equal((await w.call("GET", "/api/orders", undefined, { cookie: `jinko_table=${body}.AAAA` })).status, 401);
  assert.equal((await w.call("GET", "/api/orders", undefined, { cookie: "jinko_table=garbage" })).status, 401);
  // a session-signed token cannot be replayed as a table pass, nor the other way round
  const sessionLike = await signToken(w.env, "session", { t: "3", v: 0, exp: Date.now() + 1e7 });
  assert.equal((await w.call("GET", "/api/orders", undefined, { cookie: `jinko_table=${sessionLike}` })).status, 401);
  const tableLike = await signToken(w.env, "table", { r: "owner", exp: Date.now() + 1e7 });
  assert.equal((await w.call("GET", "/api/devices", undefined, { cookie: `jinko_session=${tableLike}` })).status, 401);
});

test("customer: after staff clears the table the old pass stops working and the next customer starts clean", async () => {
  const w = await world();
  const old = w.creds.customer;
  assert.equal((await w.call("GET", "/api/orders", undefined, old)).status, 200);

  assert.equal((await w.call("POST", "/api/table-status", { action: "clear-table", table: 3 }, w.creds.staff)).status, 200);
  assert.equal((await w.call("GET", "/api/orders", undefined, old)).status, 401);

  await sleep(5);
  const next = await w.call("POST", "/api/orders", { table: 3, items: [{ ...ITEM, name: "ข้าวผัด" }] });
  const seen = await (await w.call("GET", "/api/orders", undefined, { cookie: cookieOf(next) })).json();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].items[0].name, "ข้าวผัด"); // not the previous customer's กระเพรา
  assert.equal((await w.call("GET", "/api/orders", undefined, old)).status, 401); // the old pass stays dead
});

test("customer: checkout also invalidates the pass", async () => {
  const w = await world();
  const done = await w.call("POST", "/api/table-status", { action: "checkout", table: 3 }, w.creds.staff);
  assert.equal(done.status, 200);
  assert.equal((await w.call("GET", "/api/orders", undefined, w.creds.customer)).status, 401);
});

test("orders: table number must exist and is stored in one canonical form", async () => {
  const w = setup();
  for (const table of [0, "0", 999, 21, "abc", "", null, "1e1", -1]) {
    const response = await w.call("POST", "/api/orders", { table, items: [ITEM] });
    assert.equal(response.status, 400, `table ${JSON.stringify(table)}`);
  }
  const owner = await login(w.call, "owner", ENV.OWNER_PASSWORD);
  await w.call("POST", "/api/settings", { tableCount: 5 }, { cookie: owner });
  assert.equal((await w.call("POST", "/api/orders", { table: 6, items: [ITEM] })).status, 400);
  const placed = await w.call("POST", "/api/orders", { table: " 05 ", items: [ITEM] });
  assert.equal(placed.status, 200);
  assert.equal((await placed.json()).order.table, "5");
});

test("orders: a table can only send so many orders per minute; staff are not limited", async () => {
  const w = setup({ ORDER_RATE_PER_MIN: "3" });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await w.call("POST", "/api/orders", { table: 3, items: [ITEM] })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal((await w.call("POST", "/api/orders", { table: 4, items: [ITEM] })).status, 200); // other table unaffected

  const staff = await login(w.call, "staff", ENV.STAFF_PASSWORD);
  for (let i = 0; i < 6; i += 1) assert.equal((await w.call("POST", "/api/orders", { table: 3, items: [ITEM] }, { cookie: staff })).status, 200);
});

test("orders: one client cannot spray many tables", async () => {
  const w = setup({ ORDER_RATE_PER_MIN: "2" }); // per-client limit is 3x
  const statuses = [];
  for (let table = 1; table <= 8; table += 1) statuses.push((await w.call("POST", "/api/orders", { table, items: [ITEM] })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429, 429]);
});

// ---- regression: a table pass binds POST /api/orders to its own table -------------------------

const tablesIn = (orders) => orders.map((order) => String(order.table));

test("table pass: a holder of the pass for table 3 can not order for table 4, and gets no replacement pass", async () => {
  const w = await world(); // the customer holds the pass for table 3
  const pass = w.creds.customer;
  for (const table of [4, "4", "04", " 4 ", [4]]) {
    const response = await w.call("POST", "/api/orders", { table, items: [ITEM] }, pass);
    assert.equal(response.status, 403, `table ${JSON.stringify(table)}`);
    assert.equal(response.headers.getSetCookie().length, 0, "no replacement pass");
  }
  // nothing was stored for table 4 and the original pass is untouched
  assert.deepEqual(tablesIn(await (await w.call("GET", "/api/orders", undefined, w.creds.staff)).json()), ["3"]);
  assert.deepEqual(tablesIn(await (await w.call("GET", "/api/orders", undefined, pass)).json()), ["3"]);
});

test("table pass: ordering for the pass's own table still works, in any spelling, without a new pass", async () => {
  const w = await world();
  for (const table of [3, "3", "03", " 3 "]) {
    const response = await w.call("POST", "/api/orders", { table, items: [ITEM] }, w.creds.customer);
    assert.equal(response.status, 200, `table ${JSON.stringify(table)}`);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal((await response.json()).order.table, "3");
  }
});

test("table pass: a request with a pass is still checked for a valid table and the rate limit", async () => {
  const w = await world({ ORDER_RATE_PER_MIN: "3" });
  assert.equal((await w.call("POST", "/api/orders", { table: 999, items: [ITEM] }, w.creds.customer)).status, 400);
  assert.equal((await w.call("POST", "/api/orders", { items: [ITEM] }, w.creds.customer)).status, 400);
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await w.call("POST", "/api/orders", { table: 3, items: [ITEM] }, w.creds.customer)).status);
  assert.deepEqual(statuses, [200, 200, 429, 429]); // the order placed while building the world counted as the first
});

test("first order: without a pass (or with a dead one) any existing table is accepted and gets its pass", async () => {
  const w = await world();
  const fresh = await w.call("POST", "/api/orders", { table: 4, items: [ITEM] }); // no pass at all
  assert.equal(fresh.status, 200);
  assert.deepEqual(tablesIn(await (await w.call("GET", "/api/orders", undefined, { cookie: cookieOf(fresh) })).json()), ["4"]);

  // staff clear table 3: the old pass is dead, so its holder is a first-time orderer again
  await w.call("POST", "/api/table-status", { action: "clear-table", table: 3 }, w.creds.staff);
  const moved = await w.call("POST", "/api/orders", { table: 5, items: [ITEM] }, w.creds.customer);
  assert.equal(moved.status, 200);
  assert.deepEqual(tablesIn(await (await w.call("GET", "/api/orders", undefined, { cookie: cookieOf(moved) })).json()), ["5"]);
});

test("table pass: staff may order for any table, and a device or reader is not handed a customer pass", async () => {
  const w = await world();
  const byStaff = await w.call("POST", "/api/orders", { table: 8, items: [ITEM] }, w.creds.staff);
  assert.equal(byStaff.status, 200);
  assert.equal(byStaff.headers.getSetCookie().length, 0);
});

test("table pass in AUTH_MODE=log: a mismatched order is logged as table_mismatch but no replacement pass is issued", async () => {
  const w = await world({ AUTH_MODE: "log" });
  let response;
  const lines = await captureLogs(async () => {
    response = await w.call("POST", "/api/orders", { table: 4, items: [ITEM] }, w.creds.customer);
  });
  assert.equal(response.status, 200); // log mode never blocks
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.ok(lines.some((line) => line.includes("table_mismatch")));
  assert.deepEqual(tablesIn(await (await w.call("GET", "/api/orders", undefined, w.creds.customer)).json()).sort(), ["3", "4"]); // log mode: unfiltered, as before
});

// ---- regression: /api/auth/me tells the login gate whether enforcement is active --------------

test("/api/auth/me reports the mode so the gate only forces a login when enforcing", async () => {
  const expected = [[undefined, "enforce"], ["enforce", "enforce"], ["log", "log"], ["off", "off"], ["garbage", "enforce"]];
  for (const [AUTH_MODE, mode] of expected) {
    const body = await (await setup({ AUTH_MODE }).call("GET", "/api/auth/me")).json();
    assert.deepEqual({ role: body.role, mode: body.mode }, { role: "public", mode }, String(AUTH_MODE));
  }
});

test("orders: a cookie-authenticated order must come from our own pages", async () => {
  const w = await world();
  const evil = await w.call("POST", "/api/orders", { table: 3, items: [ITEM] }, { ...w.creds.customer, origin: "https://evil.example" });
  assert.equal(evil.status, 403);
});

// ---------------------------------------------------------------------------------------------
// 3. Settings visibility

test("settings: the public only sees shopName and tableCount; devices and staff see everything", async () => {
  const w = await world();
  await w.call("POST", "/api/settings", { receipt: { taxId: "0123456789012", address: "secret street" }, printers: [{ ip: "10.0.0.5" }] }, w.creds.owner);
  for (const role of ["public", "customer", "reader"]) {
    const body = await (await w.call("GET", "/api/settings", undefined, w.creds[role])).json();
    assert.deepEqual(Object.keys(body).sort(), ["shopName", "tableCount"], role);
  }
  for (const role of ["device", "staff", "owner"]) {
    const body = await (await w.call("GET", "/api/settings", undefined, w.creds[role])).json();
    assert.equal(body.receipt.taxId, "0123456789012", role);
    assert.ok(body.printers);
  }
});

// ---------------------------------------------------------------------------------------------
// 4. Staff / owner sessions

test("login: not configured, short password and missing signing secret all answer 503", async () => {
  const body = { role: "owner", password: "whatever-whatever" };
  assert.equal((await setup({ OWNER_PASSWORD: undefined }).call("POST", "/api/auth/login", body)).status, 503);
  assert.equal((await setup({ OWNER_PASSWORD: "short" }).call("POST", "/api/auth/login", { role: "owner", password: "short" })).status, 503);
  assert.equal((await setup({ SESSION_SECRET: undefined }).call("POST", "/api/auth/login", body)).status, 503);
  assert.equal((await setup({ SESSION_SECRET: "too-short" }).call("POST", "/api/auth/login", body)).status, 503);
  assert.equal((await setup().call("POST", "/api/auth/login", { role: "admin", password: ENV.OWNER_PASSWORD })).status, 400);
});

test("login: right password gives a hardened cookie, wrong password gives none", async () => {
  const { call } = setup();
  const bad = await call("POST", "/api/auth/login", { role: "owner", password: "not-the-password" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.getSetCookie().length, 0);
  assert.equal((await call("POST", "/api/auth/login", { role: "owner", password: ENV.STAFF_PASSWORD })).status, 401);

  const good = await call("POST", "/api/auth/login", { role: "staff", password: ENV.STAFF_PASSWORD });
  const cookie = good.headers.getSetCookie()[0];
  for (const part of ["jinko_session=", "HttpOnly", "SameSite=Strict", "Path=/", "Secure", "Max-Age=43200"]) assert.ok(cookie.includes(part), part);
  const me = await (await call("GET", "/api/auth/me", undefined, { cookie: cookieOf(good) })).json();
  assert.equal(me.role, "staff");
  assert.equal((await (await call("GET", "/api/auth/me")).json()).role, "public");
});

test("login: five wrong passwords lock that role out for this client, even with the right password", async () => {
  const { call } = setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await call("POST", "/api/auth/login", { role: "owner", password: `wrong-password-${i}` })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { role: "owner", password: ENV.OWNER_PASSWORD })).status, 429);
  assert.equal((await call("POST", "/api/auth/login", { role: "staff", password: ENV.STAFF_PASSWORD })).status, 200); // other role unaffected
});

test("login: a successful login resets the failure count", async () => {
  const { call } = setup();
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 4; i += 1) await call("POST", "/api/auth/login", { role: "owner", password: "nope-nope-nope" });
    assert.equal((await call("POST", "/api/auth/login", { role: "owner", password: ENV.OWNER_PASSWORD })).status, 200);
  }
});

test("login and logout refuse requests from other sites", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/auth/login", { role: "staff", password: ENV.STAFF_PASSWORD }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("POST", "/api/auth/login", { role: "staff", password: ENV.STAFF_PASSWORD }, { origin: null, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await call("POST", "/api/auth/login", { role: "staff", password: ENV.STAFF_PASSWORD }, { origin: null, headers: { "sec-fetch-site": "same-origin" } })).status, 200);
});

test("session: staff cannot do owner things; logout clears the cookie", async () => {
  const w = await world();
  assert.equal((await w.call("POST", "/api/menu", [], w.creds.staff)).status, 403);
  assert.equal((await w.call("POST", "/api/menu", { action: "set-availability", id: "m1", available: false }, w.creds.staff)).status, 200);
  assert.equal((await w.call("POST", "/api/menu", { action: "set-availability", id: "m1", available: false }, w.creds.customer)).status, 403);
  assert.equal((await w.call("POST", "/api/settings", { shopName: "x" }, w.creds.staff)).status, 403);
  assert.equal((await w.call("GET", "/api/devices", undefined, w.creds.staff)).status, 403);
  assert.equal((await w.call("POST", "/api/bill-history", { action: "reprint", id: "nope" }, w.creds.staff)).status, 404); // staff may reach it (bill missing)

  const out = await w.call("POST", "/api/auth/logout", undefined, w.creds.staff);
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0], /^jinko_session=;.*Max-Age=0/);
});

test("session: expired, tampered or foreign-signed cookies are refused", async () => {
  const { call, env } = setup();
  const live = await signToken(env, "session", { r: "owner", exp: Date.now() + 60_000 });
  assert.equal((await call("GET", "/api/devices", undefined, { cookie: `jinko_session=${live}` })).status, 200);

  const expired = await signToken(env, "session", { r: "owner", exp: Date.now() - 1000 });
  assert.equal((await call("GET", "/api/devices", undefined, { cookie: `jinko_session=${expired}` })).status, 401);

  // Replace the second-to-last character with one that is guaranteed to be different.
  const original = live.at(-2);
  const replacement = original === "A" ? "B" : "A";
  const flipped = `${live.slice(0, -2)}${replacement}${live.slice(-1)}`;
  assert.notEqual(flipped, live);
  assert.equal((await call("GET", "/api/devices", undefined, { cookie: `jinko_session=${flipped}` })).status, 401);

  const foreign = await signToken({ SESSION_SECRET: "another-secret-another-secret-12345" }, "session", { r: "owner", exp: Date.now() + 60_000 });
  assert.equal((await call("GET", "/api/devices", undefined, { cookie: `jinko_session=${foreign}` })).status, 401);

  const promoted = await signToken(env, "session", { r: "admin", exp: Date.now() + 60_000 });
  assert.equal((await call("GET", "/api/devices", undefined, { cookie: `jinko_session=${promoted}` })).status, 401);
});

test("session: a cookie-authenticated change from another site is refused", async () => {
  const w = await world();
  const body = { action: "clear-table", table: 9 };
  assert.equal((await w.call("POST", "/api/table-status", body, { ...w.creds.staff, origin: "https://evil.example" })).status, 403);
  assert.equal((await w.call("POST", "/api/table-status", body, { ...w.creds.staff, origin: null, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await w.call("POST", "/api/table-status", body, w.creds.staff)).status, 200);
  // reading is not a state change
  assert.equal((await w.call("GET", "/api/table-status", undefined, { ...w.creds.staff, headers: { origin: "https://evil.example" } })).status, 200);
});

// ---------------------------------------------------------------------------------------------
// 5. Print devices

async function receiptJob(w) {
  await w.call("POST", "/api/orders", { table: 5, items: [ITEM] });
  const checkout = await (await w.call("POST", "/api/table-status", { action: "checkout", table: 5, printReceipt: true }, w.creds.staff)).json();
  assert.ok(checkout.receiptJobId);
  return checkout.receiptJobId;
}

test("device: created once, the secret is never stored or listed", async () => {
  const w = await world();
  const secret = w.deviceToken.split(".")[1];
  assert.match(w.deviceToken, /^dev_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
  const listed = JSON.stringify(await (await w.call("GET", "/api/devices", undefined, w.creds.owner)).json());
  assert.ok(listed.includes(w.deviceId));
  assert.ok(!listed.includes(secret) && !/hash/i.test(listed));
  assert.ok(!JSON.stringify(w.store.exportAll()).includes(secret)); // backups hold only the hash
});

test("device: its identity comes from the credential, not from the request body", async () => {
  const w = await world();
  const id = await receiptJob(w);
  const claimed = await (await w.call("POST", "/api/print-jobs", { action: "claim", id, deviceId: "attacker-device-0001" }, w.creds.device)).json();
  assert.equal(claimed.job.claimedBy, w.deviceId);

  const status = await w.call("POST", "/api/printer-status", { instanceId: "spoofed-agent", hostname: "tablet", printers: [] }, w.creds.device);
  assert.equal(status.status, 200);
  const listed = JSON.stringify(await (await w.call("GET", "/api/printer-status", undefined, w.creds.staff)).json());
  assert.ok(listed.includes(w.deviceId) && !listed.includes("spoofed-agent"));
});

test("device: two devices can not take over each other's job", async () => {
  const w = await world();
  const second = await newDevice(w, "kitchen");
  const id = await receiptJob(w);
  assert.equal((await w.call("POST", "/api/print-jobs", { action: "claim", id }, w.creds.device)).status, 200);
  assert.equal((await w.call("POST", "/api/print-jobs", { action: "claim", id }, { bearer: second.token })).status, 409);
  assert.equal((await w.call("POST", "/api/print-jobs", { action: "complete", id }, { bearer: second.token })).status, 409);
  assert.equal((await w.call("POST", "/api/print-jobs", { action: "complete", id }, w.creds.device)).status, 200);
});

test("device: wrong, unknown or malformed tokens are refused; people are not devices", async () => {
  const w = await world();
  const [id, secret] = w.deviceToken.split(".");
  const tokens = [`${id}.${"x".repeat(43)}`, `dev_000000000000.${secret}`, id, `${id}.short`, "garbage", ""];
  for (const token of tokens) assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: token || undefined })).status, 401, token);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, w.creds.staff)).status, 403);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, w.creds.owner)).status, 403);
});

test("device: rotation keeps the old token working until the owner finishes it", async () => {
  const w = await world();
  const rotated = await (await w.call("POST", "/api/devices", { action: "rotate", id: w.deviceId }, w.creds.owner)).json();
  assert.notEqual(rotated.token, w.deviceToken);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: rotated.token })).status, 200);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: w.deviceToken })).status, 200); // overlap

  await w.call("POST", "/api/devices", { action: "finish-rotation", id: w.deviceId }, w.creds.owner);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: w.deviceToken })).status, 401);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: rotated.token })).status, 200);
});

test("device: the overlap ends by itself after the grace period", async () => {
  const w = await world();
  const rotated = await (await w.call("POST", "/api/devices", { action: "rotate", id: w.deviceId }, w.creds.owner)).json();
  const devices = await w.store.get("auth:devices");
  devices[w.deviceId].previous.expiresAt = Date.now() - 1;
  await w.store.set("auth:devices", devices);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: w.deviceToken })).status, 401);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: rotated.token })).status, 200);
});

test("device: revoking one device cuts it off at once and leaves the others alone", async () => {
  const w = await world();
  const other = await newDevice(w, "spare");
  const rotated = await (await w.call("POST", "/api/devices", { action: "rotate", id: w.deviceId }, w.creds.owner)).json();
  assert.equal((await w.call("POST", "/api/devices", { action: "revoke", id: w.deviceId }, w.creds.owner)).status, 200);
  for (const bearer of [w.deviceToken, rotated.token]) assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer })).status, 401);
  assert.equal((await w.call("GET", "/api/print-jobs", undefined, { bearer: other.token })).status, 200);
  assert.equal((await w.call("POST", "/api/devices", { action: "rotate", id: w.deviceId }, w.creds.owner)).status, 409);
});

test("device: only the owner manages devices, with bounds", async () => {
  const w = await world();
  for (const role of ["public", "customer", "device", "reader", "staff"]) {
    const response = await w.call("POST", "/api/devices", { action: "create", name: "x" }, w.creds[role]);
    assert.equal(response.status, role === "public" ? 401 : 403, role);
  }
  assert.equal((await w.call("POST", "/api/devices", { action: "create", name: "  " }, w.creds.owner)).status, 400);
  assert.equal((await w.call("POST", "/api/devices", { action: "revoke", id: "dev_missing" }, w.creds.owner)).status, 404);
  assert.equal((await w.call("POST", "/api/devices", { action: "explode", id: w.deviceId }, w.creds.owner)).status, 400);
  for (let i = 0; i < 9; i += 1) assert.equal((await w.call("POST", "/api/devices", { action: "create", name: `d${i}` }, w.creds.owner)).status, 200);
  assert.equal((await w.call("POST", "/api/devices", { action: "create", name: "one too many" }, w.creds.owner)).status, 409);
});

// ---------------------------------------------------------------------------------------------
// 6. Bill Summary reader token

test("reader token: can fetch bills and nothing else; short or wrong tokens are refused", async () => {
  const w = await world();
  assert.equal((await w.call("GET", "/api/bill-history", undefined, w.creds.reader)).status, 200);
  assert.equal((await w.call("POST", "/api/bill-history", { action: "cancel", id: "x" }, w.creds.reader)).status, 403);
  assert.equal((await w.call("GET", "/api/orders", undefined, w.creds.reader)).status, 403);
  assert.equal((await w.call("GET", "/api/bill-history", undefined, { bearer: "wrong-token-wrong-token-wrong-token-1" })).status, 401);

  const weak = setup({ BILL_READER_TOKEN: "short" });
  assert.equal((await weak.call("GET", "/api/bill-history", undefined, { bearer: "short" })).status, 401);
  const unset = setup({ BILL_READER_TOKEN: undefined });
  assert.equal((await unset.call("GET", "/api/bill-history", undefined, { bearer: "undefined" })).status, 401);
});

// ---------------------------------------------------------------------------------------------
// 7. Denied requests, AUTH_MODE, logs

test("denied requests never read or write shop data", async () => {
  const w = await world();
  const touched = [];
  for (const name of ["get", "set", "del", "expire", "hset", "hgetall"]) {
    const original = w.store[name].bind(w.store);
    w.store[name] = (...args) => (touched.push(String(args[0])), original(...args));
  }
  const mget = w.store.mget.bind(w.store);
  w.store.mget = (...args) => (touched.push(...args.flat().map(String)), mget(...args));

  const attempts = [
    ["GET", "/api/orders", undefined, {}],
    ["POST", "/api/table-status", { action: "checkout", table: 3 }, {}],
    ["GET", "/api/bill-history", undefined, { bearer: "nope" }],
    ["POST", "/api/settings", { shopName: "hacked" }, w.creds.customer],
    ["POST", "/api/menu", [], w.creds.staff],
    ["GET", "/api/print-jobs", undefined, w.creds.owner],
    ["POST", "/api/bill-history", { action: "cancel", id: "x" }, w.creds.reader],
  ];
  for (const [method, path, body, creds] of attempts) assert.ok([401, 403].includes((await w.call(method, path, body, creds)).status), path);
  assert.deepEqual(touched.filter((key) => !key.startsWith("auth:")), []);
});

test("AUTH_MODE: unknown or missing values mean enforce", () => {
  assert.equal(authMode({}), "enforce");
  assert.equal(authMode(undefined), "enforce");
  assert.equal(authMode({ AUTH_MODE: "banana" }), "enforce");
  assert.equal(authMode({ AUTH_MODE: "" }), "enforce");
  assert.equal(authMode({ AUTH_MODE: "OFF" }), "off");
  assert.equal(authMode({ AUTH_MODE: " log " }), "log");
  assert.equal(authMode({ AUTH_MODE: "enforce" }), "enforce");
});

test("AUTH_MODE=off: old open behaviour, but device management stays owner-only", async () => {
  const w = setup({ AUTH_MODE: "off" });
  const placed = await w.call("POST", "/api/orders", { table: 3, items: [ITEM] });
  assert.equal(placed.status, 200);
  assert.equal(placed.headers.getSetCookie().length, 0);
  assert.equal((await w.call("GET", "/api/orders")).status, 200);
  assert.equal((await w.call("POST", "/api/table-status", { action: "clear-table", table: 3 })).status, 200);
  assert.ok("printers" in (await (await w.call("GET", "/api/settings")).json())); // full settings, as before
  assert.equal((await w.call("GET", "/api/devices")).status, 401);
});

async function captureLogs(run) {
  const lines = [];
  const saved = {};
  for (const level of ["log", "info", "warn", "error"]) {
    saved[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  try {
    await run();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

test("AUTH_MODE=log: nothing is blocked, would-be refusals are logged, customers already get passes", async () => {
  const w = setup({ AUTH_MODE: "log" });
  let cookie;
  const lines = await captureLogs(async () => {
    const placed = await w.call("POST", "/api/orders", { table: 3, items: [ITEM] });
    cookie = cookieOf(placed);
    await w.call("POST", "/api/orders", { table: 4, items: [ITEM] });
    const everything = await w.call("GET", "/api/orders"); // signed out, still served in full
    assert.equal(everything.status, 200);
    assert.equal((await everything.json()).length, 2);
    assert.equal((await w.call("POST", "/api/table-status", { action: "clear-table", table: 4 })).status, 200);
  });
  const denials = lines.filter((line) => line.includes('"evt":"auth.deny"'));
  assert.ok(denials.length >= 2);
  assert.ok(denials.some((line) => line.includes('"route":"orders"') && line.includes("no_credential")));
  assert.ok(denials.some((line) => line.includes('"route":"table-status"')));

  // the pass collected during the log phase keeps working once enforcement starts
  const enforced = { ...w.env, AUTH_MODE: "enforce" };
  const after = await handleApiRequest(new Request(`${ORIGIN}/api/orders`, { headers: { cookie } }), { store: w.store, env: enforced });
  assert.equal(after.status, 200);
  assert.deepEqual((await after.json()).map((order) => String(order.table)), ["3"]);
});

test("logs never contain passwords, secrets, tokens, cookies or client addresses", async () => {
  const w = await world();
  const secrets = [ENV.OWNER_PASSWORD, ENV.STAFF_PASSWORD, ENV.SESSION_SECRET, ENV.BILL_READER_TOKEN, w.deviceToken.split(".")[1], "203.0.113.77", "wrong-guess-password"];
  const lines = await captureLogs(async () => {
    const headers = { "cf-connecting-ip": "203.0.113.77" };
    for (let i = 0; i < 7; i += 1) await w.call("POST", "/api/auth/login", { role: "owner", password: "wrong-guess-password" }, { headers });
    await w.call("GET", "/api/orders", undefined, { headers });
    await w.call("POST", "/api/table-status", { action: "checkout", table: 3 }, { bearer: "x".repeat(40), headers });
    await w.call("POST", "/api/devices", { action: "rotate", id: w.deviceId }, w.creds.owner);
    await w.call("POST", "/api/devices", { action: "revoke", id: w.deviceId }, w.creds.owner);
    await w.call("GET", "/api/print-jobs", undefined, { bearer: w.deviceToken, headers });
  });
  assert.ok(lines.length > 0);
  const text = lines.join("\n");
  for (const secret of secrets) assert.ok(!text.includes(secret), `log leaked ${secret.slice(0, 6)}...`);
  const cookies = Object.values(w.creds).map((entry) => entry.cookie).filter(Boolean).map((value) => value.split("=")[1]);
  for (const value of cookies) assert.ok(!text.includes(value), "log leaked a cookie");
});

// ---------------------------------------------------------------------------------------------
// 8. Worker pre-filter (runs before the Durable Object is woken)

test("pre-filter: turns away credential-less calls to protected routes, lets the rest through", async () => {
  const env = { ...ENV };
  const req = (method, path, headers = {}) => new Request(`${ORIGIN}${path}`, { method, headers });
  const rejected = await quickReject(req("GET", "/api/orders"), env);
  assert.equal(rejected.status, 401);
  assert.equal((await quickReject(req("POST", "/api/table-status"), env)).status, 401);
  assert.equal((await quickReject(req("GET", "/api/devices"), env)).status, 401);
  assert.equal((await quickReject(req("GET", "/api/print-jobs", { authorization: "Bearer not-a-device-token" }), env)).status, 401);

  assert.equal(await quickReject(req("GET", "/api/menu"), env), null);
  assert.equal(await quickReject(req("POST", "/api/orders"), env), null); // placing an order is public
  assert.equal(await quickReject(req("POST", "/api/auth/login"), env), null);
  assert.equal(await quickReject(req("GET", "/api/nothing-here"), env), null);
  assert.equal(await quickReject(req("GET", "/api/print-jobs", { authorization: `Bearer dev_0123456789ab.${"A".repeat(43)}` }), env), null);
  assert.equal(await quickReject(req("GET", "/api/bill-history", { authorization: `Bearer ${ENV.BILL_READER_TOKEN}` }), env), null);

  const session = await signToken(env, "session", { r: "staff", exp: Date.now() + 60_000 });
  assert.equal(await quickReject(req("GET", "/api/orders", { cookie: `jinko_session=${session}` }), env), null);
  assert.equal((await quickReject(req("GET", "/api/orders", { cookie: `jinko_session=${session}x` }), env)).status, 401);
});

test("pre-filter does nothing unless AUTH_MODE is enforce", async () => {
  for (const AUTH_MODE of ["off", "log"]) {
    assert.equal(await quickReject(new Request(`${ORIGIN}/api/orders`), { ...ENV, AUTH_MODE }), null);
  }
});
