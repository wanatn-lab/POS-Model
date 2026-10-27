// Cloudflare port: the API handlers still call `redis.get/set/hset/...` exactly as on Vercel,
// but the "redis" here is a thin proxy onto the store of the single Durable Object that runs
// every API request (see src/shop-do.js). The Durable Object installs its store once, when it
// is constructed; handlers resolve it lazily on every call.
//
// Why a proxy and not a direct import: the handler modules create their default instances at
// import time (`export default createOrdersHandler()`), before any Durable Object exists.

function store() {
  const current = globalThis.__shopStore;
  if (!current) throw new Error("[api] store is not ready (no Durable Object context)");
  return current;
}

export const redis = {
  get: (...args) => store().get(...args),
  set: (...args) => store().set(...args),
  del: (...args) => store().del(...args),
  expire: (...args) => store().expire(...args),
  hset: (...args) => store().hset(...args),
  hgetall: (...args) => store().hgetall(...args),
  mget: (...args) => store().mget(...args),
};
