// Runs one API request against the store. Pure JavaScript (no Cloudflare imports) so it can be
// tested in plain Node. The Durable Object wrapper (shop-do.js) installs the store and env.
import billHistory from "../api/bill-history.js";
import kitchen from "../api/kitchen.js";
import menu from "../api/menu.js";
import orders from "../api/orders.js";
import printJobs from "../api/print-jobs.js";
import printerStatus from "../api/printer-status.js";
import qrPrintJobs from "../api/qr-print-jobs.js";
import settings from "../api/settings.js";
import shopStatus from "../api/shop-status.js";
import tableStatus from "../api/table-status.js";
import {
  CUSTOMER,
  DEFAULT_ORDERS_PER_MINUTE,
  DEVICE,
  OWNER,
  PUBLIC,
  STAFF,
  TABLE_COOKIE,
  TABLE_PASS_TTL_SEC,
  authMode,
  authorize,
  buildCookie,
  bumpTableVersion,
  clientLabel,
  issueTablePass,
  jsonResponse,
  logAuth,
  normalizeTable,
  rateHit,
  resolvePrincipal,
  sameOriginRequest,
  sameToken,
} from "./auth.js";
import { handleAuthRoute, handleDevicesRoute } from "./auth-routes.js";
import { createNodeLikeResponse, toNodeLikeRequest } from "./http-shim.js";

const HANDLERS = {
  "bill-history": billHistory,
  kitchen,
  menu,
  orders,
  "print-jobs": printJobs,
  "printer-status": printerStatus,
  "qr-print-jobs": qrPrintJobs,
  settings,
  "shop-status": shopStatus,
  "table-status": tableStatus,
};

// Exported so a test can prove that every handler has an access rule (src/auth.js RULES).
export const ROUTES = Object.keys(HANDLERS);

const DEFAULT_TABLE_COUNT = 20;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Backup/migration endpoints. Disabled (404) unless the ADMIN_TOKEN secret is configured.
// Separate from the staff/owner login on purpose, and not affected by AUTH_MODE.
async function adminRoute(request, name, { store, env }) {
  if (!env.ADMIN_TOKEN) return json(404, { ok: false, error: "not found" });
  const auth = request.headers.get("authorization") || "";
  if (!sameToken(auth.replace(/^Bearer\s+/i, ""), env.ADMIN_TOKEN)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  if (name === "export" && request.method === "GET") return json(200, { ok: true, data: store.exportAll() });
  if (name === "import" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json(400, { ok: false, error: "bad body" });
    const count = await store.importAll(body);
    return json(200, { ok: true, imported: count });
  }
  return json(405, { ok: false, error: "method not allowed" });
}

// Handlers do read -> change -> write across several awaits, so two requests running at the
// same time could both read the same state (e.g. two devices claiming one print job). We run
// requests one at a time per store; each is a few milliseconds, so the queue stays empty.
const queues = new WeakMap();
export function handleApiRequest(request, options) {
  const previous = queues.get(options.store) || Promise.resolve();
  const run = previous.then(() => handleApiRequestNow(request, options));
  queues.set(options.store, run.catch(() => {}));
  return run;
}

function bodyAction(body) {
  return body && typeof body === "object" && typeof body.action === "string" ? body.action : undefined;
}

function isCustomerOrderCreate(route, req, principal) {
  return (
    route === "orders" &&
    req.method === "POST" &&
    bodyAction(req.body) !== "done" &&
    principal.role !== STAFF &&
    principal.role !== OWNER
  );
}

// A customer (or anyone without a staff session) placing an order: the table must exist, and a
// table may only send so many orders per minute. Staff are not limited.
// Someone holding a table pass may only order for the table on that pass. Someone without a
// (valid) pass is the "first order" case: any existing table is accepted and a pass is issued.
async function checkOrderCreate(request, req, principal, { store, env }) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const table = normalizeTable(body.table);
  const saved = await store.get("settings");
  const tableCount = Number(saved && saved.tableCount) > 0 ? Number(saved.tableCount) : DEFAULT_TABLE_COUNT;
  if (!table || Number(table) > tableCount) {
    return { ok: false, status: 400, error: "invalid table", reason: "invalid_table" };
  }
  if (principal.role === CUSTOMER && table !== normalizeTable(principal.table)) {
    return { ok: false, status: 403, error: "forbidden", reason: "table_mismatch" };
  }
  const perMinute = Math.max(1, Math.floor(Number(env.ORDER_RATE_PER_MIN) || DEFAULT_ORDERS_PER_MINUTE));
  if ((await rateHit(store, `auth:rl:order:${table}`, 60)) > perMinute) {
    return { ok: false, status: 429, error: "too many orders", reason: "table_rate_limited" };
  }
  if ((await rateHit(store, `auth:rl:orderip:${await clientLabel(request)}`, 60)) > perMinute * 3) {
    return { ok: false, status: 429, error: "too many orders", reason: "client_rate_limited" };
  }
  return { ok: true, table };
}

async function decide(request, route, req, principal, context) {
  const verdict = authorize(route, req.method, req.body, principal);
  if (!verdict.ok) return verdict;
  // A browser sends cookies by itself, so a cookie-authenticated change must come from our own pages.
  if (principal.viaCookie && req.method !== "GET" && !sameOriginRequest(request)) {
    return { ok: false, status: 403, error: "forbidden", reason: "cross_origin" };
  }
  if (isCustomerOrderCreate(route, req, principal)) return checkOrderCreate(request, req, principal, context);
  return verdict;
}

async function handleApiRequestNow(request, { store, env = {} }) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/([^/]+?)(?:\.js)?\/?$/);
  const adminMatch = url.pathname.match(/^\/api\/_admin\/([a-z]+)\/?$/);
  const authMatch = url.pathname.match(/^\/api\/auth\/(login|logout|me)\/?$/);

  globalThis.__shopStore = store;
  globalThis.__shopEnv = env;

  if (adminMatch) return adminRoute(request, adminMatch[1], { store, env });
  if (authMatch) return handleAuthRoute(request, authMatch[1], { store, env });
  if (/^\/api\/devices\/?$/.test(url.pathname)) {
    return handleDevicesRoute(request, { store, env, principal: await resolvePrincipal(request, { store, env }) });
  }

  const route = match && Object.prototype.hasOwnProperty.call(HANDLERS, match[1]) ? match[1] : null;
  if (!route) return json(404, { ok: false, error: "not found" });
  const handler = HANDLERS[route];

  const mode = authMode(env);
  const req = await toNodeLikeRequest(request);
  let principal = null;
  if (mode !== "off") {
    principal = await resolvePrincipal(request, { store, env });
    const verdict = await decide(request, route, req, principal, { store, env });
    if (!verdict.ok) {
      logAuth("auth.deny", { mode, route, method: req.method, action: bodyAction(req.body), role: principal.role, reason: verdict.reason });
      if (mode === "enforce") return jsonResponse(verdict.status, { ok: false, error: verdict.error });
    } else if (mode === "enforce") {
      // Handlers learn who is calling only when the rules are enforced.
      req.auth = principal;
      if (principal.role === DEVICE && req.body && typeof req.body === "object") {
        // A device is identified by its credential, never by what it says about itself.
        if (route === "print-jobs") req.body = { ...req.body, deviceId: principal.deviceId };
        if (route === "printer-status") req.body = { ...req.body, instanceId: principal.deviceId };
      }
      if (isCustomerOrderCreate(route, req, principal)) req.body = { ...req.body, table: normalizeTable(req.body.table) };
    }
  }

  const res = createNodeLikeResponse();
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`[api] ${url.pathname} failed:`, error && error.stack ? error.stack : error);
    return json(500, { ok: false, error: "internal error" });
  }
  if (!res.finished) return json(500, { ok: false, error: "handler returned no response" });
  const response = res.toResponse();

  if (principal && response.status === 200) {
    const action = bodyAction(req.body);
    if (route === "table-status" && req.method === "POST" && (action === "checkout" || action === "clear-table")) {
      // Table passes issued before this moment stop working: the next customer starts clean.
      await bumpTableVersion(store, req.body.table);
    }
    // Only someone without a valid pass is handed one. A pass holder never receives a replacement.
    if (isCustomerOrderCreate(route, req, principal) && principal.role === PUBLIC) {
      const table = normalizeTable(req.body.table);
      const pass = table ? await issueTablePass(env, store, table) : null;
      if (pass) {
        response.headers.append("set-cookie", buildCookie(request, TABLE_COOKIE, pass, { path: "/api", maxAgeSec: TABLE_PASS_TTL_SEC }));
      }
    }
  }
  return response;
}
