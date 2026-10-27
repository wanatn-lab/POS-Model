// "Bell" (กริ่ง) — a tiny wake-up signal in Firebase Realtime Database.
//
// Redis stays the single source of truth for orders and print jobs. After a
// write that creates NEW printable work, the API writes {ts, seq} to
// /bridge/ping so the Android print bridge can fetch from Redis immediately
// instead of waiting for its next poll. One ping covers every kind of work
// (kitchen/drinks tickets, receipts, table QR labels): the app checks them all.
// The bell carries no order data, only "something changed".
//
// Hard rules (an order must never fail because of the bell):
//   * ringBell() never throws and never rejects.
//   * The whole attempt (token + write) is capped at BELL_TIMEOUT_MS.
//   * Disabled unless BELL_ENABLED=true and credentials are present.
//   * Preview deployments only ever use PREVIEW_* settings and a separate path
//     (/bridge-preview), mirroring the rule in _redis.js. Missing preview
//     settings = no-op.
//
// No SDK: a service-account JWT is exchanged for a Google OAuth2 access token
// (scope firebase.database), then one HTTPS PATCH is sent. This keeps the
// serverless bundle small and avoids holding a websocket open in a function.

export const BELL_TIMEOUT_MS = 1500;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/firebase.database",
].join(" ");
// Google access tokens last about an hour; refresh well before that.
const TOKEN_REUSE_MS = 50 * 60 * 1000;

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64url(input) {
  return toBase64Url(typeof input === "string" ? new TextEncoder().encode(input) : input);
}

// Cloudflare port: no node:crypto. The service-account key (PKCS#8 PEM) is imported with WebCrypto.
async function signRs256(privateKeyPem, message) {
  const body = privateKeyPem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(signature));
}

// Environment variables are handed over by the Durable Object (globalThis.__shopEnv); read lazily.
const workerEnv = new Proxy({}, {
  get: (_target, name) => (globalThis.__shopEnv || {})[name],
});

function parseServiceAccount(raw) {
  if (!raw || typeof raw !== "string") return null;
  const text = raw.trim();
  try {
    // Accept plain JSON or base64-encoded JSON (easier to paste into Vercel).
    const json = text.startsWith("{")
      ? text
      : new TextDecoder().decode(Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0)));
    const account = JSON.parse(json);
    if (!account.client_email || !account.private_key) return null;
    return { clientEmail: account.client_email, privateKey: String(account.private_key).replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

/** Reads configuration for the current deployment. Exported for tests. */
export function bellConfig(env = workerEnv) {
  const isPreview = env.VERCEL_ENV === "preview" || env.APP_ENV === "preview";
  const pick = (name) => (isPreview ? env[`PREVIEW_${name}`] : env[name]);
  const enabled = String(pick("BELL_ENABLED") || "").toLowerCase() === "true";
  const databaseUrl = String(pick("FIREBASE_DATABASE_URL") || "").trim().replace(/\/+$/, "");
  const account = parseServiceAccount(pick("FIREBASE_SERVICE_ACCOUNT_JSON"));
  const ready = enabled && /^https:\/\//.test(databaseUrl) && Boolean(account);
  return {
    ready,
    enabled,
    isPreview,
    databaseUrl,
    account,
    // Preview rings a separate path so a test app can never wake the shop's printer.
    rootPath: isPreview ? "bridge-preview" : "bridge",
  };
}

export function createBell({
  env = workerEnv,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = BELL_TIMEOUT_MS,
  log = console,
} = {}) {
  let cachedToken = null;
  let cachedAt = 0;

  async function accessToken(config, signal) {
    if (cachedToken && now() - cachedAt < TOKEN_REUSE_MS) return cachedToken;
    const issuedAt = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({
      iss: config.account.clientEmail,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const signature = await signRs256(config.account.privateKey, `${header}.${claims}`);
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
      signal,
    });
    if (!response.ok) throw new Error(`token HTTP ${response.status}`);
    const body = await response.json();
    if (!body || !body.access_token) throw new Error("token missing");
    cachedToken = body.access_token;
    cachedAt = now();
    return cachedToken;
  }

  function writePing(url, token, body, signal) {
    return fetchImpl(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
  }

  /**
   * Rings the bell once. `reason` is only a label for logs ("print", "qr"...).
   * Resolves to true when the ping was written, false otherwise. Never throws.
   */
  return async function ringBell(reason = "") {
    try {
      const config = bellConfig(env);
      if (!config.ready || typeof fetchImpl !== "function") return false;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const token = await accessToken(config, controller.signal);
        const url = `${config.databaseUrl}/${config.rootPath}/ping.json?print=silent`;
        // ts: Firebase server time. seq: server-side counter, so every ring is a
        // change even if two land in the same millisecond.
        let response = await writePing(
          url,
          token,
          { ts: { ".sv": "timestamp" }, seq: { ".sv": { increment: 1 } } },
          controller.signal,
        );
        if (response.status === 400) {
          // Counter not accepted: still ring with the timestamp alone rather than stay silent.
          response = await writePing(url, token, { ts: { ".sv": "timestamp" } }, controller.signal);
        }
        if (response.status === 401 || response.status === 403) cachedToken = null;
        if (!response.ok) throw new Error(`bell HTTP ${response.status}`);
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      try {
        log.warn(`[bell] ${reason || "ping"} not rung: ${error && error.name === "AbortError" ? "timeout" : error && error.message}`);
      } catch {
        // Logging must not break an order either.
      }
      return false;
    }
  };
}

export const ringBell = createBell();
