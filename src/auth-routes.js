// Endpoints that belong to access control itself (they need the Worker environment and the
// store, so they live here instead of in api/):
//   POST /api/auth/login   { role: "staff" | "owner", password }   -> session cookie
//   POST /api/auth/logout                                          -> clears the cookie
//   GET  /api/auth/me                                              -> { role }
//   GET/POST /api/devices  (owner only)                            -> print-device credentials
import {
  DEVICES_KEY,
  LOGIN_MAX_FAILS,
  LOGIN_WINDOW_SEC,
  MIN_PASSWORD_LENGTH,
  OWNER,
  PUBLIC,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  STAFF,
  authMode,
  buildCookie,
  clearCookie,
  clientLabel,
  jsonResponse,
  logAuth,
  randomToken,
  rateClear,
  rateCount,
  rateHit,
  resolvePrincipal,
  sameOriginRequest,
  sameSecret,
  sha256Hex,
  signToken,
  signingConfigured,
} from "./auth.js";

const PASSWORD_VARIABLE = { [STAFF]: "STAFF_PASSWORD", [OWNER]: "OWNER_PASSWORD" };
const MAX_DEVICES = 10;
const DEFAULT_ROTATION_GRACE_HOURS = 168;

export async function handleAuthRoute(request, name, { store, env }) {
  if (name === "me") {
    if (request.method !== "GET") return jsonResponse(405, { ok: false, error: "method not allowed" });
    const principal = await resolvePrincipal(request, { store, env });
    // `mode` lets the login gate know whether it must ask for a login up front (enforce) or only
    // react to a real 401/403 (log / off).
    return jsonResponse(200, { ok: true, role: principal.role, mode: authMode(env) });
  }
  if (request.method !== "POST") return jsonResponse(405, { ok: false, error: "method not allowed" });
  if (!sameOriginRequest(request)) return jsonResponse(403, { ok: false, error: "forbidden" });

  if (name === "logout") {
    return jsonResponse(200, { ok: true }, { "set-cookie": clearCookie(request, SESSION_COOKIE, "/") });
  }
  if (name !== "login") return jsonResponse(404, { ok: false, error: "not found" });

  const body = await request.json().catch(() => null);
  const role = body && body.role;
  const password = body && body.password;
  if ((role !== STAFF && role !== OWNER) || typeof password !== "string") {
    return jsonResponse(400, { ok: false, error: "bad_request" });
  }
  const expected = env[PASSWORD_VARIABLE[role]];
  if (!signingConfigured(env) || typeof expected !== "string" || expected.length < MIN_PASSWORD_LENGTH) {
    return jsonResponse(503, { ok: false, error: "not_configured" });
  }

  const key = `auth:rl:login:${role}:${await clientLabel(request)}`;
  if ((await rateCount(store, key, LOGIN_WINDOW_SEC)) >= LOGIN_MAX_FAILS) {
    logAuth("auth.login_locked", { role });
    return jsonResponse(429, { ok: false, error: "too_many_attempts" });
  }
  if (!(await sameSecret(password, expected))) {
    await rateHit(store, key, LOGIN_WINDOW_SEC);
    logAuth("auth.login_failed", { role });
    return jsonResponse(401, { ok: false, error: "bad_credentials" });
  }
  await rateClear(store, key);
  const token = await signToken(env, "session", { r: role, exp: Date.now() + SESSION_TTL_SEC * 1000 });
  return jsonResponse(
    200,
    { ok: true, role },
    { "set-cookie": buildCookie(request, SESSION_COOKIE, token, { path: "/", maxAgeSec: SESSION_TTL_SEC }) },
  );
}

function publicView(device) {
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    createdAt: device.createdAt,
    rotatedAt: device.rotatedAt || null,
    rotationOpen: Boolean(device.previous),
    revokedAt: device.revokedAt || null,
  };
}

async function newSecret() {
  const secret = randomToken(32);
  return { secret, hash: await sha256Hex(secret) };
}

export async function handleDevicesRoute(request, { store, env, principal }) {
  // Device credentials are always owner-only, whatever AUTH_MODE says.
  if (principal.role !== OWNER) {
    return jsonResponse(principal.role === PUBLIC ? 401 : 403, { ok: false, error: principal.role === PUBLIC ? "unauthorized" : "forbidden" });
  }
  const devices = (await store.get(DEVICES_KEY)) || {};

  if (request.method === "GET") {
    return jsonResponse(200, { ok: true, devices: Object.values(devices).map(publicView) });
  }
  if (request.method !== "POST") return jsonResponse(405, { ok: false, error: "method not allowed" });
  if (!sameOriginRequest(request)) return jsonResponse(403, { ok: false, error: "forbidden" });

  const body = (await request.json().catch(() => null)) || {};
  const now = Date.now();
  const iso = new Date(now).toISOString();

  if (body.action === "create") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
    if (!name) return jsonResponse(400, { ok: false, error: "name is required" });
    if (Object.values(devices).filter((device) => device.status === "active").length >= MAX_DEVICES) {
      return jsonResponse(409, { ok: false, error: "too many active devices" });
    }
    const id = `dev_${[...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const { secret, hash } = await newSecret();
    devices[id] = { id, name, status: "active", createdAt: iso, current: { hash, createdAt: iso }, previous: null };
    await store.set(DEVICES_KEY, devices);
    logAuth("auth.device_created", { deviceId: id });
    // The secret is shown exactly once and is never stored in readable form.
    return jsonResponse(200, { ok: true, device: publicView(devices[id]), token: `${id}.${secret}` });
  }

  const device = typeof body.id === "string" && Object.prototype.hasOwnProperty.call(devices, body.id) ? devices[body.id] : null;
  if (!device) return jsonResponse(404, { ok: false, error: "device not found" });

  if (body.action === "rotate") {
    if (device.status !== "active") return jsonResponse(409, { ok: false, error: "device is revoked" });
    const hours = Math.min(720, Math.max(1, Number(env.ROTATION_GRACE_HOURS) || DEFAULT_ROTATION_GRACE_HOURS));
    const { secret, hash } = await newSecret();
    // Old and new tokens both work until the owner finishes the rotation or the grace period ends.
    device.previous = { ...device.current, expiresAt: now + hours * 3600 * 1000 };
    device.current = { hash, createdAt: iso };
    device.rotatedAt = iso;
    await store.set(DEVICES_KEY, devices);
    logAuth("auth.device_rotated", { deviceId: device.id });
    return jsonResponse(200, { ok: true, device: publicView(device), token: `${device.id}.${secret}` });
  }
  if (body.action === "finish-rotation") {
    device.previous = null;
    await store.set(DEVICES_KEY, devices);
    logAuth("auth.device_rotation_finished", { deviceId: device.id });
    return jsonResponse(200, { ok: true, device: publicView(device) });
  }
  if (body.action === "revoke") {
    device.status = "revoked";
    device.revokedAt = iso;
    device.current = null;
    device.previous = null;
    await store.set(DEVICES_KEY, devices);
    logAuth("auth.device_revoked", { deviceId: device.id });
    return jsonResponse(200, { ok: true, device: publicView(device) });
  }
  return jsonResponse(400, { ok: false, error: "unknown action" });
}
