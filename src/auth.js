// Access control for every /api/* request. Pure JavaScript (Web Crypto only), so it runs in a
// Worker, in the Durable Object and in plain Node tests.
//
// Who can call what is declared once, in RULES below. Anything not listed is denied.
//
// Principals (who is calling):
//   public    nobody is signed in
//   customer  holds a "table pass" cookie, issued when a table places its first order
//   device    a print device presenting its own Bearer token (<deviceId>.<secret>)
//   reader    the read-only Bill Summary token (BILL_READER_TOKEN)
//   staff     signed in with the staff password (session cookie)
//   owner     signed in with the owner password; may do everything staff may do
//
// AUTH_MODE (Worker variable): "enforce" (default, also for any unknown value), "log" (decide
// and log, but let everything through) or "off" (legacy behaviour, no checks).

export const PUBLIC = "public";
export const CUSTOMER = "customer";
export const DEVICE = "device";
export const READER = "reader";
export const STAFF = "staff";
export const OWNER = "owner";

export const SESSION_COOKIE = "jinko_session";
export const TABLE_COOKIE = "jinko_table";
export const DEVICES_KEY = "auth:devices";

export const SESSION_TTL_SEC = 12 * 60 * 60;
export const TABLE_PASS_TTL_SEC = 8 * 60 * 60;
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_WINDOW_SEC = 15 * 60;
export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SECRET_LENGTH = 32;
export const DEFAULT_ORDERS_PER_MINUTE = 10;
export const DEVICE_TOKEN_RE = /^(dev_[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

// ---- the access matrix --------------------------------------------------------------------
// route -> HTTP method -> allowed roles, or { <body.action>: roles, "*": default roles }.
// "public" means everyone. "staff" also admits "owner". Omitted action with no "*" = nobody.
export const RULES = {
  // Staff may mark an item sold out / available again; editing the menu itself is owner-only.
  menu: { GET: [PUBLIC], POST: { "set-availability": [STAFF], "*": [OWNER] } },
  "shop-status": { GET: [PUBLIC], POST: [OWNER] },
  // GET is open, but the handler only returns shopName/tableCount unless the caller is
  // a device, staff or owner (receipt design and printer setup are not public).
  settings: { GET: [PUBLIC], POST: [OWNER] },
  orders: {
    GET: [CUSTOMER, DEVICE, STAFF], // a customer only ever receives their own table
    POST: { done: [STAFF], "*": [PUBLIC] }, // placing an order is how a table gets its pass
  },
  "table-status": { GET: [STAFF], POST: [STAFF] },
  "bill-history": { GET: [STAFF, READER], POST: [STAFF] },
  "print-jobs": { GET: [DEVICE], POST: [DEVICE] },
  "printer-status": { GET: [STAFF], POST: [DEVICE] },
  "qr-print-jobs": { GET: [DEVICE], POST: { create: [STAFF], "*": [DEVICE] } },
  kitchen: { GET: [STAFF], POST: [STAFF] },
  devices: { GET: [OWNER], POST: [OWNER] },
};

export function authMode(env) {
  const mode = String((env && env.AUTH_MODE) || "").trim().toLowerCase();
  return mode === "off" || mode === "log" ? mode : "enforce";
}

function actionOf(body) {
  return body && typeof body === "object" && typeof body.action === "string" ? body.action : undefined;
}

export function rolesFor(route, method, body) {
  const byMethod = Object.prototype.hasOwnProperty.call(RULES, route) ? RULES[route] : null;
  const rule = byMethod && Object.prototype.hasOwnProperty.call(byMethod, method) ? byMethod[method] : null;
  if (!rule) return null;
  if (Array.isArray(rule)) return rule;
  const action = actionOf(body);
  if (action !== undefined && Object.prototype.hasOwnProperty.call(rule, action)) return rule[action];
  return rule["*"] || [];
}

// Every role that could ever be accepted for this route+method (used by the cheap pre-filter).
export function allRolesFor(route, method) {
  const byMethod = Object.prototype.hasOwnProperty.call(RULES, route) ? RULES[route] : null;
  const rule = byMethod && Object.prototype.hasOwnProperty.call(byMethod, method) ? byMethod[method] : null;
  if (!rule) return null;
  return Array.isArray(rule) ? rule : Object.values(rule).flat();
}

export function isAllowed(role, roles) {
  return roles.includes(PUBLIC) || roles.includes(role) || (role === OWNER && roles.includes(STAFF));
}

export function authorize(route, method, body, principal) {
  if (!Object.prototype.hasOwnProperty.call(RULES, route)) {
    return { ok: false, status: 403, error: "forbidden", reason: "no_policy" };
  }
  const roles = rolesFor(route, method, body);
  if (!roles) return { ok: false, status: 405, error: "method not allowed", reason: "method" };
  if (isAllowed(principal.role, roles)) return { ok: true };
  return principal.role === PUBLIC
    ? { ok: false, status: 401, error: "unauthorized", reason: "no_credential" }
    : { ok: false, status: 403, error: "forbidden", reason: "insufficient_role" };
}

// ---- small crypto helpers ------------------------------------------------------------------
const encoder = new TextEncoder();

export function toB64Url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(byteLength = 32) {
  return toB64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sameToken(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Compares two secrets without leaking their length: both sides are hashed first.
export async function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  return sameToken(await sha256Hex(given), await sha256Hex(expected));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toB64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

export function signingConfigured(env) {
  return typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= MIN_SECRET_LENGTH;
}

// label separates the cookies ("session" vs "table") so one can never be replayed as the other.
export async function signToken(env, label, payload) {
  if (!signingConfigured(env)) return null;
  const body = toB64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.SESSION_SECRET, `${label}.${body}`)}`;
}

export async function verifyToken(env, label, token, now = Date.now()) {
  if (!signingConfigured(env) || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  if (!sameToken(parts[1], await hmac(env.SESSION_SECRET, `${label}.${parts[0]}`))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64Url(parts[0])));
    if (!payload || typeof payload !== "object" || !(payload.exp > now)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- cookies ---------------------------------------------------------------------------------
export function parseCookies(header) {
  const jar = {};
  for (const piece of String(header || "").split(";")) {
    const at = piece.indexOf("=");
    if (at > 0) jar[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
  }
  return jar;
}

export function buildCookie(request, name, value, { path, maxAgeSec }) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Strict${secure}`;
}

export function clearCookie(request, name, path) {
  return buildCookie(request, name, "", { path, maxAgeSec: 0 });
}

// A cookie-authenticated, state-changing request must come from our own pages.
export function sameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// ---- table numbers / table passes ------------------------------------------------------------
// "5", " 5", "05" and 5 are the same table. Anything that is not a whole number 1..999 is invalid.
export function normalizeTable(value) {
  const text = String(value == null ? "" : value).trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 ? String(number) : null;
}

const tableVersionKey = (table) => `auth:tv:${table}`;

export async function tableVersion(store, table) {
  return Number(await store.get(tableVersionKey(table))) || 0;
}

// Called after checkout / clear-table: passes issued before this moment stop working.
export async function bumpTableVersion(store, table) {
  const normalized = normalizeTable(table);
  if (!normalized) return;
  await store.set(tableVersionKey(normalized), (await tableVersion(store, normalized)) + 1);
}

export async function issueTablePass(env, store, table, now = Date.now()) {
  return signToken(env, "table", {
    t: table,
    v: await tableVersion(store, table),
    exp: now + TABLE_PASS_TTL_SEC * 1000,
  });
}

// ---- rate limiting (fixed window, kept in the same SQLite store) -----------------------------
export async function rateCount(store, key, windowSec, now = Date.now()) {
  const record = await store.get(key);
  return record && now - record.start < windowSec * 1000 ? record.n : 0;
}

export async function rateHit(store, key, windowSec, now = Date.now()) {
  const record = await store.get(key);
  const fresh = !record || now - record.start >= windowSec * 1000;
  const next = { n: fresh ? 1 : record.n + 1, start: fresh ? now : record.start };
  const remainingSec = Math.max(1, Math.ceil((next.start + windowSec * 1000 - now) / 1000));
  await store.set(key, next, { ex: remainingSec });
  return next.n;
}

export async function rateClear(store, key) {
  await store.del(key);
}

// Short, non-reversible label for a client address (the raw address is never stored or logged).
export async function clientLabel(request) {
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  return (await sha256Hex(address)).slice(0, 16);
}

// ---- devices -----------------------------------------------------------------------------------
async function authenticateDevice(store, id, secret, now) {
  const devices = (await store.get(DEVICES_KEY)) || {};
  const device = Object.prototype.hasOwnProperty.call(devices, id) ? devices[id] : null;
  if (!device || device.status !== "active") return null;
  const hash = await sha256Hex(secret);
  if (device.current && sameToken(hash, device.current.hash)) return device;
  if (device.previous && device.previous.expiresAt > now && sameToken(hash, device.previous.hash)) return device;
  return null;
}

// ---- who is calling ------------------------------------------------------------------------------
export async function resolvePrincipal(request, { store, env }, now = Date.now()) {
  const bearer = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (bearer) {
    const token = bearer[1];
    const shaped = DEVICE_TOKEN_RE.exec(token);
    if (shaped) {
      const device = await authenticateDevice(store, shaped[1], shaped[2], now);
      if (device) return { role: DEVICE, deviceId: device.id };
    } else if (
      typeof env.BILL_READER_TOKEN === "string" &&
      env.BILL_READER_TOKEN.length >= MIN_SECRET_LENGTH &&
      (await sameSecret(token, env.BILL_READER_TOKEN))
    ) {
      return { role: READER };
    }
  }

  const jar = parseCookies(request.headers.get("cookie"));
  const session = await verifyToken(env, "session", jar[SESSION_COOKIE], now);
  if (session && (session.r === STAFF || session.r === OWNER)) return { role: session.r, viaCookie: true };

  const pass = await verifyToken(env, "table", jar[TABLE_COOKIE], now);
  if (pass && normalizeTable(pass.t) && pass.v === (await tableVersion(store, pass.t))) {
    return { role: CUSTOMER, table: pass.t, viaCookie: true };
  }
  return { role: PUBLIC };
}

// Cheap check run in the Worker before the Durable Object is woken (nothing is read from
// storage): a request that carries no plausible credential for a non-public route is turned
// away here, so junk traffic does not use up Durable Object requests.
export async function quickReject(request, env) {
  if (authMode(env) !== "enforce") return null;
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/([^/]+?)(?:\.js)?\/?$/);
  if (!match) return null;
  const roles = allRolesFor(match[1], request.method);
  if (!roles || roles.includes(PUBLIC)) return null;

  const bearer = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (bearer) {
    if (DEVICE_TOKEN_RE.test(bearer[1])) return null;
    if (typeof env.BILL_READER_TOKEN === "string" && (await sameSecret(bearer[1], env.BILL_READER_TOKEN))) return null;
  }
  const jar = parseCookies(request.headers.get("cookie"));
  if (await verifyToken(env, "session", jar[SESSION_COOKIE])) return null;
  if (await verifyToken(env, "table", jar[TABLE_COOKIE])) return null;
  return jsonResponse(401, { ok: false, error: "unauthorized" });
}

export function jsonResponse(status, body, extraHeaders) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const [name, value] of Object.entries(extraHeaders || {})) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

// One line per decision that matters; never contains a password, token, cookie or address.
export function logAuth(event, fields) {
  console.warn(JSON.stringify({ evt: event, ...fields }));
}
